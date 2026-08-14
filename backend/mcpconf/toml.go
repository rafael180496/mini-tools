package mcpconf

import (
	"bufio"
	"fmt"
	"os"
	"sort"
	"strings"
)

// Lectura del config de Codex (~/.codex/config.toml), donde los servidores MCP
// viven en secciones `[mcp_servers.<nombre>]`.
//
// Por qué un lector a mano y no una librería de TOML: la regla de
// dependencias mínimas (.claude/rules/technical.md punto 12) y el mismo
// criterio que ya se aplicó con el frontmatter y con el parsing de SQL. Lo que
// hace falta leer es un puñado de claves escalares, un array de strings y una
// tabla de entorno; un parser de TOML completo —fechas, enteros con guiones
// bajos, arrays de tablas, strings multilínea— sería traer una gramática
// entera para eso.
//
// **Lo que este lector NO cubre, dicho explícitamente**: strings multilínea
// (`"""`), arrays de tablas (`[[...]]`) y valores que no sean string, array de
// strings o tabla en línea. Nada de eso aparece hoy en una sección
// `mcp_servers`. Si apareciera, la clave se ignora y el servidor se lista
// igual con lo que sí se entendió — el mismo modo de fallo que el resto del
// paquete, y la razón por la que esto es aceptable siendo SOLO LECTURA. Si
// alguna vez se escribe este archivo (tarea 4.7 del plan), este lector no
// alcanza: escribir exige preservar lo que no se entiende, y para eso hay que
// discutir traer un parser de verdad.

// readCodexTOML lee las secciones [mcp_servers.*] de un config.toml.
func readCodexTOML(path string) ([]Server, File) {
	f := File{Path: path, Agent: "codex", Scope: ScopeUser}

	fh, err := os.Open(path)
	if err != nil {
		return nil, f
	}
	defer fh.Close()
	f.Present = true

	// Acumulador por nombre de servidor: las claves de un servidor pueden
	// venir en su sección y también en subsecciones ([mcp_servers.x.env]).
	found := map[string]*Server{}
	order := []string{}

	get := func(name string) *Server {
		if s, ok := found[name]; ok {
			return s
		}
		s := &Server{Name: name, Agent: "codex", Scope: ScopeUser, Transport: TransportStdio, Args: []string{}, Source: path}
		found[name] = s
		order = append(order, name)
		return s
	}

	var current *Server
	var subsection string

	sc := bufio.NewScanner(fh)
	// Un config.toml es un archivo de configuración, no un log: una línea de
	// 1 MB significa que esto no es lo que creemos que es.
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)

	for sc.Scan() {
		line := strings.TrimSpace(stripComment(sc.Text()))
		if line == "" {
			continue
		}

		if strings.HasPrefix(line, "[") {
			current, subsection = nil, ""
			// [[array of tables]] no se usa acá; ignorarlo entero es correcto.
			if strings.HasPrefix(line, "[[") {
				continue
			}
			parts := splitTOMLKey(strings.TrimSuffix(strings.TrimPrefix(line, "["), "]"))
			if len(parts) >= 2 && parts[0] == "mcp_servers" {
				current = get(parts[1])
				if len(parts) >= 3 {
					subsection = parts[2]
				}
			}
			continue
		}

		if current == nil {
			continue
		}

		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.Trim(strings.TrimSpace(key), `"'`)
		value = strings.TrimSpace(value)

		// Dentro de [mcp_servers.x.env] cada clave ES una variable de entorno.
		// Solo se guarda el nombre: el valor es exactamente donde viaja el
		// token (ver la nota del paquete).
		if subsection == "env" {
			current.EnvKeys = append(current.EnvKeys, key)
			continue
		}

		switch key {
		case "command":
			current.Command = unquoteTOML(value)
		case "args":
			current.Args = parseTOMLArray(value, sc)
		case "url":
			current.URL = unquoteTOML(value)
			if current.Transport == TransportStdio {
				current.Transport = TransportHTTP
			}
		case "type":
			switch unquoteTOML(value) {
			case "sse":
				current.Transport = TransportSSE
			case "http", "streamable_http":
				current.Transport = TransportHTTP
			}
		case "env":
			current.EnvKeys = append(current.EnvKeys, parseInlineTableKeys(value)...)
		}
	}
	if err := sc.Err(); err != nil {
		f.Error = fmt.Sprintf("no se pudo leer el archivo: %v", err)
		return nil, f
	}

	out := make([]Server, 0, len(order))
	for _, name := range order {
		s := found[name]
		sort.Strings(s.EnvKeys)
		out = append(out, *s)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	f.Servers = len(out)
	return out, f
}

