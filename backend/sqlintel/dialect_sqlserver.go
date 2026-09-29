package sqlintel

import "mini-tools/backend/i18n"

func init() {
	Register(&Dialect{
		Name:       "sqlserver",
		QuoteIdent: func(s string) string { return "[" + s + "]" },
		Keywords: []string{
			"TOP", "OFFSET", "FETCH NEXT", "ROWS ONLY", "MERGE", "OUTPUT",
			"CROSS APPLY", "OUTER APPLY", "IDENTITY", "NVARCHAR", "DATETIME2",
			"UNIQUEIDENTIFIER", "WITH (NOLOCK)", "PIVOT", "UNPIVOT", "GO",
			"BEGIN TRANSACTION", "COMMIT TRANSACTION", "ROLLBACK TRANSACTION",
			"TRY", "CATCH", "THROW", "DECLARE", "SET NOCOUNT ON",
			"CREATE OR ALTER PROCEDURE", "EXEC", "SET SHOWPLAN_ALL ON",
		},
		Functions: []FunctionDef{
			{Name: "ISNULL", Signature: "ISNULL(expr, valor_si_null)", Doc: i18n.Msg{ES: "Devuelve valor_si_null cuando expr es NULL. El NVL de SQL Server (ojo: no es el IS NULL del WHERE).", EN: "Returns valor_si_null when expr is NULL. SQL Server's NVL (careful: it's not the WHERE's IS NULL)."}, Snippet: "ISNULL(${1:expr}, ${2:valor})"},
			{Name: "GETDATE", Signature: "GETDATE()", Doc: i18n.Msg{ES: "Fecha y hora del servidor.", EN: "Date and time of the server."}, Snippet: "GETDATE()"},
			{Name: "SYSDATETIME", Signature: "SYSDATETIME()", Doc: i18n.Msg{ES: "Fecha y hora con mayor precisión que GETDATE().", EN: "Date and time with more precision than GETDATE()."}, Snippet: "SYSDATETIME()"},
			{Name: "DATEADD", Signature: "DATEADD(unidad, n, fecha)", Doc: i18n.Msg{ES: "Suma n unidades a una fecha.", EN: "Adds n units to a date."}, Snippet: "DATEADD(${1:day}, ${2:1}, ${3:columna})"},
			{Name: "DATEDIFF", Signature: "DATEDIFF(unidad, f1, f2)", Doc: i18n.Msg{ES: "Diferencia entre dos fechas en la unidad indicada.", EN: "Difference between two dates in the given unit."}, Snippet: "DATEDIFF(${1:day}, ${2:f1}, ${3:f2})"},
			{Name: "FORMAT", Signature: "FORMAT(valor, formato)", Doc: i18n.Msg{ES: "Formatea fecha o número con una máscara .NET.", EN: "Formats a date or number with a .NET mask."}, Snippet: "FORMAT(${1:valor}, '${2:dd/MM/yyyy}')"},
			{Name: "CONVERT", Signature: "CONVERT(tipo, expr, estilo)", Doc: i18n.Msg{ES: "Conversión de tipo con estilo opcional (el CAST extendido de T-SQL).", EN: "Type conversion with an optional style (T-SQL's extended CAST)."}, Snippet: "CONVERT(${1:varchar(20)}, ${2:expr}, ${3:103})"},
			{Name: "STRING_AGG", Signature: "STRING_AGG(col, sep)", Doc: i18n.Msg{ES: "Concatena los valores de un grupo (2017+).", EN: "Concatenates the values of a group (2017+)."}, Snippet: "STRING_AGG(${1:columna}, ', ')", Aggregate: true},
			{Name: "CHARINDEX", Signature: "CHARINDEX(buscar, texto)", Doc: i18n.Msg{ES: "Posición de una subcadena (1-based, 0 si no está).", EN: "Position of a substring (1-based, 0 if absent)."}},
			{Name: "LEN", Signature: "LEN(texto)", Doc: i18n.Msg{ES: "Largo del texto sin espacios finales (a diferencia de LENGTH).", EN: "Length of the text without trailing spaces (unlike LENGTH)."}},
			{Name: "IIF", Signature: "IIF(condicion, si, no)", Doc: i18n.Msg{ES: "CASE de dos ramas en línea.", EN: "Inline two-branch CASE."}, Snippet: "IIF(${1:condicion}, ${2:si}, ${3:no})"},
			{Name: "NEWID", Signature: "NEWID()", Doc: i18n.Msg{ES: "UNIQUEIDENTIFIER nuevo.", EN: "New UNIQUEIDENTIFIER."}, Snippet: "NEWID()"},
			{Name: "SCOPE_IDENTITY", Signature: "SCOPE_IDENTITY()", Doc: i18n.Msg{ES: "Último IDENTITY generado en el ámbito actual.", EN: "Last IDENTITY generated in the current scope."}, Snippet: "SCOPE_IDENTITY()"},
			{Name: "TRY_CONVERT", Signature: "TRY_CONVERT(tipo, expr)", Doc: i18n.Msg{ES: "Como CONVERT, pero devuelve NULL en vez de fallar.", EN: "Like CONVERT, but returns NULL instead of failing."}, Snippet: "TRY_CONVERT(${1:int}, ${2:expr})"},
		},
		Snippets: []SnippetDef{
			{Label: "limit", Detail: i18n.Msg{ES: "SELECT TOP n …", EN: "SELECT TOP n …"}, Body: "SELECT TOP ${1:50} ${2:*}\nFROM ${3:tabla}\nORDER BY ${4:columna};"},
			{Label: "page", Detail: i18n.Msg{ES: "OFFSET … FETCH NEXT … (paginado)", EN: "OFFSET … FETCH NEXT … (paging)"}, Body: "SELECT ${1:*}\nFROM ${2:tabla}\nORDER BY ${3:columna}\nOFFSET ${4:0} ROWS FETCH NEXT ${5:50} ROWS ONLY;"},
			{Label: "upsert", Detail: i18n.Msg{ES: "MERGE … (upsert de T-SQL)", EN: "MERGE … (T-SQL upsert)"}, Body: "MERGE ${1:destino} AS d\nUSING ${2:origen} AS o\n    ON d.${3:id} = o.${3:id}\nWHEN MATCHED THEN\n    UPDATE SET d.${4:columna} = o.${4:columna}\nWHEN NOT MATCHED THEN\n    INSERT (${3:id}, ${4:columna}) VALUES (o.${3:id}, o.${4:columna});"},
			{Label: "proc", Detail: i18n.Msg{ES: "CREATE OR ALTER PROCEDURE", EN: "CREATE OR ALTER PROCEDURE"}, Body: "CREATE OR ALTER PROCEDURE ${1:nombre}\n    @${2:param} ${3:int}\nAS\nBEGIN\n    SET NOCOUNT ON;\n    ${4:SELECT 1;}\nEND\nGO"},
			{Label: "updj", Detail: i18n.Msg{ES: "UPDATE … FROM … JOIN … (sintaxis de T-SQL)", EN: "UPDATE … FROM … JOIN … (T-SQL syntax)"}, Body: "UPDATE d\nSET d.${1:columna} = o.${1:columna}\nFROM ${2:destino} d\nJOIN ${3:origen} o ON o.${4:id} = d.${4:id};"},
			{Label: "tx", Detail: i18n.Msg{ES: "Transacción con TRY/CATCH y ROLLBACK", EN: "Transaction with TRY/CATCH and ROLLBACK"}, Body: "BEGIN TRY\n    BEGIN TRANSACTION;\n    ${1:UPDATE tabla SET columna = valor WHERE condicion;}\n    COMMIT TRANSACTION;\nEND TRY\nBEGIN CATCH\n    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;\n    THROW;\nEND CATCH;"},
			{Label: "cols", Detail: i18n.Msg{ES: "Columnas de una tabla (INFORMATION_SCHEMA)", EN: "Columns of a table (INFORMATION_SCHEMA)"}, Body: "SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE\nFROM INFORMATION_SCHEMA.COLUMNS\nWHERE TABLE_SCHEMA = '${1:dbo}'\n  AND TABLE_NAME = '${2:tabla}'\nORDER BY ORDINAL_POSITION;"},
			{Label: "size", Detail: i18n.Msg{ES: "Tamaño de las tablas más grandes", EN: "Size of the largest tables"}, Body: "SELECT t.name AS tabla, SUM(p.rows) AS filas, SUM(a.total_pages) * 8 / 1024 AS mb\nFROM sys.tables t\nJOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)\nJOIN sys.allocation_units a ON a.container_id = p.partition_id\nGROUP BY t.name\nORDER BY mb DESC;"},
			{Label: "act", Detail: i18n.Msg{ES: "Consultas en curso (sys.dm_exec_requests)", EN: "Running queries (sys.dm_exec_requests)"}, Body: "SELECT r.session_id, r.status, r.wait_type, r.total_elapsed_time, t.text\nFROM sys.dm_exec_requests r\nCROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t\nWHERE r.session_id <> @@SPID;"},
			// SQL Server no renombra con ALTER TABLE.
			{Label: "ren", Detail: i18n.Msg{ES: "Renombrar una tabla (sp_rename)", EN: "Rename a table (sp_rename)"}, Body: "EXEC sp_rename '${1:tabla}', '${2:nombre_nuevo}';"},
						{Label: "try", Detail: i18n.Msg{ES: "BEGIN TRY … BEGIN CATCH", EN: "BEGIN TRY … BEGIN CATCH"}, Body: "BEGIN TRY\n    ${1:SELECT 1;}\nEND TRY\nBEGIN CATCH\n    SELECT ERROR_MESSAGE();\nEND CATCH"},
		},
	})
}
