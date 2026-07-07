package explain

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// SQLitePlan runs EXPLAIN QUERY PLAN and rebuilds SQLite's flat id/parent
// rows into a tree. SQLite has no EXPLAIN ANALYZE equivalent (no actual
// timing), so Plan.DurationMs is always 0 here.
func SQLitePlan(ctx context.Context, pool *sql.DB, query string) (*Plan, error) {
	rows, err := pool.QueryContext(ctx, "EXPLAIN QUERY PLAN "+query)
	if err != nil {
		return nil, fmt.Errorf("explain: ejecutando EXPLAIN QUERY PLAN: %w", err)
	}
	defer rows.Close()

	type row struct {
		id, parent int
		detail     string
	}
	var parsed []row
	var rawLines []string

	for rows.Next() {
		var id, parent, notused int
		var detail string
		if err := rows.Scan(&id, &parent, &notused, &detail); err != nil {
			return nil, fmt.Errorf("explain: escaneando fila: %w", err)
		}
		parsed = append(parsed, row{id: id, parent: parent, detail: detail})
		rawLines = append(rawLines, detail)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	nodesByID := map[int]*PlanNode{0: {Operation: "QUERY PLAN"}}
	parentByID := map[int]int{}
	for _, r := range parsed {
		nodesByID[r.id] = &PlanNode{
			Operation:  firstWord(r.detail),
			Detail:     r.detail,
			IsFullScan: isSQLiteFullScan(r.detail),
		}
		parentByID[r.id] = r.parent
	}
	for _, r := range parsed {
		parent, ok := nodesByID[parentByID[r.id]]
		if !ok {
			parent = nodesByID[0]
		}
		parent.Children = append(parent.Children, nodesByID[r.id])
	}

	return &Plan{Root: nodesByID[0], RawText: strings.Join(rawLines, "\n")}, nil
}

func firstWord(s string) string {
	fields := strings.Fields(s)
	if len(fields) == 0 {
		return s
	}
	return fields[0]
}

// isSQLiteFullScan reports whether detail describes a full table scan.
// SQLite uses "SCAN" for scans and "SEARCH" for indexed lookups — older
// versions wrote "SCAN TABLE x", modern ones just "SCAN x", so the check
// can't depend on the literal word "TABLE" appearing (a real bug in an
// earlier version of this function — verified against SQLite's actual
// output, not just documentation). A "SCAN x USING INDEX ..."  or "USING
// COVERING INDEX ..." is scanning an index structure, not the raw table, so
// it's excluded.
func isSQLiteFullScan(detail string) bool {
	upper := strings.ToUpper(detail)
	if !strings.HasPrefix(upper, "SCAN") {
		return false
	}
	return !strings.Contains(upper, "USING INDEX") && !strings.Contains(upper, "USING COVERING INDEX")
}
