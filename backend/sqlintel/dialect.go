package sqlintel

import "strings"

// FunctionDef is one built-in function offered by a dialect.
type FunctionDef struct {
	// Name is the bare function name, e.g. "NVL".
	Name string
	// Signature is what the detail line shows, e.g. "NVL(expr, default)".
	Signature string
	// Doc is a one-line explanation, shown in the expanded info panel.
	Doc string
	// Snippet, when set, is what gets inserted instead of the bare name —
	// "${1:…}" placeholder syntax, which @codemirror/autocomplete's
	// snippetCompletion consumes verbatim (same syntax the Redis command
	// snippets already use). Empty means "insert Name()" with the cursor
	// between the parentheses.
	Snippet string
	// Aggregate marks functions that only make sense where aggregation is
	// allowed, so ranking can favour them in HAVING/GROUP BY.
	Aggregate bool
}

// SnippetDef is a full statement template.
type SnippetDef struct {
	Label  string
	Detail string
	Body   string
}

// Dialect is the per-engine catalog: reserved words, built-in functions and
// statement templates. Registering a new engine means adding one file with
// one Register call — nothing in the engine, the parser or the index needs
// to know the list of engines.
//
// MySQL is deliberately absent: the app has no MySQL connector
// (backend/db has sqlite/postgres/oracle/sqlserver), so a MySQL dialect
// would be unreachable. Adding one later is a single new file here plus the
// connector work; nothing else in this package changes.
type Dialect struct {
	// Name matches db.DBType ("oracle", "postgres", "sqlite", "sqlserver").
	Name string
	// Keywords are the reserved words offered as completions. Kept as a
	// dialect concern rather than a shared list because the differences are
	// exactly what a user notices (Oracle has CONNECT BY, SQL Server has
	// TOP, neither has the other's).
	Keywords []string
	// Functions are the engine's built-ins, merged with commonFunctions.
	Functions []FunctionDef
	// Snippets are statement templates, merged with commonSnippets. A
	// dialect-provided snippet with the same Label as a common one replaces
	// it — that is how the upsert template differs per engine (Oracle's
	// MERGE vs. SQLite/Postgres' ON CONFLICT) without a special case in the
	// engine.
	Snippets []SnippetDef
	// QuoteIdent wraps an identifier that needs delimiting.
	QuoteIdent func(string) string
}

var dialects = map[string]*Dialect{}

// Register adds a dialect to the registry. Called from each dialect file's
// init, so importing this package is enough to have every engine available.
func Register(d *Dialect) { dialects[d.Name] = d }

// DialectFor returns the dialect for a db type, falling back to a
// standard-SQL dialect for an unknown or empty engine (which is what an
// editor tab bound to no connection gets).
func DialectFor(dbType string) *Dialect {
	if d, ok := dialects[strings.ToLower(dbType)]; ok {
		return d
	}
	return standardDialect
}

// AllFunctions is the dialect's built-ins merged with the ones every engine
// shares. Computed per call rather than cached: it runs once per completion
// request over a few hundred entries, far below the cost of the IPC hop it
// answers, and caching it would mean invalidating on registry changes.
func (d *Dialect) AllFunctions() []FunctionDef {
	out := make([]FunctionDef, 0, len(commonFunctions)+len(d.Functions))
	out = append(out, commonFunctions...)
	out = append(out, d.Functions...)
	return out
}

// AllKeywords is the dialect's reserved words merged with the shared ones.
// Function looks a built-in up by name, case-insensitively. Used by
// signature help, which has to answer for the dialect's own functions too —
// a user typing NVL( wants the argument list as much as they do for a
// stored routine.
func (d *Dialect) Function(name string) (FunctionDef, bool) {
	for _, f := range d.AllFunctions() {
		if strings.EqualFold(f.Name, name) {
			return f, true
		}
	}
	return FunctionDef{}, false
}

func (d *Dialect) AllKeywords() []string {
	out := make([]string, 0, len(commonKeywords)+len(d.Keywords))
	out = append(out, commonKeywords...)
	out = append(out, d.Keywords...)
	return out
}

// AllSnippets merges the shared templates with the dialect's, letting the
// dialect override by Label (see the Snippets field doc).
func (d *Dialect) AllSnippets() []SnippetDef {
	overridden := make(map[string]bool, len(d.Snippets))
	for _, s := range d.Snippets {
		overridden[s.Label] = true
	}
	out := make([]SnippetDef, 0, len(commonSnippets)+len(d.Snippets))
	for _, s := range commonSnippets {
		if !overridden[s.Label] {
			out = append(out, s)
		}
	}
	return append(out, d.Snippets...)
}

