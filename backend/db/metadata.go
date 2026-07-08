package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// Column describes one table column, enough for autocomplete and the
// hover tooltip (spec: "tipo columna, nullable, FK").
type Column struct {
	Name         string `json:"name"`
	DataType     string `json:"dataType"`
	Nullable     bool   `json:"nullable"`
	IsPrimaryKey bool   `json:"isPrimaryKey"`
}

// ForeignKey describes one FK relationship on a column.
type ForeignKey struct {
	Column           string `json:"column"`
	ReferencedTable  string `json:"referencedTable"`
	ReferencedColumn string `json:"referencedColumn"`
}

// Table is one table/view with its columns and FKs.
type Table struct {
	Schema      string       `json:"schema,omitempty"`
	Name        string       `json:"name"`
	Columns     []Column     `json:"columns"`
	ForeignKeys []ForeignKey `json:"foreignKeys"`
}

// SchemaMetadata is the unified shape used to populate the sidebar tree and
// Monaco's autocomplete/hover, regardless of engine.
type SchemaMetadata struct {
	Tables []Table `json:"tables"`
}

// FetchSchemaMetadata queries pool for its table/column/FK metadata, using
// the catalog appropriate to dbType. schemas restricts the scan to those
// Postgres schemas or Oracle owners only (nil/empty = every schema/owner
// visible to the connection, the historical default for both); ignored for
// SQLite, which has no equivalent multi-schema catalog to restrict.
func FetchSchemaMetadata(ctx context.Context, pool *sql.DB, dbType DBType, schemas []string) (*SchemaMetadata, error) {
	switch dbType {
	case DBTypeSQLite:
		return fetchSQLiteMetadata(ctx, pool)
	case DBTypePostgres:
		return fetchPostgresMetadata(ctx, pool, schemas)
	case DBTypeOracle:
		return fetchOracleMetadata(ctx, pool, schemas)
	default:
		return nil, fmt.Errorf("db: metadata no soportada para %q", dbType)
	}
}

// ListSchemas returns just the schema/owner names visible to pool — cheap
// even on a catalog with hundreds of schemas, since it never touches
// information_schema.columns/all_tab_columns's full column list (the
// expensive part FetchSchemaMetadata does). Postgres and Oracle; SQLite
// returns an empty slice (nothing to restrict).
func ListSchemas(ctx context.Context, pool *sql.DB, dbType DBType) ([]string, error) {
	switch dbType {
	case DBTypePostgres:
		return listPostgresSchemas(ctx, pool)
	case DBTypeOracle:
		return listOracleSchemas(ctx, pool)
	default:
		return nil, nil
	}
}

func listPostgresSchemas(ctx context.Context, pool *sql.DB) ([]string, error) {
	rows, err := pool.QueryContext(ctx, `
		SELECT schema_name FROM information_schema.schemata
		WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
			AND schema_name NOT LIKE 'pg\_%' ESCAPE '\'
		ORDER BY schema_name
	`)
	if err != nil {
		return nil, fmt.Errorf("db: listando esquemas postgres: %w", err)
	}
	defer rows.Close()

	var schemas []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, fmt.Errorf("db: escaneando esquema postgres: %w", err)
		}
		schemas = append(schemas, s)
	}
	return schemas, rows.Err()
}

// listOracleSchemas lists distinct owners from ALL_TAB_COLUMNS rather than
// ALL_USERS — deliberately: ALL_USERS lists every DB user regardless of
// whether the connected user can see any of their tables, while
// ALL_TAB_COLUMNS is already scoped to what the connection has visibility
// into, so a typical app-level Oracle user (no DBA-style grants) never sees
// SYS/SYSTEM here — no hardcoded system-schema exclude list needed. Caveat:
// a connection with broad grants (e.g. SELECT ANY TABLE) will see Oracle's
// own internal schemas in this list too; accepted rather than maintaining a
// fragile/incomplete exclude list. Not verified against a real Oracle
// instance — see .claude/skills/mini-tools-patterns/SKILL.md.
func listOracleSchemas(ctx context.Context, pool *sql.DB) ([]string, error) {
	rows, err := pool.QueryContext(ctx, `
		SELECT DISTINCT owner FROM all_tab_columns ORDER BY owner
	`)
	if err != nil {
		return nil, fmt.Errorf("db: listando esquemas oracle: %w", err)
	}
	defer rows.Close()

	var schemas []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, fmt.Errorf("db: escaneando esquema oracle: %w", err)
		}
		schemas = append(schemas, s)
	}
	return schemas, rows.Err()
}

