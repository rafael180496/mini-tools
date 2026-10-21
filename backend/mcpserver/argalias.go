package mcpserver

import "strings"

// Los modelos adivinan el nombre de los argumentos: mandan `sql` donde la
// herramienta pide `query`, `note` en vez de `title`, `alias` en vez de
// `connection`. Antes eso volvía como «falta X» y costaba una vuelta por cada
// tropiezo (medido en ScadLab con Antigravity/Gemini, que comparte este patrón).
// NormalizeArgs lo corrige antes de ejecutar la herramienta: por cada propiedad
// del esquema que falta, toma el valor de un sinónimo conocido que el esquema NO
// declara. Un sinónimo que la herramienta sí declara nunca se mueve, y un
// argumento ya presente no se pisa.

// argAliases: nombre canónico → sinónimos que mandan los modelos.
var argAliases = map[string][]string{
	"connection": {"conn", "connection_alias", "connection_name", "alias", "database", "db", "name"},
	"query":      {"sql", "q", "search", "text", "pattern", "statement", "term"},
	"title":      {"note", "note_title", "name", "file", "note_name"},
	"content":    {"text", "body", "markdown", "contents", "note_content"},
	"folder":     {"path", "directory", "dir", "folder_name", "folder_path"},
	"heading":    {"section", "header", "section_title"},
	"repo":       {"repository", "path", "project", "dir", "repo_path"},
	"server":     {"host", "ssh", "connection", "alias", "name"},
	"tag":        {"tags", "label"},
}

// NormalizeArgs devuelve args con los sinónimos movidos a su nombre canónico,
// según las propiedades que declara el esquema JSON de la herramienta. No
// modifica el mapa recibido.
func NormalizeArgs(schema map[string]any, args map[string]any) map[string]any {
	props, _ := schema["properties"].(map[string]any)
	if len(props) == 0 || len(args) == 0 {
		return args
	}
	out := make(map[string]any, len(args))
	for k, v := range args {
		out[k] = v
	}
	// Otra capitalización o guiones: `Query`, `note-title`.
	for k, v := range args {
		if _, ok := props[k]; ok {
			continue
		}
		norm := strings.ReplaceAll(strings.ToLower(k), "-", "_")
		if _, ok := props[norm]; ok {
			if _, taken := out[norm]; !taken {
				out[norm] = v
				delete(out, k)
			}
		}
	}
	for canon := range props {
		if argPresent(out[canon]) {
			continue
		}
		for _, alias := range argAliases[canon] {
			if _, declared := props[alias]; declared {
				continue // la herramienta lo usa con su propio sentido
			}
			if v, ok := out[alias]; ok && argPresent(v) {
				out[canon] = v
				delete(out, alias)
				break
			}
		}
	}
	return out
}

// argPresent: el valor cuenta como dado (un "" o null no tapa un sinónimo).
func argPresent(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case string:
		return strings.TrimSpace(x) != ""
	}
	return true
}
