package sqlintel

import "mini-tools/backend/i18n"

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
			{Name: "NVL", Signature: "NVL(expr, valor_si_null)", Doc: i18n.Msg{ES: "Devuelve valor_si_null cuando expr es NULL. El COALESCE de dos argumentos de Oracle.", EN: "Returns valor_si_null when expr is NULL. Oracle's two-argument COALESCE."}, Snippet: "NVL(${1:expr}, ${2:valor})"},
			{Name: "NVL2", Signature: "NVL2(expr, si_no_null, si_null)", Doc: i18n.Msg{ES: "Elige entre dos valores según si expr es NULL.", EN: "Picks between two values depending on whether expr is NULL."}, Snippet: "NVL2(${1:expr}, ${2:si_no_null}, ${3:si_null})"},
			{Name: "DECODE", Signature: "DECODE(expr, buscar, resultado, ..., default)", Doc: i18n.Msg{ES: "IF-THEN-ELSE inline, equivalente compacto de un CASE.", EN: "Inline IF-THEN-ELSE, a compact equivalent of a CASE."}, Snippet: "DECODE(${1:expr}, ${2:valor}, ${3:resultado}, ${4:default})"},
			{Name: "SYSDATE", Signature: "SYSDATE", Doc: i18n.Msg{ES: "Fecha y hora del servidor de base de datos. Sin paréntesis.", EN: "Date and time of the database server. No parentheses."}, Snippet: "SYSDATE"},
			{Name: "SYSTIMESTAMP", Signature: "SYSTIMESTAMP", Doc: i18n.Msg{ES: "Timestamp con zona horaria del servidor.", EN: "Timestamp with the server's time zone."}, Snippet: "SYSTIMESTAMP"},
			{Name: "TO_DATE", Signature: "TO_DATE(texto, formato)", Doc: i18n.Msg{ES: "Convierte texto a DATE con una máscara de formato.", EN: "Converts text to DATE with a format mask."}, Snippet: "TO_DATE(${1:texto}, '${2:DD/MM/YYYY}')"},
			{Name: "TO_CHAR", Signature: "TO_CHAR(valor, formato)", Doc: i18n.Msg{ES: "Formatea una fecha o número como texto.", EN: "Formats a date or number as text."}, Snippet: "TO_CHAR(${1:valor}, '${2:DD/MM/YYYY}')"},
			{Name: "TO_NUMBER", Signature: "TO_NUMBER(texto)", Doc: i18n.Msg{ES: "Convierte texto a número.", EN: "Converts text to a number."}},
			{Name: "TRUNC", Signature: "TRUNC(fecha_o_num, unidad)", Doc: i18n.Msg{ES: "Trunca una fecha a día/mes/año o un número a N decimales.", EN: "Truncates a date to day/month/year or a number to N decimals."}, Snippet: "TRUNC(${1:fecha})"},
			{Name: "ADD_MONTHS", Signature: "ADD_MONTHS(fecha, n)", Doc: i18n.Msg{ES: "Suma n meses a una fecha.", EN: "Adds n months to a date."}},
			{Name: "MONTHS_BETWEEN", Signature: "MONTHS_BETWEEN(f1, f2)", Doc: i18n.Msg{ES: "Meses entre dos fechas.", EN: "Months between two dates."}},
			{Name: "LAST_DAY", Signature: "LAST_DAY(fecha)", Doc: i18n.Msg{ES: "Último día del mes de esa fecha.", EN: "Last day of that date's month."}},
			{Name: "INSTR", Signature: "INSTR(texto, buscar)", Doc: i18n.Msg{ES: "Posición de una subcadena (1-based, 0 si no está).", EN: "Position of a substring (1-based, 0 if absent)."}},
			{Name: "LISTAGG", Signature: "LISTAGG(col, sep) WITHIN GROUP (ORDER BY col)", Doc: i18n.Msg{ES: "Concatena valores de un grupo en un solo texto.", EN: "Concatenates a group's values into a single text."}, Snippet: "LISTAGG(${1:columna}, ', ') WITHIN GROUP (ORDER BY ${2:columna})", Aggregate: true},
			{Name: "REGEXP_LIKE", Signature: "REGEXP_LIKE(texto, patron)", Doc: i18n.Msg{ES: "Coincidencia por expresión regular.", EN: "Regular expression match."}, Snippet: "REGEXP_LIKE(${1:texto}, '${2:patron}')"},
			{Name: "REGEXP_SUBSTR", Signature: "REGEXP_SUBSTR(texto, patron)", Doc: i18n.Msg{ES: "Extrae la parte que coincide con la expresión regular.", EN: "Extracts the part matching the regular expression."}},
			{Name: "LPAD", Signature: "LPAD(texto, largo, relleno)", Doc: i18n.Msg{ES: "Rellena por izquierda hasta un largo fijo.", EN: "Left-pads to a fixed length."}},
			{Name: "RPAD", Signature: "RPAD(texto, largo, relleno)", Doc: i18n.Msg{ES: "Rellena por derecha hasta un largo fijo.", EN: "Right-pads to a fixed length."}},
			{Name: "USER", Signature: "USER", Doc: i18n.Msg{ES: "Usuario Oracle conectado.", EN: "Connected Oracle user."}, Snippet: "USER"},
		},
		Snippets: []SnippetDef{
			{Label: "limit", Detail: i18n.Msg{ES: "FETCH FIRST n ROWS ONLY (12c+)", EN: "FETCH FIRST n ROWS ONLY (12c+)"}, Body: "SELECT ${1:*}\nFROM ${2:tabla}\nORDER BY ${3:columna}\nFETCH FIRST ${4:50} ROWS ONLY;"},
			{Label: "rownum", Detail: i18n.Msg{ES: "Limitar con ROWNUM (pre-12c)", EN: "Limit with ROWNUM (pre-12c)"}, Body: "SELECT * FROM (\n    SELECT ${1:*} FROM ${2:tabla} ORDER BY ${3:columna}\n) WHERE ROWNUM <= ${4:50};"},
			{Label: "upsert", Detail: i18n.Msg{ES: "MERGE INTO … USING … (upsert de Oracle)", EN: "MERGE INTO … USING … (Oracle upsert)"}, Body: "MERGE INTO ${1:destino} d\nUSING ${2:origen} o\n    ON (d.${3:id} = o.${3:id})\nWHEN MATCHED THEN\n    UPDATE SET d.${4:columna} = o.${4:columna}\nWHEN NOT MATCHED THEN\n    INSERT (${3:id}, ${4:columna}) VALUES (o.${3:id}, o.${4:columna});"},
			{Label: "plsql", Detail: i18n.Msg{ES: "Bloque anónimo PL/SQL", EN: "Anonymous PL/SQL block"}, Body: "DECLARE\n    ${1:v_valor} ${2:NUMBER};\nBEGIN\n    ${3:NULL;}\nEXCEPTION\n    WHEN OTHERS THEN\n        DBMS_OUTPUT.PUT_LINE(SQLERRM);\nEND;\n/"},
			{Label: "proc", Detail: i18n.Msg{ES: "CREATE OR REPLACE PROCEDURE", EN: "CREATE OR REPLACE PROCEDURE"}, Body: "CREATE OR REPLACE PROCEDURE ${1:nombre} (\n    ${2:p_param} IN ${3:NUMBER}\n) IS\nBEGIN\n    ${4:NULL;}\nEND ${1:nombre};\n/"},
			// Oracle no acepta ADD COLUMN: la columna nueva va entre
			// paréntesis, y ahí mismo entran varias de una.
			{Label: "addcol", Detail: i18n.Msg{ES: "ALTER TABLE … ADD (…) — sintaxis de Oracle", EN: "ALTER TABLE … ADD (…) — Oracle syntax"}, Body: "ALTER TABLE ${1:tabla} ADD (${2:columna} ${3:VARCHAR2(100)} NULL);"},
			{Label: "updj", Detail: i18n.Msg{ES: "UPDATE con subconsulta correlacionada", EN: "UPDATE with a correlated subquery"}, Body: "UPDATE ${1:destino} d\nSET d.${2:columna} = (\n    SELECT o.${3:columna}\n    FROM ${4:origen} o\n    WHERE o.${5:id} = d.${5:id}\n)\nWHERE EXISTS (\n    SELECT 1 FROM ${4:origen} o WHERE o.${5:id} = d.${5:id}\n);"},
			{Label: "seq", Detail: i18n.Msg{ES: "CREATE SEQUENCE …", EN: "CREATE SEQUENCE …"}, Body: "CREATE SEQUENCE ${1:nombre}\n    START WITH ${2:1}\n    INCREMENT BY 1\n    NOCACHE\n    NOCYCLE;"},
			{Label: "trg", Detail: i18n.Msg{ES: "CREATE OR REPLACE TRIGGER (BEFORE INSERT)", EN: "CREATE OR REPLACE TRIGGER (BEFORE INSERT)"}, Body: "CREATE OR REPLACE TRIGGER ${1:nombre}\nBEFORE INSERT ON ${2:tabla}\nFOR EACH ROW\nBEGIN\n    ${3:NULL;}\nEND;\n/"},
			{Label: "exc", Detail: i18n.Msg{ES: "EXCEPTION WHEN NO_DATA_FOUND / OTHERS", EN: "EXCEPTION WHEN NO_DATA_FOUND / OTHERS"}, Body: "EXCEPTION\n    WHEN NO_DATA_FOUND THEN\n        ${1:NULL;}\n    WHEN OTHERS THEN\n        DBMS_OUTPUT.PUT_LINE(SQLERRM);\n        RAISE;"},
			{Label: "bulk", Detail: i18n.Msg{ES: "BULK COLLECT … LIMIT (lote de filas)", EN: "BULK COLLECT … LIMIT (batch of rows)"}, Body: "DECLARE\n    CURSOR c IS SELECT ${1:*} FROM ${2:tabla};\n    TYPE t_tab IS TABLE OF c%ROWTYPE;\n    v_filas t_tab;\nBEGIN\n    OPEN c;\n    LOOP\n        FETCH c BULK COLLECT INTO v_filas LIMIT ${3:1000};\n        EXIT WHEN v_filas.COUNT = 0;\n        FOR i IN 1 .. v_filas.COUNT LOOP\n            ${4:NULL;}\n        END LOOP;\n    END LOOP;\n    CLOSE c;\nEND;\n/"},
			{Label: "tx", Detail: i18n.Msg{ES: "Transacción con COMMIT/ROLLBACK", EN: "Transaction with COMMIT/ROLLBACK"}, Body: "BEGIN\n    ${1:NULL;}\n    COMMIT;\nEXCEPTION\n    WHEN OTHERS THEN\n        ROLLBACK;\n        RAISE;\nEND;\n/"},
			{Label: "cols", Detail: i18n.Msg{ES: "Columnas de una tabla (ALL_TAB_COLUMNS)", EN: "Columns of a table (ALL_TAB_COLUMNS)"}, Body: "SELECT column_name, data_type, data_length, nullable\nFROM all_tab_columns\nWHERE owner = UPPER('${1:esquema}')\n  AND table_name = UPPER('${2:tabla}')\nORDER BY column_id;"},
			{Label: "sess", Detail: i18n.Msg{ES: "Sesiones activas (V$SESSION)", EN: "Active sessions (V$SESSION)"}, Body: "SELECT s.sid, s.serial#, s.username, s.status, s.machine, s.program, s.sql_id\nFROM v$session s\nWHERE s.username IS NOT NULL\n  AND s.status = 'ACTIVE'\nORDER BY s.logon_time DESC;"},
			{Label: "size", Detail: i18n.Msg{ES: "Tamaño de un objeto (USER_SEGMENTS)", EN: "Size of an object (USER_SEGMENTS)"}, Body: "SELECT segment_name, segment_type, ROUND(bytes / 1024 / 1024, 2) AS mb\nFROM user_segments\nWHERE segment_name = UPPER('${1:tabla}')\nORDER BY bytes DESC;"},
			{Label: "fnc", Detail: i18n.Msg{ES: "CREATE OR REPLACE FUNCTION", EN: "CREATE OR REPLACE FUNCTION"}, Body: "CREATE OR REPLACE FUNCTION ${1:nombre} (\n    ${2:p_param} IN ${3:NUMBER}\n) RETURN ${4:NUMBER} IS\n    v_resultado ${4:NUMBER};\nBEGIN\n    ${5:NULL;}\n    RETURN v_resultado;\nEND ${1:nombre};\n/"},
			{Label: "pkg", Detail: i18n.Msg{ES: "CREATE PACKAGE + BODY", EN: "CREATE PACKAGE + BODY"}, Body: "CREATE OR REPLACE PACKAGE ${1:nombre} IS\n    PROCEDURE ${2:metodo} (${3:p_param} IN ${4:NUMBER});\nEND ${1:nombre};\n/\n\nCREATE OR REPLACE PACKAGE BODY ${1:nombre} IS\n    PROCEDURE ${2:metodo} (${3:p_param} IN ${4:NUMBER}) IS\n    BEGIN\n        ${5:NULL;}\n    END ${2:metodo};\nEND ${1:nombre};\n/"},
			{Label: "datef", Detail: i18n.Msg{ES: "TO_DATE con formato", EN: "TO_DATE with a format"}, Body: "TO_DATE('${1:01/01/2026}', 'DD/MM/YYYY')"},
						{Label: "cur", Detail: i18n.Msg{ES: "FOR … IN (cursor implícito) LOOP", EN: "FOR … IN (implicit cursor) LOOP"}, Body: "FOR ${1:r} IN (SELECT ${2:*} FROM ${3:tabla}) LOOP\n    ${4:NULL;}\nEND LOOP;"},
		},
	})
}
