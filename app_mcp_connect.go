package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"mini-tools/backend/agents"
	"mini-tools/backend/i18n"
	"mini-tools/backend/mcpconf"
)

// Conectar el servidor MCP de mini-tools a cada CLI sin copiar configuración a
// mano (fase 1 de .claude/specs/harness-mejoras.md).
//
// El servidor MCP es la puerta de todo lo demás: sin él, el agente no ve el
// cerebro ni los datos de la app. Hasta ahora *Acceso de la IA* mostraba un
// fragmento para copiar en cada CLI; acá la app lo hace sola **solo donde es
// seguro**:
//
//   - **Claude Code**: con su propio comando (`claude mcp add --scope user`).
//     Su configuración vive en `~/.claude.json`, que es su archivo de ESTADO, y
//     no se reescribe desde afuera (ver mcpconf/write.go).
//   - **Antigravity**: se escribe su `mcp_config.json`, que mcpconf ya sabe
//     editar preservando lo ajeno y con copia de respaldo.
//   - **Codex y OpenCode**: no. Sus archivos son TOML y JSONC, y reescribirlos
//     perdería comentarios o claves que esta app no entiende. Se sigue
//     ofreciendo copiar.

// mcpServerName es el nombre con el que mini-tools se registra en cada CLI. Es
// el mismo que muestran los fragmentos para copiar.
const mcpServerName = "mini-tools"

// MCPConnection es el estado del servidor MCP de mini-tools en UN agente.
type MCPConnection struct {
	Agent string `json:"agent"`
	Label string `json:"label"`
	// Installed es si el CLI está en esta máquina.
	Installed bool `json:"installed"`
	// Connected es si su configuración ya tiene a mini-tools.
	Connected bool `json:"connected"`
	// Stale: está configurado, pero apunta a OTRO ejecutable (una versión
	// movida de lugar, o una compilación de desarrollo). El agente lanzaría un
	// binario que ya no existe o que no es este.
	Stale bool `json:"stale"`
	// Source es el archivo donde figura, para poder decir dónde mirar.
	Source string `json:"source"`
	// CanConnect es si la app puede conectarlo sola en este agente.
	CanConnect bool `json:"canConnect"`
}

// mcpConnectable son los agentes que la app sabe conectar sola.
var mcpConnectable = map[string]bool{"claude": true, "antigravity": true}

// MCPConnections informa, por agente del catálogo, si mini-tools ya está en su
// configuración de MCP.
func (a *App) MCPConnections() ([]MCPConnection, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	list, err := a.ListAgents()
	if err != nil {
		return nil, err
	}
	exe, _ := os.Executable()
	// Sin repositorio: lo que interesa es la configuración de la máquina, que
	// es donde se registra un servidor que vale para todos los proyectos.
	return mcpConnectionsFrom(list, mcpconf.Scan("").Servers, exe), nil
}

func mcpConnectionsFrom(list []agents.Agent, servers []mcpconf.Server, exe string) []MCPConnection {
	out := make([]MCPConnection, 0, len(list))
	for _, ag := range list {
		c := MCPConnection{Agent: ag.ID, Label: ag.Label, Installed: ag.Available, CanConnect: mcpConnectable[ag.ID]}
		for _, s := range servers {
			if s.Agent != ag.ID || s.Scope != mcpconf.ScopeUser || !isMiniToolsServer(s) {
				continue
			}
			c.Connected, c.Source = true, s.Source
			c.Stale = exe != "" && !sameExecutable(s.Command, exe)
			break
		}
		out = append(out, c)
	}
	return out
}

// isMiniToolsServer reconoce la entrada de mini-tools por su nombre o por cómo
// se lanza (`<algo>/mini-tools --mcp`): quien la agregó a mano pudo ponerle
// otro nombre.
func isMiniToolsServer(s mcpconf.Server) bool {
	if s.Name == mcpServerName {
		return true
	}
	base := strings.TrimSuffix(strings.ToLower(filepath.Base(s.Command)), ".exe")
	for _, arg := range s.Args {
		if arg == "--mcp" && strings.HasPrefix(base, "mini-tools") {
			return true
		}
	}
	return false
}

// sameExecutable compara resolviendo enlaces: un alias en /usr/local/bin y el
// binario dentro del .app son el mismo programa.
func sameExecutable(a, b string) bool {
	ca, cb := filepath.Clean(a), filepath.Clean(b)
	if ra, err := filepath.EvalSymlinks(ca); err == nil {
		ca = ra
	}
	if rb, err := filepath.EvalSymlinks(cb); err == nil {
		cb = rb
	}
	return ca == cb
}

// mcpConnectTimeout acota el `claude mcp …`: es una escritura local que tarda
// menos de un segundo.
const mcpConnectTimeout = 20 * time.Second

// ConnectMCP registra el servidor MCP de mini-tools en un agente. Si ya estaba
// apuntando a otro ejecutable, lo reemplaza: es el caso de una app movida de
// lugar, y dejarlo así haría que el agente lance un binario que no existe.
func (a *App) ConnectMCP(agentID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return i18n.Errorf(i18n.Msg{ES: "app: no se pudo saber dónde está mini-tools: %w", EN: "app: couldn't tell where mini-tools is: %w"}, err)
	}

	switch agentID {
	case "claude":
		agent, err := a.agentByID(agentID)
		if err != nil {
			return err
		}
		if !agent.Available {
			return i18n.Errorf(i18n.Msg{ES: "app: Claude Code no está instalado", EN: "app: Claude Code is not installed"})
		}
		argv := agents.Launcher(agent.Path)
		run := func(args ...string) (string, error) {
			ctx, cancel := context.WithTimeout(context.Background(), mcpConnectTimeout)
			defer cancel()
			cmd := exec.CommandContext(ctx, argv[0], append(argv[1:], args...)...)
			cmd.Env = agents.Env()
			out, err := cmd.CombinedOutput()
			return strings.TrimSpace(string(out)), err
		}
		// Se quita primero lo que hubiera: `mcp add` no reemplaza una entrada
		// existente. Que no exista no es un error.
		_, _ = run("mcp", "remove", "--scope", "user", mcpServerName)
		if out, err := run("mcp", "add", "--scope", "user", mcpServerName, "--", exe, "--mcp"); err != nil {
			if out == "" {
				out = err.Error()
			}
			return i18n.Errorf(i18n.Msg{ES: "app: Claude Code no pudo agregar el servidor: %s", EN: "app: Claude Code couldn't add the server: %s"}, out)
		}
		return nil

	case "antigravity":
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		// La ubicación del CLI actual (la misma que lee mcpconf.Scan primero).
		return connectAntigravityAt(filepath.Join(home, ".gemini", "config", "mcp_config.json"), exe)
	}
	return i18n.Errorf(i18n.Msg{ES: "app: %s se conecta copiando la configuración; la app no reescribe su archivo", EN: "app: %s is connected by copying the configuration; the app doesn't rewrite its file"}, agentID)
}

// connectAntigravityAt escribe la entrada de mini-tools en el config de
// Antigravity que está en path. Aparte de ConnectMCP para poder probarlo contra
// un directorio temporal sin tocar el ~/.gemini real.
func connectAntigravityAt(path, exe string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return mcpconf.UpsertServer(path, mcpconf.ServerInput{
		Name:      mcpServerName,
		Transport: mcpconf.TransportStdio,
		Command:   exe,
		Args:      []string{"--mcp"},
	})
}
