package mcpconf

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Estos tests existen por una excepción a la regla «no tests»: las funciones
// editan un archivo GLOBAL del usuario (~/.gemini/antigravity-cli). Siempre
// corren contra t.TempDir(), nunca contra el home real.

const testServer = "mini-tools"

func agyPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "antigravity-cli", "settings.json")
}

func writeAgyFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// readDoc lee el archivo como mapa genérico y devuelve la lista allow.
func readDoc(t *testing.T, path string) (map[string]any, []string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatalf("el archivo escrito no es JSON: %v\n%s", err, data)
	}
	var allow []string
	if p, ok := doc["permissions"].(map[string]any); ok {
		if a, ok := p["allow"].([]any); ok {
			for _, v := range a {
				if s, ok := v.(string); ok {
					allow = append(allow, s)
				}
			}
		}
	}
	return doc, allow
}

func TestSyncAgyPermissions_CreatesFromScratch(t *testing.T) {
	path := agyPath(t)
	changed, err := SyncAgyPermissions(path, testServer, []string{"vault_search_notes", "db_get_schema"})
	if err != nil || !changed {
		t.Fatalf("changed=%v err=%v", changed, err)
	}
	_, allow := readDoc(t, path)
	want := []string{"mcp(mini-tools/vault_search_notes)", "mcp(mini-tools/db_get_schema)"}
	if !reflect.DeepEqual(allow, want) {
		t.Fatalf("allow = %v, quería %v", allow, want)
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
		t.Errorf("permisos del archivo = %v, quería 0600", info.Mode().Perm())
	}
	if info, _ := os.Stat(filepath.Dir(path)); info.Mode().Perm() != 0o700 {
		t.Errorf("permisos de la carpeta = %v, quería 0700", info.Mode().Perm())
	}
}

func TestSyncAgyPermissions_MergesForeignContent(t *testing.T) {
	path := agyPath(t)
	writeAgyFile(t, path, `{
  "theme": "dark",
  "model": {"name": "x", "n": 3},
  "permissions": {
    "allow": ["command(git status)", "mcp(otro/herramienta)", "mcp(mini-tools/vieja)", 42],
    "deny": ["command(rm *)"],
    "extra": true
  }
}`)
	changed, err := SyncAgyPermissions(path, testServer, []string{"nueva"})
	if err != nil || !changed {
		t.Fatalf("changed=%v err=%v", changed, err)
	}
	doc, allow := readDoc(t, path)

	want := []string{"command(git status)", "mcp(otro/herramienta)", "mcp(mini-tools/nueva)"}
	if !reflect.DeepEqual(allow, want) {
		t.Fatalf("allow = %v, quería %v", allow, want)
	}
	// La entrada que no es texto sigue ahí.
	data, _ := os.ReadFile(path)
	if !strings.Contains(string(data), "42") {
		t.Errorf("se perdió la entrada no textual de allow:\n%s", data)
	}
	if doc["theme"] != "dark" {
		t.Errorf("se perdió theme: %v", doc["theme"])
	}
	if m, _ := doc["model"].(map[string]any); m["name"] != "x" || m["n"] != float64(3) {
		t.Errorf("se alteró model: %v", doc["model"])
	}
	perms := doc["permissions"].(map[string]any)
	if d, _ := perms["deny"].([]any); len(d) != 1 || d[0] != "command(rm *)" {
		t.Errorf("se alteró deny: %v", perms["deny"])
	}
	if perms["extra"] != true {
		t.Errorf("se perdió permissions.extra")
	}
	// Había archivo: tiene que haber respaldo.
	if _, err := os.Stat(path + ".mini-tools.bak"); err != nil {
		t.Errorf("falta la copia de respaldo: %v", err)
	}
}

func TestSyncAgyPermissions_Idempotent(t *testing.T) {
	path := agyPath(t)
	tools := []string{"a", "b"}
	if _, err := SyncAgyPermissions(path, testServer, tools); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(path)
	os.Remove(path + ".mini-tools.bak")

	changed, err := SyncAgyPermissions(path, testServer, tools)
	if err != nil || changed {
		t.Fatalf("segunda sincronización: changed=%v err=%v", changed, err)
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Errorf("el archivo cambió sin necesidad")
	}
	if _, err := os.Stat(path + ".mini-tools.bak"); err == nil {
		t.Errorf("se escribió un respaldo sin cambios")
	}
}

