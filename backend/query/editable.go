package query

import (
	"fmt"
	"regexp"
	"strings"
)

// Editar una fila del resultado: de qué tabla salió esta consulta.
//
// **Qué problema resuelve.** Corregir un dato mirando el resultado es lo que
// uno hace todo el tiempo, y hoy obliga a escribir el UPDATE a mano: copiar el
// nombre de la tabla, acordarse de la clave, escribir el WHERE. Un WHERE mal
// escrito ahí no es un error de tipeo, es una fila —o mil— cambiadas de más.
//
// **Y por eso el reconocimiento es deliberadamente estricto.** Solo se ofrece
// editar cuando no queda ninguna duda de a qué fila de qué tabla corresponde lo
// que se está mirando: un `SELECT` de UNA sola tabla, sin JOIN, sin UNION, sin
// GROUP BY, sin DISTINCT y sin subconsultas. Con un JOIN, la misma celda en
// pantalla puede venir de dos tablas distintas y "guardar" tendría que adivinar
// cuál — y adivinar, acá, se paga escribiendo en la base equivocada. Cuando no
// se puede, se dice **por qué**, que es lo que permite entender por qué esta
// consulta no se edita y la de al lado sí.
//
// El resto de la validación —que la tabla exista, que tenga clave primaria y
// que las columnas del resultado sean columnas reales— la hace quien tiene el
// catálogo (ver app_dbedit.go). Acá solo se lee la forma de la consulta.

// EditSource es la tabla que respalda un resultado.
type EditSource struct {
	// Schema queda vacío si la consulta no calificó la tabla.
	Schema string `json:"schema"`
	Table  string `json:"table"`
	// Alias con el que la consulta nombra la tabla, si le puso uno. Sirve para
	// entender `WHERE c.id = …`, no para el UPDATE.
	Alias string `json:"alias"`
}

// Estas expresiones se aplican sobre la consulta ya sin comentarios ni cadenas
// (ver stripNoise): así una tabla llamada `union_log` o un texto que diga
// 'join' no descalifican una consulta que sí era editable.
var (
	reSelect = regexp.MustCompile(`(?is)^\s*select\s+(.*?)\s+from\s+(.*)$`)
	// Cláusulas que cortan la parte "de dónde salen las filas". Lo que venga
	// después no cambia el origen: un ORDER BY o un LIMIT no hacen que el
	// resultado deje de ser una tabla.
	reTail = regexp.MustCompile(`(?is)\s+(where|group\s+by|having|order\s+by|limit|offset|fetch\s+first|fetch\s+next|for\s+update|window|qualify)\b`)
	// Nombre de tabla: `esquema.tabla`, con o sin comillas dobles, corchetes o
	// acentos graves según el motor.
	reTableName = regexp.MustCompile(`^(?:([\w$#]+|"[^"]+"|\[[^\]]+\]|` + "`[^`]+`" + `)\s*\.\s*)?([\w$#]+|"[^"]+"|\[[^\]]+\]|` + "`[^`]+`" + `)$`)
)

