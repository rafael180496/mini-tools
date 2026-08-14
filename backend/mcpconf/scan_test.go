package mcpconf

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestReadProjectMCPJSON(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, ".mcp.json"), `{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgres://localhost/db"],
      "env": {"PGPASSWORD": "supersecreto", "PGUSER": "admin"}
    },
    "remoto": {"type": "http", "url": "https://mcp.ejemplo.com/api"},
    "futuro": {"command": "algo", "campoQueNoConocemos": {"a": 1}}
  }
}`)

	servers, f := readJSONServers(filepath.Join(root, ".mcp.json"), "claude", ScopeProject)

	if !f.Present || f.Error != "" || f.Servers != 3 {
		t.Fatalf("archivo mal leído: %+v", f)
	}
	// Orden alfabético estable, no el del mapa de Go.
	if servers[0].Name != "futuro" || servers[1].Name != "postgres" || servers[2].Name != "remoto" {
		t.Errorf("los servidores no vienen ordenados: %+v", servers)
	}

	pg := servers[1]
	if pg.Transport != TransportStdio || pg.Command != "npx" || len(pg.Args) != 3 {
		t.Errorf("servidor stdio mal normalizado: %+v", pg)
	}
	// Lo más importante de todo el paquete: las claves sí, los valores NUNCA.
	if len(pg.EnvKeys) != 2 || pg.EnvKeys[0] != "PGPASSWORD" || pg.EnvKeys[1] != "PGUSER" {
		t.Errorf("las claves de env deberían venir ordenadas y completas: %+v", pg.EnvKeys)
	}
	for _, blob := range []string{pg.Command, pg.URL, strings.Join(pg.Args, " "), strings.Join(pg.EnvKeys, " ")} {
		if strings.Contains(blob, "supersecreto") {
			t.Fatalf("un valor de env se filtró al modelo que cruza el binding: %q", blob)
		}
	}

	if r := servers[2]; r.Transport != TransportHTTP || r.URL != "https://mcp.ejemplo.com/api" {
		t.Errorf("servidor remoto mal normalizado: %+v", r)
	}
	// Un campo desconocido no puede tirar la entrada abajo.
	if servers[0].Command != "algo" {
		t.Errorf("una entrada con un campo desconocido debe leerse igual: %+v", servers[0])
	}
}

// Un archivo roto se INFORMA. Sin esto, "no tengo servidores MCP" y "mi
// archivo tiene un error de sintaxis" se ven exactamente igual.
func TestBrokenJSONIsReported(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, ".mcp.json"), `{"mcpServers": {`)

	servers, f := readJSONServers(filepath.Join(root, ".mcp.json"), "claude", ScopeProject)

	if len(servers) != 0 {
		t.Errorf("no debería devolver servidores de un archivo roto: %+v", servers)
	}
	if !f.Present || f.Error == "" {
		t.Errorf("un archivo presente y roto debe reportar el error: %+v", f)
	}
}

// Los servidores por proyecto de ~/.claude.json son los que explican el caso
// más confuso: aparecen en un repo y no en otro sin que nada del repo los
// mencione.
func TestClaudeUserFilePerProjectServers(t *testing.T) {
	home := t.TempDir()
	repo := "/Users/alguien/proyectos/mi-repo"
	writeFile(t, filepath.Join(home, ".claude.json"), `{
  "mcpServers": {"global": {"command": "g"}},
  "projects": {
    "`+repo+`": {"mcpServers": {"solo-de-este-repo": {"command": "x"}}},
    "/otro/repo": {"mcpServers": {"ajeno": {"command": "y"}}}
  }
}`)

	servers, f := readClaudeUserFile(filepath.Join(home, ".claude.json"), repo)

	if f.Error != "" || len(servers) != 2 {
		t.Fatalf("se esperaban el global y el del proyecto: %+v (%+v)", servers, f)
	}
	byName := map[string]Server{}
	for _, s := range servers {
		byName[s.Name] = s
	}
	if _, ok := byName["ajeno"]; ok {
		t.Error("se coló un servidor de OTRO proyecto")
	}
	if byName["global"].Scope != ScopeUser {
		t.Errorf("el global debe ser de scope user: %+v", byName["global"])
	}
	// Vive en el archivo del usuario pero aplica solo a este proyecto: el
	// scope describe a qué aplica, no dónde está escrito.
	if byName["solo-de-este-repo"].Scope != ScopeProject {
		t.Errorf("el del proyecto debe ser de scope project: %+v", byName["solo-de-este-repo"])
	}
}