// commonKeywords are the words all four engines share. Dialect-specific
// words live in the dialect files.
var commonKeywords = []string{
	"SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "JOIN",
	"INNER JOIN", "LEFT JOIN", "RIGHT JOIN", "FULL JOIN", "CROSS JOIN", "ON",
	"AS", "AND", "OR", "NOT", "IN", "EXISTS", "BETWEEN", "LIKE", "IS NULL",
	"IS NOT NULL", "DISTINCT", "UNION", "UNION ALL", "INTERSECT", "EXCEPT",
	"INSERT INTO", "VALUES", "UPDATE", "SET", "DELETE FROM", "CREATE TABLE",
	"CREATE VIEW", "CREATE INDEX", "ALTER TABLE", "DROP TABLE", "TRUNCATE TABLE",
	"WITH", "CASE", "WHEN", "THEN", "ELSE", "END", "ASC", "DESC", "PRIMARY KEY",
	"FOREIGN KEY", "REFERENCES", "DEFAULT", "CHECK", "UNIQUE", "COMMIT", "ROLLBACK",
}

// commonFunctions are the built-ins with the same name and meaning in all
// four engines. Anything that differs — even slightly — belongs in a
// dialect file instead, so a suggestion is never valid-looking but wrong.
var commonFunctions = []FunctionDef{
	{Name: "COUNT", Signature: "COUNT(expr)", Doc: "Cantidad de filas.", Snippet: "COUNT(${1:*})", Aggregate: true},
	{Name: "SUM", Signature: "SUM(expr)", Doc: "Suma de los valores.", Aggregate: true},
	{Name: "AVG", Signature: "AVG(expr)", Doc: "Promedio de los valores.", Aggregate: true},
	{Name: "MIN", Signature: "MIN(expr)", Doc: "Valor mínimo.", Aggregate: true},
	{Name: "MAX", Signature: "MAX(expr)", Doc: "Valor máximo.", Aggregate: true},
	{Name: "COALESCE", Signature: "COALESCE(expr, ...)", Doc: "Primer argumento no nulo."},
	{Name: "NULLIF", Signature: "NULLIF(a, b)", Doc: "NULL si a = b, si no a."},
	{Name: "CAST", Signature: "CAST(expr AS tipo)", Doc: "Convierte un valor a otro tipo.", Snippet: "CAST(${1:expr} AS ${2:tipo})"},
	{Name: "UPPER", Signature: "UPPER(texto)", Doc: "Pasa el texto a mayúsculas."},
	{Name: "LOWER", Signature: "LOWER(texto)", Doc: "Pasa el texto a minúsculas."},
	{Name: "TRIM", Signature: "TRIM(texto)", Doc: "Quita espacios de ambos extremos."},
	{Name: "LENGTH", Signature: "LENGTH(texto)", Doc: "Cantidad de caracteres."},
	{Name: "SUBSTR", Signature: "SUBSTR(texto, desde, largo)", Doc: "Subcadena.", Snippet: "SUBSTR(${1:texto}, ${2:1}, ${3:10})"},
	{Name: "REPLACE", Signature: "REPLACE(texto, buscar, reemplazo)", Doc: "Reemplaza todas las ocurrencias."},
	{Name: "ABS", Signature: "ABS(n)", Doc: "Valor absoluto."},
	{Name: "ROUND", Signature: "ROUND(n, decimales)", Doc: "Redondea."},
	{Name: "ROW_NUMBER", Signature: "ROW_NUMBER() OVER (...)", Doc: "Número de fila dentro de la ventana.", Snippet: "ROW_NUMBER() OVER (PARTITION BY ${1:col} ORDER BY ${2:col})"},
	{Name: "RANK", Signature: "RANK() OVER (...)", Doc: "Ranking con huecos.", Snippet: "RANK() OVER (ORDER BY ${1:col})"},
	{Name: "DENSE_RANK", Signature: "DENSE_RANK() OVER (...)", Doc: "Ranking sin huecos.", Snippet: "DENSE_RANK() OVER (ORDER BY ${1:col})"},
}

