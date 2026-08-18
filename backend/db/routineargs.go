package db

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"strings"
)

// This file answers one question the rest of the catalog scan deliberately
// left open: what does calling this routine actually require? Listing a
// procedure's name is enough to draw a sidebar node, but not enough to help
// anyone call it — that needs the parameter list, its order, its types and
// which arguments are OUT. Every engine keeps that in a different catalog
// (ALL_ARGUMENTS, pg_proc's parallel arrays, sys.parameters), so each gets
// its own fetch here and they all land in the same RoutineArg shape.
//
// The whole pass is enrichment, never a precondition: attachRoutineArgs
// reports its error but FetchSchemaMetadata deliberately swallows it. A
// connection whose user can read ALL_OBJECTS but not ALL_ARGUMENTS must
// still get the tree and the table/column completion it got before this
// existed, just without signatures.

// Mode values for RoutineArg. Kept as plain strings rather than a typed
// enum because they cross the Wails bridge into TypeScript, where the
// frontend compares them literally.
const (
	ArgModeIn    = "IN"
	ArgModeOut   = "OUT"
	ArgModeInOut = "INOUT"
)

// attachRoutineArgs fills in the Args (and, where the engine has one, the
// Comment) of every routine already listed in meta. It mutates meta in
// place rather than returning a new one: the routines were listed by the
// engine-specific scan and this only adds detail to them.
func attachRoutineArgs(ctx context.Context, pool *sql.DB, dbType DBType, schemas []string, meta *SchemaMetadata) error {
	if meta == nil {
		return nil
	}
	switch dbType {
	case DBTypeOracle:
		return attachOracleRoutineArgs(ctx, pool, schemas, meta)
	case DBTypePostgres:
		return attachPostgresRoutineArgs(ctx, pool, schemas, meta)
	case DBTypeSQLServer:
		return attachSQLServerRoutineArgs(ctx, pool, schemas, meta)
	default:
		// SQLite has no stored routines at all — nothing to enrich, and
		// this is not an error.
		return nil
	}
}

// routineKey identifies a routine across the two halves of the scan (the
// listing pass and this one). Overload is part of the key because Oracle
// packages and Postgres both allow the same name to be declared more than
// once with different parameter lists.
type routineKey struct {
	schema   string
	pkg      string
	name     string
	overload string
}

func newRoutineKey(schema, pkg, name, overload string) routineKey {
	return routineKey{
		schema:   strings.ToUpper(strings.TrimSpace(schema)),
		pkg:      strings.ToUpper(strings.TrimSpace(pkg)),
		name:     strings.ToUpper(strings.TrimSpace(name)),
		overload: strings.TrimSpace(overload),
	}
}

// --- Oracle -----------------------------------------------------------------

