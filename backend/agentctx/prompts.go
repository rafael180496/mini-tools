package agentctx

import (
	"strings"

	"mini-tools/backend/db"
	"mini-tools/backend/i18n"
)

// Prompts del asistente de consultas.
//
// Viven en Go y no en el frontend por dos motivos. El primero es que la
// dialéctica la decide el MOTOR de la conexión, y el motor lo sabe el backend:
// pedirle a un agente "una consulta SQL" a secas devuelve algo que corre en
// Postgres y falla en Oracle, y esa es exactamente la diferencia entre un
// asistente útil y uno que hace perder tiempo. El segundo es que el prompt
// lleva adentro el esquema (ver dbctx.go), que nunca cruza al frontend.
//
// **Lo que ningún prompt de acá pide.** Ninguno le pide al agente que ejecute
// nada, ni que se conecte a la base: el agente devuelve texto y ejecutarlo
// sigue siendo un clic del usuario. La app le da el esquema y el plan
// justamente para que no necesite tocar la base para responder.

// dialectName es cómo se nombra el motor dentro del prompt.
func dialectName(t db.DBType) string {
	switch t {
	case db.DBTypeOracle:
		return "Oracle"
	case db.DBTypePostgres:
		return "PostgreSQL"
	case db.DBTypeSQLite:
		return "SQLite"
	case db.DBTypeSQLServer:
		return "SQL Server (T-SQL)"
	case db.DBTypeMongo:
		return "MongoDB"
	case db.DBTypeRedis:
		return "Redis"
	}
	return string(t)
}