// DetectEditSource decide si un resultado se puede editar y de qué tabla es.
//
// Devuelve un motivo legible cuando NO se puede: es lo que después se muestra
// en la interfaz, y explicarlo evita la pregunta obvia ("¿por qué acá no me
// deja?").
func DetectEditSource(sqlText string) (EditSource, error) {
	clean := stripNoise(sqlText)
	clean = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(clean), ";"))

	if strings.Contains(clean, ";") {
		return EditSource{}, fmt.Errorf("hay más de una sentencia: editar filas necesita una sola consulta")
	}
	if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(clean)), "select") {
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(clean)), "with") {
			return EditSource{}, fmt.Errorf("las consultas con WITH no se editan: las filas salen de la CTE, no directamente de una tabla")
		}
		return EditSource{}, fmt.Errorf("solo se editan los resultados de un SELECT")
	}

	m := reSelect.FindStringSubmatch(clean)
	if m == nil {
		return EditSource{}, fmt.Errorf("no se pudo leer de qué tabla sale esta consulta")
	}
	list, rest := m[1], m[2]

	lowerList := strings.ToLower(list)
	if strings.Contains(lowerList, "distinct") {
		return EditSource{}, fmt.Errorf("con DISTINCT una fila del resultado puede representar varias de la tabla, así que no hay a cuál escribirle")
	}
	if strings.Contains(list, "(") {
		return EditSource{}, fmt.Errorf("la lista de columnas tiene funciones o expresiones: lo que se ve no es el valor guardado")
	}

	// De la parte del FROM en adelante, hasta la primera cláusula que corta.
	from := rest
	if t := reTail.FindStringIndex(rest); t != nil {
		from = rest[:t[0]]
	}
	from = strings.TrimSpace(from)

	lowerFrom := " " + strings.ToLower(from) + " "
	switch {
	case strings.Contains(from, "("):
		return EditSource{}, fmt.Errorf("el origen es una subconsulta, no una tabla")
	case strings.Contains(lowerFrom, " join "):
		return EditSource{}, fmt.Errorf("hay un JOIN: la misma celda podría venir de cualquiera de las tablas, y guardar tendría que adivinar cuál")
	case strings.Contains(from, ","):
		return EditSource{}, fmt.Errorf("hay más de una tabla en el FROM: no se puede saber a cuál pertenece cada columna")
	}
	if strings.Contains(strings.ToLower(rest), " union ") || strings.Contains(strings.ToLower(rest), " intersect ") {
		return EditSource{}, fmt.Errorf("la consulta combina varios resultados (UNION/INTERSECT): una fila puede venir de cualquiera de ellos")
	}
	if strings.Contains(strings.ToLower(rest), "group by") {
		return EditSource{}, fmt.Errorf("con GROUP BY cada fila del resultado resume varias de la tabla")
	}

	// `tabla alias` o `tabla AS alias`.
	fields := strings.Fields(from)
	if len(fields) == 0 {
		return EditSource{}, fmt.Errorf("no se pudo leer el nombre de la tabla")
	}
	src := EditSource{}
	name := fields[0]
	if len(fields) >= 2 {
		alias := fields[len(fields)-1]
		if !strings.EqualFold(alias, "as") && !strings.EqualFold(alias, name) {
			src.Alias = unquoteIdent(alias)
		}
	}
	if len(fields) > 3 {
		return EditSource{}, fmt.Errorf("no se pudo leer el nombre de la tabla")
	}

	nm := reTableName.FindStringSubmatch(name)
	if nm == nil {
		return EditSource{}, fmt.Errorf("no se pudo leer el nombre de la tabla")
	}
	src.Schema = unquoteIdent(nm[1])
	src.Table = unquoteIdent(nm[2])
	if src.Table == "" {
		return EditSource{}, fmt.Errorf("no se pudo leer el nombre de la tabla")
	}
	return src, nil
}

func unquoteIdent(s string) string {
	s = strings.TrimSpace(s)
	if len(s) < 2 {
		return s
	}
	switch {
	case s[0] == '"' && s[len(s)-1] == '"',
		s[0] == '`' && s[len(s)-1] == '`':
		return s[1 : len(s)-1]
	case s[0] == '[' && s[len(s)-1] == ']':
		return s[1 : len(s)-1]
	}
	return s
}

// stripNoise saca comentarios y vacía las cadenas.
//
// Es lo que evita el falso negativo más molesto: `WHERE nota = 'sin join'` no
// tiene ningún JOIN, y una tabla llamada `union_log` tampoco. Las cadenas se
// vacían en vez de borrarse para no pegar dos palabras que estaban separadas.
func stripNoise(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '-' && i+1 < len(s) && s[i+1] == '-':
			for i < len(s) && s[i] != '\n' {
				i++
			}
			b.WriteByte('\n')
		case c == '/' && i+1 < len(s) && s[i+1] == '*':
			end := strings.Index(s[i+2:], "*/")
			if end < 0 {
				return b.String()
			}
			i += end + 3
			b.WriteByte(' ')
		case c == '\'':
			b.WriteString("''")
			i++
			for i < len(s) {
				if s[i] == '\'' {
					if i+1 < len(s) && s[i+1] == '\'' {
						i += 2
						continue
					}
					break
				}
				i++
			}
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}
