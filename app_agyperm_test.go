package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mini-tools/backend/appdata"
	"mini-tools/backend/mcpconf"
	"mini-tools/backend/mcpserver"
)

// Estos tests nunca tocan el ~/.gemini ni la carpeta de datos reales: el
// settings.json de Antigravity y la marca de «quitado» viven en directorios
// temporales.
func agyTestEnv(t *testing.T) (settings string) {
	t.Helper()
	t.Setenv(appdata.OverrideEnv, t.TempDir())
	settings = filepath.Join(t.TempDir(), ".gemini", "antigravity-cli", "settings.json")
	prev := agySettingsPath
	agySettingsPath = func() string { return settings }
	t.Cleanup(func() { agySettingsPath = prev })
	return settings
}

var agyTestTools = []string{"vault_search_notes", "db_get_schema"}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// La primera sincronización agrega las reglas y avisa; la segunda no escribe
// ni avisa; una herramienta nueva vuelve a avisar.
func TestSyncAgyPermissionsAddsOnceAndNotices(t *testing.T) {
	settings := agyTestEnv(t)
	if err := os.MkdirAll(filepath.Dir(settings), 0o700); err != nil {
		t.Fatal(err)
	}
	foreign := `{"theme":"dark","permissions":{"allow":["command(ls)"],"deny":["mcp(otro/x)"]}}`
	if err := os.WriteFile(settings, []byte(foreign), 0o600); err != nil {
		t.Fatal(err)
	}

	res := syncAgyPermissionsAt(settings, "mini-tools", agyTestTools, false)
	if res.Err != nil || res.Added != 2 || res.Removed != 0 {
		t.Fatalf("primera sincronización: %+v", res)
	}
	got := readFile(t, settings)
	for _, want := range []string{"mcp(mini-tools/vault_search_notes)", "mcp(mini-tools/db_get_schema)", "command(ls)", "mcp(otro/x)", `"theme"`} {
		if !strings.Contains(got, want) {
			t.Errorf("falta %q en %s", want, got)
		}
	}
	if strings.Contains(got, "mcp(*)") {
		t.Errorf("nunca un comodín: %s", got)
	}
	notice := agyNoticeFor(res, "mini-tools")
	if !strings.HasPrefix(notice, "_⚠ ") || !strings.Contains(notice, settings) || strings.Contains(notice, "\n") {
		t.Errorf("aviso: %q", notice)
	}

	if res = syncAgyPermissionsAt(settings, "mini-tools", agyTestTools, false); res.Changed() || res.Err != nil || agyNoticeFor(res, "mini-tools") != "" {
		t.Errorf("la segunda sincronización no debe escribir ni avisar: %+v", res)
	}

	res = syncAgyPermissionsAt(settings, "mini-tools", append([]string{"git_status"}, agyTestTools...), false)
	if res.Added != 1 || agyNoticeFor(res, "mini-tools") == "" {
		t.Errorf("una herramienta nueva se agrega y se avisa: %+v", res)
	}
}

// «Quitar» deja la marca: ni un turno ni Conectar las reponen; Reparar sí.
func TestRemoveLeavesMarkerThatTurnsRespect(t *testing.T) {
	settings := agyTestEnv(t)
	if res := syncAgyPermissionsAt(settings, "mini-tools", agyTestTools, false); res.Added != 2 {
		t.Fatalf("setup: %+v", res)
	}
	// Una regla ajena que debe sobrevivir a Quitar.
	if _, err := mcpconf.SyncAgyPermissions(settings, "otro", []string{"x"}); err != nil {
		t.Fatal(err)
	}

	if _, err := mcpconf.RemoveAgyPermissions(settings, "mini-tools"); err != nil {
		t.Fatal(err)
	}
	if err := setAgyPermsManaged(false); err != nil {
		t.Fatal(err)
	}
	got := readFile(t, settings)
	if strings.Contains(got, "mini-tools/") || !strings.Contains(got, "mcp(otro/x)") {
		t.Errorf("Quitar solo quita las propias: %s", got)
	}
	if agyPermsManaged() {
		t.Fatal("la marca de quitado debe existir")
	}

	before := readFile(t, settings)
	res := syncAgyPermissionsAt(settings, "mini-tools", agyTestTools, false)
	if !res.Skipped || res.Changed() || agyNoticeFor(res, "mini-tools") != "" {
		t.Errorf("un turno no repone lo quitado: %+v", res)
	}
	if readFile(t, settings) != before {
		t.Error("el archivo no debe cambiar")
	}

	// Reparar: limpia la marca y fuerza la sincronización.
	if err := setAgyPermsManaged(true); err != nil {
		t.Fatal(err)
	}
	res = syncAgyPermissionsAt(settings, "mini-tools", agyTestTools, true)
	if res.Added != 2 || !agyPermsManaged() {
		t.Errorf("reparar repone las reglas y limpia la marca: %+v", res)
	}
}