// ListSchemasForDSN is ListSchemas for a connection that isn't saved/pooled
// yet — opens a short-lived connection (same pattern as Ping), lists
// schemas, closes. Used by the "which schemas should I scan" picker shown
// in the new-connection dialog right after a successful Test Connection,
// before the connection has a connID to look up a pool for.
func ListSchemasForDSN(ctx context.Context, dbType DBType, dsn string) ([]string, error) {
	if dbType != DBTypePostgres && dbType != DBTypeOracle {
		return nil, nil
	}

	conn, err := sql.Open(dbType.DriverName(), dsn)
	if err != nil {
		return nil, fmt.Errorf("db: abriendo para listar esquemas: %w", err)
	}
	defer conn.Close()

	ctx, cancel := context.WithTimeout(ctx, defaultPingTimeout)
	defer cancel()

	return ListSchemas(ctx, conn, dbType)
}

func fetchSQLiteMetadata(ctx context.Context, pool *sql.DB) (*SchemaMetadata, error) {
	rows, err := pool.QueryContext(ctx, `
		SELECT name FROM sqlite_master
		WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
		ORDER BY name
	`)
	if err != nil {
		return nil, fmt.Errorf("db: listando tablas sqlite: %w", err)
	}

	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return nil, fmt.Errorf("db: leyendo nombre de tabla sqlite: %w", err)
		}
		names = append(names, name)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	tables := make([]Table, 0, len(names))
	for _, name := range names {
		t := Table{Name: name}

		colRows, err := pool.QueryContext(ctx, fmt.Sprintf(`PRAGMA table_info(%q)`, name))
		if err != nil {
			return nil, fmt.Errorf("db: leyendo columnas de %q: %w", name, err)
		}
		for colRows.Next() {
			var cid, notnull, pk int
			var colName, colType string
			var dflt sql.NullString
			if err := colRows.Scan(&cid, &colName, &colType, &notnull, &dflt, &pk); err != nil {
				colRows.Close()
				return nil, fmt.Errorf("db: escaneando columna de %q: %w", name, err)
			}
			t.Columns = append(t.Columns, Column{
				Name: colName, DataType: colType, Nullable: notnull == 0, IsPrimaryKey: pk > 0,
			})
		}
		colRows.Close()

		fkRows, err := pool.QueryContext(ctx, fmt.Sprintf(`PRAGMA foreign_key_list(%q)`, name))
		if err != nil {
			return nil, fmt.Errorf("db: leyendo FKs de %q: %w", name, err)
		}
		for fkRows.Next() {
			var id, seq int
			var refTable, from, to, onUpdate, onDelete, match string
			if err := fkRows.Scan(&id, &seq, &refTable, &from, &to, &onUpdate, &onDelete, &match); err != nil {
				fkRows.Close()
				return nil, fmt.Errorf("db: escaneando FK de %q: %w", name, err)
			}
			t.ForeignKeys = append(t.ForeignKeys, ForeignKey{Column: from, ReferencedTable: refTable, ReferencedColumn: to})
		}
		fkRows.Close()

		tables = append(tables, t)
	}

	return &SchemaMetadata{Tables: tables}, nil
}

// schemaFilterClause builds a "AND <col> IN ($1, $2, ...)" clause plus its
// matching args, for however many placeholders already precede it in the
// query (startAt). Empty schemas means no restriction — returns "" so the
// caller's query runs unfiltered, same as before this feature existed.
func schemaFilterClause(col string, schemas []string, startAt int) (string, []interface{}) {
	if len(schemas) == 0 {
		return "", nil
	}
	placeholders := make([]string, len(schemas))
	args := make([]interface{}, len(schemas))
	for i, s := range schemas {
		placeholders[i] = fmt.Sprintf("$%d", startAt+i)
		args[i] = s
	}
	return fmt.Sprintf("AND %s IN (%s)", col, strings.Join(placeholders, ", ")), args
}