// attachOracleRoutineArgs reads ALL_ARGUMENTS (or USER_ARGUMENTS when the
// connection is not owner-scoped, mirroring the split the listing pass
// already makes) and additionally discovers package members, which the
// listing pass never enumerates: it stops at the package name.
//
// DATA_LEVEL = 0 restricts the scan to top-level parameters. A parameter of
// a record or collection type also has rows at level 1+ for each of its
// fields, and folding those into the signature would render
// `P_REC.FIELD_A` as if it were an argument of its own.
func attachOracleRoutineArgs(ctx context.Context, pool *sql.DB, schemas []string, meta *SchemaMetadata) error {
	var (
		query string
		args  []interface{}
	)
	if len(schemas) == 0 {
		query = `
			SELECT NULL, package_name, object_name, overload, argument_name, position,
			       data_type, in_out, defaulted, data_length, data_precision, data_scale
			FROM user_arguments
			WHERE data_level = 0
			ORDER BY package_name, object_name, overload, position
		`
	} else {
		filter, filterArgs := oracleSchemaFilterClause("owner", schemas, 1)
		query = fmt.Sprintf(`
			SELECT owner, package_name, object_name, overload, argument_name, position,
			       data_type, in_out, defaulted, data_length, data_precision, data_scale
			FROM all_arguments
			WHERE data_level = 0
			%s
			ORDER BY owner, package_name, object_name, overload, position
		`, filter)
		args = filterArgs
	}

	rows, err := pool.QueryContext(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("db: listando argumentos de rutinas oracle: %w", err)
	}
	defer rows.Close()

	byRoutine := map[routineKey][]RoutineArg{}
	returnTypes := map[routineKey]string{}

	for rows.Next() {
		var owner, pkg, argName, dataType, inOut, defaulted, overload sql.NullString
		var objectName string
		var position sql.NullInt64
		var dataLength, precision, scale sql.NullInt64
		if err := rows.Scan(&owner, &pkg, &objectName, &overload, &argName, &position,
			&dataType, &inOut, &defaulted, &dataLength, &precision, &scale); err != nil {
			return fmt.Errorf("db: escaneando argumento de rutina oracle: %w", err)
		}

		key := newRoutineKey(owner.String, pkg.String, objectName, overload.String)
		typeText := oracleTypeString(dataType.String, dataLength, precision, scale)

		// POSITION 0 is the function's return slot, not a parameter: it is
		// what says "this is a function, and it gives back a NUMBER".
		if position.Valid && position.Int64 == 0 {
			returnTypes[key] = typeText
			continue
		}

		byRoutine[key] = append(byRoutine[key], RoutineArg{
			Name:       argName.String,
			DataType:   typeText,
			Mode:       oracleArgMode(inOut.String),
			HasDefault: strings.EqualFold(strings.TrimSpace(defaulted.String), "Y"),
		})
	}
	if err := rows.Err(); err != nil {
		return err
	}

	// Standalone routines: match what the listing pass already found.
	for i := range meta.Procedures {
		p := &meta.Procedures[i]
		key := newRoutineKey(p.Schema, "", p.Name, "")
		p.Args = byRoutine[key]
	}
	for i := range meta.Functions {
		f := &meta.Functions[i]
		key := newRoutineKey(f.Schema, "", f.Name, "")
		f.Args = byRoutine[key]
		if f.ReturnType == "" {
			f.ReturnType = returnTypes[key]
		}
	}

	// Package members are discovered here and nowhere else. ALL_ARGUMENTS
	// only knows the members that declare at least one parameter, so the
	// member list itself comes from ALL_PROCEDURES; a zero-argument member
	// would otherwise be invisible.
	members, err := fetchOraclePackageMembers(ctx, pool, schemas)
	if err != nil {
		return err
	}
	for i := range meta.Packages {
		pkg := &meta.Packages[i]
		for _, m := range members[newRoutineKey(pkg.Schema, "", pkg.Name, "")] {
			key := newRoutineKey(pkg.Schema, pkg.Name, m.Name, m.Overload)
			m.Args = byRoutine[key]
			if ret, ok := returnTypes[key]; ok {
				m.IsFunction = true
				m.ReturnType = ret
			}
			pkg.Members = append(pkg.Members, m)
		}
	}

	return nil
}

// fetchOraclePackageMembers lists the procedures and functions each package
// declares, keyed by the package's own routineKey. Returned as a map rather
// than a slice because the caller walks meta.Packages, not the query order.
func fetchOraclePackageMembers(ctx context.Context, pool *sql.DB, schemas []string) (map[routineKey][]PackageMember, error) {
	var (
		query string
		args  []interface{}
	)
	if len(schemas) == 0 {
		query = `
			SELECT NULL, object_name, procedure_name, overload
			FROM user_procedures
			WHERE procedure_name IS NOT NULL
			ORDER BY object_name, procedure_name, overload
		`
	} else {
		filter, filterArgs := oracleSchemaFilterClause("owner", schemas, 1)
		query = fmt.Sprintf(`
			SELECT owner, object_name, procedure_name, overload
			FROM all_procedures
			WHERE procedure_name IS NOT NULL
			%s
			ORDER BY owner, object_name, procedure_name, overload
		`, filter)
		args = filterArgs
	}

	rows, err := pool.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("db: listando miembros de packages oracle: %w", err)
	}
	defer rows.Close()

	out := map[routineKey][]PackageMember{}
	for rows.Next() {
		var owner, overload sql.NullString
		var pkgName, memberName string
		if err := rows.Scan(&owner, &pkgName, &memberName, &overload); err != nil {
			return nil, fmt.Errorf("db: escaneando miembro de package oracle: %w", err)
		}
		key := newRoutineKey(owner.String, "", pkgName, "")
		out[key] = append(out[key], PackageMember{Name: memberName, Overload: strings.TrimSpace(overload.String)})
	}
	return out, rows.Err()
}

// oracleArgMode maps ALL_ARGUMENTS.IN_OUT ("IN", "OUT", "IN/OUT") onto the
// shared mode vocabulary.
func oracleArgMode(inOut string) string {
	switch strings.ToUpper(strings.TrimSpace(inOut)) {
	case "OUT":
		return ArgModeOut
	case "IN/OUT", "INOUT":
		return ArgModeInOut
	default:
		return ArgModeIn
	}
}