// commonSnippets are the statement templates whose shape is identical
// across engines. "upsert" and "limit" are NOT here — both differ per
// engine and each dialect defines its own.
var commonSnippets = []SnippetDef{
	{Label: "sel", Detail: "SELECT … FROM …", Body: "SELECT ${1:*}\nFROM ${2:tabla}\nWHERE ${3:condicion};"},
	{Label: "selall", Detail: "SELECT * FROM …", Body: "SELECT * FROM ${1:tabla};"},
	{Label: "ins", Detail: "INSERT INTO … VALUES …", Body: "INSERT INTO ${1:tabla} (${2:columnas})\nVALUES (${3:valores});"},
	{Label: "upd", Detail: "UPDATE … SET … WHERE …", Body: "UPDATE ${1:tabla}\nSET ${2:columna} = ${3:valor}\nWHERE ${4:condicion};"},
	{Label: "del", Detail: "DELETE FROM … WHERE …", Body: "DELETE FROM ${1:tabla}\nWHERE ${2:condicion};"},
	{Label: "join", Detail: "INNER JOIN … ON …", Body: "INNER JOIN ${1:tabla} ${2:alias} ON ${3:condicion}"},
	{Label: "ljoin", Detail: "LEFT JOIN … ON …", Body: "LEFT JOIN ${1:tabla} ${2:alias} ON ${3:condicion}"},
	{Label: "cte", Detail: "WITH … AS (…)", Body: "WITH ${1:nombre} AS (\n    ${2:SELECT 1}\n)\nSELECT * FROM ${1:nombre};"},
	{Label: "case", Detail: "CASE WHEN … THEN … END", Body: "CASE WHEN ${1:condicion} THEN ${2:valor} ELSE ${3:otro} END"},
	{Label: "grp", Detail: "GROUP BY … HAVING …", Body: "GROUP BY ${1:columna}\nHAVING ${2:COUNT(*) > 1}"},
	{Label: "ct", Detail: "CREATE TABLE …", Body: "CREATE TABLE ${1:tabla} (\n    ${2:id} ${3:INTEGER} NOT NULL,\n    PRIMARY KEY (${2:id})\n);"},
	{Label: "inssel", Detail: "INSERT INTO … SELECT … (copiar filas)", Body: "INSERT INTO ${1:destino} (${2:columnas})\nSELECT ${2:columnas}\nFROM ${3:origen}\nWHERE ${4:condicion};"},
	{Label: "exists", Detail: "WHERE EXISTS (subconsulta correlacionada)", Body: "WHERE EXISTS (\n    SELECT 1\n    FROM ${1:otra_tabla} o\n    WHERE o.${2:id} = ${3:t}.${2:id}\n)"},
	{Label: "cnt", Detail: "Contar por grupo y quedarse con los repetidos", Body: "SELECT ${1:columna}, COUNT(*) AS total\nFROM ${2:tabla}\nGROUP BY ${1:columna}\nHAVING COUNT(*) > 1\nORDER BY total DESC;"},
	{Label: "win", Detail: "ROW_NUMBER() OVER (PARTITION BY … ORDER BY …)", Body: "ROW_NUMBER() OVER (PARTITION BY ${1:columna} ORDER BY ${2:fecha} DESC)"},
	{Label: "dedup", Detail: "Quedarse con la última fila de cada grupo", Body: "SELECT *\nFROM (\n    SELECT t.*,\n           ROW_NUMBER() OVER (PARTITION BY ${1:clave} ORDER BY ${2:fecha} DESC) AS rn\n    FROM ${3:tabla} t\n) x\nWHERE rn = 1;"},
	{Label: "ci", Detail: "CREATE INDEX …", Body: "CREATE INDEX ${1:ix_tabla_columna} ON ${2:tabla} (${3:columna});"},
	{Label: "cv", Detail: "CREATE VIEW …", Body: "CREATE VIEW ${1:nombre} AS\nSELECT ${2:*}\nFROM ${3:tabla}\nWHERE ${4:condicion};"},
	{Label: "addcol", Detail: "ALTER TABLE … ADD COLUMN …", Body: "ALTER TABLE ${1:tabla} ADD COLUMN ${2:columna} ${3:VARCHAR(100)};"},

	// Condiciones de WHERE. Son cortas de escribir a mano, pero son las que
	// más se repiten en un día de soporte, y tenerlas acá evita el error de
	// siempre: el IN sin paréntesis, el BETWEEN al revés, el `= NULL`.
	{Label: "in", Detail: "WHERE … IN (…)", Body: "WHERE ${1:columna} IN (${2:valor1, valor2})"},
	{Label: "notin", Detail: "WHERE … NOT IN (…)", Body: "WHERE ${1:columna} NOT IN (${2:valor1, valor2})"},
	{Label: "bet", Detail: "WHERE … BETWEEN … AND …", Body: "WHERE ${1:columna} BETWEEN ${2:desde} AND ${3:hasta}"},
	{Label: "like", Detail: "WHERE … LIKE '%…%'", Body: "WHERE ${1:columna} LIKE '%${2:texto}%'"},
	{Label: "null", Detail: "WHERE … IS NULL", Body: "WHERE ${1:columna} IS NULL"},
	{Label: "notnull", Detail: "WHERE … IS NOT NULL", Body: "WHERE ${1:columna} IS NOT NULL"},

	// El resto de los JOIN. El INNER y el LEFT ya estaban; estos tres son los
	// que uno escribe mal justo cuando los necesita.
	{Label: "rjoin", Detail: "RIGHT JOIN … ON …", Body: "RIGHT JOIN ${1:tabla} ${2:alias} ON ${3:condicion}"},
	{Label: "fjoin", Detail: "FULL OUTER JOIN … ON …", Body: "FULL OUTER JOIN ${1:tabla} ${2:alias} ON ${3:condicion}"},
	{Label: "cjoin", Detail: "CROSS JOIN (producto cartesiano)", Body: "CROSS JOIN ${1:tabla} ${2:alias}"},
	{Label: "sjoin", Detail: "Auto-join: la tabla consigo misma (jerarquías)", Body: "SELECT h.${1:nombre} AS hijo, p.${1:nombre} AS padre\nFROM ${2:tabla} h\nLEFT JOIN ${2:tabla} p ON p.${3:id} = h.${4:id_padre};"},

	{Label: "dist", Detail: "SELECT DISTINCT …", Body: "SELECT DISTINCT ${1:columna}\nFROM ${2:tabla}\nORDER BY ${1:columna};"},
	{Label: "ord", Detail: "ORDER BY … DESC", Body: "ORDER BY ${1:columna} DESC"},
	{Label: "union", Detail: "UNION ALL entre dos consultas", Body: "SELECT ${1:columnas} FROM ${2:tabla_a}\nUNION ALL\nSELECT ${1:columnas} FROM ${3:tabla_b};"},
	{Label: "notex", Detail: "WHERE NOT EXISTS (…) — lo que falta en la otra tabla", Body: "WHERE NOT EXISTS (\n    SELECT 1\n    FROM ${1:otra_tabla} o\n    WHERE o.${2:id} = ${3:t}.${2:id}\n)"},
	{Label: "sub", Detail: "Subconsulta en el FROM (tabla derivada)", Body: "SELECT x.${1:*}\nFROM (\n    SELECT ${2:columnas}\n    FROM ${3:tabla}\n    WHERE ${4:condicion}\n) x;"},
	{Label: "delx", Detail: "DELETE de lo que existe en otra tabla", Body: "DELETE FROM ${1:tabla} t\nWHERE EXISTS (\n    SELECT 1 FROM ${2:otra} o WHERE o.${3:id} = t.${3:id}\n);"},
	{Label: "insmulti", Detail: "INSERT de varias filas de una vez", Body: "INSERT INTO ${1:tabla} (${2:columnas})\nVALUES (${3:fila1}),\n       (${4:fila2});"},

	// Diagnóstico: las tres consultas con las que uno empieza a mirar una
	// tabla que no conoce.
	{Label: "sumif", Detail: "SUM(CASE WHEN …) — contar por condición", Body: "SUM(CASE WHEN ${1:condicion} THEN 1 ELSE 0 END) AS ${2:total}"},
	{Label: "nulls", Detail: "Cuántos nulos tiene una columna", Body: "SELECT COUNT(*) AS filas,\n       COUNT(${1:columna}) AS con_valor,\n       COUNT(*) - COUNT(${1:columna}) AS nulos\nFROM ${2:tabla};"},
	{Label: "minmax", Detail: "Perfil rápido de una columna (min, max, distintos)", Body: "SELECT MIN(${1:columna}) AS minimo,\n       MAX(${1:columna}) AS maximo,\n       COUNT(DISTINCT ${1:columna}) AS distintos,\n       COUNT(*) AS filas\nFROM ${2:tabla};"},

	// DDL de mantenimiento.
	{Label: "trunc", Detail: "TRUNCATE TABLE … (vaciar sin borrar la tabla)", Body: "TRUNCATE TABLE ${1:tabla};"},
	{Label: "dt", Detail: "DROP TABLE …", Body: "DROP TABLE ${1:tabla};"},
	{Label: "dropcol", Detail: "ALTER TABLE … DROP COLUMN …", Body: "ALTER TABLE ${1:tabla} DROP COLUMN ${2:columna};"},
	{Label: "uix", Detail: "CREATE UNIQUE INDEX …", Body: "CREATE UNIQUE INDEX ${1:ux_tabla_columna} ON ${2:tabla} (${3:columna});"},
	{Label: "pk", Detail: "ALTER TABLE … ADD CONSTRAINT … PRIMARY KEY", Body: "ALTER TABLE ${1:tabla}\n    ADD CONSTRAINT ${2:pk_tabla} PRIMARY KEY (${3:columna});"},
	{Label: "fk", Detail: "ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY", Body: "ALTER TABLE ${1:tabla}\n    ADD CONSTRAINT ${2:fk_tabla_otra} FOREIGN KEY (${3:columna})\n    REFERENCES ${4:otra_tabla} (${5:columna});"},
	{Label: "ren", Detail: "Renombrar una tabla", Body: "ALTER TABLE ${1:tabla} RENAME TO ${2:nombre_nuevo};"},
}

// standardDialect backs an editor tab with no connection bound: shared
// keywords, shared functions, shared snippets, nothing engine-specific.
var standardDialect = &Dialect{
	Name:       "",
	QuoteIdent: func(s string) string { return `"` + s + `"` },
}