func fetchPostgresMetadata(ctx context.Context, pool *sql.DB, schemas []string) (*SchemaMetadata, error) {
	index := map[string]*Table{}
	var order []string
	key := func(schema, table string) string { return schema + "." + table }

	colFilter, colArgs := schemaFilterClause("table_schema", schemas, 1)
	rows, err := pool.QueryContext(ctx, fmt.Sprintf(`
		SELECT table_schema, table_name, column_name, data_type, is_nullable
		FROM information_schema.columns
		WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
			AND table_schema NOT LIKE 'pg\_%%' ESCAPE '\'
		%s
		ORDER BY table_schema, table_name, ordinal_position
	`, colFilter), colArgs...)
	if err != nil {
		return nil, fmt.Errorf("db: listando columnas postgres: %w", err)
	}
	for rows.Next() {
		var schema, table, col, dtype, nullable string
		if err := rows.Scan(&schema, &table, &col, &dtype, &nullable); err != nil {
			rows.Close()
			return nil, fmt.Errorf("db: escaneando columna postgres: %w", err)
		}
		k := key(schema, table)
		t, ok := index[k]
		if !ok {
			t = &Table{Schema: schema, Name: table}
			index[k] = t
			order = append(order, k)
		}
		t.Columns = append(t.Columns, Column{Name: col, DataType: dtype, Nullable: nullable == "YES"})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	pkFilter, pkArgs := schemaFilterClause("tc.table_schema", schemas, 1)
	pkRows, err := pool.QueryContext(ctx, fmt.Sprintf(`
		SELECT tc.table_schema, tc.table_name, kcu.column_name
		FROM information_schema.table_constraints tc
		JOIN information_schema.key_column_usage kcu
			ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
		WHERE tc.constraint_type = 'PRIMARY KEY'
		%s
	`, pkFilter), pkArgs...)
	if err != nil {
		return nil, fmt.Errorf("db: listando primary keys postgres: %w", err)
	}
	for pkRows.Next() {
		var schema, table, col string
		if err := pkRows.Scan(&schema, &table, &col); err != nil {
			pkRows.Close()
			return nil, fmt.Errorf("db: escaneando primary key postgres: %w", err)
		}
		if t, ok := index[key(schema, table)]; ok {
			for i := range t.Columns {
				if t.Columns[i].Name == col {
					t.Columns[i].IsPrimaryKey = true
				}
			}
		}
	}
	pkRows.Close()

	fkFilter, fkArgs := schemaFilterClause("tc.table_schema", schemas, 1)
	fkRows, err := pool.QueryContext(ctx, fmt.Sprintf(`
		SELECT tc.table_schema, tc.table_name, kcu.column_name, ccu.table_name, ccu.column_name
		FROM information_schema.table_constraints tc
		JOIN information_schema.key_column_usage kcu
			ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
		JOIN information_schema.constraint_column_usage ccu
			ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
		WHERE tc.constraint_type = 'FOREIGN KEY'
		%s
	`, fkFilter), fkArgs...)
	if err != nil {
		return nil, fmt.Errorf("db: listando foreign keys postgres: %w", err)
	}
	for fkRows.Next() {
		var schema, table, col, refTable, refCol string
		if err := fkRows.Scan(&schema, &table, &col, &refTable, &refCol); err != nil {
			fkRows.Close()
			return nil, fmt.Errorf("db: escaneando foreign key postgres: %w", err)
		}
		if t, ok := index[key(schema, table)]; ok {
			t.ForeignKeys = append(t.ForeignKeys, ForeignKey{Column: col, ReferencedTable: refTable, ReferencedColumn: refCol})
		}
	}
	fkRows.Close()

	tables := make([]Table, 0, len(order))
	for _, k := range order {
		tables = append(tables, *index[k])
	}
	return &SchemaMetadata{Tables: tables}, nil
}

// oracleSchemaFilterClause is schemaFilterClause's Oracle counterpart: bind
// placeholders are positional (":1", ":2", ...), not "$N" — go-ora/database
// bind params the same way backend/query/dbmsoutput.go does for
// DBMS_OUTPUT.GET_LINE. Empty schemas means no restriction, same convention.
func oracleSchemaFilterClause(col string, schemas []string, startAt int) (string, []interface{}) {
	if len(schemas) == 0 {
		return "", nil
	}
	placeholders := make([]string, len(schemas))
	args := make([]interface{}, len(schemas))
	for i, s := range schemas {
		placeholders[i] = fmt.Sprintf(":%d", startAt+i)
		args[i] = s
	}
	return fmt.Sprintf("AND %s IN (%s)", col, strings.Join(placeholders, ", ")), args
}

// fetchOracleMetadata uses USER_* catalog views (scoped to the connected
// schema) when schemas is empty — the historical default, and what keeps
// every existing Oracle connection (which has no metadata_schemas saved)
// behaving exactly as before this feature existed. When schemas is
// non-empty, it switches to ALL_* views filtered by OWNER instead, so the
// scan can cover schemas beyond the connected user's own. Not verified
// against a real Oracle instance — see
// .claude/skills/mini-tools-patterns/SKILL.md.
func fetchOracleMetadata(ctx context.Context, pool *sql.DB, schemas []string) (*SchemaMetadata, error) {
	if len(schemas) == 0 {
		return fetchOracleMetadataUnqualified(ctx, pool)
	}
	return fetchOracleMetadataForOwners(ctx, pool, schemas)
}

func fetchOracleMetadataUnqualified(ctx context.Context, pool *sql.DB) (*SchemaMetadata, error) {
	index := map[string]*Table{}
	var order []string

	rows, err := pool.QueryContext(ctx, `
		SELECT table_name, column_name, data_type, nullable
		FROM user_tab_columns
		ORDER BY table_name, column_id
	`)
	if err != nil {
		return nil, fmt.Errorf("db: listando columnas oracle: %w", err)
	}
	for rows.Next() {
		var table, col, dtype, nullable string
		if err := rows.Scan(&table, &col, &dtype, &nullable); err != nil {
			rows.Close()
			return nil, fmt.Errorf("db: escaneando columna oracle: %w", err)
		}
		t, ok := index[table]
		if !ok {
			t = &Table{Name: table}
			index[table] = t
			order = append(order, table)
		}
		t.Columns = append(t.Columns, Column{Name: col, DataType: dtype, Nullable: nullable == "Y"})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	pkRows, err := pool.QueryContext(ctx, `
		SELECT cols.table_name, cols.column_name
		FROM user_constraints cons
		JOIN user_cons_columns cols ON cons.constraint_name = cols.constraint_name
		WHERE cons.constraint_type = 'P'
	`)
	if err != nil {
		return nil, fmt.Errorf("db: listando primary keys oracle: %w", err)
	}
	for pkRows.Next() {
		var table, col string
		if err := pkRows.Scan(&table, &col); err != nil {
			pkRows.Close()
			return nil, fmt.Errorf("db: escaneando primary key oracle: %w", err)
		}
		if t, ok := index[table]; ok {
			for i := range t.Columns {
				if t.Columns[i].Name == col {
					t.Columns[i].IsPrimaryKey = true
				}
			}
		}
	}
	pkRows.Close()

	// Standard Oracle FK->PK column mapping pattern: match the FK
	// constraint's columns to its referenced constraint's columns by
	// position.
	fkRows, err := pool.QueryContext(ctx, `
		SELECT a.table_name, a.column_name, c_pk.table_name, b.column_name
		FROM user_cons_columns a
		JOIN user_constraints c ON a.constraint_name = c.constraint_name
		JOIN user_constraints c_pk ON c.r_constraint_name = c_pk.constraint_name
		JOIN user_cons_columns b ON c_pk.constraint_name = b.constraint_name AND b.position = a.position
		WHERE c.constraint_type = 'R'
	`)
	if err != nil {
		return nil, fmt.Errorf("db: listando foreign keys oracle: %w", err)
	}
	for fkRows.Next() {
		var table, col, refTable, refCol string
		if err := fkRows.Scan(&table, &col, &refTable, &refCol); err != nil {
			fkRows.Close()
			return nil, fmt.Errorf("db: escaneando foreign key oracle: %w", err)
		}
		if t, ok := index[table]; ok {
			t.ForeignKeys = append(t.ForeignKeys, ForeignKey{Column: col, ReferencedTable: refTable, ReferencedColumn: refCol})
		}
	}
	fkRows.Close()

	tables := make([]Table, 0, len(order))
	for _, name := range order {
		tables = append(tables, *index[name])
	}
	return &SchemaMetadata{Tables: tables}, nil
}

func fetchOracleMetadataForOwners(ctx context.Context, pool *sql.DB, schemas []string) (*SchemaMetadata, error) {
	index := map[string]*Table{}
	var order []string
	key := func(owner, table string) string { return owner + "." + table }

	colFilter, colArgs := oracleSchemaFilterClause("owner", schemas, 1)
	rows, err := pool.QueryContext(ctx, fmt.Sprintf(`
		SELECT owner, table_name, column_name, data_type, nullable
		FROM all_tab_columns
		WHERE 1 = 1
		%s
		ORDER BY owner, table_name, column_id
	`, colFilter), colArgs...)
	if err != nil {
		return nil, fmt.Errorf("db: listando columnas oracle: %w", err)
	}
	for rows.Next() {
		var owner, table, col, dtype, nullable string
		if err := rows.Scan(&owner, &table, &col, &dtype, &nullable); err != nil {
			rows.Close()
			return nil, fmt.Errorf("db: escaneando columna oracle: %w", err)
		}
		k := key(owner, table)
		t, ok := index[k]
		if !ok {
			t = &Table{Schema: owner, Name: table}
			index[k] = t
			order = append(order, k)
		}
		t.Columns = append(t.Columns, Column{Name: col, DataType: dtype, Nullable: nullable == "Y"})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	pkFilter, pkArgs := oracleSchemaFilterClause("cons.owner", schemas, 1)
	pkRows, err := pool.QueryContext(ctx, fmt.Sprintf(`
		SELECT cons.owner, cols.table_name, cols.column_name
		FROM all_constraints cons
		JOIN all_cons_columns cols
			ON cons.constraint_name = cols.constraint_name AND cons.owner = cols.owner
		WHERE cons.constraint_type = 'P'
		%s
	`, pkFilter), pkArgs...)
	if err != nil {
		return nil, fmt.Errorf("db: listando primary keys oracle: %w", err)
	}
	for pkRows.Next() {
		var owner, table, col string
		if err := pkRows.Scan(&owner, &table, &col); err != nil {
			pkRows.Close()
			return nil, fmt.Errorf("db: escaneando primary key oracle: %w", err)
		}
		if t, ok := index[key(owner, table)]; ok {
			for i := range t.Columns {
				if t.Columns[i].Name == col {
					t.Columns[i].IsPrimaryKey = true
				}
			}
		}
	}
	pkRows.Close()

	// Same FK->PK column mapping pattern as the unqualified path, with owner
	// added to every join/filter since ALL_* constraint names aren't unique
	// across schemas the way USER_* ones are within a single schema.
	fkFilter, fkArgs := oracleSchemaFilterClause("c.owner", schemas, 1)
	fkRows, err := pool.QueryContext(ctx, fmt.Sprintf(`
		SELECT a.owner, a.table_name, a.column_name, c_pk.owner, c_pk.table_name, b.column_name
		FROM all_cons_columns a
		JOIN all_constraints c ON a.constraint_name = c.constraint_name AND a.owner = c.owner
		JOIN all_constraints c_pk ON c.r_constraint_name = c_pk.constraint_name AND c.r_owner = c_pk.owner
		JOIN all_cons_columns b
			ON c_pk.constraint_name = b.constraint_name AND c_pk.owner = b.owner AND b.position = a.position
		WHERE c.constraint_type = 'R'
		%s
	`, fkFilter), fkArgs...)
	if err != nil {
		return nil, fmt.Errorf("db: listando foreign keys oracle: %w", err)
	}
	for fkRows.Next() {
		var owner, table, col, refOwner, refTable, refCol string
		if err := fkRows.Scan(&owner, &table, &col, &refOwner, &refTable, &refCol); err != nil {
			fkRows.Close()
			return nil, fmt.Errorf("db: escaneando foreign key oracle: %w", err)
		}
		if t, ok := index[key(owner, table)]; ok {
			refName := refTable
			if refOwner != owner {
				refName = refOwner + "." + refTable
			}
			t.ForeignKeys = append(t.ForeignKeys, ForeignKey{Column: col, ReferencedTable: refName, ReferencedColumn: refCol})
		}
	}
	fkRows.Close()

	tables := make([]Table, 0, len(order))
	for _, k := range order {
		tables = append(tables, *index[k])
	}
	return &SchemaMetadata{Tables: tables}, nil
}
