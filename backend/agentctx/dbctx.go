package agentctx

import (
	"fmt"
	"sort"
	"strings"

	"mini-tools/backend/db"
)

// Contexto de esquema para el asistente de consultas.
//
// El problema que resuelve: un esquema Oracle real tiene cientos de tablas con
// decenas de columnas cada una. Mandárselo entero al agente no es caro, es
// **inútil** — llena su ventana de contexto y desplaza la pregunta. Y mandarle
// solo la tabla que uno nombró tampoco alcanza: una consulta que sirva casi
// siempre cruza dos o tres por sus claves foráneas.
//
// Entonces se eligen las tablas RELEVANTES: las que el pedido menciona, más las
// que se alcanzan desde ellas por FK. Es una heurística, no un analizador
// semántico, y por eso el resultado dice explícitamente cuántas tablas hay en
// total y cuáles se incluyeron — un contexto recortado en silencio hace que el
// agente razone sobre un esquema que cree completo.

const (
	// maxContextTables es cuántas tablas entran con su DDL completo.
	maxContextTables = 12
	// maxNameOnlyTables es cuántos NOMBRES se listan cuando el pedido no
	// menciona ninguna en particular. Un nombre cuesta cuatro palabras y le
	// permite al agente pedir la que necesita en vez de inventarla.
	maxNameOnlyTables = 120
)

// SchemaContext es el bloque de esquema que se le pasa al agente, más lo que
// hace falta para poder decir qué quedó afuera.
type SchemaContext struct {
	// Text es el bloque listo para el prompt.
	Text string
	// Included son las tablas que fueron con su DDL.
	Included []string
	// TotalTables es cuántas hay en la conexión.
	TotalTables int
}

// BuildSchemaContext elige las tablas relevantes para un pedido en lenguaje
// natural (o para una consulta que hay que corregir) y las escribe como DDL.
//
// `text` es de donde salen las pistas: el pedido del usuario y, cuando existe,
// la consulta que se está editando — el nombre de una tabla aparece mucho más
// seguido en el SQL que en la frase.
func BuildSchemaContext(meta *db.SchemaMetadata, dbType db.DBType, text string) SchemaContext {
	if meta == nil || len(meta.Tables) == 0 {
		return SchemaContext{Text: "(no se pudo leer el esquema de esta conexión)"}
	}

	byName := make(map[string]*db.Table, len(meta.Tables))
	for i := range meta.Tables {
		byName[strings.ToLower(meta.Tables[i].Name)] = &meta.Tables[i]
	}

	words := tokenize(text)
	picked := map[string]*db.Table{}
	for i := range meta.Tables {
		t := &meta.Tables[i]
		if words[strings.ToLower(t.Name)] {
			picked[strings.ToLower(t.Name)] = t
		}
	}

	// Cierre por claves foráneas, un salto. Dos saltos ya arrastra medio
	// esquema en una base normalizada y deja de acotar nada.
	for _, t := range tablesOf(picked) {
		for _, fk := range t.ForeignKeys {
			ref := strings.ToLower(fk.ReferencedTable)
			if r, ok := byName[ref]; ok {
				picked[ref] = r
			}
		}
		// También al revés: las que apuntan a esta. Es como se llega de
		// "clientes" a "facturas", que es la mitad de las preguntas reales.
		for i := range meta.Tables {
			cand := &meta.Tables[i]
			for _, fk := range cand.ForeignKeys {
				if strings.EqualFold(fk.ReferencedTable, t.Name) {
					picked[strings.ToLower(cand.Name)] = cand
				}
			}
		}
	}

	out := SchemaContext{TotalTables: len(meta.Tables)}
	list := tablesOf(picked)
	sort.Slice(list, func(i, j int) bool { return list[i].Name < list[j].Name })
	if len(list) > maxContextTables {
		list = list[:maxContextTables]
	}

	var b strings.Builder
	if len(list) == 0 {
		// Nada reconocible en el pedido: se listan los NOMBRES para que el
		// agente sepa qué hay, sin gastar contexto en columnas que quizá no
		// necesite.
		b.WriteString(fmt.Sprintf("-- El pedido no menciona ninguna tabla conocida. Tablas disponibles (%d):\n", len(meta.Tables)))
		names := make([]string, 0, len(meta.Tables))
		for i := range meta.Tables {
			names = append(names, qualifiedName(meta.Tables[i]))
		}
		sort.Strings(names)
		if len(names) > maxNameOnlyTables {
			names = names[:maxNameOnlyTables]
			b.WriteString("-- (lista recortada)\n")
		}
		b.WriteString("-- " + strings.Join(names, ", ") + "\n")
		b.WriteString("-- Si necesitás el detalle de alguna, pedilo antes de escribir la consulta.\n")
		out.Text = b.String()
		return out
	}

	b.WriteString(fmt.Sprintf("-- Esquema de %s (%d de %d tablas, elegidas por lo que menciona el pedido)\n\n",
		dialectName(dbType), len(list), len(meta.Tables)))
	for _, t := range list {
		out.Included = append(out.Included, qualifiedName(*t))
		b.WriteString(tableDDL(*t))
		b.WriteString("\n")
	}
	if len(meta.Tables) > len(list) {
		b.WriteString(fmt.Sprintf("-- Hay %d tablas más en esta conexión que no se incluyeron acá.\n", len(meta.Tables)-len(list)))
	}
	out.Text = b.String()
	return out
}