func TestReadCodexTOML(t *testing.T) {
	home := t.TempDir()
	writeFile(t, filepath.Join(home, ".codex", "config.toml"), `
# Config de Codex
model = "o3"

[mcp_servers.github]
command = "npx"
args = [
  "-y",
  "@modelcontextprotocol/server-github",   # comentario adentro del array
]
env = { GITHUB_TOKEN = "ghp_secretisimo", OTRA = "1" }

[mcp_servers."con.punto"]
command = "raro"

[mcp_servers.remoto]
type = "sse"
url = "https://ejemplo.com/sse#frag"

[mcp_servers.github.env]
EXTRA = "2"

[otra_seccion]
command = "no-es-un-mcp"
`)

	servers, f := readCodexTOML(filepath.Join(home, ".codex", "config.toml"))

	if !f.Present || f.Error != "" {
		t.Fatalf("archivo mal leído: %+v", f)
	}
	if len(servers) != 3 {
		t.Fatalf("se esperaban 3 servidores, hay %d: %+v", len(servers), servers)
	}

	byName := map[string]Server{}
	for _, s := range servers {
		byName[s.Name] = s
	}

	gh := byName["github"]
	if gh.Command != "npx" || len(gh.Args) != 2 || gh.Args[1] != "@modelcontextprotocol/server-github" {
		t.Errorf("array multilínea con comentario mal leído: %+v", gh.Args)
	}
	// La tabla en línea y la subsección [mcp_servers.github.env] se suman.
	if len(gh.EnvKeys) != 3 || gh.EnvKeys[0] != "EXTRA" || gh.EnvKeys[1] != "GITHUB_TOKEN" || gh.EnvKeys[2] != "OTRA" {
		t.Errorf("claves de env mal reunidas: %+v", gh.EnvKeys)
	}
	for _, k := range gh.EnvKeys {
		if strings.Contains(k, "ghp_") {
			t.Fatalf("un valor de env se filtró como si fuera una clave: %q", k)
		}
	}

	// Un nombre con punto no se parte en dos.
	if _, ok := byName["con.punto"]; !ok {
		t.Errorf("un nombre entre comillas con punto debe quedar entero: %+v", servers)
	}
	// El # de un fragmento de URL no es un comentario.
	if r := byName["remoto"]; r.Transport != TransportSSE || r.URL != "https://ejemplo.com/sse#frag" {
		t.Errorf("servidor sse mal leído: %+v", r)
	}
	// Una sección que no es mcp_servers no aporta servidores.
	if _, ok := byName["otra_seccion"]; ok {
		t.Error("se leyó una sección que no es de mcp_servers")
	}
}

// El caso normal: nada configurado. Se informan igual los archivos mirados,
// que es lo que convierte "no aparece mi servidor" en una pregunta
// contestable.
func TestScanReportsWhereItLooked(t *testing.T) {
	cfg := Scan(t.TempDir())

	if cfg.Servers == nil || cfg.Files == nil {
		t.Fatal("las listas vacías deben serializar como [] y no como null")
	}
	if len(cfg.Files) < 4 {
		t.Errorf("deberían informarse todos los archivos consultados: %+v", cfg.Files)
	}
	for _, f := range cfg.Files {
		if f.Path == "" || f.Agent == "" {
			t.Errorf("archivo consultado sin identificar: %+v", f)
		}
	}
}

