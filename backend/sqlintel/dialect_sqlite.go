package sqlintel

func init() {
	Register(&Dialect{
		Name:       "sqlite",
		QuoteIdent: func(s string) string { return `"` + s + `"` },
		Keywords: []string{
			"LIMIT", "OFFSET", "ON CONFLICT", "DO UPDATE SET", "DO NOTHING",
			"INSERT OR REPLACE", "INSERT OR IGNORE", "AUTOINCREMENT",
			"INTEGER PRIMARY KEY", "WITHOUT ROWID", "PRAGMA", "ATTACH DATABASE",
			"VACUUM", "GLOB", "REGEXP", "RETURNING", "EXPLAIN QUERY PLAN",
		},
		Functions: []FunctionDef{
			{Name: "IFNULL", Signature: "IFNULL(expr, valor_si_null)", Doc: "Devuelve valor_si_null cuando expr es NULL. El NVL de SQLite.", Snippet: "IFNULL(${1:expr}, ${2:valor})"},
			{Name: "datetime", Signature: "datetime('now')", Doc: "Fecha y hora como texto ISO-8601. En SQLite las funciones de fecha van en minúscula.", Snippet: "datetime('now')"},
			{Name: "date", Signature: "date('now')", Doc: "Fecha actual como texto YYYY-MM-DD.", Snippet: "date('now')"},
			{Name: "time", Signature: "time('now')", Doc: "Hora actual como texto HH:MM:SS.", Snippet: "time('now')"},
			{Name: "strftime", Signature: "strftime(formato, ts)", Doc: "Formatea una fecha con una máscara tipo C.", Snippet: "strftime('${1:%Y-%m-%d}', ${2:columna})"},
			{Name: "julianday", Signature: "julianday(fecha)", Doc: "Día juliano — restar dos da la diferencia en días."},
			{Name: "INSTR", Signature: "INSTR(texto, buscar)", Doc: "Posición de una subcadena (1-based, 0 si no está)."},
			{Name: "GROUP_CONCAT", Signature: "GROUP_CONCAT(col, sep)", Doc: "Concatena los valores de un grupo.", Snippet: "GROUP_CONCAT(${1:columna}, ', ')", Aggregate: true},
			{Name: "TYPEOF", Signature: "TYPEOF(expr)", Doc: "Tipo dinámico real del valor: null/integer/real/text/blob."},
			{Name: "HEX", Signature: "HEX(blob)", Doc: "Representación hexadecimal de un blob."},
			{Name: "RANDOM", Signature: "RANDOM()", Doc: "Entero pseudoaleatorio de 64 bits.", Snippet: "RANDOM()"},
			{Name: "LAST_INSERT_ROWID", Signature: "LAST_INSERT_ROWID()", Doc: "rowid de la última fila insertada en esta conexión.", Snippet: "LAST_INSERT_ROWID()"},
			{Name: "JSON_EXTRACT", Signature: "JSON_EXTRACT(json, path)", Doc: "Extrae un valor de un documento JSON.", Snippet: "JSON_EXTRACT(${1:columna}, '$.${2:campo}')"},
		},
		Snippets: []SnippetDef{
			{Label: "limit", Detail: "LIMIT … OFFSET …", Body: "SELECT ${1:*}\nFROM ${2:tabla}\nORDER BY ${3:columna}\nLIMIT ${4:50} OFFSET ${5:0};"},
			{Label: "upsert", Detail: "INSERT … ON CONFLICT DO UPDATE (upsert)", Body: "INSERT INTO ${1:tabla} (${2:id}, ${3:columna})\nVALUES (${4:valor_id}, ${5:valor})\nON CONFLICT(${2:id}) DO UPDATE\n    SET ${3:columna} = excluded.${3:columna};"},
			{Label: "ct", Detail: "CREATE TABLE … (con rowid autoincremental)", Body: "CREATE TABLE ${1:tabla} (\n    id INTEGER PRIMARY KEY AUTOINCREMENT,\n    ${2:nombre} TEXT NOT NULL,\n    creado_en TEXT NOT NULL DEFAULT (datetime('now'))\n);"},
			{Label: "expl", Detail: "EXPLAIN QUERY PLAN", Body: "EXPLAIN QUERY PLAN\n${1:SELECT 1};"},
			{Label: "pragma", Detail: "PRAGMA table_info(…)", Body: "PRAGMA table_info(${1:tabla});"},
		},
	})
}
