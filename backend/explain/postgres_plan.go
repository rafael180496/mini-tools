package explain

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
)

type pgPlanNode struct {
	NodeType        string       `json:"Node Type"`
	RelationName    string       `json:"Relation Name"`
	TotalCost       float64      `json:"Total Cost"`
	PlanRows        int64        `json:"Plan Rows"`
	ActualTotalTime float64      `json:"Actual Total Time"`
	ActualRows      int64        `json:"Actual Rows"`
	Plans           []pgPlanNode `json:"Plans"`
}

type pgExplainResult struct {
	Plan          pgPlanNode `json:"Plan"`
	PlanningTime  float64    `json:"Planning Time"`
	ExecutionTime float64    `json:"Execution Time"`
}

// PostgresPlan runs EXPLAIN (FORMAT JSON[, ANALYZE]) and converts Postgres's
// nested JSON plan into our tree shape. With analyze=true, ActualTotalTime
// reflects real execution timing (the query actually runs); without it,
// only planner estimates are available.
func PostgresPlan(ctx context.Context, pool *sql.DB, query string, analyze bool) (*Plan, error) {
	analyzeClause := ""
	if analyze {
		analyzeClause = ", ANALYZE"
	}

	var rawJSON string
	explainSQL := fmt.Sprintf("EXPLAIN (FORMAT JSON%s) %s", analyzeClause, query)
	if err := pool.QueryRowContext(ctx, explainSQL).Scan(&rawJSON); err != nil {
		return nil, fmt.Errorf("explain: ejecutando EXPLAIN: %w", err)
	}

	var results []pgExplainResult
	if err := json.Unmarshal([]byte(rawJSON), &results); err != nil {
		return nil, fmt.Errorf("explain: parseando JSON de postgres: %w", err)
	}
	if len(results) == 0 {
		return nil, fmt.Errorf("explain: postgres no devolvió ningún plan")
	}

	return &Plan{
		Root:       convertPgNode(&results[0].Plan),
		RawText:    rawJSON,
		DurationMs: results[0].ExecutionTime,
	}, nil
}

func convertPgNode(n *pgPlanNode) *PlanNode {
	node := &PlanNode{
		Operation:    n.NodeType,
		ObjectName:   n.RelationName,
		Cost:         n.TotalCost,
		Rows:         n.PlanRows,
		ActualTimeMs: n.ActualTotalTime,
		IsFullScan:   n.NodeType == "Seq Scan",
	}
	for i := range n.Plans {
		node.Children = append(node.Children, convertPgNode(&n.Plans[i]))
	}
	return node
}
