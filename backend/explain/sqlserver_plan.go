package explain

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// SQLServerPlan gets the estimated execution plan via SET SHOWPLAN_ALL ON —
// under that session setting the user's query is NOT executed, it returns the
// plan as a tabular result instead (StmtText/NodeId/Parent/PhysicalOp/... rows).
// Run on a single reserved connection so the SET ON/OFF pair and the query in
// between share one session (same reasoning as OraclePlan's reserved conn).
// The `analyze` flag is accepted for signature parity with the other engines
// but not distinctly honored here — SQL Server's actual-plan mode
// (SET STATISTICS PROFILE ON) executes the query and returns a different column
// layout; supporting it is deferred. Not verified against a real SQL Server
// instance — see .claude/skills/mini-tools-patterns/SKILL.md.
func SQLServerPlan(ctx context.Context, pool *sql.DB, query string, analyze bool) (*Plan, error) {
	_ = analyze

	conn, err := pool.Conn(ctx)
	if err != nil {
		return nil, fmt.Errorf("explain: reservando conexión: %w", err)
	}
	defer conn.Close()

	if _, err := conn.ExecContext(ctx, "SET SHOWPLAN_ALL ON"); err != nil {
		return nil, fmt.Errorf("explain: activando SHOWPLAN_ALL: %w", err)
	}
	defer func() {
		_, _ = conn.ExecContext(context.Background(), "SET SHOWPLAN_ALL OFF")
	}()

	rows, err := conn.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("explain: obteniendo el plan: %w", err)
	}
	defer rows.Close()

	cols, err := rows.Columns()
	if err != nil {
		return nil, fmt.Errorf("explain: leyendo columnas del plan: %w", err)
	}
	colIdx := make(map[string]int, len(cols))
	for i, c := range cols {
		colIdx[strings.ToLower(c)] = i
	}

	type planRow struct {
		nodeID, parent   int64
		hasParent        bool
		stmtText         string
		physicalOp       string
		logicalOp        string
		argument         string
		estimateRows     float64
		totalSubtreeCost float64
	}
	var parsed []planRow
	var rawLines []string

	for rows.Next() {
		scan := make([]interface{}, len(cols))
		holders := make([]interface{}, len(cols))
		for i := range scan {
			holders[i] = &scan[i]
		}
		if err := rows.Scan(holders...); err != nil {
			return nil, fmt.Errorf("explain: escaneando fila del plan: %w", err)
		}

		r := planRow{
			stmtText:         strings.TrimSpace(cellString(scan, colIdx, "stmttext")),
			physicalOp:       cellString(scan, colIdx, "physicalop"),
			logicalOp:        cellString(scan, colIdx, "logicalop"),
			argument:         cellString(scan, colIdx, "argument"),
			estimateRows:     cellFloat(scan, colIdx, "estimaterows"),
			totalSubtreeCost: cellFloat(scan, colIdx, "totalsubtreecost"),
			nodeID:           cellInt(scan, colIdx, "nodeid"),
		}
		if parent, ok := cellIntOK(scan, colIdx, "parent"); ok && parent != 0 {
			r.parent = parent
			r.hasParent = true
		}
		parsed = append(parsed, r)
		line := strings.TrimSpace(strings.Join([]string{r.physicalOp, r.logicalOp, r.argument}, " "))
		if line == "" {
			line = r.stmtText
		}
		rawLines = append(rawLines, line)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(parsed) == 0 {
		return nil, fmt.Errorf("explain: SHOWPLAN_ALL no devolvió filas")
	}

	nodesByID := make(map[int64]*PlanNode, len(parsed))
	for _, r := range parsed {
		// The statement header row has no PhysicalOp — show its (trimmed)
		// statement text as the operation so the root of the tree is labeled.
		op := strings.TrimSpace(r.physicalOp + " " + r.logicalOp)
		if op == "" {
			op = firstLine(r.stmtText)
		}
		nodesByID[r.nodeID] = &PlanNode{
			Operation:  op,
			ObjectName: sqlServerObject(r.argument),
			Cost:       r.totalSubtreeCost,
			Rows:       int64(r.estimateRows),
			Detail:     r.argument,
			Filter:     sqlServerPredicate(r.argument),
			IsFullScan: strings.Contains(r.physicalOp, "Scan") && !strings.Contains(r.physicalOp, "Seek"),
		}
	}

	var root *PlanNode
	for _, r := range parsed {
		node := nodesByID[r.nodeID]
		if r.hasParent {
			if parent, ok := nodesByID[r.parent]; ok {
				parent.Children = append(parent.Children, node)
				continue
			}
		}
		if root == nil {
			root = node
		}
	}

	plan := &Plan{Root: root, RawText: strings.Join(rawLines, "\n")}
	// analyze is always false here: SHOWPLAN_ALL returns the ESTIMATED plan
	// without running the statement (the actual-plan mode, SET STATISTICS
	// PROFILE ON, is still deferred — see this function's doc comment), so
	// there is nothing measured to grade.
	Analyze(plan, "sqlserver", false)
	return plan, nil
}