func TestSyncAgyPermissions_RemovesStaleAndKeepsOrder(t *testing.T) {
	path := agyPath(t)
	if _, err := SyncAgyPermissions(path, testServer, []string{"a", "b", "c"}); err != nil {
		t.Fatal(err)
	}
	if _, err := SyncAgyPermissions(path, testServer, []string{"a", "c"}); err != nil {
		t.Fatal(err)
	}
	_, allow := readDoc(t, path)
	want := []string{"mcp(mini-tools/a)", "mcp(mini-tools/c)"}
	if !reflect.DeepEqual(allow, want) {
		t.Fatalf("allow = %v, quería %v", allow, want)
	}
}

func TestSyncAgyPermissions_DoesNotTouchSimilarServer(t *testing.T) {
	path := agyPath(t)
	writeAgyFile(t, path, `{"permissions":{"allow":["mcp(mini-tools-otro/x)","mcp(mini-tools/y)"]}}`)
	if _, err := SyncAgyPermissions(path, testServer, nil); err != nil {
		t.Fatal(err)
	}
	_, allow := readDoc(t, path)
	if !reflect.DeepEqual(allow, []string{"mcp(mini-tools-otro/x)"}) {
		t.Fatalf("allow = %v", allow)
	}
}

func TestSyncAgyPermissions_EmptyToolsDoesNotCreateFile(t *testing.T) {
	path := agyPath(t)
	changed, err := SyncAgyPermissions(path, testServer, nil)
	if err != nil || changed {
		t.Fatalf("changed=%v err=%v", changed, err)
	}
	if _, err := os.Stat(path); err == nil {
		t.Errorf("se creó un archivo sin reglas que escribir")
	}
}

func TestRemoveAgyPermissions(t *testing.T) {
	path := agyPath(t)
	writeAgyFile(t, path, `{"keep":1,"permissions":{"allow":["command(ls)","mcp(mini-tools/a)","mcp(mini-tools/b)"],"deny":["x"]}}`)
	changed, err := RemoveAgyPermissions(path, testServer)
	if err != nil || !changed {
		t.Fatalf("changed=%v err=%v", changed, err)
	}
	doc, allow := readDoc(t, path)
	if !reflect.DeepEqual(allow, []string{"command(ls)"}) {
		t.Fatalf("allow = %v", allow)
	}
	if doc["keep"] != float64(1) {
		t.Errorf("se perdió una clave ajena")
	}

	changed, err = RemoveAgyPermissions(path, testServer)
	if err != nil || changed {
		t.Errorf("segunda quita: changed=%v err=%v", changed, err)
	}
}

func TestRemoveAgyPermissions_CleansEmptyBlocks(t *testing.T) {
	path := agyPath(t)
	if _, err := SyncAgyPermissions(path, testServer, []string{"a"}); err != nil {
		t.Fatal(err)
	}
	if _, err := RemoveAgyPermissions(path, testServer); err != nil {
		t.Fatal(err)
	}
	doc, _ := readDoc(t, path)
	if _, ok := doc["permissions"]; ok {
		t.Errorf("quedó un bloque permissions vacío: %v", doc)
	}
}

func TestRemoveAgyPermissions_MissingFile(t *testing.T) {
	path := agyPath(t)
	changed, err := RemoveAgyPermissions(path, testServer)
	if err != nil || changed {
		t.Fatalf("changed=%v err=%v", changed, err)
	}
	if _, err := os.Stat(path); err == nil {
		t.Errorf("quitar no debe crear el archivo")
	}
}

func TestSyncAgyPermissions_InvalidJSONIsNotOverwritten(t *testing.T) {
	cases := map[string]string{
		"no es JSON":          `{"permissions": {"allow": [`,
		"raíz no es objeto":   `[1,2,3]`,
		"permissions no obj":  `{"permissions": "x"}`,
		"allow no es lista":   `{"permissions": {"allow": "mcp(x/y)"}}`,
		"permissions es null": `{"permissions": null}`,
	}
	for name, content := range cases {
		t.Run(name, func(t *testing.T) {
			path := agyPath(t)
			writeAgyFile(t, path, content)
			changed, err := SyncAgyPermissions(path, testServer, []string{"a"})
			if err == nil || changed {
				t.Fatalf("esperaba error sin cambios; changed=%v err=%v", changed, err)
			}
			if _, err := RemoveAgyPermissions(path, testServer); err == nil {
				t.Errorf("Remove debería rechazar el archivo")
			}
			got, _ := os.ReadFile(path)
			if string(got) != content {
				t.Errorf("el archivo se modificó:\n%s", got)
			}
			if _, err := os.Stat(path + ".mini-tools.bak"); err == nil {
				t.Errorf("no debería haber respaldo si no se escribe")
			}
			st, err := AgyPermStatus(path, testServer, []string{"a"})
			if err != nil || st.Valid || st.Problem == "" || !st.Exists {
				t.Errorf("status = %+v err=%v", st, err)
			}
		})
	}
}

