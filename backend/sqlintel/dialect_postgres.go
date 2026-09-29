package sqlintel

import "mini-tools/backend/i18n"

func init() {
	Register(&Dialect{
		Name:       "postgres",
		QuoteIdent: func(s string) string { return `"` + s + `"` },
		Keywords: []string{
			"LIMIT", "OFFSET", "RETURNING", "ON CONFLICT", "DO UPDATE SET",
			"DO NOTHING", "ILIKE", "SIMILAR TO", "LATERAL", "DISTINCT ON",
			"GENERATED ALWAYS AS IDENTITY", "SERIAL", "BIGSERIAL", "JSONB",
			"TEXT", "TIMESTAMPTZ", "INTERVAL", "ARRAY", "UNNEST", "MATERIALIZED",
			"CREATE OR REPLACE FUNCTION", "LANGUAGE plpgsql", "EXPLAIN ANALYZE",
			"VACUUM", "ANALYZE", "TABLESAMPLE", "FILTER", "WINDOW", "OVER",
		},
		Functions: []FunctionDef{
			{Name: "NOW", Signature: "NOW()", Doc: i18n.Msg{ES: "Timestamp con zona horaria del inicio de la transacción actual.", EN: "Timestamp with time zone of the start of the current transaction."}, Snippet: "NOW()"},
			{Name: "CURRENT_DATE", Signature: "CURRENT_DATE", Doc: i18n.Msg{ES: "Fecha actual, sin hora.", EN: "Current date, without time."}, Snippet: "CURRENT_DATE"},
			{Name: "AGE", Signature: "AGE(t1, t2)", Doc: i18n.Msg{ES: "Intervalo entre dos timestamps, en años/meses/días.", EN: "Interval between two timestamps, in years/months/days."}},
			{Name: "DATE_TRUNC", Signature: "DATE_TRUNC('unidad', ts)", Doc: i18n.Msg{ES: "Trunca un timestamp a hora/día/mes/año.", EN: "Truncates a timestamp to hour/day/month/year."}, Snippet: "DATE_TRUNC('${1:month}', ${2:columna})"},
			{Name: "DATE_PART", Signature: "DATE_PART('campo', ts)", Doc: i18n.Msg{ES: "Extrae un componente de una fecha.", EN: "Extracts a component from a date."}, Snippet: "DATE_PART('${1:year}', ${2:columna})"},
			{Name: "TO_CHAR", Signature: "TO_CHAR(valor, formato)", Doc: i18n.Msg{ES: "Formatea fecha o número como texto.", EN: "Formats a date or number as text."}, Snippet: "TO_CHAR(${1:valor}, '${2:DD/MM/YYYY}')"},
			{Name: "STRING_AGG", Signature: "STRING_AGG(col, sep)", Doc: i18n.Msg{ES: "Concatena los valores de un grupo.", EN: "Concatenates the values of a group."}, Snippet: "STRING_AGG(${1:columna}, ', ')", Aggregate: true},
			{Name: "ARRAY_AGG", Signature: "ARRAY_AGG(col)", Doc: i18n.Msg{ES: "Junta los valores del grupo en un array.", EN: "Collects the group's values into an array."}, Aggregate: true},
			{Name: "JSONB_BUILD_OBJECT", Signature: "JSONB_BUILD_OBJECT(k, v, ...)", Doc: i18n.Msg{ES: "Arma un objeto JSONB a partir de pares clave/valor.", EN: "Builds a JSONB object from key/value pairs."}, Snippet: "JSONB_BUILD_OBJECT('${1:clave}', ${2:valor})"},
			{Name: "JSONB_AGG", Signature: "JSONB_AGG(expr)", Doc: i18n.Msg{ES: "Agrega las filas del grupo en un array JSONB.", EN: "Aggregates the group's rows into a JSONB array."}, Aggregate: true},
			{Name: "GENERATE_SERIES", Signature: "GENERATE_SERIES(desde, hasta, paso)", Doc: i18n.Msg{ES: "Genera una serie de valores como filas.", EN: "Generates a series of values as rows."}, Snippet: "GENERATE_SERIES(${1:1}, ${2:10})"},
			{Name: "COALESCE", Signature: "COALESCE(expr, ...)", Doc: i18n.Msg{ES: "Primer argumento no nulo (el NVL de Postgres).", EN: "First non-null argument (Postgres' NVL)."}},
			{Name: "SPLIT_PART", Signature: "SPLIT_PART(texto, sep, n)", Doc: i18n.Msg{ES: "N-ésima parte de un texto separado por un delimitador.", EN: "N-th part of a text split by a delimiter."}, Snippet: "SPLIT_PART(${1:texto}, '${2:,}', ${3:1})"},
			{Name: "POSITION", Signature: "POSITION(sub IN texto)", Doc: i18n.Msg{ES: "Posición de una subcadena.", EN: "Position of a substring."}, Snippet: "POSITION(${1:sub} IN ${2:texto})"},
			{Name: "REGEXP_REPLACE", Signature: "REGEXP_REPLACE(texto, patron, reemplazo)", Doc: i18n.Msg{ES: "Reemplazo por expresión regular.", EN: "Regular expression replace."}, Snippet: "REGEXP_REPLACE(${1:texto}, '${2:patron}', '${3:reemplazo}')"},
			{Name: "GEN_RANDOM_UUID", Signature: "GEN_RANDOM_UUID()", Doc: i18n.Msg{ES: "UUID v4 aleatorio (pgcrypto/13+).", EN: "Random v4 UUID (pgcrypto/13+)."}, Snippet: "GEN_RANDOM_UUID()"},
		},
		Snippets: []SnippetDef{
			{Label: "limit", Detail: i18n.Msg{ES: "LIMIT … OFFSET …", EN: "LIMIT … OFFSET …"}, Body: "SELECT ${1:*}\nFROM ${2:tabla}\nORDER BY ${3:columna}\nLIMIT ${4:50} OFFSET ${5:0};"},
			{Label: "upsert", Detail: i18n.Msg{ES: "INSERT … ON CONFLICT DO UPDATE (upsert)", EN: "INSERT … ON CONFLICT DO UPDATE (upsert)"}, Body: "INSERT INTO ${1:tabla} (${2:id}, ${3:columna})\nVALUES (${4:valor_id}, ${5:valor})\nON CONFLICT (${2:id}) DO UPDATE\n    SET ${3:columna} = EXCLUDED.${3:columna};"},
			{Label: "fn", Detail: i18n.Msg{ES: "CREATE OR REPLACE FUNCTION (plpgsql)", EN: "CREATE OR REPLACE FUNCTION (plpgsql)"}, Body: "CREATE OR REPLACE FUNCTION ${1:nombre}(${2:p_param} ${3:integer})\nRETURNS ${4:integer} AS $$\nBEGIN\n    RETURN ${5:0};\nEND;\n$$ LANGUAGE plpgsql;"},
			{Label: "updj", Detail: i18n.Msg{ES: "UPDATE … FROM otra tabla", EN: "UPDATE … FROM another table"}, Body: "UPDATE ${1:destino} d\nSET ${2:columna} = o.${2:columna}\nFROM ${3:origen} o\nWHERE o.${4:id} = d.${4:id};"},
			{Label: "delj", Detail: i18n.Msg{ES: "DELETE … USING otra tabla", EN: "DELETE … USING another table"}, Body: "DELETE FROM ${1:destino} d\nUSING ${2:origen} o\nWHERE o.${3:id} = d.${3:id};"},
			{Label: "tx", Detail: i18n.Msg{ES: "Transacción explícita", EN: "Explicit transaction"}, Body: "BEGIN;\n    ${1:UPDATE tabla SET columna = valor WHERE condicion;}\nCOMMIT;"},
			{Label: "cols", Detail: i18n.Msg{ES: "Columnas de una tabla (information_schema)", EN: "Columns of a table (information_schema)"}, Body: "SELECT column_name, data_type, is_nullable, column_default\nFROM information_schema.columns\nWHERE table_schema = '${1:public}'\n  AND table_name = '${2:tabla}'\nORDER BY ordinal_position;"},
			{Label: "size", Detail: i18n.Msg{ES: "Tamaño de las tablas más grandes", EN: "Size of the largest tables"}, Body: "SELECT relname AS tabla, pg_size_pretty(pg_total_relation_size(c.oid)) AS tamano\nFROM pg_class c\nJOIN pg_namespace n ON n.oid = c.relnamespace\nWHERE c.relkind = 'r' AND n.nspname = '${1:public}'\nORDER BY pg_total_relation_size(c.oid) DESC\nLIMIT ${2:20};"},
			{Label: "act", Detail: i18n.Msg{ES: "Consultas en curso (pg_stat_activity)", EN: "Running queries (pg_stat_activity)"}, Body: "SELECT pid, usename, state, now() - query_start AS duracion, query\nFROM pg_stat_activity\nWHERE state <> 'idle'\nORDER BY query_start;"},
			{Label: "gen", Detail: i18n.Msg{ES: "generate_series (rango de fechas)", EN: "generate_series (date range)"}, Body: "SELECT d::date\nFROM generate_series('${1:2026-01-01}'::date, '${2:2026-12-31}'::date, interval '1 day') AS d;"},
			{Label: "ilike", Detail: i18n.Msg{ES: "WHERE … ILIKE '%…%' (sin distinguir mayúsculas)", EN: "WHERE … ILIKE '%…%' (case-insensitive)"}, Body: "WHERE ${1:columna} ILIKE '%${2:texto}%'"},
						{Label: "expl", Detail: i18n.Msg{ES: "EXPLAIN (ANALYZE, BUFFERS)", EN: "EXPLAIN (ANALYZE, BUFFERS)"}, Body: "EXPLAIN (ANALYZE, BUFFERS)\n${1:SELECT 1};"},
		},
	})
}