// sqlServerObject pulls the table out of a SHOWPLAN_ALL Argument, which
// names it as OBJECT:([db].[schema].[table] [alias]). Only the table part
// is kept — that is what a CREATE INDEX has to name.
func sqlServerObject(argument string) string {
	const marker = "OBJECT:("
	i := strings.Index(argument, marker)
	if i < 0 {
		return ""
	}
	rest := argument[i+len(marker):]
	end := strings.IndexAny(rest, "),")
	if end < 0 {
		return ""
	}
	parts := strings.Split(strings.TrimSpace(rest[:end]), ".")
	name := strings.Trim(parts[len(parts)-1], "[] ")
	// "[table] [alias]" — drop the alias, keep the table.
	if sp := strings.IndexByte(name, ' '); sp > 0 {
		name = name[:sp]
	}
	return strings.Trim(name, "[] ")
}

// sqlServerPredicate pulls the WHERE-equivalent out of an Argument, which
// SHOWPLAN_ALL writes as WHERE:(...) — the part an index would remove.
func sqlServerPredicate(argument string) string {
	const marker = "WHERE:("
	i := strings.Index(argument, marker)
	if i < 0 {
		return ""
	}
	rest := argument[i+len(marker):]
	depth := 1
	for j := 0; j < len(rest); j++ {
		switch rest[j] {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return rest[:j]
			}
		}
	}
	return rest
}

// firstLine returns the first non-empty line of s, for labeling the plan's
// statement-header node with something readable rather than a whole query.
func firstLine(s string) string {
	for _, line := range strings.Split(s, "\n") {
		if t := strings.TrimSpace(line); t != "" {
			return t
		}
	}
	return s
}

func cellString(row []interface{}, idx map[string]int, name string) string {
	i, ok := idx[name]
	if !ok || row[i] == nil {
		return ""
	}
	switch v := row[i].(type) {
	case string:
		return v
	case []byte:
		return string(v)
	default:
		return fmt.Sprintf("%v", v)
	}
}

func cellIntOK(row []interface{}, idx map[string]int, name string) (int64, bool) {
	i, ok := idx[name]
	if !ok || row[i] == nil {
		return 0, false
	}
	switch v := row[i].(type) {
	case int64:
		return v, true
	case int32:
		return int64(v), true
	case float64:
		return int64(v), true
	default:
		return 0, false
	}
}

func cellInt(row []interface{}, idx map[string]int, name string) int64 {
	v, _ := cellIntOK(row, idx, name)
	return v
}

func cellFloat(row []interface{}, idx map[string]int, name string) float64 {
	i, ok := idx[name]
	if !ok || row[i] == nil {
		return 0
	}
	switch v := row[i].(type) {
	case float64:
		return v
	case float32:
		return float64(v)
	case int64:
		return float64(v)
	default:
		return 0
	}
}
