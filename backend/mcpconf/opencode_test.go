package mcpconf

import (
	"path/filepath"
	"strings"
	"testing"
)

// El config de OpenCode es JSONC: comentarios y comas finales tienen que
// leerse, y una `//` dentro de una cadena (una URL) no es un comentario.
func TestReadOpencodeFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "opencode.jsonc")
	writeFile(t, path, `{
  // servidores
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "github": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-github"],
      "environment": { "GITHUB_TOKEN": "ghp_secretisimo", },
    },
    /* remoto */
    "docs": { "type": "remote", "url": "https://ejemplo.com/mcp" },
    "apagado": { "type": "local", "command": ["x"], "enabled": false },
  },
}`)

	servers, f := readOpencodeFile(path, ScopeUser)
	if !f.Present || f.Error != "" {
		t.Fatalf("archivo mal leído: %+v", f)
	}
	if len(servers) != 2 {
		t.Fatalf("se esperaban 2 servidores (el apagado no cuenta): %+v", servers)
	}
	by := map[string]Server{}
	for _, s := range servers {
		by[s.Name] = s
	}
	gh := by["github"]
	if gh.Transport != TransportStdio || gh.Command != "npx" || strings.Join(gh.Args, " ") != "-y @modelcontextprotocol/server-github" {
		t.Errorf("el comando es un arreglo con el ejecutable primero: %+v", gh)
	}
	if strings.Join(gh.EnvKeys, ",") != "GITHUB_TOKEN" {
		t.Errorf("solo las claves de environment: %+v", gh.EnvKeys)
	}
	if d := by["docs"]; d.Transport != TransportHTTP || d.URL != "https://ejemplo.com/mcp" {
		t.Errorf("remote es http y la URL no se corta en el //: %+v", d)
	}
	if Writable(f) {
		t.Error("un config de OpenCode no se escribe: perdería los comentarios")
	}
	if Writable(File{Path: filepath.Join(dir, "opencode.json")}) {
		t.Error("tampoco con extensión .json: se reconoce por el nombre")
	}
}