// stripComment corta el comentario final, respetando un # que esté dentro de
// comillas (aparece en un token o en una URL con fragmento).
func stripComment(line string) string {
	inSingle, inDouble := false, false
	for i, r := range line {
		switch r {
		case '\'':
			if !inDouble {
				inSingle = !inSingle
			}
		case '"':
			if !inSingle {
				inDouble = !inDouble
			}
		case '#':
			if !inSingle && !inDouble {
				return line[:i]
			}
		}
	}
	return line
}

// splitTOMLKey parte una clave con puntos respetando las comillas: un servidor
// puede llamarse "mi.servidor" y entonces el punto no separa nada.
func splitTOMLKey(key string) []string {
	var parts []string
	var buf strings.Builder
	inQuote := rune(0)

	for _, r := range key {
		switch {
		case inQuote != 0:
			if r == inQuote {
				inQuote = 0
			} else {
				buf.WriteRune(r)
			}
		case r == '"' || r == '\'':
			inQuote = r
		case r == '.':
			parts = append(parts, strings.TrimSpace(buf.String()))
			buf.Reset()
		default:
			buf.WriteRune(r)
		}
	}
	if s := strings.TrimSpace(buf.String()); s != "" || len(parts) > 0 {
		parts = append(parts, s)
	}
	return parts
}

func unquoteTOML(v string) string {
	v = strings.TrimSpace(v)
	if len(v) >= 2 {
		if (v[0] == '"' && v[len(v)-1] == '"') || (v[0] == '\'' && v[len(v)-1] == '\'') {
			return v[1 : len(v)-1]
		}
	}
	return v
}

// parseTOMLArray lee un array de strings, siguiendo hasta cerrar el corchete
// si está escrito en varias líneas — que es como se escribe un `args` largo, o
// sea el caso normal y no el raro.
func parseTOMLArray(value string, sc *bufio.Scanner) []string {
	text := value
	for strings.Count(text, "[") > strings.Count(text, "]") && sc.Scan() {
		text += " " + strings.TrimSpace(stripComment(sc.Text()))
	}

	start, end := strings.Index(text, "["), strings.LastIndex(text, "]")
	if start < 0 || end < start {
		return []string{}
	}

	out := []string{}
	for _, item := range splitTopLevel(text[start+1:end], ',') {
		if item = strings.TrimSpace(item); item != "" {
			out = append(out, unquoteTOML(item))
		}
	}
	return out
}

// parseInlineTableKeys saca los NOMBRES de una tabla en línea
// (`env = { A = "1", B = "2" }`). Los valores no se leen a propósito.
func parseInlineTableKeys(value string) []string {
	start, end := strings.Index(value, "{"), strings.LastIndex(value, "}")
	if start < 0 || end < start {
		return nil
	}

	var keys []string
	for _, pair := range splitTopLevel(value[start+1:end], ',') {
		if k, _, ok := strings.Cut(pair, "="); ok {
			if k = strings.Trim(strings.TrimSpace(k), `"'`); k != "" {
				keys = append(keys, k)
			}
		}
	}
	return keys
}

// splitTopLevel parte por sep ignorando lo que esté entre comillas o dentro de
// corchetes/llaves anidados — una coma dentro de un argumento no separa
// elementos.
func splitTopLevel(s string, sep rune) []string {
	var out []string
	var buf strings.Builder
	inQuote := rune(0)
	depth := 0

	for _, r := range s {
		switch {
		case inQuote != 0:
			if r == inQuote {
				inQuote = 0
			}
			buf.WriteRune(r)
		case r == '"' || r == '\'':
			inQuote = r
			buf.WriteRune(r)
		case r == '[' || r == '{':
			depth++
			buf.WriteRune(r)
		case r == ']' || r == '}':
			depth--
			buf.WriteRune(r)
		case r == sep && depth == 0:
			out = append(out, buf.String())
			buf.Reset()
		default:
			buf.WriteRune(r)
		}
	}
	out = append(out, buf.String())
	return out
}
