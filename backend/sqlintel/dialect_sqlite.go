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
			{Label: "updj", Detail: "UPDATE … FROM otra tabla (SQLite 3.33+)", Body: "UPDATE ${1:destino}\nSET ${2:columna} = o.${2:columna}\nFROM ${3:origen} o\nWHERE o.${4:id} = ${1:destino}.${4:id};"},
			{Label: "expl", Detail: "EXPLAIN QUERY PLAN", Body: "EXPLAIN QUERY PLAN\n${1:SELECT 1};"},
			{Label: "tx", Detail: "Transacción explícita", Body: "BEGIN TRANSACTION;\n    ${1:UPDATE tabla SET columna = valor WHERE condicion;}\nCOMMIT;"},
			{Label: "cols", Detail: "Columnas de una tabla (pragma table_info)", Body: "SELECT name, type, \"notnull\", dflt_value, pk\nFROM pragma_table_info('${1:tabla}');"},
			{Label: "idxs", Detail: "Índices declarados en la base", Body: "SELECT name, tbl_name, sql\nFROM sqlite_master\nWHERE type = 'index' AND sql IS NOT NULL\nORDER BY tbl_name, name;"},
			{Label: "vac", Detail: "VACUUM (compactar el archivo)", Body: "VACUUM;"},
			// SQLite no tiene TRUNCATE: el DELETE sin WHERE está optimizado
			// justamente para este caso.
			{Label: "trunc", Detail: "Vaciar una tabla (SQLite no tiene TRUNCATE)", Body: "DELETE FROM ${1:tabla};"},
						{Label: "pragma", Detail: "PRAGMA table_info(…)", Body: "PRAGMA table_info(${1:tabla});"},
		},
	})
}