// dialectRules son las particularidades de cada motor que un agente acierta
// solo la mitad de las veces si no se las dicen.
//
// No es una lista de todo lo que distingue a un motor —eso lo sabe el modelo—
// sino de lo que se equivoca en la práctica: la sintaxis de limitar filas, el
// manejo de nulos y las funciones de fecha, que son las tres cosas que
// aparecen en casi toda consulta y que difieren en las cuatro.
func dialectRules(t db.DBType) string {
	switch t {
	case db.DBTypeOracle:
		return i18n.T(i18n.Msg{
			ES: `- Limitar filas: FETCH FIRST n ROWS ONLY (12c+) o ROWNUM <= n. NUNCA LIMIT.
- Nulos: NVL/NVL2/COALESCE. Cadena vacía y NULL son lo mismo en Oracle.
- Fechas: TO_DATE/TO_CHAR con máscara explícita, SYSDATE, ADD_MONTHS, INTERVAL.
- Concatenación con || . Alias de tabla sin AS.
- Identificadores sin comillas son MAYÚSCULAS; respetá el caso del esquema tal cual viene arriba.`,
			EN: `- Limiting rows: FETCH FIRST n ROWS ONLY (12c+) or ROWNUM <= n. NEVER LIMIT.
- Nulls: NVL/NVL2/COALESCE. Empty string and NULL are the same thing in Oracle.
- Dates: TO_DATE/TO_CHAR with an explicit mask, SYSDATE, ADD_MONTHS, INTERVAL.
- Concatenation with || . Table aliases without AS.
- Unquoted identifiers are UPPERCASE; keep the case of the schema exactly as it appears above.`,
		})
	case db.DBTypePostgres:
		return i18n.T(i18n.Msg{
			ES: `- Limitar filas: LIMIT n OFFSET m.
- Case-insensitive: ILIKE. Expresiones regulares: ~ / ~*.
- JSON/JSONB: ->, ->>, #>, jsonb_agg, jsonb_build_object.
- DISTINCT ON (col) es de Postgres y suele ser la respuesta correcta a "el último por cada X".
- Fechas: NOW(), CURRENT_DATE, INTERVAL '1 hour', date_trunc.`,
			EN: `- Limiting rows: LIMIT n OFFSET m.
- Case-insensitive: ILIKE. Regular expressions: ~ / ~*.
- JSON/JSONB: ->, ->>, #>, jsonb_agg, jsonb_build_object.
- DISTINCT ON (col) is Postgres-specific and is usually the right answer to "the latest one for each X".
- Dates: NOW(), CURRENT_DATE, INTERVAL '1 hour', date_trunc.`,
		})
	case db.DBTypeSQLite:
		return i18n.T(i18n.Msg{
			ES: `- Limitar filas: LIMIT n OFFSET m.
- Tipado dinámico: no hay tipos estrictos; CAST cuando importe.
- Fechas: son texto/numéricas — usar date(), datetime(), strftime(), julianday().
- No hay RIGHT/FULL OUTER JOIN en versiones viejas; resolvé con LEFT JOIN.`,
			EN: `- Limiting rows: LIMIT n OFFSET m.
- Dynamic typing: there are no strict types; CAST when it matters.
- Dates: they are text/numeric — use date(), datetime(), strftime(), julianday().
- There is no RIGHT/FULL OUTER JOIN in old versions; solve it with LEFT JOIN.`,
		})
	case db.DBTypeSQLServer:
		return i18n.T(i18n.Msg{
			ES: `- Limitar filas: SELECT TOP (n), u OFFSET n ROWS FETCH NEXT m ROWS ONLY (requiere ORDER BY).
- Fechas: GETDATE(), DATEADD, DATEDIFF, FORMAT/CONVERT con estilo.
- Nulos: ISNULL/COALESCE.
- CROSS APPLY / OUTER APPLY para correlacionadas; identificadores entre [corchetes].`,
			EN: `- Limiting rows: SELECT TOP (n), or OFFSET n ROWS FETCH NEXT m ROWS ONLY (requires ORDER BY).
- Dates: GETDATE(), DATEADD, DATEDIFF, FORMAT/CONVERT with a style.
- Nulls: ISNULL/COALESCE.
- CROSS APPLY / OUTER APPLY for correlated queries; identifiers in [brackets].`,
		})
	case db.DBTypeMongo:
		return i18n.T(i18n.Msg{
			ES: `- Respondé con sintaxis de mongosh: db.<colección>.find(...) o db.<colección>.aggregate([...]).
- Para agrupar, pipeline de agregación: $match primero (usa índices), después $group/$sort/$project.
- Fechas: ISODate("..."), operadores $gte/$lt sobre el campo de fecha.
- No inventes campos: usá solo los que aparecen en el esquema inferido de arriba.`,
			EN: `- Answer with mongosh syntax: db.<collection>.find(...) or db.<collection>.aggregate([...]).
- To group, an aggregation pipeline: $match first (it uses indexes), then $group/$sort/$project.
- Dates: ISODate("..."), $gte/$lt operators on the date field.
- Do not invent fields: use only the ones that appear in the inferred schema above.`,
		})
	case db.DBTypeRedis:
		return i18n.T(i18n.Msg{
			ES: `- Respondé con comandos de redis-cli, uno por línea.
- Nunca uses KEYS en producción: SCAN con MATCH y COUNT.
- Respetá el tipo de cada clave (STRING/HASH/LIST/SET/ZSET/STREAM): un comando del tipo equivocado falla.
- Para Streams: XADD/XRANGE/XREAD; para expiración: TTL/EXPIRE.`,
			EN: `- Answer with redis-cli commands, one per line.
- Never use KEYS in production: SCAN with MATCH and COUNT.
- Respect the type of each key (STRING/HASH/LIST/SET/ZSET/STREAM): a command for the wrong type fails.
- For Streams: XADD/XRANGE/XREAD; for expiration: TTL/EXPIRE.`,
		})
	}
	return ""
}

// codeFence es el lenguaje del bloque en el que se pide la respuesta.
func codeFence(t db.DBType) string {
	switch t {
	case db.DBTypeMongo:
		return "javascript"
	case db.DBTypeRedis:
		return "bash"
	}
	return "sql"
}

