package mcpconf

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
)

// Lectura de los configs en JSON: Claude Code (.mcp.json del proyecto,
// ~/.claude.json del usuario) y Gemini (.gemini/settings.json, en el proyecto
// y en el home).
//
// Los dos comparten la misma forma para el bloque que importa —un objeto
// `mcpServers` cuyas claves son los nombres— así que se leen con el mismo
// código y se diferencian solo en dónde está ese bloque dentro del archivo.

// rawServer es una entrada tal como viene, con los campos que se entienden.
// Todo lo demás del objeto se ignora en silencio: cada CLI agrega los suyos
// (`trust`, `timeout`, `disabled`, `cwd`…) y fallar por un campo que no
// conocemos sería romperse con cada versión nueva de un programa ajeno.
type rawServer struct {
	Type    string            `json:"type"`
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env"`
	URL     string            `json:"url"`
	HTTPURL string            `json:"httpUrl"`
}

// toServer normaliza una entrada cruda.
func (r rawServer) toServer(name, agent string, scope Scope, source string) Server {
	s := Server{
		Name:    name,
		Agent:   agent,
		Scope:   scope,
		Command: r.Command,
		Args:    r.Args,
		Source:  source,
		EnvKeys: envKeys(r.Env),
	}

	// El transporte se deduce en vez de confiar solo en `type`: no todos los
	// CLIs lo escriben, y una entrada con `url` y sin `command` es remota sin
	// importar lo que diga (o no diga) el campo.
	switch {
	case r.Type == "sse":
		s.Transport, s.URL = TransportSSE, firstNonEmpty(r.URL, r.HTTPURL)
	case r.Type == "http" || r.HTTPURL != "" || (r.URL != "" && r.Command == ""):
		s.Transport, s.URL = TransportHTTP, firstNonEmpty(r.HTTPURL, r.URL)
	default:
		s.Transport = TransportStdio
	}
	if s.Args == nil {
		s.Args = []string{}
	}
	return s
}

// envKeys devuelve las claves ordenadas. Los valores se descartan acá, en el
// punto más cercano a la lectura, para que no haya un camino por el que puedan
// llegar más arriba.
func envKeys(env map[string]string) []string {
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// claudeUserFile es la forma de ~/.claude.json que nos interesa: servidores
// globales arriba, y servidores POR PROYECTO bajo `projects`, indexados por la
// ruta absoluta del proyecto.
//
// Los de `projects` son los que explican el caso más confuso de todos: un
// servidor que aparece en un repositorio y no en otro sin que ningún archivo
// del repositorio lo mencione.
type claudeUserFile struct {
	MCPServers map[string]rawServer `json:"mcpServers"`
	Projects   map[string]struct {
		MCPServers map[string]rawServer `json:"mcpServers"`
	} `json:"projects"`
}

// readJSONServers lee un archivo con un `mcpServers` en la raíz.
func readJSONServers(path, agent string, scope Scope) ([]Server, File) {
	f := File{Path: path, Agent: agent, Scope: scope}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, f
	}
	f.Present = true

	var doc struct {
		MCPServers map[string]rawServer `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		f.Error = fmt.Sprintf("no se pudo leer como JSON: %v", err)
		return nil, f
	}

	out := serversFrom(doc.MCPServers, agent, scope, path)
	f.Servers = len(out)
	return out, f
}

// readClaudeUserFile lee ~/.claude.json, sumando los servidores globales y los
// del proyecto abierto.
func readClaudeUserFile(path, repoRoot string) ([]Server, File) {
	f := File{Path: path, Agent: "claude", Scope: ScopeUser}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, f
	}
	f.Present = true

	var doc claudeUserFile
	if err := json.Unmarshal(data, &doc); err != nil {
		f.Error = fmt.Sprintf("no se pudo leer como JSON: %v", err)
		return nil, f
	}

	out := serversFrom(doc.MCPServers, "claude", ScopeUser, path)

	// Los del proyecto se marcan con scope de proyecto aunque vivan en el
	// archivo del usuario: lo que describe el scope es a qué aplica el
	// servidor, no en qué archivo está escrito.
	if p, ok := doc.Projects[repoRoot]; ok {
		out = append(out, serversFrom(p.MCPServers, "claude", ScopeProject, path)...)
	}

	f.Servers = len(out)
	return out, f
}

func serversFrom(raw map[string]rawServer, agent string, scope Scope, source string) []Server {
	if len(raw) == 0 {
		return nil
	}
	names := make([]string, 0, len(raw))
	for name := range raw {
		names = append(names, name)
	}
	sort.Strings(names)

	out := make([]Server, 0, len(names))
	for _, name := range names {
		out = append(out, raw[name].toServer(name, agent, scope, source))
	}
	return out
}
