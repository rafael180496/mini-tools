package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mini-tools/backend/agents"
	"mini-tools/backend/mcpconf"
)

func testAgents() []agents.Agent {
	return []agents.Agent{
		{ID: "claude", Label: "Claude Code", Available: true},
		{ID: "codex", Label: "Codex CLI", Available: true},
		{ID: "opencode", Label: "OpenCode", Available: false},
		{ID: "antigravity", Label: "Antigravity CLI", Available: true},
	}
}

func byAgent(list []MCPConnection, id string) MCPConnection {
	for _, c := range list {
		if c.Agent == id {
			return c
		}
	}
	return MCPConnection{}
}

func TestMCPConnectionsFrom(t *testing.T) {
	exe := filepath.Join(t.TempDir(), "mini-tools")
	other := filepath.Join(t.TempDir(), "mini-tools")

	servers := []mcpconf.Server{
		// Conectado a este ejecutable, por nombre.
		{Name: "mini-tools", Agent: "claude", Scope: mcpconf.ScopeUser, Command: exe, Args: []string{"--mcp"}, Source: "/home/u/.claude.json"},
		// Desactualizado: otro ejecutable.
		{Name: "mini-tools", Agent: "antigravity", Scope: mcpconf.ScopeUser, Command: other, Args: []string{"--mcp"}, Source: "/home/u/.gemini/config/mcp_config.json"},
		// Solo en scope proyecto: no cuenta como conectado.
		{Name: "mini-tools", Agent: "codex", Scope: mcpconf.ScopeProject, Command: exe, Args: []string{"--mcp"}},
	}
	got := mcpConnectionsFrom(testAgents(), servers, exe)
	if len(got) != 4 {
		t.Fatalf("esperaba una entrada por agente, hay %d", len(got))
	}

	cl := byAgent(got, "claude")
	if !cl.Connected || cl.Stale || cl.Source != "/home/u/.claude.json" || !cl.Installed || !cl.CanConnect {
		t.Errorf("claude: %+v", cl)
	}
	ag := byAgent(got, "antigravity")
	if !ag.Connected || !ag.Stale || !ag.CanConnect {
		t.Errorf("antigravity debería estar conectado pero desactualizado: %+v", ag)
	}
	cx := byAgent(got, "codex")
	if cx.Connected || cx.CanConnect {
		t.Errorf("codex: solo scope proyecto y no se conecta solo: %+v", cx)
	}
	oc := byAgent(got, "opencode")
	if oc.Connected || oc.Installed || oc.CanConnect {
		t.Errorf("opencode: %+v", oc)
	}
}

func TestMCPConnectionsFromRecognizesByCommand(t *testing.T) {
	exe := filepath.Join(t.TempDir(), "mini-tools")
	// Con otro nombre de servidor, pero lanzando mini-tools --mcp.
	servers := []mcpconf.Server{
		{Name: "mt", Agent: "claude", Scope: mcpconf.ScopeUser, Command: exe, Args: []string{"--mcp"}},
	}
	c := byAgent(mcpConnectionsFrom(testAgents(), servers, exe), "claude")
	if !c.Connected || c.Stale {
		t.Errorf("debería reconocerse por el comando: %+v", c)
	}
}

func TestMCPConnectionsFromSameExecutableThroughSymlink(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "mini-tools")
	if err := os.WriteFile(exe, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "alias")
	if err := os.Symlink(exe, link); err != nil {
		t.Skip("sin symlinks en este entorno")
	}
	servers := []mcpconf.Server{
		{Name: "mini-tools", Agent: "claude", Scope: mcpconf.ScopeUser, Command: link, Args: []string{"--mcp"}},
	}
	if c := byAgent(mcpConnectionsFrom(testAgents(), servers, exe), "claude"); c.Stale {
		t.Errorf("un alias al mismo binario no es desactualizado: %+v", c)
	}
}

func TestIsMiniToolsServer(t *testing.T) {
	cases := []struct {
		name string
		s    mcpconf.Server
		want bool
	}{
		{"por nombre", mcpconf.Server{Name: "mini-tools"}, true},
		{"por comando", mcpconf.Server{Name: "otro", Command: "/Applications/mini-tools.app/Contents/MacOS/mini-tools", Args: []string{"--mcp"}}, true},
		{"windows .exe", mcpconf.Server{Name: "otro", Command: "C:/Apps/Mini-Tools.exe", Args: []string{"--mcp"}}, true},
		{"mini-tools sin --mcp", mcpconf.Server{Name: "otro", Command: "/usr/bin/mini-tools", Args: []string{"--version"}}, false},
		{"otro programa con --mcp", mcpconf.Server{Name: "github", Command: "/usr/bin/github-mcp", Args: []string{"--mcp"}}, false},
		{"remoto", mcpconf.Server{Name: "x", URL: "https://example.com/mcp"}, false},
	}
	for _, c := range cases {
		if got := isMiniToolsServer(c.s); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

// Antigravity se escribe contra un directorio temporal: nunca el ~/.gemini real.
func TestConnectAntigravityAt(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	path := filepath.Join(home, ".gemini", "config", "mcp_config.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	// Una entrada ajena que tiene que sobrevivir.
	if err := os.WriteFile(path, []byte(`{"mcpServers":{"github":{"command":"gh-mcp"}},"otraClave":1}`), 0o600); err != nil {
		t.Fatal(err)
	}

	exe := filepath.Join(home, "bin", "mini-tools")
	if err := connectAntigravityAt(path, exe); err != nil {
		t.Fatal(err)
	}

	servers := mcpconf.Scan("").Servers
	var names []string
	for _, s := range servers {
		names = append(names, s.Name)
	}
	got := byAgent(mcpConnectionsFrom(testAgents(), servers, exe), "antigravity")
	if !got.Connected || got.Stale {
		t.Errorf("tras conectar debería figurar conectado y al día: %+v (servidores: %v)", got, names)
	}
	hasGithub := false
	for _, s := range servers {
		if s.Name == "github" {
			hasGithub = true
		}
	}
	if !hasGithub {
		t.Error("la entrada ajena se perdió")
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), "otraClave") {
		t.Error("se perdió una clave ajena del archivo")
	}

	// Reconectar con otro ejecutable lo reemplaza, no lo duplica.
	exe2 := filepath.Join(home, "nuevo", "mini-tools")
	if err := connectAntigravityAt(path, exe2); err != nil {
		t.Fatal(err)
	}
	got = byAgent(mcpConnectionsFrom(testAgents(), mcpconf.Scan("").Servers, exe2), "antigravity")
	if !got.Connected || got.Stale {
		t.Errorf("tras reconectar: %+v", got)
	}
}
