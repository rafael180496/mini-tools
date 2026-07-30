package explain

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"mini-tools/backend/query"
)

type pgPlanNode struct {
	NodeType     string `json:"Node Type"`
	RelationName string `json:"Relation Name"`
	IndexName    string `json:"Index Name"`
	// Alias is Postgres's name for the relation in the query; kept as the
	// fallback object name for nodes that report no Relation Name.
	Alias           string  `json:"Alias"`
	TotalCost       float64 `json:"Total Cost"`
	PlanRows        int64   `json:"Plan Rows"`
	ActualTotalTime float64 `json:"Actual Total Time"`
	ActualRows      int64   `json:"Actual Rows"`
	ActualLoops     int64   `json:"Actual Loops"`
	// The three predicate shapes, in the order they are worth indexing:
	// a Filter is applied after reading a row (the expensive one an index
	// would remove), an Index Cond is already served by an index, and a
	// Recheck Cond belongs to a bitmap scan.
	Filter      string `json:"Filter"`
	IndexCond   string `json:"Index Cond"`
	RecheckCond string `json:"Recheck Cond"`
	JoinFilter  string `json:"Join Filter"`
	HashCond    string `json:"Hash Cond"`

	SharedHitBlocks     int64 `json:"Shared Hit Blocks"`
	SharedReadBlocks    int64 `json:"Shared Read Blocks"`
	SharedDirtiedBlocks int64 `json:"Shared Dirtied Blocks"`
	SharedWrittenBlocks int64 `json:"Shared Written Blocks"`

	Plans []pgPlanNode `json:"Plans"`
}

type pgExplainResult struct {
	Plan          pgPlanNode `json:"Plan"`
	PlanningTime  float64    `json:"Planning Time"`
	ExecutionTime float64    `json:"Execution Time"`
}

// PostgresPlan runs EXPLAIN and converts Postgres's nested JSON plan into
// our tree shape.
//
// With analyze=false the query is only planned — instant and side-effect
// free. With analyze=true the query REALLY RUNS, which is the whole point
// (real row counts and timings) and also the whole risk. Two things follow
// from that:
//
//   - BUFFERS is requested alongside ANALYZE. It costs nothing extra once
//     the query is running anyway, and it is the only way to tell "slow
//     because it read a lot" from "slow because it read from disk".
//   - A mutating statement is wrapped in a transaction that is ALWAYS rolled
//     back. EXPLAIN ANALYZE on a DELETE deletes; the rollback is what makes
//     the button safe to press. The plan reports RolledBack so the UI can
//     say so rather than leaving the user to wonder.
func PostgresPlan(ctx context.Context, pool *sql.DB, sqlText string, analyze bool) (*Plan, error) {
	explainSQL := "EXPLAIN (FORMAT JSON) " + sqlText
	if analyze {
		explainSQL = "EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS) " + sqlText
	}

	mutating := analyze && query.ContainsMutation(sqlText)

	var rawJSON string
	var err error
	if mutating {
		rawJSON, err = runInRolledBackTx(ctx, pool, explainSQL)
	} else {
		err = pool.QueryRowContext(ctx, explainSQL).Scan(&rawJSON)
	}
	if err != nil {
		return nil, fmt.Errorf("explain: ejecutando EXPLAIN: %w", err)
	}

	var results []pgExplainResult
	if err := json.Unmarshal([]byte(rawJSON), &results); err != nil {
		return nil, fmt.Errorf("explain: parseando JSON de postgres: %w", err)
	}
	if len(results) == 0 {
		return nil, fmt.Errorf("explain: postgres no devolvió ningún plan")
	}

	plan := &Plan{
		Root:            convertPgNode(&results[0].Plan),
		RawText:         rawJSON,
		DurationMs:      results[0].ExecutionTime,
		ExecutionTimeMs: results[0].ExecutionTime,
		PlanningTimeMs:  results[0].PlanningTime,
		RolledBack:      mutating,
	}
	plan.Buffers = collectBuffers(&results[0].Plan)
	Analyze(plan, "postgres", analyze)
	return plan, nil
}

// runInRolledBackTx executes one EXPLAIN on a reserved connection inside a
// transaction that is rolled back unconditionally, and returns its single
// text result.
//
// A reserved *sql.Conn rather than *sql.Tx, and an explicit BEGIN/ROLLBACK,
// for the same reason backend/query/executor.go reserves one for user
// transactions: the statement being explained may itself contain
// transaction control, and Go's *sql.Tx would fight with it. The ROLLBACK
// runs on context.Background() so a cancelled or timed-out EXPLAIN still
// undoes its writes — a rollback that gets skipped because the context died
// is exactly the failure this function exists to prevent.
func runInRolledBackTx(ctx context.Context, pool *sql.DB, explainSQL string) (string, error) {
	conn, err := pool.Conn(ctx)
	if err != nil {
		return "", fmt.Errorf("reservando conexión: %w", err)
	}
	defer conn.Close()

	if _, err := conn.ExecContext(ctx, "BEGIN"); err != nil {
		return "", fmt.Errorf("abriendo transacción: %w", err)
	}
	defer func() {
		_, _ = conn.ExecContext(context.Background(), "ROLLBACK")
	}()

	var rawJSON string
	if err := conn.QueryRowContext(ctx, explainSQL).Scan(&rawJSON); err != nil {
		return "", err
	}
	return rawJSON, nil
}

func convertPgNode(n *pgPlanNode) *PlanNode {
	object := n.RelationName
	if object == "" {
		object = n.Alias
	}

	node := &PlanNode{
		Operation:    n.NodeType,
		ObjectName:   object,
		Cost:         n.TotalCost,
		Rows:         n.PlanRows,
		ActualRows:   n.ActualRows,
		ActualTimeMs: n.ActualTotalTime,
		Loops:        n.ActualLoops,
		IndexName:    n.IndexName,
		Filter:       pickPredicate(n),
		// Seq Scan is the only node type that reads a whole heap without an
		// index. A Bitmap Heap Scan or an Index Scan may still read a lot,
		// but calling them "full scans" would be wrong and would send the
		// user hunting for an index that already exists.
		IsFullScan: n.NodeType == "Seq Scan",
	}
	for i := range n.Plans {
		node.Children = append(node.Children, convertPgNode(&n.Plans[i]))
	}
	return node
}

// pickPredicate chooses the predicate worth showing and worth deriving an
// index from. Filter first: it is the one applied AFTER reading a row, so
// it is the one an index would eliminate. An Index Cond is already indexed,
// so it is only shown when there is no Filter.
func pickPredicate(n *pgPlanNode) string {
	for _, p := range []string{n.Filter, n.IndexCond, n.RecheckCond, n.HashCond, n.JoinFilter} {
		if strings.TrimSpace(p) != "" {
			return p
		}
	}
	return ""
}

// collectBuffers sums the whole tree's block counters. Postgres reports
// them per node and cumulatively up the tree, but summing the leaves is
// wrong (parents include children) and reading only the root misses
// branches in some plan shapes — so this takes the root's own numbers,
// which Postgres already reports as the total for the subtree.
func collectBuffers(root *pgPlanNode) *BufferStats {
	if root.SharedHitBlocks == 0 && root.SharedReadBlocks == 0 {
		return nil
	}
	b := &BufferStats{
		Hit:     root.SharedHitBlocks,
		Read:    root.SharedReadBlocks,
		Dirtied: root.SharedDirtiedBlocks,
		Written: root.SharedWrittenBlocks,
	}
	if total := b.Hit + b.Read; total > 0 {
		b.HitRatePct = float64(b.Hit) / float64(total) * 100
	}
	return b
}
