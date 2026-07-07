package export

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// OracleTableDDL uses Oracle's built-in DBMS_METADATA.GET_DDL — the
// canonical way to get an accurate CREATE TABLE statement, far more
// complete than hand-reconstructing from catalog views (as Postgres does
// here). Not verified against a real Oracle instance — see
// .claude/skills/mini-tools-patterns/SKILL.md.
func OracleTableDDL(ctx context.Context, pool *sql.DB, table string) (string, error) {
	var ddl string
	err := pool.QueryRowContext(ctx, `SELECT DBMS_METADATA.GET_DDL('TABLE', :1) FROM DUAL`, table).Scan(&ddl)
	if err != nil {
		return "", fmt.Errorf("export: leyendo DDL de %q: %w", table, err)
	}
	return ddl, nil
}

// OracleSchemaDDL concatenates GET_DDL for every table owned by the
// connected user (USER_TABLES — the connected schema's own objects).
func OracleSchemaDDL(ctx context.Context, pool *sql.DB) (string, error) {
	rows, err := pool.QueryContext(ctx, `SELECT table_name FROM user_tables ORDER BY table_name`)
	if err != nil {
		return "", fmt.Errorf("export: listando tablas: %w", err)
	}
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			rows.Close()
			return "", fmt.Errorf("export: escaneando nombre de tabla: %w", err)
		}
		names = append(names, n)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return "", err
	}

	var b strings.Builder
	for _, name := range names {
		ddl, err := OracleTableDDL(ctx, pool, name)
		if err != nil {
			return "", err
		}
		b.WriteString(ddl)
		b.WriteString("\n\n")
	}
	return b.String(), nil
}
