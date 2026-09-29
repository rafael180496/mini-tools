package export

import (
	"context"
	"database/sql"
	"strings"

	"mini-tools/backend/i18n"
)

// SQLiteTableDDL returns the CREATE TABLE statement for table exactly as
// SQLite stored it in sqlite_master — no reconstruction needed.
func SQLiteTableDDL(ctx context.Context, pool *sql.DB, table string) (string, error) {
	var ddl string
	err := pool.QueryRowContext(ctx, `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, table).Scan(&ddl)
	if err != nil {
		return "", i18n.Errorf(i18n.Msg{ES: "export: leyendo DDL de %q: %w", EN: "export: reading DDL of %q: %w"}, table, err)
	}
	return ddl + ";\n", nil
}

// SQLiteTriggerDDL returns the CREATE TRIGGER statement for trigger exactly
// as SQLite stored it — same pattern as SQLiteTableDDL.
func SQLiteTriggerDDL(ctx context.Context, pool *sql.DB, trigger string) (string, error) {
	var ddl string
	err := pool.QueryRowContext(ctx, `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`, trigger).Scan(&ddl)
	if err != nil {
		return "", i18n.Errorf(i18n.Msg{ES: "export: leyendo DDL de %q: %w", EN: "export: reading DDL of %q: %w"}, trigger, err)
	}
	return ddl + ";\n", nil
}

// SQLiteSchemaDDL returns the CREATE statements for every table/view/index
// in the database, tables first (so views/indexes that depend on them
// don't fail if replayed in order).
func SQLiteSchemaDDL(ctx context.Context, pool *sql.DB) (string, error) {
	rows, err := pool.QueryContext(ctx, `
		SELECT sql FROM sqlite_master
		WHERE sql IS NOT NULL
		ORDER BY CASE type WHEN 'table' THEN 1 WHEN 'view' THEN 2 WHEN 'index' THEN 3 ELSE 4 END, name
	`)
	if err != nil {
		return "", i18n.Errorf(i18n.Msg{ES: "export: leyendo DDL del schema: %w", EN: "export: reading schema DDL: %w"}, err)
	}
	defer rows.Close()

	var b strings.Builder
	for rows.Next() {
		var ddl string
		if err := rows.Scan(&ddl); err != nil {
			return "", i18n.Errorf(i18n.Msg{ES: "export: escaneando DDL: %w", EN: "export: scanning DDL: %w"}, err)
		}
		b.WriteString(ddl)
		b.WriteString(";\n\n")
	}
	return b.String(), rows.Err()
}