// GeneratePrompt arma el pedido de "escribime esta consulta".
//
// currentSQL es lo que hay en el editor: puede estar vacío (consulta nueva) o
// traer una consulta que el usuario quiere modificar ("agregale el filtro por
// fecha"), que es el caso más frecuente y el que hace que la respuesta tenga
// que ser un reemplazo y no un agregado suelto.
func GeneratePrompt(dbType db.DBType, request, currentSQL string, schema SchemaContext) string {
	var b strings.Builder
	b.WriteString(i18n.T(i18n.Msg{ES: "Escribí una consulta para %s.", EN: "Write a query for %s."}, dialectName(dbType)) + "\n\n")

	b.WriteString(i18n.T(msgSchemaHeading) + "\n\n```sql\n")
	b.WriteString(schema.Text)
	b.WriteString("```\n\n")

	if strings.TrimSpace(currentSQL) != "" {
		b.WriteString(i18n.T(i18n.Msg{
			ES: "## Consulta actual del editor\n\nHay que MODIFICARLA, no escribir una desde cero:",
			EN: "## Current query in the editor\n\nIt has to be MODIFIED, not written from scratch:",
		}) + "\n\n```")
		b.WriteString(codeFence(dbType))
		b.WriteString("\n")
		b.WriteString(currentSQL)
		b.WriteString("\n```\n\n")
	}

	b.WriteString(i18n.T(i18n.Msg{ES: "## Lo que se pide", EN: "## What is being asked"}) + "\n\n")
	b.WriteString(request)
	b.WriteString("\n\n" + i18n.T(msgEngineRulesHeading) + "\n\n")
	b.WriteString(dialectRules(dbType))
	b.WriteString("\n\n" + answerRules(dbType))
	return b.String()
}

var (
	msgSchemaHeading      = i18n.Msg{ES: "## Esquema", EN: "## Schema"}
	msgEngineRulesHeading = i18n.Msg{ES: "## Reglas del motor", EN: "## Engine rules"}
	msgQueryHeading       = i18n.Msg{ES: "## Consulta", EN: "## Query"}
	msgWhatToAnswer       = i18n.Msg{ES: "## Qué contestar", EN: "## What to answer"}
)

// FixPrompt arma el pedido de "esto falló, explicá por qué y corregilo".
//
// El error va TAL CUAL lo devolvió el motor. Un `ORA-00942` lleva adentro más
// información que cualquier parafraseo, y el agente sabe leerlo.
func FixPrompt(dbType db.DBType, sqlText, errText string, schema SchemaContext) string {
	var b strings.Builder
	b.WriteString(i18n.T(i18n.Msg{
		ES: "Esta consulta de %s falló. Explicá en una o dos frases por qué, y devolvé la versión corregida.",
		EN: "This %s query failed. Explain why in one or two sentences, and return the corrected version.",
	}, dialectName(dbType)) + "\n\n")

	b.WriteString(i18n.T(i18n.Msg{ES: "## Error del motor", EN: "## Engine error"}) + "\n\n```\n")
	b.WriteString(errText)
	b.WriteString("\n```\n\n" + i18n.T(msgQueryHeading) + "\n\n```")
	b.WriteString(codeFence(dbType))
	b.WriteString("\n")
	b.WriteString(sqlText)
	b.WriteString("\n```\n\n" + i18n.T(msgSchemaHeading) + "\n\n```sql\n")
	b.WriteString(schema.Text)
	b.WriteString("```\n\n" + i18n.T(msgEngineRulesHeading) + "\n\n")
	b.WriteString(dialectRules(dbType))
	b.WriteString("\n\n" + i18n.T(i18n.Msg{
		ES: "Si el error es que una tabla o columna no existe, fijate en el esquema de arriba " +
			"cómo se llama en realidad en vez de suponerlo.",
		EN: "If the error is that a table or column does not exist, check in the schema above " +
			"what it is actually called instead of assuming it.",
	}) + "\n\n")
	b.WriteString(answerRules(dbType))
	return b.String()
}