// oracleTypeString rebuilds the declared type the way the DDL spells it.
// The catalog splits length/precision/scale into separate columns, and a
// bare "NUMBER" or "VARCHAR2" in a signature hides exactly the detail a
// caller is looking for.
func oracleTypeString(dataType string, length, precision, scale sql.NullInt64) string {
	t := strings.TrimSpace(dataType)
	if t == "" {
		return ""
	}
	switch strings.ToUpper(t) {
	case "VARCHAR2", "NVARCHAR2", "CHAR", "NCHAR", "RAW":
		if length.Valid && length.Int64 > 0 {
			return t + "(" + strconv.FormatInt(length.Int64, 10) + ")"
		}
	case "NUMBER":
		if precision.Valid && precision.Int64 > 0 {
			if scale.Valid && scale.Int64 > 0 {
				return t + "(" + strconv.FormatInt(precision.Int64, 10) + "," + strconv.FormatInt(scale.Int64, 10) + ")"
			}
			return t + "(" + strconv.FormatInt(precision.Int64, 10) + ")"
		}
	}
	return t
}

// --- PostgreSQL -------------------------------------------------------------

// attachPostgresRoutineArgs reads the parameter list straight out of
// pg_proc's parallel arrays, unnested server-side so each argument arrives
// as its own row.
//
// Why not pg_get_function_arguments, which returns the whole signature
// pre-formatted: that string cannot be parsed back reliably. "character
// varying, integer" is two unnamed arguments while "p_name text" is one
// named argument, and nothing in the text distinguishes a leading type word
// from a leading parameter name. The arrays keep names and types apart, so
// no guessing is needed.
//
// The LEFT JOIN LATERAL is what lets a zero-argument routine still produce
// a row — that row carries the routine's COMMENT ON, which would otherwise
// need a second query.
func attachPostgresRoutineArgs(ctx context.Context, pool *sql.DB, schemas []string, meta *SchemaMetadata) error {
	filter, args := schemaFilterClause("n.nspname", schemas, 1)
	rows, err := pool.QueryContext(ctx, fmt.Sprintf(`
		SELECT p.oid,
		       a.ordinality,
		       COALESCE(p.proargnames[a.ordinality], ''),
		       CASE WHEN a.argtype IS NULL THEN '' ELSE pg_catalog.format_type(a.argtype, NULL) END,
		       COALESCE(p.proargmodes[a.ordinality]::text, 'i'),
		       p.pronargdefaults,
		       COALESCE(pg_catalog.obj_description(p.oid, 'pg_proc'), '')
		FROM pg_proc p
		JOIN pg_namespace n ON n.oid = p.pronamespace
		LEFT JOIN LATERAL unnest(COALESCE(p.proallargtypes, p.proargtypes::oid[]))
			WITH ORDINALITY AS a(argtype, ordinality) ON true
		WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
			AND n.nspname NOT LIKE 'pg\_%%' ESCAPE '\'
			AND p.prokind IN ('f', 'p')
		%s
		ORDER BY p.oid, a.ordinality
	`, filter), args...)
	if err != nil {
		return fmt.Errorf("db: listando argumentos de rutinas postgres: %w", err)
	}
	defer rows.Close()

	type pgRoutine struct {
		args        []RoutineArg
		numDefaults int
		comment     string
	}
	byOID := map[int64]*pgRoutine{}

	for rows.Next() {
		var oid int64
		var ordinality sql.NullInt64
		var name, typeText, mode, comment string
		var numDefaults int
		if err := rows.Scan(&oid, &ordinality, &name, &typeText, &mode, &numDefaults, &comment); err != nil {
			return fmt.Errorf("db: escaneando argumento de rutina postgres: %w", err)
		}
		r, ok := byOID[oid]
		if !ok {
			r = &pgRoutine{numDefaults: numDefaults, comment: comment}
			byOID[oid] = r
		}
		if !ordinality.Valid || typeText == "" {
			// The synthetic row of a zero-argument routine: it exists only
			// to carry the comment, already captured above.
			continue
		}
		r.args = append(r.args, RoutineArg{
			Name:     name,
			DataType: typeText,
			Mode:     postgresArgMode(mode),
		})
	}
	if err := rows.Err(); err != nil {
		return err
	}

	// pronargdefaults counts the *trailing input* arguments that have a
	// DEFAULT. OUT arguments are interleaved in proallargtypes but never
	// take one, so the count has to be applied walking the input arguments
	// backwards rather than the whole list.
	for _, r := range byOID {
		remaining := r.numDefaults
		for i := len(r.args) - 1; i >= 0 && remaining > 0; i-- {
			if r.args[i].Mode == ArgModeOut {
				continue
			}
			r.args[i].HasDefault = true
			remaining--
		}
	}

	for i := range meta.Procedures {
		if r, ok := byOID[meta.Procedures[i].OID]; ok {
			meta.Procedures[i].Args = r.args
			meta.Procedures[i].Comment = r.comment
		}
	}
	for i := range meta.Functions {
		if r, ok := byOID[meta.Functions[i].OID]; ok {
			meta.Functions[i].Args = r.args
			meta.Functions[i].Comment = r.comment
		}
	}
	return nil
}