func tablesOf(m map[string]*db.Table) []*db.Table {
	out := make([]*db.Table, 0, len(m))
	for _, t := range m {
		out = append(out, t)
	}
	return out
}

// tokenize parte el texto en palabras comparables con nombres de tabla.
//
// Se queda con las palabras "desnudas" y también con la última parte de un
// nombre calificado (`SGCPRO.ACTIONS` → `actions`), que es como se escriben las
// tablas en el SQL que uno está editando.
func tokenize(s string) map[string]bool {
	out := map[string]bool{}
	var cur strings.Builder
	flush := func() {
		if cur.Len() == 0 {
			return
		}
		w := strings.ToLower(cur.String())
		cur.Reset()
		out[w] = true
		if i := strings.LastIndexByte(w, '.'); i >= 0 && i < len(w)-1 {
			out[w[i+1:]] = true
		}
		// Singular ingenuo: "clientes" en la frase, `CLIENTE` en la base.
		if strings.HasSuffix(w, "es") && len(w) > 4 {
			out[strings.TrimSuffix(w, "es")] = true
		}
		if strings.HasSuffix(w, "s") && len(w) > 3 {
			out[strings.TrimSuffix(w, "s")] = true
		}
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '$', r == '#', r == '.':
			cur.WriteRune(r)
		default:
			flush()
		}
	}
	flush()
	return out
}

func qualifiedName(t db.Table) string {
	if t.Schema == "" {
		return t.Name
	}
	return t.Schema + "." + t.Name
}

// tableDDL escribe la tabla como un CREATE TABLE legible.
//
// Como SQL y no como JSON a propósito: los tres CLIs leen SQL mucho mejor que
// un objeto anidado, y el formato ya dice qué es clave y qué es referencia sin
// tener que explicarlo en el prompt.
func tableDDL(t db.Table) string {
	var b strings.Builder
	fmt.Fprintf(&b, "CREATE TABLE %s (\n", qualifiedName(t))
	for i, c := range t.Columns {
		fmt.Fprintf(&b, "    %s %s", c.Name, c.DataType)
		if !c.Nullable {
			b.WriteString(" NOT NULL")
		}
		if c.IsPrimaryKey {
			b.WriteString(" /* PK */")
		}
		if i < len(t.Columns)-1 {
			b.WriteString(",")
		}
		b.WriteString("\n")
	}
	b.WriteString(");\n")
	for _, fk := range t.ForeignKeys {
		fmt.Fprintf(&b, "-- FK: %s.%s -> %s.%s\n", t.Name, fk.Column, fk.ReferencedTable, fk.ReferencedColumn)
	}
	return b.String()
}