// PlanPrompt arma el pedido de análisis de un plan de ejecución.
//
// Va con los hallazgos DETERMINISTAS que ya calculó backend/explain (nodos
// críticos, escaneos completos, estimaciones erradas) y no solo con el árbol
// crudo: la app ya sabe dónde está el problema, y lo que se le pide al agente
// es lo que la app no puede saber — por qué pasa y qué conviene hacer.
func PlanPrompt(dbType db.DBType, sqlText, planJSON, findings string, schema SchemaContext) string {
	var b strings.Builder
	b.WriteString(i18n.T(i18n.Msg{
		ES: "Analizá este plan de ejecución de %s y decime cómo hacer la consulta más rápida.",
		EN: "Analyze this %s execution plan and tell me how to make the query faster.",
	}, dialectName(dbType)) + "\n\n")

	b.WriteString(i18n.T(msgQueryHeading) + "\n\n```sql\n")
	b.WriteString(sqlText)
	b.WriteString("\n```\n\n")

	if strings.TrimSpace(findings) != "" {
		b.WriteString(i18n.T(i18n.Msg{ES: "## Lo que ya detectó la aplicación", EN: "## What the application already detected"}) + "\n\n")
		b.WriteString(findings)
		b.WriteString("\n\n")
	}

	b.WriteString(i18n.T(i18n.Msg{ES: "## Plan (JSON)", EN: "## Plan (JSON)"}) + "\n\n```json\n")
	b.WriteString(planJSON)
	b.WriteString("\n```\n\n" + i18n.T(msgSchemaHeading) + "\n\n```sql\n")
	b.WriteString(schema.Text)
	b.WriteString("```\n\n")

	b.WriteString(i18n.T(msgWhatToAnswer) + i18n.T(i18n.Msg{
		ES: `

1. Cuál es el cuello de botella real y por qué (una o dos frases, sin repetir el árbol entero).
2. Qué cambiar, en orden de impacto: reescribir la consulta, crear un índice, actualizar estadísticas.
3. Si proponés un índice, escribí el CREATE INDEX exacto para este motor, en un bloque de código aparte.

**No ejecutes nada.** El índice lo crea el usuario si está de acuerdo: un índice cuesta disco,
enlentece las escrituras y el orden de sus columnas depende de las otras consultas que corren
contra esa tabla, que no están acá.
`,
		EN: `

1. What the real bottleneck is and why (one or two sentences, without repeating the whole tree).
2. What to change, in order of impact: rewrite the query, create an index, update statistics.
3. If you propose an index, write the exact CREATE INDEX for this engine, in a separate code block.

**Do not execute anything.** The user creates the index if they agree: an index costs disk,
slows down writes, and the order of its columns depends on the other queries that run
against that table, which are not here.
`,
	}))
	return b.String()
}

// answerRules es el cierre común: cómo tiene que venir la respuesta para que
// la app pueda ofrecerla como reemplazo del editor.
func answerRules(dbType db.DBType) string {
	fence := codeFence(dbType)
	return i18n.T(i18n.Msg{
		ES: "## Cómo contestar\n\n" +
			"- Devolvé **un solo bloque de código ```%s** con la consulta completa y lista para correr.\n" +
			"- Antes del bloque, como mucho dos frases explicando qué hace o qué cambiaste. Sin preámbulo.\n" +
			"- Si el pedido es ambiguo, elegí la interpretación más probable, escribila igual y aclarála en esas dos frases.\n" +
			"- **No ejecutes nada ni te conectes a ninguna base**: el esquema que necesitás está arriba, y ejecutar la\n" +
			"  consulta lo decide el usuario.",
		EN: "## How to answer\n\n" +
			"- Return **a single ```%s code block** with the complete query, ready to run.\n" +
			"- Before the block, at most two sentences explaining what it does or what you changed. No preamble.\n" +
			"- If the request is ambiguous, pick the most likely interpretation, write it anyway and clarify it in those two sentences.\n" +
			"- **Do not execute anything or connect to any database**: the schema you need is above, and running the\n" +
			"  query is the user's decision.",
	}, fence)
}

// ExtractCode saca el primer bloque de código de una respuesta en Markdown.
//
// Los tres CLIs contestan en Markdown, así que la consulta viene entre vallas.
// Si no hay ninguna valla se devuelve el texto entero recortado: es preferible
// ofrecer algo que el usuario descarta a no ofrecer nada porque el agente
// contestó sin formato.
func ExtractCode(answer string) string {
	const fence = "```"
	start := strings.Index(answer, fence)
	if start < 0 {
		return strings.TrimSpace(answer)
	}
	rest := answer[start+len(fence):]
	// La primera línea después de la valla es el lenguaje, no contenido.
	if nl := strings.IndexByte(rest, '\n'); nl >= 0 {
		rest = rest[nl+1:]
	}
	end := strings.Index(rest, fence)
	if end < 0 {
		return strings.TrimSpace(rest)
	}
	return strings.TrimSpace(rest[:end])
}

