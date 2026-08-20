package sqlintel

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
			{Name: "ISNULL", Signature: "ISNULL(expr, valor_si_null)", Doc: "Devuelve valor_si_null cuando expr es NULL. El NVL de SQL Server (ojo: no es el IS NULL del WHERE).", Snippet: "ISNULL(${1:expr}, ${2:valor})"},
			{Name: "GETDATE", Signature: "GETDATE()", Doc: "Fecha y hora del servidor.", Snippet: "GETDATE()"},
			{Name: "SYSDATETIME", Signature: "SYSDATETIME()", Doc: "Fecha y hora con mayor precisión que GETDATE().", Snippet: "SYSDATETIME()"},
			{Name: "DATEADD", Signature: "DATEADD(unidad, n, fecha)", Doc: "Suma n unidades a una fecha.", Snippet: "DATEADD(${1:day}, ${2:1}, ${3:columna})"},
			{Name: "DATEDIFF", Signature: "DATEDIFF(unidad, f1, f2)", Doc: "Diferencia entre dos fechas en la unidad indicada.", Snippet: "DATEDIFF(${1:day}, ${2:f1}, ${3:f2})"},
			{Name: "FORMAT", Signature: "FORMAT(valor, formato)", Doc: "Formatea fecha o número con una máscara .NET.", Snippet: "FORMAT(${1:valor}, '${2:dd/MM/yyyy}')"},
			{Name: "CONVERT", Signature: "CONVERT(tipo, expr, estilo)", Doc: "Conversión de tipo con estilo opcional (el CAST extendido de T-SQL).", Snippet: "CONVERT(${1:varchar(20)}, ${2:expr}, ${3:103})"},
			{Name: "STRING_AGG", Signature: "STRING_AGG(col, sep)", Doc: "Concatena los valores de un grupo (2017+).", Snippet: "STRING_AGG(${1:columna}, ', ')", Aggregate: true},
			{Name: "CHARINDEX", Signature: "CHARINDEX(buscar, texto)", Doc: "Posición de una subcadena (1-based, 0 si no está)."},
			{Name: "LEN", Signature: "LEN(texto)", Doc: "Largo del texto sin espacios finales (a diferencia de LENGTH)."},
			{Name: "IIF", Signature: "IIF(condicion, si, no)", Doc: "CASE de dos ramas en línea.", Snippet: "IIF(${1:condicion}, ${2:si}, ${3:no})"},
			{Name: "NEWID", Signature: "NEWID()", Doc: "UNIQUEIDENTIFIER nuevo.", Snippet: "NEWID()"},
			{Name: "SCOPE_IDENTITY", Signature: "SCOPE_IDENTITY()", Doc: "Último IDENTITY generado en el ámbito actual.", Snippet: "SCOPE_IDENTITY()"},
			{Name: "TRY_CONVERT", Signature: "TRY_CONVERT(tipo, expr)", Doc: "Como CONVERT, pero devuelve NULL en vez de fallar.", Snippet: "TRY_CONVERT(${1:int}, ${2:expr})"},
		},
		Snippets: []SnippetDef{
			{Label: "limit", Detail: "SELECT TOP n …", Body: "SELECT TOP ${1:50} ${2:*}\nFROM ${3:tabla}\nORDER BY ${4:columna};"},
			{Label: "page", Detail: "OFFSET … FETCH NEXT … (paginado)", Body: "SELECT ${1:*}\nFROM ${2:tabla}\nORDER BY ${3:columna}\nOFFSET ${4:0} ROWS FETCH NEXT ${5:50} ROWS ONLY;"},
			{Label: "upsert", Detail: "MERGE … (upsert de T-SQL)", Body: "MERGE ${1:destino} AS d\nUSING ${2:origen} AS o\n    ON d.${3:id} = o.${3:id}\nWHEN MATCHED THEN\n    UPDATE SET d.${4:columna} = o.${4:columna}\nWHEN NOT MATCHED THEN\n    INSERT (${3:id}, ${4:columna}) VALUES (o.${3:id}, o.${4:columna});"},
			{Label: "proc", Detail: "CREATE OR ALTER PROCEDURE", Body: "CREATE OR ALTER PROCEDURE ${1:nombre}\n    @${2:param} ${3:int}\nAS\nBEGIN\n    SET NOCOUNT ON;\n    ${4:SELECT 1;}\nEND\nGO"},
			{Label: "updj", Detail: "UPDATE … FROM … JOIN … (sintaxis de T-SQL)", Body: "UPDATE d\nSET d.${1:columna} = o.${1:columna}\nFROM ${2:destino} d\nJOIN ${3:origen} o ON o.${4:id} = d.${4:id};"},
			{Label: "try", Detail: "BEGIN TRY … BEGIN CATCH", Body: "BEGIN TRY\n    ${1:SELECT 1;}\nEND TRY\nBEGIN CATCH\n    SELECT ERROR_MESSAGE();\nEND CATCH"},
		},
	})
}