// postgresArgMode maps pg_proc.proargmodes' single-character codes. 't'
// (a TABLE column of a set-returning function) is reported as OUT: from a
// caller's side it behaves the same way — something the routine returns
// rather than something to supply.
func postgresArgMode(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "o", "t":
		return ArgModeOut
	case "b":
		return ArgModeInOut
	case "v":
		return "VARIADIC"
	default:
		return ArgModeIn
	}
}

// --- SQL Server -------------------------------------------------------------

// attachSQLServerRoutineArgs reads sys.parameters. Unlike Oracle and
// Postgres, SQL Server has no routine overloading, so (schema, name) is
// already a unique key and no overload discriminator is needed.
func attachSQLServerRoutineArgs(ctx context.Context, pool *sql.DB, schemas []string, meta *SchemaMetadata) error {
	filter, args := sqlserverSchemaFilterClause("s.name", schemas, 1)
	rows, err := pool.QueryContext(ctx, fmt.Sprintf(`
		SELECT s.name, o.name, p.name, TYPE_NAME(p.user_type_id), p.max_length,
		       p.precision, p.scale, p.is_output, p.has_default_value, p.parameter_id
		FROM sys.parameters p
		JOIN sys.objects o ON o.object_id = p.object_id
		JOIN sys.schemas s ON s.schema_id = o.schema_id
		WHERE o.type IN ('P', 'FN', 'IF', 'TF', 'FS', 'FT')
		%s
		ORDER BY s.name, o.name, p.parameter_id
	`, filter), args...)
	if err != nil {
		return fmt.Errorf("db: listando argumentos de rutinas sqlserver: %w", err)
	}
	defer rows.Close()

	byRoutine := map[routineKey][]RoutineArg{}
	returnTypes := map[routineKey]string{}

	for rows.Next() {
		var schema, object string
		var name, typeName sql.NullString
		var maxLength, precision, scale, parameterID sql.NullInt64
		var isOutput, hasDefault bool
		if err := rows.Scan(&schema, &object, &name, &typeName, &maxLength,
			&precision, &scale, &isOutput, &hasDefault, &parameterID); err != nil {
			return fmt.Errorf("db: escaneando argumento de rutina sqlserver: %w", err)
		}

		key := newRoutineKey(schema, "", object, "")
		typeText := sqlserverTypeString(typeName.String, maxLength, precision, scale)

		// parameter_id 0 is a scalar function's return value, which
		// sys.parameters models as an unnamed OUTPUT parameter.
		if parameterID.Valid && parameterID.Int64 == 0 {
			returnTypes[key] = typeText
			continue
		}

		mode := ArgModeIn
		if isOutput {
			// SQL Server has no pure OUT: an OUTPUT parameter is always
			// readable inside the routine too, so INOUT is the honest mode.
			mode = ArgModeInOut
		}
		byRoutine[key] = append(byRoutine[key], RoutineArg{
			Name:       strings.TrimPrefix(name.String, "@"),
			DataType:   typeText,
			Mode:       mode,
			HasDefault: hasDefault,
		})
	}
	if err := rows.Err(); err != nil {
		return err
	}

	for i := range meta.Procedures {
		p := &meta.Procedures[i]
		p.Args = byRoutine[newRoutineKey(p.Schema, "", p.Name, "")]
	}
	for i := range meta.Functions {
		f := &meta.Functions[i]
		key := newRoutineKey(f.Schema, "", f.Name, "")
		f.Args = byRoutine[key]
		if f.ReturnType == "" {
			f.ReturnType = returnTypes[key]
		}
	}
	return nil
}

// sqlserverTypeString rebuilds the declared type from sys.parameters'
// split columns. max_length is in bytes, so the Unicode types report double
// their declared character count; -1 is the "(max)" declaration.
func sqlserverTypeString(typeName string, maxLength, precision, scale sql.NullInt64) string {
	t := strings.TrimSpace(typeName)
	if t == "" {
		return ""
	}
	lower := strings.ToLower(t)
	switch lower {
	case "varchar", "char", "varbinary", "binary", "nvarchar", "nchar":
		if !maxLength.Valid {
			return t
		}
		if maxLength.Int64 == -1 {
			return t + "(max)"
		}
		n := maxLength.Int64
		if lower == "nvarchar" || lower == "nchar" {
			n /= 2
		}
		return t + "(" + strconv.FormatInt(n, 10) + ")"
	case "decimal", "numeric":
		if precision.Valid && precision.Int64 > 0 {
			s := int64(0)
			if scale.Valid {
				s = scale.Int64
			}
			return t + "(" + strconv.FormatInt(precision.Int64, 10) + "," + strconv.FormatInt(s, 10) + ")"
		}
	}
	return t
}
