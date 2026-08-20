package sqlintel

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
			{Name: "NOW", Signature: "NOW()", Doc: "Timestamp con zona horaria del inicio de la transacción actual.", Snippet: "NOW()"},
			{Name: "CURRENT_DATE", Signature: "CURRENT_DATE", Doc: "Fecha actual, sin hora.", Snippet: "CURRENT_DATE"},
			{Name: "AGE", Signature: "AGE(t1, t2)", Doc: "Intervalo entre dos timestamps, en años/meses/días."},
			{Name: "DATE_TRUNC", Signature: "DATE_TRUNC('unidad', ts)", Doc: "Trunca un timestamp a hora/día/mes/año.", Snippet: "DATE_TRUNC('${1:month}', ${2:columna})"},
			{Name: "DATE_PART", Signature: "DATE_PART('campo', ts)", Doc: "Extrae un componente de una fecha.", Snippet: "DATE_PART('${1:year}', ${2:columna})"},
			{Name: "TO_CHAR", Signature: "TO_CHAR(valor, formato)", Doc: "Formatea fecha o número como texto.", Snippet: "TO_CHAR(${1:valor}, '${2:DD/MM/YYYY}')"},
			{Name: "STRING_AGG", Signature: "STRING_AGG(col, sep)", Doc: "Concatena los valores de un grupo.", Snippet: "STRING_AGG(${1:columna}, ', ')", Aggregate: true},
			{Name: "ARRAY_AGG", Signature: "ARRAY_AGG(col)", Doc: "Junta los valores del grupo en un array.", Aggregate: true},
			{Name: "JSONB_BUILD_OBJECT", Signature: "JSONB_BUILD_OBJECT(k, v, ...)", Doc: "Arma un objeto JSONB a partir de pares clave/valor.", Snippet: "JSONB_BUILD_OBJECT('${1:clave}', ${2:valor})"},
			{Name: "JSONB_AGG", Signature: "JSONB_AGG(expr)", Doc: "Agrega las filas del grupo en un array JSONB.", Aggregate: true},
			{Name: "GENERATE_SERIES", Signature: "GENERATE_SERIES(desde, hasta, paso)", Doc: "Genera una serie de valores como filas.", Snippet: "GENERATE_SERIES(${1:1}, ${2:10})"},
			{Name: "COALESCE", Signature: "COALESCE(expr, ...)", Doc: "Primer argumento no nulo (el NVL de Postgres)."},
			{Name: "SPLIT_PART", Signature: "SPLIT_PART(texto, sep, n)", Doc: "N-ésima parte de un texto separado por un delimitador.", Snippet: "SPLIT_PART(${1:texto}, '${2:,}', ${3:1})"},
			{Name: "POSITION", Signature: "POSITION(sub IN texto)", Doc: "Posición de una subcadena.", Snippet: "POSITION(${1:sub} IN ${2:texto})"},
			{Name: "REGEXP_REPLACE", Signature: "REGEXP_REPLACE(texto, patron, reemplazo)", Doc: "Reemplazo por expresión regular.", Snippet: "REGEXP_REPLACE(${1:texto}, '${2:patron}', '${3:reemplazo}')"},
			{Name: "GEN_RANDOM_UUID", Signature: "GEN_RANDOM_UUID()", Doc: "UUID v4 aleatorio (pgcrypto/13+).", Snippet: "GEN_RANDOM_UUID()"},
		},
		Snippets: []SnippetDef{
			{Label: "limit", Detail: "LIMIT … OFFSET …", Body: "SELECT ${1:*}\nFROM ${2:tabla}\nORDER BY ${3:columna}\nLIMIT ${4:50} OFFSET ${5:0};"},
			{Label: "upsert", Detail: "INSERT … ON CONFLICT DO UPDATE (upsert)", Body: "INSERT INTO ${1:tabla} (${2:id}, ${3:columna})\nVALUES (${4:valor_id}, ${5:valor})\nON CONFLICT (${2:id}) DO UPDATE\n    SET ${3:columna} = EXCLUDED.${3:columna};"},
			{Label: "fn", Detail: "CREATE OR REPLACE FUNCTION (plpgsql)", Body: "CREATE OR REPLACE FUNCTION ${1:nombre}(${2:p_param} ${3:integer})\nRETURNS ${4:integer} AS $$\nBEGIN\n    RETURN ${5:0};\nEND;\n$$ LANGUAGE plpgsql;"},
			{Label: "updj", Detail: "UPDATE … FROM otra tabla", Body: "UPDATE ${1:destino} d\nSET ${2:columna} = o.${2:columna}\nFROM ${3:origen} o\nWHERE o.${4:id} = d.${4:id};"},
			{Label: "delj", Detail: "DELETE … USING otra tabla", Body: "DELETE FROM ${1:destino} d\nUSING ${2:origen} o\nWHERE o.${3:id} = d.${3:id};"},
			{Label: "expl", Detail: "EXPLAIN (ANALYZE, BUFFERS)", Body: "EXPLAIN (ANALYZE, BUFFERS)\n${1:SELECT 1};"},
		},
	})
}
