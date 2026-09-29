package sqlintel

import (
	"strings"

	"mini-tools/backend/i18n"
)

// FunctionDef is one built-in function offered by a dialect.
type FunctionDef struct {
	// Name is the bare function name, e.g. "NVL".
	Name string
	// Signature is what the detail line shows, e.g. "NVL(expr, default)".
	Signature string
	// Doc is a one-line explanation, shown in the expanded info panel.
	Doc i18n.Msg
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
	Detail i18n.Msg
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
	{Name: "COUNT", Signature: "COUNT(expr)", Doc: i18n.Msg{ES: "Cantidad de filas.", EN: "Number of rows."}, Snippet: "COUNT(${1:*})", Aggregate: true},
	{Name: "SUM", Signature: "SUM(expr)", Doc: i18n.Msg{ES: "Suma de los valores.", EN: "Sum of the values."}, Aggregate: true},
	{Name: "AVG", Signature: "AVG(expr)", Doc: i18n.Msg{ES: "Promedio de los valores.", EN: "Average of the values."}, Aggregate: true},
	{Name: "MIN", Signature: "MIN(expr)", Doc: i18n.Msg{ES: "Valor mínimo.", EN: "Minimum value."}, Aggregate: true},
	{Name: "MAX", Signature: "MAX(expr)", Doc: i18n.Msg{ES: "Valor máximo.", EN: "Maximum value."}, Aggregate: true},
	{Name: "COALESCE", Signature: "COALESCE(expr, ...)", Doc: i18n.Msg{ES: "Primer argumento no nulo.", EN: "First non-null argument."}},
	{Name: "NULLIF", Signature: "NULLIF(a, b)", Doc: i18n.Msg{ES: "NULL si a = b, si no a.", EN: "NULL if a = b, otherwise a."}},
	{Name: "CAST", Signature: "CAST(expr AS tipo)", Doc: i18n.Msg{ES: "Convierte un valor a otro tipo.", EN: "Converts a value to another type."}, Snippet: "CAST(${1:expr} AS ${2:tipo})"},
	{Name: "UPPER", Signature: "UPPER(texto)", Doc: i18n.Msg{ES: "Pasa el texto a mayúsculas.", EN: "Converts the text to uppercase."}},
	{Name: "LOWER", Signature: "LOWER(texto)", Doc: i18n.Msg{ES: "Pasa el texto a minúsculas.", EN: "Converts the text to lowercase."}},
	{Name: "TRIM", Signature: "TRIM(texto)", Doc: i18n.Msg{ES: "Quita espacios de ambos extremos.", EN: "Removes spaces from both ends."}},
	{Name: "LENGTH", Signature: "LENGTH(texto)", Doc: i18n.Msg{ES: "Cantidad de caracteres.", EN: "Number of characters."}},
	{Name: "SUBSTR", Signature: "SUBSTR(texto, desde, largo)", Doc: i18n.Msg{ES: "Subcadena.", EN: "Substring."}, Snippet: "SUBSTR(${1:texto}, ${2:1}, ${3:10})"},
	{Name: "REPLACE", Signature: "REPLACE(texto, buscar, reemplazo)", Doc: i18n.Msg{ES: "Reemplaza todas las ocurrencias.", EN: "Replaces all occurrences."}},
	{Name: "ABS", Signature: "ABS(n)", Doc: i18n.Msg{ES: "Valor absoluto.", EN: "Absolute value."}},
	{Name: "ROUND", Signature: "ROUND(n, decimales)", Doc: i18n.Msg{ES: "Redondea.", EN: "Rounds."}},
	{Name: "ROW_NUMBER", Signature: "ROW_NUMBER() OVER (...)", Doc: i18n.Msg{ES: "Número de fila dentro de la ventana.", EN: "Row number within the window."}, Snippet: "ROW_NUMBER() OVER (PARTITION BY ${1:col} ORDER BY ${2:col})"},
	{Name: "RANK", Signature: "RANK() OVER (...)", Doc: i18n.Msg{ES: "Ranking con huecos.", EN: "Ranking with gaps."}, Snippet: "RANK() OVER (ORDER BY ${1:col})"},
	{Name: "DENSE_RANK", Signature: "DENSE_RANK() OVER (...)", Doc: i18n.Msg{ES: "Ranking sin huecos.", EN: "Ranking without gaps."}, Snippet: "DENSE_RANK() OVER (ORDER BY ${1:col})"},
}

