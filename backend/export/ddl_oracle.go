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
func OracleTableDDL(ctx context.Context, pool *sql.DB, owner, table string) (string, error) {
	return getDDL(ctx, pool, "TABLE", table, owner)
}

// getDDL corre DBMS_METADATA.GET_DDL para un objeto, con o sin dueño.
//
// **El dueño importa y es lo que faltaba.** Sin el tercer argumento, GET_DDL
// busca el objeto en el esquema de la SESIÓN, así que pedir el DDL de una tabla
// de otro esquema —lo normal cuando uno se conecta con un usuario de aplicación
// y las tablas viven en otro dueño— fallaba con un ORA-31603 diciendo que el
// objeto "no existe", cuando existe y hasta se lo estaba viendo en el árbol.
//
// `owner` vacío conserva el comportamiento anterior (esquema de la sesión), que
// es lo correcto para un motor/consulta que no informa dueño.
func getDDL(ctx context.Context, pool *sql.DB, objectType, name, owner string) (string, error) {
	var ddl string
	var err error
	if owner == "" {
		err = pool.QueryRowContext(ctx, `SELECT DBMS_METADATA.GET_DDL(:1, :2) FROM DUAL`, objectType, name).Scan(&ddl)
	} else {
		err = pool.QueryRowContext(ctx, `SELECT DBMS_METADATA.GET_DDL(:1, :2, :3) FROM DUAL`, objectType, name, owner).Scan(&ddl)
	}
	if err != nil {
		return "", describeDDLError(err, objectType, name, owner)
	}
	return ddl, nil
}

// describeDDLError traduce el error de Oracle a algo accionable.
//
// Un ORA-31603 llega con diez líneas de pila de `SYS.DBMS_METADATA` y termina
// diciendo "object not found", que manda a buscar un nombre mal escrito cuando
// casi siempre el problema es otro: **leer la metadata de un objeto de OTRO
// esquema pide privilegio** (`SELECT_CATALOG_ROLE` o `SELECT ANY DICTIONARY`).
// Con SELECT sobre la tabla alcanza para consultarla y no para pedir su DDL.
func describeDDLError(err error, objectType, name, owner string) error {
	full := name
	if owner != "" {
		full = owner + "." + name
	}
	if strings.Contains(err.Error(), "ORA-31603") {
		return fmt.Errorf(
			"Oracle no deja leer el DDL de %s (%s): o el objeto no existe con ese nombre, "+
				"o el usuario con el que estás conectado no tiene privilegio para leer la metadata de otro esquema "+
				"(hace falta SELECT_CATALOG_ROLE o SELECT ANY DICTIONARY — tener SELECT sobre la tabla no alcanza)",
			full, objectType)
	}
	return fmt.Errorf("export: leyendo DDL de %q: %w", full, err)
}

// OracleSchemaDDL concatena el GET_DDL de todas las tablas de un esquema.
//
// `owner` vacío usa `USER_TABLES` (las del usuario conectado, que era el único
// comportamiento anterior); con dueño usa `ALL_TABLES` filtrando por él —
// exportar "el DDL del esquema" mientras se está mirando OTRO esquema devolvía
// el del usuario conectado sin decir nada, que es el mismo error de fondo que
// el DDL de una tabla ajena.
func OracleSchemaDDL(ctx context.Context, pool *sql.DB, owner string) (string, error) {
	query := `SELECT table_name FROM user_tables ORDER BY table_name`
	args := []any{}
	if owner != "" {
		query = `SELECT table_name FROM all_tables WHERE owner = :1 ORDER BY table_name`
		args = append(args, owner)
	}
	rows, err := pool.QueryContext(ctx, query, args...)
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
		ddl, err := OracleTableDDL(ctx, pool, owner, name)
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
func OracleProcedureDDL(ctx context.Context, pool *sql.DB, owner, name string) (string, error) {
	return getDDL(ctx, pool, "PROCEDURE", name, owner)
}

func OracleFunctionDDL(ctx context.Context, pool *sql.DB, owner, name string) (string, error) {
	return getDDL(ctx, pool, "FUNCTION", name, owner)
}

func OracleTriggerDDL(ctx context.Context, pool *sql.DB, owner, name string) (string, error) {
	return getDDL(ctx, pool, "TRIGGER", name, owner)
}

// OraclePackageDDL concatenates the package spec and body — a package's
// full definition usually needs both to be useful. The body is optional
// (a spec-only package is valid Oracle), so a failure fetching
// PACKAGE_BODY isn't a hard error, it just falls back to the spec alone.
func OraclePackageDDL(ctx context.Context, pool *sql.DB, owner, name string) (string, error) {
	spec, err := getDDL(ctx, pool, "PACKAGE", name, owner)
	if err != nil {
		return "", err
	}
	body, err := getDDL(ctx, pool, "PACKAGE_BODY", name, owner)
	if err != nil {
		return spec, nil
	}
	return spec + "\n\n" + body, nil
}
