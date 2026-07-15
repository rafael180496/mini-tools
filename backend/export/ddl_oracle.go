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

// OracleProcedureDDL/OracleFunctionDDL/OracleTriggerDDL are OracleTableDDL's
// siblings for the other object types GET_DDL supports — same stateless
// single-call pattern (GET_DDL has no session-state dependency the way
// DBMS_OUTPUT does, so no reserved *sql.Conn is needed here, plain
// pool.QueryRowContext is enough).
func OracleProcedureDDL(ctx context.Context, pool *sql.DB, name string) (string, error) {
	var ddl string
	err := pool.QueryRowContext(ctx, `SELECT DBMS_METADATA.GET_DDL('PROCEDURE', :1) FROM DUAL`, name).Scan(&ddl)
	if err != nil {
		return "", fmt.Errorf("export: leyendo DDL de %q: %w", name, err)
	}
	return ddl, nil
}

func OracleFunctionDDL(ctx context.Context, pool *sql.DB, name string) (string, error) {
	var ddl string
	err := pool.QueryRowContext(ctx, `SELECT DBMS_METADATA.GET_DDL('FUNCTION', :1) FROM DUAL`, name).Scan(&ddl)
	if err != nil {
		return "", fmt.Errorf("export: leyendo DDL de %q: %w", name, err)
	}
	return ddl, nil
}

func OracleTriggerDDL(ctx context.Context, pool *sql.DB, name string) (string, error) {
	var ddl string
	err := pool.QueryRowContext(ctx, `SELECT DBMS_METADATA.GET_DDL('TRIGGER', :1) FROM DUAL`, name).Scan(&ddl)
	if err != nil {
		return "", fmt.Errorf("export: leyendo DDL de %q: %w", name, err)
	}
	return ddl, nil
}

// OraclePackageDDL concatenates the package spec and body — a package's
// full definition usually needs both to be useful. The body is optional
// (a spec-only package is valid Oracle), so a failure fetching
// PACKAGE_BODY isn't a hard error, it just falls back to the spec alone.
func OraclePackageDDL(ctx context.Context, pool *sql.DB, name string) (string, error) {
	var spec string
	if err := pool.QueryRowContext(ctx, `SELECT DBMS_METADATA.GET_DDL('PACKAGE', :1) FROM DUAL`, name).Scan(&spec); err != nil {
		return "", fmt.Errorf("export: leyendo DDL de %q: %w", name, err)
	}

	var body string
	if err := pool.QueryRowContext(ctx, `SELECT DBMS_METADATA.GET_DDL('PACKAGE_BODY', :1) FROM DUAL`, name).Scan(&body); err != nil {
		return spec, nil
	}
	return spec + "\n\n" + body, nil
}