func TestSyncAgyPermissions_BOM(t *testing.T) {
	path := agyPath(t)
	writeAgyFile(t, path, "\xef\xbb\xbf"+`{"theme":"light","permissions":{"allow":["command(ls)"]}}`)
	changed, err := SyncAgyPermissions(path, testServer, []string{"a"})
	if err != nil || !changed {
		t.Fatalf("changed=%v err=%v", changed, err)
	}
	doc, allow := readDoc(t, path)
	if doc["theme"] != "light" || !reflect.DeepEqual(allow, []string{"command(ls)", "mcp(mini-tools/a)"}) {
		t.Fatalf("doc=%v allow=%v", doc, allow)
	}
}

func TestAgyPermissions_RejectInvalidNames(t *testing.T) {
	bad := []string{"", "*", "a/b", "a(b", "a)b", "a b", "a\tb", "a\nb"}
	for _, name := range bad {
		path := agyPath(t)
		if _, err := SyncAgyPermissions(path, testServer, []string{name}); err == nil {
			t.Errorf("herramienta %q aceptada", name)
		}
		if _, err := SyncAgyPermissions(path, name, []string{"ok"}); err == nil {
			t.Errorf("servidor %q aceptado", name)
		}
		if _, err := RemoveAgyPermissions(path, name); err == nil {
			t.Errorf("Remove aceptó el servidor %q", name)
		}
		if _, err := AgyPermStatus(path, testServer, []string{name}); err == nil {
			t.Errorf("Status aceptó la herramienta %q", name)
		}
		if _, err := os.Stat(path); err == nil {
			t.Errorf("se escribió el archivo con el nombre inválido %q", name)
		}
	}
}

func TestAgyPermStatus(t *testing.T) {
	path := agyPath(t)

	st, err := AgyPermStatus(path, testServer, []string{"a", "b"})
	if err != nil {
		t.Fatal(err)
	}
	if st.Exists || !st.Valid || st.Synced || !reflect.DeepEqual(st.Missing, []string{"mcp(mini-tools/a)", "mcp(mini-tools/b)"}) {
		t.Errorf("sin archivo: %+v", st)
	}

	writeAgyFile(t, path, `{"permissions":{"allow":["mcp(mini-tools/a)","mcp(mini-tools/vieja)","mcp(otro/z)"]}}`)
	st, err = AgyPermStatus(path, testServer, []string{"a", "b"})
	if err != nil {
		t.Fatal(err)
	}
	if !st.Exists || !st.Valid || st.Synced ||
		!reflect.DeepEqual(st.Missing, []string{"mcp(mini-tools/b)"}) ||
		!reflect.DeepEqual(st.Extra, []string{"mcp(mini-tools/vieja)"}) {
		t.Errorf("con diferencias: %+v", st)
	}

	if _, err := SyncAgyPermissions(path, testServer, []string{"a", "b"}); err != nil {
		t.Fatal(err)
	}
	st, _ = AgyPermStatus(path, testServer, []string{"a", "b"})
	if !st.Synced || len(st.Missing) != 0 || len(st.Extra) != 0 {
		t.Errorf("sincronizado: %+v", st)
	}
}

func TestAgySettingsPath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	want := filepath.Join(home, ".gemini", "antigravity-cli", "settings.json")
	if got := AgySettingsPath(); got != want {
		t.Errorf("AgySettingsPath() = %q, quería %q", got, want)
	}
}

func TestAgyPermissions_EmptyPathIsRejected(t *testing.T) {
	if _, err := SyncAgyPermissions("", testServer, []string{"a"}); err == nil {
		t.Errorf("Sync aceptó una ruta vacía")
	}
	if _, err := RemoveAgyPermissions("", testServer); err == nil {
		t.Errorf("Remove aceptó una ruta vacía")
	}
	if _, err := AgyPermStatus("", testServer, []string{"a"}); err == nil {
		t.Errorf("Status aceptó una ruta vacía")
	}
}