// Un settings.json que no es JSON no se pisa: es un fallo que se avisa.
func TestSyncAgyPermissionsDoesNotOverwriteInvalidFile(t *testing.T) {
	settings := agyTestEnv(t)
	if err := os.MkdirAll(filepath.Dir(settings), 0o700); err != nil {
		t.Fatal(err)
	}
	const broken = "{ esto no es json"
	if err := os.WriteFile(settings, []byte(broken), 0o600); err != nil {
		t.Fatal(err)
	}
	res := syncAgyPermissionsAt(settings, "mini-tools", agyTestTools, true)
	if res.Err == nil || readFile(t, settings) != broken {
		t.Fatalf("no se pisa un archivo ilegible: %+v", res)
	}
	if n := agyNoticeFor(res, "mini-tools"); !(strings.Contains(n, "Reparar permisos") || strings.Contains(n, "Repair permissions")) || strings.Contains(n, "\n") {
		t.Errorf("el fallo se avisa en una línea: %q", n)
	}
}

func TestAgyRuleTool(t *testing.T) {
	if got := agyRuleTool("mcp(mini-tools/db_get_schema)"); got != "db_get_schema" {
		t.Errorf("agyRuleTool = %q", got)
	}
}

// Recorrido completo, como lo vive la persona: un turno de Antigravity agrega
// las reglas y avisa, otro no repite, Quitar las saca y deja la marca, un turno
// no las repone, y Reparar sí. Con el vault real de pruebas y todo en
// directorios temporales: nunca el ~/.gemini ni la carpeta de datos reales.
func TestAntigravityPermissionsFlowAcrossTurns(t *testing.T) {
	a, _ := newChatApp(t)
	settings := agyTestEnv(t)
	t.Setenv("HOME", t.TempDir())
	// El servidor MCP "encendido": mcpEnabled solo mira que haya puente.
	a.mcp.bridge = new(mcpserver.Bridge)
	t.Cleanup(func() { a.mcp.bridge = nil })

	if err := os.MkdirAll(filepath.Dir(settings), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(settings, []byte(`{"permissions":{"allow":["command(ls)"]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	tools := a.agyPermTools()
	if len(tools) == 0 {
		t.Fatal("el catálogo MCP no debería estar vacío")
	}
	rules := func() int { return strings.Count(readFile(t, settings), "mcp(mini-tools/") }

	// Otro agente, o el MCP apagado: ni se toca el archivo.
	if n := a.agyTurnNotice("claude"); n != "" || rules() != 0 {
		t.Errorf("claude no sincroniza: %q", n)
	}

	// Turno 1 de Antigravity: agrega y avisa.
	notice := a.agyTurnNotice("antigravity")
	if !strings.HasPrefix(notice, "_⚠ ") || !strings.Contains(notice, settings) || rules() != len(tools) {
		t.Fatalf("turno 1: aviso %q, %d reglas de %d", notice, rules(), len(tools))
	}
	t.Logf("aviso del turno 1: %s", notice)
	t.Logf("settings.json tras el turno 1:\n%s", readFile(t, settings))
	if !strings.Contains(readFile(t, settings), "command(ls)") {
		t.Error("la regla ajena debe conservarse")
	}
	// Turno 2: todo al día, en silencio.
	if n := a.agyTurnNotice("antigravity"); n != "" {
		t.Errorf("turno 2 no avisa: %q", n)
	}
	st := a.agyPermStatus()
	if !st.Valid || st.Approved != st.Expected || len(st.Missing) != 0 || st.RemovedByUser || !st.MCPEnabled {
		t.Errorf("estado tras sincronizar: %+v", st)
	}

	// Quitar.
	st, err := a.RemoveAntigravityPermissions()
	if err != nil {
		t.Fatal(err)
	}
	if rules() != 0 || !st.RemovedByUser || st.Approved != 0 || !strings.Contains(readFile(t, settings), "command(ls)") {
		t.Errorf("tras Quitar: %d reglas, %+v\n%s", rules(), st, readFile(t, settings))
	}
	t.Logf("settings.json tras Quitar:\n%s", readFile(t, settings))

	// Turno 3: respeta el Quitar.
	if n := a.agyTurnNotice("antigravity"); n != "" || rules() != 0 {
		t.Errorf("turno 3 no repone lo quitado: %q (%d reglas)", n, rules())
	}
	// Conectar tampoco las repone.
	if res := a.syncAgyPermissions(false); !res.Skipped || rules() != 0 {
		t.Errorf("Conectar respeta el Quitar: %+v", res)
	}

	// Reparar.
	st, err = a.RepairAntigravityPermissions()
	if err != nil {
		t.Fatal(err)
	}
	if rules() != len(tools) || st.RemovedByUser || st.Approved != st.Expected {
		t.Errorf("tras Reparar: %d reglas, %+v", rules(), st)
	}
	t.Logf("settings.json tras Reparar:\n%s", readFile(t, settings))
	// Y los turnos vuelven a mantenerlas.
	if n := a.agyTurnNotice("antigravity"); n != "" {
		t.Errorf("turno 4 al día: %q", n)
	}
}

func TestAntigravityTurnNoticeNeedsMCPEnabled(t *testing.T) {
	a, _ := newChatApp(t)
	settings := agyTestEnv(t)
	if n := a.agyTurnNotice("antigravity"); n != "" {
		t.Errorf("con el MCP apagado no hay aviso: %q", n)
	}
	if _, err := os.Stat(settings); err == nil {
		t.Error("con el MCP apagado no se escribe nada")
	}
}