// SSHErrorPrompt arma el pedido de "explicá este error de la terminal".
//
// El contexto de sistema va PRIMERO y en su propia sección: es lo que decide si
// la respuesta sirve. Un mismo error se arregla distinto en SunOS, RHEL, Ubuntu
// y Alpine —cambian el gestor de paquetes, las rutas, el init y hasta las
// banderas de los comandos—, y un agente sin ese dato contesta con la
// distribución más común de su entrenamiento.
//
// Cuando no se pudo averiguar, **se dice que no se sabe** en vez de callarlo:
// un agente que sabe que no sabe pregunta o da la respuesta portable, y las dos
// son mejores que una respuesta segura sobre el sistema equivocado.
//
// **Sin herramientas ni búsquedas web, pedido explícito.** Antigravity no tiene
// una bandera para apagarlas, y con este prompt salía a buscar en la web el
// banner de login, el usuario y el prompt del servidor (`"sgcpro" "sgcmain"`):
// tres búsquedas que llevaban la respuesta de ~10 s a ~40 s con el panel
// girando sin decir nada, y que mandaban nombres internos a un buscador.
func SSHErrorPrompt(serverName, osInfo, output string) string {
	var b strings.Builder
	b.WriteString(i18n.T(i18n.Msg{
		ES: "Explicá qué está fallando en esta salida de terminal del servidor %q y cómo arreglarlo.",
		EN: "Explain what is failing in this terminal output from the server %q and how to fix it.",
	}, serverName) + "\n\n")

	b.WriteString(i18n.T(i18n.Msg{ES: "## Sistema operativo del servidor", EN: "## Server operating system"}) + "\n\n")
	if strings.TrimSpace(osInfo) == "" {
		b.WriteString(i18n.T(i18n.Msg{
			ES: "No se pudo determinar. **No supongas que es Linux**: puede ser SunOS/Solaris, AIX o BSD.\n" +
				"Si la solución depende del sistema, decilo y ofrecé la variante portable, o pedí que se corra `uname -a`.",
			EN: "It could not be determined. **Do not assume it is Linux**: it may be SunOS/Solaris, AIX or BSD.\n" +
				"If the solution depends on the system, say so and offer the portable variant, or ask for `uname -a` to be run.",
		}) + "\n\n")
	} else {
		b.WriteString("```\n" + osInfo + "\n```\n\n" +
			i18n.T(i18n.Msg{
				ES: "Usá los comandos, rutas y gestor de paquetes de ESE sistema, no los de la distribución más común.",
				EN: "Use the commands, paths and package manager of THAT system, not those of the most common distribution.",
			}) + "\n\n")
	}

	b.WriteString(i18n.T(i18n.Msg{ES: "## Salida de la terminal", EN: "## Terminal output"}) + "\n\n```\n")
	b.WriteString(output)
	b.WriteString("\n```\n\n")

	b.WriteString(i18n.T(msgWhatToAnswer) + i18n.T(i18n.Msg{
		ES: `

1. Qué falló, en una o dos frases.
2. Por qué pasa.
3. Los comandos exactos para arreglarlo, en un bloque de código, **para el sistema operativo de arriba**.

**No ejecutes nada.** Devolvés texto: los comandos los corre el usuario en su terminal, donde puede
leerlos antes. Si alguno es destructivo o irreversible, decilo antes del bloque.

**No uses herramientas ni busques en la web**: todo lo que necesitás está arriba. Los nombres de servidor,
usuarios, rutas y prompts de esta salida son internos y no deben salir hacia ningún buscador.
`,
		EN: `

1. What failed, in one or two sentences.
2. Why it happens.
3. The exact commands to fix it, in a code block, **for the operating system above**.

**Do not execute anything.** You return text: the user runs the commands in their terminal, where they can
read them first. If any of them is destructive or irreversible, say so before the block.

**Do not use tools or search the web**: everything you need is above. The server names,
users, paths and prompts in this output are internal and must not go out to any search engine.
`,
	}))
	return b.String()
}