// Lo que se puede escribir y lo que no. El límite no es cosmético: escribir
// mal el archivo de otro programa rompe el setup de alguien.
func TestWritableBoundary(t *testing.T) {
	cases := []struct {
		f    File
		want bool
	}{
		{File{Path: "/repo/.mcp.json", Agent: "claude"}, true},
		{File{Path: "/repo/.gemini/settings.json", Agent: "gemini"}, true},
		// El archivo de ESTADO de Claude Code, no un config de MCP.
		{File{Path: "/home/u/.claude.json", Agent: "claude"}, false},
		// Sin escritor de TOML.
		{File{Path: "/home/u/.codex/config.toml", Agent: "codex"}, false},
	}
	for _, c := range cases {
		if got := Writable(c.f); got != c.want {
			t.Errorf("Writable(%q) = %v, se esperaba %v", c.f.Path, got, c.want)
		}
	}
}

// La propiedad que sostiene todo lo demás: lo que no se toca vuelve intacto.
func TestUpsertPreservesUnknownKeys(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".mcp.json")
	writeFile(t, path, `{
  "algoQueNoConocemos": {"anidado": [1, 2, {"x": true}]},
  "mcpServers": {"viejo": {"command": "old", "campoRaro": 42}}
}`)

	if err := UpsertServer(path, ServerInput{
		Name: "nuevo", Transport: TransportStdio, Command: "npx",
		Args: []string{"-y", "server"}, Env: map[string]string{"TOKEN": "abc"},
	}); err != nil {
		t.Fatal(err)
	}

	var root map[string]any
	data, _ := os.ReadFile(path)
	if err := json.Unmarshal(data, &root); err != nil {
		t.Fatalf("el archivo quedó ilegible: %v\n%s", err, data)
	}

	// La clave ajena sobrevive con su estructura entera.
	unknown, _ := json.Marshal(root["algoQueNoConocemos"])
	if string(unknown) != `{"anidado":[1,2,{"x":true}]}` {
		t.Errorf("se perdió o alteró una clave ajena: %s", unknown)
	}

	servers, _ := root["mcpServers"].(map[string]any)
	if len(servers) != 2 {
		t.Fatalf("se esperaban los dos servidores: %v", servers)
	}
	// Y el servidor que ya estaba conserva su campo desconocido.
	old, _ := json.Marshal(servers["viejo"])
	if !strings.Contains(string(old), "campoRaro") {
		t.Errorf("se perdió un campo desconocido del servidor existente: %s", old)
	}

	// Se dejó copia antes de tocar nada.
	if _, err := os.Stat(path + ".mini-tools.bak"); err != nil {
		t.Errorf("no se hizo backup antes de escribir: %v", err)
	}

	// Y lo escrito se vuelve a leer con el lector normal.
	got, f := readJSONServers(path, "claude", ScopeProject)
	if f.Error != "" || len(got) != 2 {
		t.Fatalf("round-trip fallido: %+v (%+v)", got, f)
	}
	for _, s := range got {
		if s.Name == "nuevo" && (s.Command != "npx" || len(s.EnvKeys) != 1 || s.EnvKeys[0] != "TOKEN") {
			t.Errorf("el servidor nuevo se escribió mal: %+v", s)
		}
	}
}

func TestRemoveServerAndEmptyBlock(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".mcp.json")
	writeFile(t, path, `{"otra": 1, "mcpServers": {"solo": {"command": "x"}}}`)

	if err := RemoveServer(path, "solo"); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if strings.Contains(string(data), "mcpServers") {
		t.Errorf("un bloque vacío debe quitarse, no quedar como {}: %s", data)
	}
	if !strings.Contains(string(data), `"otra"`) {
		t.Errorf("se perdió el resto del archivo: %s", data)
	}

	// Borrar algo que no está no es un error: el resultado pedido ya se cumple.
	if err := RemoveServer(path, "inexistente"); err != nil {
		t.Errorf("borrar un servidor ausente no debería fallar: %v", err)
	}
}

// Un archivo que no se pudo entender NO se reescribe: es la forma más rápida
// de destruirlo.
func TestBrokenFileIsNotOverwritten(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".mcp.json")
	original := `{"mcpServers": {`
	writeFile(t, path, original)

	if err := UpsertServer(path, ServerInput{Name: "x", Transport: TransportStdio, Command: "c"}); err == nil {
		t.Error("se esperaba un error sobre un archivo ilegible")
	}
	data, _ := os.ReadFile(path)
	if string(data) != original {
		t.Errorf("el archivo roto fue modificado: %s", data)
	}
}
