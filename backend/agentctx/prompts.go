package agentctx

import (
	"fmt"
	"strings"

	"mini-tools/backend/db"
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
		return `- Limitar filas: FETCH FIRST n ROWS ONLY (12c+) o ROWNUM <= n. NUNCA LIMIT.
- Nulos: NVL/NVL2/COALESCE. Cadena vacía y NULL son lo mismo en Oracle.
- Fechas: TO_DATE/TO_CHAR con máscara explícita, SYSDATE, ADD_MONTHS, INTERVAL.
- Concatenación con || . Alias de tabla sin AS.
- Identificadores sin comillas son MAYÚSCULAS; respetá el caso del esquema tal cual viene arriba.`
	case db.DBTypePostgres:
		return `- Limitar filas: LIMIT n OFFSET m.
- Case-insensitive: ILIKE. Expresiones regulares: ~ / ~*.
- JSON/JSONB: ->, ->>, #>, jsonb_agg, jsonb_build_object.
- DISTINCT ON (col) es de Postgres y suele ser la respuesta correcta a "el último por cada X".
- Fechas: NOW(), CURRENT_DATE, INTERVAL '1 hour', date_trunc.`
	case db.DBTypeSQLite:
		return `- Limitar filas: LIMIT n OFFSET m.
- Tipado dinámico: no hay tipos estrictos; CAST cuando importe.
- Fechas: son texto/numéricas — usar date(), datetime(), strftime(), julianday().
- No hay RIGHT/FULL OUTER JOIN en versiones viejas; resolvé con LEFT JOIN.`
	case db.DBTypeSQLServer:
		return `- Limitar filas: SELECT TOP (n), u OFFSET n ROWS FETCH NEXT m ROWS ONLY (requiere ORDER BY).
- Fechas: GETDATE(), DATEADD, DATEDIFF, FORMAT/CONVERT con estilo.
- Nulos: ISNULL/COALESCE.
- CROSS APPLY / OUTER APPLY para correlacionadas; identificadores entre [corchetes].`
	case db.DBTypeMongo:
		return `- Respondé con sintaxis de mongosh: db.<colección>.find(...) o db.<colección>.aggregate([...]).
- Para agrupar, pipeline de agregación: $match primero (usa índices), después $group/$sort/$project.
- Fechas: ISODate("..."), operadores $gte/$lt sobre el campo de fecha.
- No inventes campos: usá solo los que aparecen en el esquema inferido de arriba.`
	case db.DBTypeRedis:
		return `- Respondé con comandos de redis-cli, uno por línea.
- Nunca uses KEYS en producción: SCAN con MATCH y COUNT.
- Respetá el tipo de cada clave (STRING/HASH/LIST/SET/ZSET/STREAM): un comando del tipo equivocado falla.
- Para Streams: XADD/XRANGE/XREAD; para expiración: TTL/EXPIRE.`
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
	fmt.Fprintf(&b, "Escribí una consulta para %s.\n\n", dialectName(dbType))

	b.WriteString("## Esquema\n\n```sql\n")
	b.WriteString(schema.Text)
	b.WriteString("```\n\n")

	if strings.TrimSpace(currentSQL) != "" {
		b.WriteString("## Consulta actual del editor\n\nHay que MODIFICARLA, no escribir una desde cero:\n\n```")
		b.WriteString(codeFence(dbType))
		b.WriteString("\n")
		b.WriteString(currentSQL)
		b.WriteString("\n```\n\n")
	}

	b.WriteString("## Lo que se pide\n\n")
	b.WriteString(request)
	b.WriteString("\n\n## Reglas del motor\n\n")
	b.WriteString(dialectRules(dbType))
	b.WriteString("\n\n" + answerRules(dbType))
	return b.String()
}

// FixPrompt arma el pedido de "esto falló, explicá por qué y corregilo".
//
// El error va TAL CUAL lo devolvió el motor. Un `ORA-00942` lleva adentro más
// información que cualquier parafraseo, y el agente sabe leerlo.
func FixPrompt(dbType db.DBType, sqlText, errText string, schema SchemaContext) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Esta consulta de %s falló. Explicá en una o dos frases por qué, y devolvé la versión corregida.\n\n", dialectName(dbType))

	b.WriteString("## Error del motor\n\n```\n")
	b.WriteString(errText)
	b.WriteString("\n```\n\n## Consulta\n\n```")
	b.WriteString(codeFence(dbType))
	b.WriteString("\n")
	b.WriteString(sqlText)
	b.WriteString("\n```\n\n## Esquema\n\n```sql\n")
	b.WriteString(schema.Text)
	b.WriteString("```\n\n## Reglas del motor\n\n")
	b.WriteString(dialectRules(dbType))
	b.WriteString("\n\nSi el error es que una tabla o columna no existe, fijate en el esquema de arriba " +
		"cómo se llama en realidad en vez de suponerlo.\n\n")
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
	fmt.Fprintf(&b, "Analizá este plan de ejecución de %s y decime cómo hacer la consulta más rápida.\n\n", dialectName(dbType))

	b.WriteString("## Consulta\n\n```sql\n")
	b.WriteString(sqlText)
	b.WriteString("\n```\n\n")

	if strings.TrimSpace(findings) != "" {
		b.WriteString("## Lo que ya detectó la aplicación\n\n")
		b.WriteString(findings)
		b.WriteString("\n\n")
	}

	b.WriteString("## Plan (JSON)\n\n```json\n")
	b.WriteString(planJSON)
	b.WriteString("\n```\n\n## Esquema\n\n```sql\n")
	b.WriteString(schema.Text)
	b.WriteString("```\n\n")

	b.WriteString(`## Qué contestar

1. Cuál es el cuello de botella real y por qué (una o dos frases, sin repetir el árbol entero).
2. Qué cambiar, en orden de impacto: reescribir la consulta, crear un índice, actualizar estadísticas.
3. Si proponés un índice, escribí el CREATE INDEX exacto para este motor, en un bloque de código aparte.

**No ejecutes nada.** El índice lo crea el usuario si está de acuerdo: un índice cuesta disco,
enlentece las escrituras y el orden de sus columnas depende de las otras consultas que corren
contra esa tabla, que no están acá.
`)
	return b.String()
}

// answerRules es el cierre común: cómo tiene que venir la respuesta para que
// la app pueda ofrecerla como reemplazo del editor.
func answerRules(dbType db.DBType) string {
	fence := codeFence(dbType)
	return fmt.Sprintf(`## Cómo contestar

- Devolvé **un solo bloque de código `+"```"+`%s** con la consulta completa y lista para correr.
- Antes del bloque, como mucho dos frases explicando qué hace o qué cambiaste. Sin preámbulo.
- Si el pedido es ambiguo, elegí la interpretación más probable, escribila igual y aclarála en esas dos frases.
- **No ejecutes nada ni te conectes a ninguna base**: el esquema que necesitás está arriba, y ejecutar la
  consulta lo decide el usuario.`, fence)
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