// commonSnippets are the statement templates whose shape is identical
// across engines. "upsert" and "limit" are NOT here — both differ per
// engine and each dialect defines its own.
var commonSnippets = []SnippetDef{
	{Label: "sel", Detail: i18n.Msg{ES: "SELECT … FROM …", EN: "SELECT … FROM …"}, Body: "SELECT ${1:*}\nFROM ${2:tabla}\nWHERE ${3:condicion};"},
	{Label: "selall", Detail: i18n.Msg{ES: "SELECT * FROM …", EN: "SELECT * FROM …"}, Body: "SELECT * FROM ${1:tabla};"},
	{Label: "ins", Detail: i18n.Msg{ES: "INSERT INTO … VALUES …", EN: "INSERT INTO … VALUES …"}, Body: "INSERT INTO ${1:tabla} (${2:columnas})\nVALUES (${3:valores});"},
	{Label: "upd", Detail: i18n.Msg{ES: "UPDATE … SET … WHERE …", EN: "UPDATE … SET … WHERE …"}, Body: "UPDATE ${1:tabla}\nSET ${2:columna} = ${3:valor}\nWHERE ${4:condicion};"},
	{Label: "del", Detail: i18n.Msg{ES: "DELETE FROM … WHERE …", EN: "DELETE FROM … WHERE …"}, Body: "DELETE FROM ${1:tabla}\nWHERE ${2:condicion};"},
	{Label: "join", Detail: i18n.Msg{ES: "INNER JOIN … ON …", EN: "INNER JOIN … ON …"}, Body: "INNER JOIN ${1:tabla} ${2:alias} ON ${3:condicion}"},
	{Label: "ljoin", Detail: i18n.Msg{ES: "LEFT JOIN … ON …", EN: "LEFT JOIN … ON …"}, Body: "LEFT JOIN ${1:tabla} ${2:alias} ON ${3:condicion}"},
	{Label: "cte", Detail: i18n.Msg{ES: "WITH … AS (…)", EN: "WITH … AS (…)"}, Body: "WITH ${1:nombre} AS (\n    ${2:SELECT 1}\n)\nSELECT * FROM ${1:nombre};"},
	{Label: "case", Detail: i18n.Msg{ES: "CASE WHEN … THEN … END", EN: "CASE WHEN … THEN … END"}, Body: "CASE WHEN ${1:condicion} THEN ${2:valor} ELSE ${3:otro} END"},
	{Label: "grp", Detail: i18n.Msg{ES: "GROUP BY … HAVING …", EN: "GROUP BY … HAVING …"}, Body: "GROUP BY ${1:columna}\nHAVING ${2:COUNT(*) > 1}"},
	{Label: "ct", Detail: i18n.Msg{ES: "CREATE TABLE …", EN: "CREATE TABLE …"}, Body: "CREATE TABLE ${1:tabla} (\n    ${2:id} ${3:INTEGER} NOT NULL,\n    PRIMARY KEY (${2:id})\n);"},
	{Label: "inssel", Detail: i18n.Msg{ES: "INSERT INTO … SELECT … (copiar filas)", EN: "INSERT INTO … SELECT … (copy rows)"}, Body: "INSERT INTO ${1:destino} (${2:columnas})\nSELECT ${2:columnas}\nFROM ${3:origen}\nWHERE ${4:condicion};"},
	{Label: "exists", Detail: i18n.Msg{ES: "WHERE EXISTS (subconsulta correlacionada)", EN: "WHERE EXISTS (correlated subquery)"}, Body: "WHERE EXISTS (\n    SELECT 1\n    FROM ${1:otra_tabla} o\n    WHERE o.${2:id} = ${3:t}.${2:id}\n)"},
	{Label: "cnt", Detail: i18n.Msg{ES: "Contar por grupo y quedarse con los repetidos", EN: "Count per group and keep the duplicates"}, Body: "SELECT ${1:columna}, COUNT(*) AS total\nFROM ${2:tabla}\nGROUP BY ${1:columna}\nHAVING COUNT(*) > 1\nORDER BY total DESC;"},
	{Label: "win", Detail: i18n.Msg{ES: "ROW_NUMBER() OVER (PARTITION BY … ORDER BY …)", EN: "ROW_NUMBER() OVER (PARTITION BY … ORDER BY …)"}, Body: "ROW_NUMBER() OVER (PARTITION BY ${1:columna} ORDER BY ${2:fecha} DESC)"},
	{Label: "dedup", Detail: i18n.Msg{ES: "Quedarse con la última fila de cada grupo", EN: "Keep the latest row of each group"}, Body: "SELECT *\nFROM (\n    SELECT t.*,\n           ROW_NUMBER() OVER (PARTITION BY ${1:clave} ORDER BY ${2:fecha} DESC) AS rn\n    FROM ${3:tabla} t\n) x\nWHERE rn = 1;"},
	{Label: "ci", Detail: i18n.Msg{ES: "CREATE INDEX …", EN: "CREATE INDEX …"}, Body: "CREATE INDEX ${1:ix_tabla_columna} ON ${2:tabla} (${3:columna});"},
	{Label: "cv", Detail: i18n.Msg{ES: "CREATE VIEW …", EN: "CREATE VIEW …"}, Body: "CREATE VIEW ${1:nombre} AS\nSELECT ${2:*}\nFROM ${3:tabla}\nWHERE ${4:condicion};"},
	{Label: "addcol", Detail: i18n.Msg{ES: "ALTER TABLE … ADD COLUMN …", EN: "ALTER TABLE … ADD COLUMN …"}, Body: "ALTER TABLE ${1:tabla} ADD COLUMN ${2:columna} ${3:VARCHAR(100)};"},

	// Condiciones de WHERE. Son cortas de escribir a mano, pero son las que
	// más se repiten en un día de soporte, y tenerlas acá evita el error de
	// siempre: el IN sin paréntesis, el BETWEEN al revés, el `= NULL`.
	{Label: "in", Detail: i18n.Msg{ES: "WHERE … IN (…)", EN: "WHERE … IN (…)"}, Body: "WHERE ${1:columna} IN (${2:valor1, valor2})"},
	{Label: "notin", Detail: i18n.Msg{ES: "WHERE … NOT IN (…)", EN: "WHERE … NOT IN (…)"}, Body: "WHERE ${1:columna} NOT IN (${2:valor1, valor2})"},
	{Label: "bet", Detail: i18n.Msg{ES: "WHERE … BETWEEN … AND …", EN: "WHERE … BETWEEN … AND …"}, Body: "WHERE ${1:columna} BETWEEN ${2:desde} AND ${3:hasta}"},
	{Label: "like", Detail: i18n.Msg{ES: "WHERE … LIKE '%…%'", EN: "WHERE … LIKE '%…%'"}, Body: "WHERE ${1:columna} LIKE '%${2:texto}%'"},
	{Label: "null", Detail: i18n.Msg{ES: "WHERE … IS NULL", EN: "WHERE … IS NULL"}, Body: "WHERE ${1:columna} IS NULL"},
	{Label: "notnull", Detail: i18n.Msg{ES: "WHERE … IS NOT NULL", EN: "WHERE … IS NOT NULL"}, Body: "WHERE ${1:columna} IS NOT NULL"},

	// El resto de los JOIN. El INNER y el LEFT ya estaban; estos tres son los
	// que uno escribe mal justo cuando los necesita.
	{Label: "rjoin", Detail: i18n.Msg{ES: "RIGHT JOIN … ON …", EN: "RIGHT JOIN … ON …"}, Body: "RIGHT JOIN ${1:tabla} ${2:alias} ON ${3:condicion}"},
	{Label: "fjoin", Detail: i18n.Msg{ES: "FULL OUTER JOIN … ON …", EN: "FULL OUTER JOIN … ON …"}, Body: "FULL OUTER JOIN ${1:tabla} ${2:alias} ON ${3:condicion}"},
	{Label: "cjoin", Detail: i18n.Msg{ES: "CROSS JOIN (producto cartesiano)", EN: "CROSS JOIN (cartesian product)"}, Body: "CROSS JOIN ${1:tabla} ${2:alias}"},
	{Label: "sjoin", Detail: i18n.Msg{ES: "Auto-join: la tabla consigo misma (jerarquías)", EN: "Self-join: the table with itself (hierarchies)"}, Body: "SELECT h.${1:nombre} AS hijo, p.${1:nombre} AS padre\nFROM ${2:tabla} h\nLEFT JOIN ${2:tabla} p ON p.${3:id} = h.${4:id_padre};"},

	{Label: "dist", Detail: i18n.Msg{ES: "SELECT DISTINCT …", EN: "SELECT DISTINCT …"}, Body: "SELECT DISTINCT ${1:columna}\nFROM ${2:tabla}\nORDER BY ${1:columna};"},
	{Label: "ord", Detail: i18n.Msg{ES: "ORDER BY … DESC", EN: "ORDER BY … DESC"}, Body: "ORDER BY ${1:columna} DESC"},
	{Label: "union", Detail: i18n.Msg{ES: "UNION ALL entre dos consultas", EN: "UNION ALL between two queries"}, Body: "SELECT ${1:columnas} FROM ${2:tabla_a}\nUNION ALL\nSELECT ${1:columnas} FROM ${3:tabla_b};"},
	{Label: "notex", Detail: i18n.Msg{ES: "WHERE NOT EXISTS (…) — lo que falta en la otra tabla", EN: "WHERE NOT EXISTS (…) — what's missing in the other table"}, Body: "WHERE NOT EXISTS (\n    SELECT 1\n    FROM ${1:otra_tabla} o\n    WHERE o.${2:id} = ${3:t}.${2:id}\n)"},
	{Label: "sub", Detail: i18n.Msg{ES: "Subconsulta en el FROM (tabla derivada)", EN: "Subquery in the FROM (derived table)"}, Body: "SELECT x.${1:*}\nFROM (\n    SELECT ${2:columnas}\n    FROM ${3:tabla}\n    WHERE ${4:condicion}\n) x;"},
	{Label: "delx", Detail: i18n.Msg{ES: "DELETE de lo que existe en otra tabla", EN: "DELETE what exists in another table"}, Body: "DELETE FROM ${1:tabla} t\nWHERE EXISTS (\n    SELECT 1 FROM ${2:otra} o WHERE o.${3:id} = t.${3:id}\n);"},
	{Label: "insmulti", Detail: i18n.Msg{ES: "INSERT de varias filas de una vez", EN: "INSERT several rows at once"}, Body: "INSERT INTO ${1:tabla} (${2:columnas})\nVALUES (${3:fila1}),\n       (${4:fila2});"},

	// Diagnóstico: las tres consultas con las que uno empieza a mirar una
	// tabla que no conoce.
	{Label: "sumif", Detail: i18n.Msg{ES: "SUM(CASE WHEN …) — contar por condición", EN: "SUM(CASE WHEN …) — count by condition"}, Body: "SUM(CASE WHEN ${1:condicion} THEN 1 ELSE 0 END) AS ${2:total}"},
	{Label: "nulls", Detail: i18n.Msg{ES: "Cuántos nulos tiene una columna", EN: "How many nulls a column has"}, Body: "SELECT COUNT(*) AS filas,\n       COUNT(${1:columna}) AS con_valor,\n       COUNT(*) - COUNT(${1:columna}) AS nulos\nFROM ${2:tabla};"},
	{Label: "minmax", Detail: i18n.Msg{ES: "Perfil rápido de una columna (min, max, distintos)", EN: "Quick profile of a column (min, max, distinct)"}, Body: "SELECT MIN(${1:columna}) AS minimo,\n       MAX(${1:columna}) AS maximo,\n       COUNT(DISTINCT ${1:columna}) AS distintos,\n       COUNT(*) AS filas\nFROM ${2:tabla};"},

	// DDL de mantenimiento.
	{Label: "trunc", Detail: i18n.Msg{ES: "TRUNCATE TABLE … (vaciar sin borrar la tabla)", EN: "TRUNCATE TABLE … (empty without dropping the table)"}, Body: "TRUNCATE TABLE ${1:tabla};"},
	{Label: "dt", Detail: i18n.Msg{ES: "DROP TABLE …", EN: "DROP TABLE …"}, Body: "DROP TABLE ${1:tabla};"},
	{Label: "dropcol", Detail: i18n.Msg{ES: "ALTER TABLE … DROP COLUMN …", EN: "ALTER TABLE … DROP COLUMN …"}, Body: "ALTER TABLE ${1:tabla} DROP COLUMN ${2:columna};"},
	{Label: "uix", Detail: i18n.Msg{ES: "CREATE UNIQUE INDEX …", EN: "CREATE UNIQUE INDEX …"}, Body: "CREATE UNIQUE INDEX ${1:ux_tabla_columna} ON ${2:tabla} (${3:columna});"},
	{Label: "pk", Detail: i18n.Msg{ES: "ALTER TABLE … ADD CONSTRAINT … PRIMARY KEY", EN: "ALTER TABLE … ADD CONSTRAINT … PRIMARY KEY"}, Body: "ALTER TABLE ${1:tabla}\n    ADD CONSTRAINT ${2:pk_tabla} PRIMARY KEY (${3:columna});"},
	{Label: "fk", Detail: i18n.Msg{ES: "ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY", EN: "ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY"}, Body: "ALTER TABLE ${1:tabla}\n    ADD CONSTRAINT ${2:fk_tabla_otra} FOREIGN KEY (${3:columna})\n    REFERENCES ${4:otra_tabla} (${5:columna});"},
	{Label: "ren", Detail: i18n.Msg{ES: "Renombrar una tabla", EN: "Rename a table"}, Body: "ALTER TABLE ${1:tabla} RENAME TO ${2:nombre_nuevo};"},
}

// standardDialect backs an editor tab with no connection bound: shared
// keywords, shared functions, shared snippets, nothing engine-specific.
var standardDialect = &Dialect{
	Name:       "",
	QuoteIdent: func(s string) string { return `"` + s + `"` },
}
