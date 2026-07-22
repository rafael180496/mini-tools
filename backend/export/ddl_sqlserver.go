package export

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// SQLServerTableDDL reconstructs a CREATE TABLE statement from
// INFORMATION_SCHEMA (columns + primary key) and sys.foreign_key_columns
// (FKs), same approach as PostgresTableDDL — SQL Server has no built-in
// "get table DDL" function like Oracle's DBMS_METADATA.GET_DDL, so this is a
// reasonable approximation, not sp_help/SSMS-grade scripting: it does not
// reproduce check/unique constraints, defaults beyond the column DEFAULT,
// indexes, identity/computed columns, or filegroup/storage options. Not
// verified against a real SQL Server instance — see
// .claude/skills/mini-tools-patterns/SKILL.md.
func SQLServerTableDDL(ctx context.Context, pool *sql.DB, schema, table string) (string, error) {
	if schema == "" {
		schema = "dbo"
	}

	rows, err := pool.QueryContext(ctx, `
		SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT,
		       CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE
		FROM INFORMATION_SCHEMA.COLUMNS
		WHERE TABLE_SCHEMA = @p1 AND TABLE_NAME = @p2
		ORDER BY ORDINAL_POSITION
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
		SELECT kcu.COLUMN_NAME
		FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
		JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
			ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
		WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_SCHEMA = @p1 AND tc.TABLE_NAME = @p2
		ORDER BY kcu.ORDINAL_POSITION
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
		SELECT cp.name, rt.name, rc.name
		FROM sys.foreign_key_columns fkc
		JOIN sys.tables tp ON fkc.parent_object_id = tp.object_id
		JOIN sys.schemas sch ON tp.schema_id = sch.schema_id
		JOIN sys.columns cp ON fkc.parent_object_id = cp.object_id AND fkc.parent_column_id = cp.column_id
		JOIN sys.tables rt ON fkc.referenced_object_id = rt.object_id
		JOIN sys.columns rc ON fkc.referenced_object_id = rc.object_id AND fkc.referenced_column_id = rc.column_id
		WHERE sch.name = @p1 AND tp.name = @p2
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
	fmt.Fprintf(&b, "CREATE TABLE %s.%s (\n", quoteBracket(schema), quoteBracket(table))
	for i, c := range cols {
		fmt.Fprintf(&b, "  %s %s", quoteBracket(c.name), formatSQLServerType(c.dtype, c.charLen, c.numPrec, c.numScale))
		if c.nullable == "NO" {
			b.WriteString(" NOT NULL")
		} else {
			b.WriteString(" NULL")
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
		fmt.Fprintf(&b, "  PRIMARY KEY (%s)", strings.Join(quoteBrackets(pk), ", "))
		if len(fks) > 0 {
			b.WriteString(",")
		}
		b.WriteString("\n")
	}
	for i, fk := range fks {
		fmt.Fprintf(&b, "  FOREIGN KEY (%s) REFERENCES %s.%s (%s)",
			quoteBracket(fk.column), quoteBracket(schema), quoteBracket(fk.refTable), quoteBracket(fk.refColumn))
		if i < len(fks)-1 {
			b.WriteString(",")
		}
		b.WriteString("\n")
	}
	b.WriteString(");\nGO\n")

	return b.String(), nil
}

// SQLServerSchemaDDL concatenates SQLServerTableDDL for every base table in
// schema.
func SQLServerSchemaDDL(ctx context.Context, pool *sql.DB, schema string) (string, error) {
	if schema == "" {
		schema = "dbo"
	}
	rows, err := pool.QueryContext(ctx, `
		SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
		WHERE TABLE_SCHEMA = @p1 AND TABLE_TYPE = 'BASE TABLE'
		ORDER BY TABLE_NAME
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
		ddl, err := SQLServerTableDDL(ctx, pool, schema, name)
		if err != nil {
			return "", err
		}
		b.WriteString(ddl)
		b.WriteString("\n")
	}
	return b.String(), nil
}

// SQLServerObjectDDL returns the full CREATE text of a stored procedure,
// function, or trigger via the built-in OBJECT_DEFINITION — SQL Server stores
// the original module text and hands it back verbatim, so no reconstruction
// is needed (the sibling of Postgres's pg_get_functiondef and Oracle's
// GET_DDL). schema defaults to dbo. Not verified against a real SQL Server
// instance — see .claude/skills/mini-tools-patterns/SKILL.md.
func SQLServerObjectDDL(ctx context.Context, pool *sql.DB, schema, name string) (string, error) {
	if schema == "" {
		schema = "dbo"
	}
	qualified := fmt.Sprintf("%s.%s", quoteBracket(schema), quoteBracket(name))

	var ddl sql.NullString
	err := pool.QueryRowContext(ctx, `SELECT OBJECT_DEFINITION(OBJECT_ID(@p1))`, qualified).Scan(&ddl)
	if err != nil {
		return "", fmt.Errorf("export: leyendo DDL de %q: %w", name, err)
	}
	if !ddl.Valid {
		return "", fmt.Errorf("export: no se encontró la definición de %q (¿objeto encriptado o inexistente?)", name)
	}
	return ddl.String + "\nGO\n", nil
}

// formatSQLServerType renders a column type from INFORMATION_SCHEMA metadata.
// A length/precision of -1 in SQL Server means MAX (varchar(max) etc.).
func formatSQLServerType(dtype string, charLen, numPrec, numScale sql.NullInt64) string {
	upper := strings.ToUpper(dtype)
	switch dtype {
	case "varchar", "nvarchar", "char", "nchar", "varbinary", "binary":
		if charLen.Valid {
			if charLen.Int64 == -1 {
				return fmt.Sprintf("%s(MAX)", upper)
			}
			return fmt.Sprintf("%s(%d)", upper, charLen.Int64)
		}
		return upper
	case "decimal", "numeric":
		if numPrec.Valid && numScale.Valid {
			return fmt.Sprintf("%s(%d,%d)", upper, numPrec.Int64, numScale.Int64)
		}
		return upper
	default:
		return upper
	}
}
