package sqlintel

import "mini-tools/backend/i18n"

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
			{Name: "IFNULL", Signature: "IFNULL(expr, valor_si_null)", Doc: i18n.Msg{ES: "Devuelve valor_si_null cuando expr es NULL. El NVL de SQLite.", EN: "Returns valor_si_null when expr is NULL. SQLite's NVL."}, Snippet: "IFNULL(${1:expr}, ${2:valor})"},
			{Name: "datetime", Signature: "datetime('now')", Doc: i18n.Msg{ES: "Fecha y hora como texto ISO-8601. En SQLite las funciones de fecha van en minúscula.", EN: "Date and time as ISO-8601 text. In SQLite date functions are lowercase."}, Snippet: "datetime('now')"},
			{Name: "date", Signature: "date('now')", Doc: i18n.Msg{ES: "Fecha actual como texto YYYY-MM-DD.", EN: "Current date as YYYY-MM-DD text."}, Snippet: "date('now')"},
			{Name: "time", Signature: "time('now')", Doc: i18n.Msg{ES: "Hora actual como texto HH:MM:SS.", EN: "Current time as HH:MM:SS text."}, Snippet: "time('now')"},
			{Name: "strftime", Signature: "strftime(formato, ts)", Doc: i18n.Msg{ES: "Formatea una fecha con una máscara tipo C.", EN: "Formats a date with a C-style mask."}, Snippet: "strftime('${1:%Y-%m-%d}', ${2:columna})"},
			{Name: "julianday", Signature: "julianday(fecha)", Doc: i18n.Msg{ES: "Día juliano — restar dos da la diferencia en días.", EN: "Julian day — subtracting two gives the difference in days."}},
			{Name: "INSTR", Signature: "INSTR(texto, buscar)", Doc: i18n.Msg{ES: "Posición de una subcadena (1-based, 0 si no está).", EN: "Position of a substring (1-based, 0 if absent)."}},
			{Name: "GROUP_CONCAT", Signature: "GROUP_CONCAT(col, sep)", Doc: i18n.Msg{ES: "Concatena los valores de un grupo.", EN: "Concatenates the values of a group."}, Snippet: "GROUP_CONCAT(${1:columna}, ', ')", Aggregate: true},
			{Name: "TYPEOF", Signature: "TYPEOF(expr)", Doc: i18n.Msg{ES: "Tipo dinámico real del valor: null/integer/real/text/blob.", EN: "Actual dynamic type of the value: null/integer/real/text/blob."}},
			{Name: "HEX", Signature: "HEX(blob)", Doc: i18n.Msg{ES: "Representación hexadecimal de un blob.", EN: "Hexadecimal representation of a blob."}},
			{Name: "RANDOM", Signature: "RANDOM()", Doc: i18n.Msg{ES: "Entero pseudoaleatorio de 64 bits.", EN: "64-bit pseudo-random integer."}, Snippet: "RANDOM()"},
			{Name: "LAST_INSERT_ROWID", Signature: "LAST_INSERT_ROWID()", Doc: i18n.Msg{ES: "rowid de la última fila insertada en esta conexión.", EN: "rowid of the last row inserted on this connection."}, Snippet: "LAST_INSERT_ROWID()"},
			{Name: "JSON_EXTRACT", Signature: "JSON_EXTRACT(json, path)", Doc: i18n.Msg{ES: "Extrae un valor de un documento JSON.", EN: "Extracts a value from a JSON document."}, Snippet: "JSON_EXTRACT(${1:columna}, '$.${2:campo}')"},
		},
		Snippets: []SnippetDef{
			{Label: "limit", Detail: i18n.Msg{ES: "LIMIT … OFFSET …", EN: "LIMIT … OFFSET …"}, Body: "SELECT ${1:*}\nFROM ${2:tabla}\nORDER BY ${3:columna}\nLIMIT ${4:50} OFFSET ${5:0};"},
			{Label: "upsert", Detail: i18n.Msg{ES: "INSERT … ON CONFLICT DO UPDATE (upsert)", EN: "INSERT … ON CONFLICT DO UPDATE (upsert)"}, Body: "INSERT INTO ${1:tabla} (${2:id}, ${3:columna})\nVALUES (${4:valor_id}, ${5:valor})\nON CONFLICT(${2:id}) DO UPDATE\n    SET ${3:columna} = excluded.${3:columna};"},
			{Label: "ct", Detail: i18n.Msg{ES: "CREATE TABLE … (con rowid autoincremental)", EN: "CREATE TABLE … (with autoincrement rowid)"}, Body: "CREATE TABLE ${1:tabla} (\n    id INTEGER PRIMARY KEY AUTOINCREMENT,\n    ${2:nombre} TEXT NOT NULL,\n    creado_en TEXT NOT NULL DEFAULT (datetime('now'))\n);"},
			{Label: "updj", Detail: i18n.Msg{ES: "UPDATE … FROM otra tabla (SQLite 3.33+)", EN: "UPDATE … FROM another table (SQLite 3.33+)"}, Body: "UPDATE ${1:destino}\nSET ${2:columna} = o.${2:columna}\nFROM ${3:origen} o\nWHERE o.${4:id} = ${1:destino}.${4:id};"},
			{Label: "expl", Detail: i18n.Msg{ES: "EXPLAIN QUERY PLAN", EN: "EXPLAIN QUERY PLAN"}, Body: "EXPLAIN QUERY PLAN\n${1:SELECT 1};"},
			{Label: "tx", Detail: i18n.Msg{ES: "Transacción explícita", EN: "Explicit transaction"}, Body: "BEGIN TRANSACTION;\n    ${1:UPDATE tabla SET columna = valor WHERE condicion;}\nCOMMIT;"},
			{Label: "cols", Detail: i18n.Msg{ES: "Columnas de una tabla (pragma table_info)", EN: "Columns of a table (pragma table_info)"}, Body: "SELECT name, type, \"notnull\", dflt_value, pk\nFROM pragma_table_info('${1:tabla}');"},
			{Label: "idxs", Detail: i18n.Msg{ES: "Índices declarados en la base", EN: "Indexes declared in the database"}, Body: "SELECT name, tbl_name, sql\nFROM sqlite_master\nWHERE type = 'index' AND sql IS NOT NULL\nORDER BY tbl_name, name;"},
			{Label: "vac", Detail: i18n.Msg{ES: "VACUUM (compactar el archivo)", EN: "VACUUM (compact the file)"}, Body: "VACUUM;"},
			// SQLite no tiene TRUNCATE: el DELETE sin WHERE está optimizado
			// justamente para este caso.
			{Label: "trunc", Detail: i18n.Msg{ES: "Vaciar una tabla (SQLite no tiene TRUNCATE)", EN: "Empty a table (SQLite has no TRUNCATE)"}, Body: "DELETE FROM ${1:tabla};"},
						{Label: "pragma", Detail: i18n.Msg{ES: "PRAGMA table_info(…)", EN: "PRAGMA table_info(…)"}, Body: "PRAGMA table_info(${1:tabla});"},
		},
	})
}
