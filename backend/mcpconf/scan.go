package mcpconf

import (
	"os"
	"path/filepath"
	"sort"
)

// Scan lee todos los configs MCP que aplican a este repositorio.
//
// No devuelve error: un archivo que no existe es el caso normal (la mayoría de
// las máquinas no tiene los tres CLIs configurados) y uno que no se puede
// parsear se informa en su File, no aborta el resto. Perder los servidores de
// Gemini porque el TOML de Codex tiene una coma de más sería el peor
// resultado posible.
func Scan(repoRoot string) Config {
	cfg := Config{Servers: []Server{}, Files: []File{}}

	add := func(servers []Server, f File) {
		// Se resuelve acá, en un solo lugar, para que la lectura y la UI no
		// puedan tener dos ideas distintas de qué se puede escribir.
		f.Writable = Writable(f)
		cfg.Servers = append(cfg.Servers, servers...)
		cfg.Files = append(cfg.Files, f)
	}

	if repoRoot != "" {
		// Claude Code: el .mcp.json del proyecto es el único de estos que se
		// versiona y viaja con el repositorio — el resto es de la máquina.
		add(readJSONServers(filepath.Join(repoRoot, ".mcp.json"), "claude", ScopeProject))
		add(readJSONServers(filepath.Join(repoRoot, ".gemini", "settings.json"), "antigravity", ScopeProject))
	}

	if home, err := os.UserHomeDir(); err == nil {
		// ~/.claude.json tiene su propio lector porque además de los
		// servidores globales guarda unos POR PROYECTO, que son los que
		// explican el caso más confuso: un servidor que aparece en un
		// repositorio y no en otro sin que nada del repositorio lo mencione.
		add(readClaudeUserFile(filepath.Join(home, ".claude.json"), repoRoot))
		add(readCodexTOML(filepath.Join(home, ".codex", "config.toml")))
		// Dos ubicaciones para el mismo agente: `~/.gemini/config/mcp_config.json`
		// es la que usa el CLI actual (verificada en una instalación real) y
		// `~/.gemini/settings.json` la del nombre anterior. Se miran las dos
		// porque una instalación vieja puede seguir teniendo la segunda, y
		// mirar de más solo cuesta un stat que falla.
		add(readJSONServers(filepath.Join(home, ".gemini", "config", "mcp_config.json"), "antigravity", ScopeUser))
		add(readJSONServers(filepath.Join(home, ".gemini", "settings.json"), "antigravity", ScopeUser))
	}

	// Primero lo del proyecto y después lo de la máquina; dentro de cada
	// grupo, por agente y por nombre. Lo que viaja con el repositorio es lo
	// que se busca primero.
	sort.SliceStable(cfg.Servers, func(i, j int) bool {
		a, b := cfg.Servers[i], cfg.Servers[j]
		if a.Scope != b.Scope {
			return a.Scope == ScopeProject
		}
		if a.Agent != b.Agent {
			return a.Agent < b.Agent
		}
		return a.Name < b.Name
	})
	return cfg
}
