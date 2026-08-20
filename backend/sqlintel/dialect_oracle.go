package sqlintel

func init() {
	Register(&Dialect{
		Name:       "oracle",
		QuoteIdent: func(s string) string { return `"` + s + `"` },
		Keywords: []string{
			"CONNECT BY", "START WITH", "PRIOR", "LEVEL", "ROWNUM", "ROWID",
			"DUAL", "MINUS", "FETCH FIRST", "ROWS ONLY", "PARTITION BY",
			"MERGE INTO", "USING", "WHEN MATCHED THEN", "WHEN NOT MATCHED THEN",
			"NOCYCLE", "SIBLINGS", "PIVOT", "UNPIVOT", "MODEL", "KEEP",
			"CREATE OR REPLACE PROCEDURE", "CREATE OR REPLACE FUNCTION",
			"CREATE OR REPLACE PACKAGE", "CREATE OR REPLACE TRIGGER",
			"DECLARE", "BEGIN", "EXCEPTION", "END", "IS", "AS", "LOOP",
			"CURSOR", "PRAGMA", "SEQUENCE", "SYNONYM", "TABLESPACE",
		},
		Functions: []FunctionDef{
			{Name: "NVL", Signature: "NVL(expr, valor_si_null)", Doc: "Devuelve valor_si_null cuando expr es NULL. El COALESCE de dos argumentos de Oracle.", Snippet: "NVL(${1:expr}, ${2:valor})"},
			{Name: "NVL2", Signature: "NVL2(expr, si_no_null, si_null)", Doc: "Elige entre dos valores según si expr es NULL.", Snippet: "NVL2(${1:expr}, ${2:si_no_null}, ${3:si_null})"},
			{Name: "DECODE", Signature: "DECODE(expr, buscar, resultado, ..., default)", Doc: "IF-THEN-ELSE inline, equivalente compacto de un CASE.", Snippet: "DECODE(${1:expr}, ${2:valor}, ${3:resultado}, ${4:default})"},
			{Name: "SYSDATE", Signature: "SYSDATE", Doc: "Fecha y hora del servidor de base de datos. Sin paréntesis.", Snippet: "SYSDATE"},
			{Name: "SYSTIMESTAMP", Signature: "SYSTIMESTAMP", Doc: "Timestamp con zona horaria del servidor.", Snippet: "SYSTIMESTAMP"},
			{Name: "TO_DATE", Signature: "TO_DATE(texto, formato)", Doc: "Convierte texto a DATE con una máscara de formato.", Snippet: "TO_DATE(${1:texto}, '${2:DD/MM/YYYY}')"},
			{Name: "TO_CHAR", Signature: "TO_CHAR(valor, formato)", Doc: "Formatea una fecha o número como texto.", Snippet: "TO_CHAR(${1:valor}, '${2:DD/MM/YYYY}')"},
			{Name: "TO_NUMBER", Signature: "TO_NUMBER(texto)", Doc: "Convierte texto a número."},
			{Name: "TRUNC", Signature: "TRUNC(fecha_o_num, unidad)", Doc: "Trunca una fecha a día/mes/año o un número a N decimales.", Snippet: "TRUNC(${1:fecha})"},
			{Name: "ADD_MONTHS", Signature: "ADD_MONTHS(fecha, n)", Doc: "Suma n meses a una fecha."},
			{Name: "MONTHS_BETWEEN", Signature: "MONTHS_BETWEEN(f1, f2)", Doc: "Meses entre dos fechas."},
			{Name: "LAST_DAY", Signature: "LAST_DAY(fecha)", Doc: "Último día del mes de esa fecha."},
			{Name: "INSTR", Signature: "INSTR(texto, buscar)", Doc: "Posición de una subcadena (1-based, 0 si no está)."},
			{Name: "LISTAGG", Signature: "LISTAGG(col, sep) WITHIN GROUP (ORDER BY col)", Doc: "Concatena valores de un grupo en un solo texto.", Snippet: "LISTAGG(${1:columna}, ', ') WITHIN GROUP (ORDER BY ${2:columna})", Aggregate: true},
			{Name: "REGEXP_LIKE", Signature: "REGEXP_LIKE(texto, patron)", Doc: "Coincidencia por expresión regular.", Snippet: "REGEXP_LIKE(${1:texto}, '${2:patron}')"},
			{Name: "REGEXP_SUBSTR", Signature: "REGEXP_SUBSTR(texto, patron)", Doc: "Extrae la parte que coincide con la expresión regular."},
			{Name: "LPAD", Signature: "LPAD(texto, largo, relleno)", Doc: "Rellena por izquierda hasta un largo fijo."},
			{Name: "RPAD", Signature: "RPAD(texto, largo, relleno)", Doc: "Rellena por derecha hasta un largo fijo."},
			{Name: "USER", Signature: "USER", Doc: "Usuario Oracle conectado.", Snippet: "USER"},
		},
		Snippets: []SnippetDef{
			{Label: "limit", Detail: "FETCH FIRST n ROWS ONLY (12c+)", Body: "SELECT ${1:*}\nFROM ${2:tabla}\nORDER BY ${3:columna}\nFETCH FIRST ${4:50} ROWS ONLY;"},
			{Label: "rownum", Detail: "Limitar con ROWNUM (pre-12c)", Body: "SELECT * FROM (\n    SELECT ${1:*} FROM ${2:tabla} ORDER BY ${3:columna}\n) WHERE ROWNUM <= ${4:50};"},
			{Label: "upsert", Detail: "MERGE INTO … USING … (upsert de Oracle)", Body: "MERGE INTO ${1:destino} d\nUSING ${2:origen} o\n    ON (d.${3:id} = o.${3:id})\nWHEN MATCHED THEN\n    UPDATE SET d.${4:columna} = o.${4:columna}\nWHEN NOT MATCHED THEN\n    INSERT (${3:id}, ${4:columna}) VALUES (o.${3:id}, o.${4:columna});"},
			{Label: "plsql", Detail: "Bloque anónimo PL/SQL", Body: "DECLARE\n    ${1:v_valor} ${2:NUMBER};\nBEGIN\n    ${3:NULL;}\nEXCEPTION\n    WHEN OTHERS THEN\n        DBMS_OUTPUT.PUT_LINE(SQLERRM);\nEND;\n/"},
			{Label: "proc", Detail: "CREATE OR REPLACE PROCEDURE", Body: "CREATE OR REPLACE PROCEDURE ${1:nombre} (\n    ${2:p_param} IN ${3:NUMBER}\n) IS\nBEGIN\n    ${4:NULL;}\nEND ${1:nombre};\n/"},
			// Oracle no acepta ADD COLUMN: la columna nueva va entre
			// paréntesis, y ahí mismo entran varias de una.
			{Label: "addcol", Detail: "ALTER TABLE … ADD (…) — sintaxis de Oracle", Body: "ALTER TABLE ${1:tabla} ADD (${2:columna} ${3:VARCHAR2(100)} NULL);"},
			{Label: "updj", Detail: "UPDATE con subconsulta correlacionada", Body: "UPDATE ${1:destino} d\nSET d.${2:columna} = (\n    SELECT o.${3:columna}\n    FROM ${4:origen} o\n    WHERE o.${5:id} = d.${5:id}\n)\nWHERE EXISTS (\n    SELECT 1 FROM ${4:origen} o WHERE o.${5:id} = d.${5:id}\n);"},
			{Label: "seq", Detail: "CREATE SEQUENCE …", Body: "CREATE SEQUENCE ${1:nombre}\n    START WITH ${2:1}\n    INCREMENT BY 1\n    NOCACHE\n    NOCYCLE;"},
			{Label: "trg", Detail: "CREATE OR REPLACE TRIGGER (BEFORE INSERT)", Body: "CREATE OR REPLACE TRIGGER ${1:nombre}\nBEFORE INSERT ON ${2:tabla}\nFOR EACH ROW\nBEGIN\n    ${3:NULL;}\nEND;\n/"},
			{Label: "exc", Detail: "EXCEPTION WHEN NO_DATA_FOUND / OTHERS", Body: "EXCEPTION\n    WHEN NO_DATA_FOUND THEN\n        ${1:NULL;}\n    WHEN OTHERS THEN\n        DBMS_OUTPUT.PUT_LINE(SQLERRM);\n        RAISE;"},
			{Label: "bulk", Detail: "BULK COLLECT … LIMIT (lote de filas)", Body: "DECLARE\n    CURSOR c IS SELECT ${1:*} FROM ${2:tabla};\n    TYPE t_tab IS TABLE OF c%ROWTYPE;\n    v_filas t_tab;\nBEGIN\n    OPEN c;\n    LOOP\n        FETCH c BULK COLLECT INTO v_filas LIMIT ${3:1000};\n        EXIT WHEN v_filas.COUNT = 0;\n        FOR i IN 1 .. v_filas.COUNT LOOP\n            ${4:NULL;}\n        END LOOP;\n    END LOOP;\n    CLOSE c;\nEND;\n/"},
			{Label: "cur", Detail: "FOR … IN (cursor implícito) LOOP", Body: "FOR ${1:r} IN (SELECT ${2:*} FROM ${3:tabla}) LOOP\n    ${4:NULL;}\nEND LOOP;"},
		},
	})
}
