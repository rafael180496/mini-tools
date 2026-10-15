package agentplan

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeAuth(t *testing.T, xdg, body string) {
	t.Helper()
	dir := filepath.Join(xdg, "opencode")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

// El plan se arma SOLO con las claves de auth.json. El valor de prueba es un
// secreto reconocible: si aparece en cualquier campo, es una filtración.
func TestOpencodePlanReadsOnlyKeys(t *testing.T) {
	xdg := t.TempDir()
	t.Setenv("XDG_DATA_HOME", xdg)
	writeAuth(t, xdg, `{"opencode-go":{"type":"api","key":"SECRETO-NO-DEBE-SALIR"}}`)

	p := opencodePlan(t.TempDir())
	if !p.Known || p.Label != "OpenCode Go" {
		t.Fatalf("plan = %+v", p)
	}
	for _, f := range []string{p.Label, p.Detail, p.Note} {
		if strings.Contains(f, "SECRETO") {
			t.Fatalf("una credencial llegó al plan: %q", f)
		}
	}
	if !strings.Contains(p.Detail, "OpenCode Go") {
		t.Errorf("el detalle debería listar los proveedores: %q", p.Detail)
	}
}

func TestOpencodePlanManyProviders(t *testing.T) {
	xdg := t.TempDir()
	t.Setenv("XDG_DATA_HOME", xdg)
	writeAuth(t, xdg, `{"opencode-go":{},"anthropic":{},"github-copilot":{}}`)

	p := opencodePlan(t.TempDir())
	if !p.Known || !strings.HasSuffix(p.Label, "+1") {
		t.Errorf("con tres proveedores la píldora muestra dos y +1: %q", p.Label)
	}
	for _, want := range []string{"Anthropic", "Github Copilot", "OpenCode Go"} {
		if !strings.Contains(p.Detail, want) {
			t.Errorf("el detalle debería nombrar %q: %q", want, p.Detail)
		}
	}
}

func TestOpencodePlanUnknownCases(t *testing.T) {
	t.Run("sin archivo", func(t *testing.T) {
		t.Setenv("XDG_DATA_HOME", t.TempDir())
		p := opencodePlan(t.TempDir())
		if p.Known || p.Note == "" {
			t.Errorf("sin sesión: Known=false con nota, fue %+v", p)
		}
	})
	t.Run("sin proveedores", func(t *testing.T) {
		xdg := t.TempDir()
		t.Setenv("XDG_DATA_HOME", xdg)
		writeAuth(t, xdg, `{}`)
		p := opencodePlan(t.TempDir())
		if p.Known || p.Note == "" {
			t.Errorf("sin proveedores: Known=false con nota, fue %+v", p)
		}
	})
	t.Run("archivo roto", func(t *testing.T) {
		xdg := t.TempDir()
		t.Setenv("XDG_DATA_HOME", xdg)
		writeAuth(t, xdg, `no es json`)
		p := opencodePlan(t.TempDir())
		if p.Known || p.Note == "" {
			t.Errorf("archivo roto: Known=false con nota, fue %+v", p)
		}
	})
}

func TestAllListsOpencode(t *testing.T) {
	found := false
	for _, p := range All() {
		if p.Agent == "opencode" {
			found = true
		}
	}
	if !found {
		t.Error("All debe incluir a opencode")
	}
}
