package export

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// PostgresTableDDL reconstructs a CREATE TABLE statement from
// information_schema (columns + primary key + foreign keys). This is a
// reasonable approximation, not a full pg_dump — it does not reproduce
// check constraints, non-PK unique constraints, custom types,
// partitioning, or storage parameters. Not verified against a real
// Postgres instance for every type combination.
func PostgresTableDDL(ctx context.Context, pool *sql.DB, schema, table string) (string, error) {
	rows, err := pool.QueryContext(ctx, `
		SELECT column_name, data_type, is_nullable, column_default,
		       character_maximum_length, numeric_precision, numeric_scale
		FROM information_schema.columns
		WHERE table_schema = $1 AND table_name = $2
		ORDER BY ordinal_position
	`, schema, table)
	if err != nil {
		return "", fmt.Errorf("export: leyendo columnas de %q: %w", table, err)
	}

	type colInfo struct {
		name, dtype, nullable string
		def                   sql.NullString
		charLen               sql.NullInt64
		numPrec, numScale     sql.NullInt64
	}
	var cols []colInfo
	for rows.Next() {
		var c colInfo
		if err := rows.Scan(&c.name, &c.dtype, &c.nullable, &c.def, &c.charLen, &c.numPrec, &c.numScale); err != nil {
			rows.Close()
			return "", fmt.Errorf("export: escaneando columna: %w", err)
		}
		cols = append(cols, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return "", err
	}
	if len(cols) == 0 {
		return "", fmt.Errorf("export: tabla %q no encontrada en schema %q", table, schema)
	}

	var pk []string
	pkRows, err := pool.QueryContext(ctx, `
		SELECT kcu.column_name
		FROM information_schema.table_constraints tc
		JOIN information_schema.key_column_usage kcu
			ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
		WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2
		ORDER BY kcu.ordinal_position
	`, schema, table)
	if err != nil {
		return "", fmt.Errorf("export: leyendo primary key de %q: %w", table, err)
	}
	for pkRows.Next() {
		var c string
		if err := pkRows.Scan(&c); err != nil {
			pkRows.Close()
			return "", fmt.Errorf("export: escaneando primary key: %w", err)
		}
		pk = append(pk, c)
	}
	pkRows.Close()
	if err := pkRows.Err(); err != nil {
		return "", err
	}

	type fkInfo struct {
		column, refTable, refColumn string
	}
	var fks []fkInfo
	fkRows, err := pool.QueryContext(ctx, `
		SELECT kcu.column_name, ccu.table_name, ccu.column_name
		FROM information_schema.table_constraints tc
		JOIN information_schema.key_column_usage kcu
			ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
		JOIN information_schema.constraint_column_usage ccu
			ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
		WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2
	`, schema, table)
	if err != nil {
		return "", fmt.Errorf("export: leyendo foreign keys de %q: %w", table, err)
	}
	for fkRows.Next() {
		var f fkInfo
		if err := fkRows.Scan(&f.column, &f.refTable, &f.refColumn); err != nil {
			fkRows.Close()
			return "", fmt.Errorf("export: escaneando foreign key: %w", err)
		}
		fks = append(fks, f)
	}
	fkRows.Close()
	if err := fkRows.Err(); err != nil {
		return "", err
	}

	var b strings.Builder
	fmt.Fprintf(&b, "CREATE TABLE %s.%s (\n", quoteIdent(schema), quoteIdent(table))
	for i, c := range cols {
		fmt.Fprintf(&b, "  %s %s", quoteIdent(c.name), formatPostgresType(c.dtype, c.charLen, c.numPrec, c.numScale))
		if c.nullable == "NO" {
			b.WriteString(" NOT NULL")
		}
		if c.def.Valid {
			fmt.Fprintf(&b, " DEFAULT %s", c.def.String)
		}
		if i < len(cols)-1 || len(pk) > 0 || len(fks) > 0 {
			b.WriteString(",")
		}
		b.WriteString("\n")
	}
	if len(pk) > 0 {
		fmt.Fprintf(&b, "  PRIMARY KEY (%s)", strings.Join(quoteIdents(pk), ", "))
		if len(fks) > 0 {
			b.WriteString(",")
		}
		b.WriteString("\n")
	}
	for i, fk := range fks {
		fmt.Fprintf(&b, "  FOREIGN KEY (%s) REFERENCES %s.%s (%s)",
			quoteIdent(fk.column), quoteIdent(schema), quoteIdent(fk.refTable), quoteIdent(fk.refColumn))
		if i < len(fks)-1 {
			b.WriteString(",")
		}
		b.WriteString("\n")
	}
	b.WriteString(");\n")

	return b.String(), nil
}

// PostgresSchemaDDL concatenates PostgresTableDDL for every table in schema.
func PostgresSchemaDDL(ctx context.Context, pool *sql.DB, schema string) (string, error) {
	rows, err := pool.QueryContext(ctx, `
		SELECT table_name FROM information_schema.tables
		WHERE table_schema = $1 AND table_type = 'BASE TABLE'
		ORDER BY table_name
	`, schema)
	if err != nil {
		return "", fmt.Errorf("export: listando tablas del schema: %w", err)
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
		ddl, err := PostgresTableDDL(ctx, pool, schema, name)
		if err != nil {
			return "", err
		}
		b.WriteString(ddl)
		b.WriteString("\n")
	}
	return b.String(), nil
}

// PostgresFunctionDDL returns a function or procedure's full
// CREATE-statement text via the built-in pg_get_functiondef — unlike
// PostgresTableDDL, no hand reconstruction needed, Postgres exposes this
// directly. oid (not schema+name) identifies the object because Postgres
// allows overloading — the same name can have multiple signatures, only
// the oid is unambiguous (see db.Function/db.Procedure's OID field).
func PostgresFunctionDDL(ctx context.Context, pool *sql.DB, oid int64) (string, error) {
	var ddl string
	err := pool.QueryRowContext(ctx, `SELECT pg_get_functiondef($1)`, oid).Scan(&ddl)
	if err != nil {
		return "", fmt.Errorf("export: leyendo DDL de la función/procedure: %w", err)
	}
	return ddl + ";\n", nil
}

// PostgresTriggerDDL returns a trigger's CREATE TRIGGER statement via the
// built-in pg_get_triggerdef. Same oid-not-name reasoning as
// PostgresFunctionDDL — trigger names are only unique per-table, not
// globally, so the oid is the simplest unambiguous key.
func PostgresTriggerDDL(ctx context.Context, pool *sql.DB, oid int64) (string, error) {
	var ddl string
	err := pool.QueryRowContext(ctx, `SELECT pg_get_triggerdef($1, true)`, oid).Scan(&ddl)
	if err != nil {
		return "", fmt.Errorf("export: leyendo DDL del trigger: %w", err)
	}
	return ddl + ";\n", nil
}

func formatPostgresType(dtype string, charLen, numPrec, numScale sql.NullInt64) string {
	switch dtype {
	case "character varying":
		if charLen.Valid {
			return fmt.Sprintf("VARCHAR(%d)", charLen.Int64)
		}
		return "VARCHAR"
	case "character":
		if charLen.Valid {
			return fmt.Sprintf("CHAR(%d)", charLen.Int64)
		}
		return "CHAR"
	case "numeric":
		if numPrec.Valid && numScale.Valid {
			return fmt.Sprintf("NUMERIC(%d,%d)", numPrec.Int64, numScale.Int64)
		}
		return "NUMERIC"
	default:
		return strings.ToUpper(dtype)
	}
}
