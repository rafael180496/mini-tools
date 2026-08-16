package agentctx

import (
	"fmt"
	"sort"
	"strings"

	"mini-tools/backend/db"
)

// Contexto de esquema para los dos motores que no son relacionales.
//
// **La regla que los separa del resto: acá el esquema y los datos están mucho
// más cerca de lo que parece.** En una base relacional el catálogo es una cosa
// y las filas son otra; en Mongo el "esquema" se infiere muestreando
// documentos reales, y en Redis la lista de claves ES contenido —una clave
// `sesion:usuario:rafael@empresa.com` lleva un dato personal adentro del
// nombre—.
//
// Por eso estas dos funciones son deliberadamente más pobres que el DDL
// relacional: van los NOMBRES de campo con sus tipos BSON (nunca un valor
// muestreado), y en Redis van PATRONES de clave con su tipo (nunca las claves
// completas ni, por supuesto, sus valores).

// MongoCollection es lo que hace falta de una colección para escribir una
// consulta contra ella.
type MongoCollection struct {
	Name    string
	Count   int64
	Indexes []string
	// Fields son las rutas de campo inferidas con su tipo BSON. Nunca traen
	// un valor de ejemplo: el tipo alcanza para escribir el filtro, y un
	// valor de ejemplo es un dato del usuario.
	Fields []string
}

// BuildMongoContext escribe el contexto de una base Mongo.
func BuildMongoContext(database string, colls []MongoCollection, hintText string) SchemaContext {
	out := SchemaContext{TotalTables: len(colls)}
	if len(colls) == 0 {
		out.Text = "(no se pudieron listar las colecciones de esta conexión)"
		return out
	}

	words := tokenize(hintText)
	var picked []MongoCollection
	for _, c := range colls {
		if words[strings.ToLower(c.Name)] {
			picked = append(picked, c)
		}
	}

	var b strings.Builder
	fmt.Fprintf(&b, "// Base: %s (%d colecciones)\n\n", database, len(colls))

	if len(picked) == 0 {
		// Igual que en el caso relacional: si el pedido no nombra ninguna, se
		// listan los nombres para que el agente pida la que necesita en vez de
		// inventarle campos a una colección que no vio.
		names := make([]string, 0, len(colls))
		for _, c := range colls {
			names = append(names, c.Name)
		}
		sort.Strings(names)
		b.WriteString("// El pedido no menciona ninguna colección conocida. Disponibles:\n")
		b.WriteString("// " + strings.Join(names, ", ") + "\n")
		b.WriteString("// Si necesitás los campos de alguna, pedila antes de escribir la consulta.\n")
		out.Text = b.String()
		return out
	}

	if len(picked) > maxContextTables {
		picked = picked[:maxContextTables]
	}
	for _, c := range picked {
		out.Included = append(out.Included, c.Name)
		fmt.Fprintf(&b, "// Colección %s (~%d documentos)\n", c.Name, c.Count)
		if len(c.Fields) > 0 {
			b.WriteString("//   campos: " + strings.Join(c.Fields, ", ") + "\n")
		}
		if len(c.Indexes) > 0 {
			b.WriteString("//   índices: " + strings.Join(c.Indexes, ", ") + "\n")
		}
		b.WriteString("\n")
	}
	b.WriteString("// Los campos salen de muestrear documentos: pueden faltar los de documentos raros.\n")
	out.Text = b.String()
	return out
}

// BuildRedisContext escribe el contexto de una conexión Redis a partir de una
// muestra de claves.
//
// **Lo que entra son PATRONES, no claves.** `sesion:usuario:12345` y
// `sesion:usuario:67890` se colapsan a `sesion:usuario:*`, que es lo que el
// agente necesita para escribir un SCAN correcto y lo que evita que una lista
// de identificadores reales —o de correos, o de documentos— salga de la
// máquina dentro de un nombre de clave.
func BuildRedisContext(keys []db.RedisKeyEntry, totalKeys int64) SchemaContext {
	out := SchemaContext{TotalTables: int(totalKeys)}
	if len(keys) == 0 {
		out.Text = "// (no se pudo muestrear ninguna clave de esta conexión)"
		return out
	}

	// patrón → tipos vistos y cuántas claves cayeron ahí.
	type agg struct {
		types map[string]bool
		count int
	}
	byPattern := map[string]*agg{}
	for _, k := range keys {
		p := keyPattern(k.Key)
		a := byPattern[p]
		if a == nil {
			a = &agg{types: map[string]bool{}}
			byPattern[p] = a
		}
		a.types[k.Type] = true
		a.count++
	}

	patterns := make([]string, 0, len(byPattern))
	for p := range byPattern {
		patterns = append(patterns, p)
	}
	sort.Slice(patterns, func(i, j int) bool { return byPattern[patterns[i]].count > byPattern[patterns[j]].count })
	if len(patterns) > 40 {
		patterns = patterns[:40]
	}

	var b strings.Builder
	fmt.Fprintf(&b, "# Patrones de clave observados (muestra de %d claves", len(keys))
	if totalKeys > 0 {
		fmt.Fprintf(&b, " sobre ~%d en la base", totalKeys)
	}
	b.WriteString(")\n#\n")
	for _, p := range patterns {
		a := byPattern[p]
		types := make([]string, 0, len(a.types))
		for t := range a.types {
			types = append(types, t)
		}
		sort.Strings(types)
		fmt.Fprintf(&b, "# %-44s %-8s ~%d claves\n", p, strings.Join(types, "/"), a.count)
		out.Included = append(out.Included, p)
	}
	b.WriteString("#\n# Son PATRONES, no claves reales: los identificadores están reemplazados por *.\n")
	b.WriteString("# Ningún valor de ninguna clave está incluido acá.\n")
	return finishRedis(&b, out)
}

func finishRedis(b *strings.Builder, out SchemaContext) SchemaContext {
	out.Text = b.String()
	return out
}

// keyPattern reemplaza por `*` los segmentos que parecen identificadores.
//
// La heurística es a propósito conservadora: un segmento se anonimiza si tiene
// algún dígito, una arroba, o es largo (un UUID, un hash). Ante la duda se
// anonimiza — dejar pasar un identificador es peor que perder una pista sobre
// la forma de la clave.
func keyPattern(key string) string {
	parts := strings.Split(key, ":")
	for i, p := range parts {
		if looksLikeID(p) {
			parts[i] = "*"
		}
	}
	return strings.Join(parts, ":")
}

func looksLikeID(s string) bool {
	if len(s) >= 16 {
		return true
	}
	for _, r := range s {
		if (r >= '0' && r <= '9') || r == '@' || r == '.' || r == '-' {
			return true
		}
	}
	return false
}
