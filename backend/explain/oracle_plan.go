package explain

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// OraclePlan runs EXPLAIN PLAN FOR against a uniquely-tagged statement_id
// and reads the resulting rows back from PLAN_TABLE, on a single reserved
// connection (same reasoning as DBMS_OUTPUT in backend/query/dbmsoutput.go
// — PLAN_TABLE writes/reads must happen predictably, and a unique
// statement_id also means concurrent EXPLAINs from other sessions don't
// collide). Not verified against a real Oracle instance — see
// .claude/skills/mini-tools-patterns/SKILL.md.
func OraclePlan(ctx context.Context, pool *sql.DB, query string) (*Plan, error) {
	conn, err := pool.Conn(ctx)
	if err != nil {
		return nil, fmt.Errorf("explain: reservando conexión: %w", err)
	}
	defer conn.Close()

	statementID := fmt.Sprintf("mt_%d", time.Now().UnixNano())

	if _, err := conn.ExecContext(ctx, fmt.Sprintf("EXPLAIN PLAN SET STATEMENT_ID = '%s' FOR %s", statementID, query)); err != nil {
		return nil, fmt.Errorf("explain: ejecutando EXPLAIN PLAN: %w", err)
	}
	defer func() {
		_, _ = conn.ExecContext(context.Background(), "DELETE FROM plan_table WHERE statement_id = :1", statementID)
	}()

	rows, err := conn.QueryContext(ctx, `
		SELECT id, parent_id, operation, options, object_name, cost, cardinality
		FROM plan_table WHERE statement_id = :1 ORDER BY id
	`, statementID)
	if err != nil {
		return nil, fmt.Errorf("explain: leyendo plan_table: %w", err)
	}
	defer rows.Close()

	type row struct {
		id, parentID      int64
		hasParent         bool
		operation         string
		options           string
		objectName        string
		cost, cardinality sql.NullInt64
	}
	var parsed []row
	var rawLines []string

	for rows.Next() {
		var id int64
		var parentID sql.NullInt64
		var operation, options, objectName sql.NullString
		var cost, cardinality sql.NullInt64
		if err := rows.Scan(&id, &parentID, &operation, &options, &objectName, &cost, &cardinality); err != nil {
			return nil, fmt.Errorf("explain: escaneando fila de plan_table: %w", err)
		}
		r := row{id: id, operation: operation.String, options: options.String, objectName: objectName.String, cost: cost, cardinality: cardinality}
		if parentID.Valid {
			r.parentID = parentID.Int64
			r.hasParent = true
		}
		parsed = append(parsed, r)
		rawLines = append(rawLines, strings.TrimSpace(fmt.Sprintf("%s %s %s", r.operation, r.options, r.objectName)))
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(parsed) == 0 {
		return nil, fmt.Errorf("explain: plan_table no devolvió filas")
	}

	nodesByID := make(map[int64]*PlanNode, len(parsed))
	for _, r := range parsed {
		op := r.operation
		if r.options != "" {
			op = op + " " + r.options
		}
		nodesByID[r.id] = &PlanNode{
			Operation:  op,
			ObjectName: r.objectName,
			Cost:       float64(r.cost.Int64),
			Rows:       r.cardinality.Int64,
			IsFullScan: strings.Contains(strings.ToUpper(r.options), "FULL"),
		}
	}

	var root *PlanNode
	for _, r := range parsed {
		node := nodesByID[r.id]
		if r.hasParent {
			if parent, ok := nodesByID[r.parentID]; ok {
				parent.Children = append(parent.Children, node)
				continue
			}
		}
		if root == nil {
			root = node
		}
	}

	return &Plan{Root: root, RawText: strings.Join(rawLines, "\n")}, nil
}
