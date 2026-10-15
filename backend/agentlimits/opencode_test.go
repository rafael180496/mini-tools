package agentlimits

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOpencodeLimitsUnavailableWithReason(t *testing.T) {
	xdg := t.TempDir()
	t.Setenv("XDG_DATA_HOME", xdg)

	// No instalado: no hay datos y lo dice.
	l := opencodeLimits(t.TempDir())
	if l.Agent != "opencode" || l.Known || l.Note == "" {
		t.Errorf("no instalado: %+v", l)
	}

	// Instalado: tampoco hay cuota, pero con otra razón, y no es consultable.
	if err := os.MkdirAll(filepath.Join(xdg, "opencode"), 0o755); err != nil {
		t.Fatal(err)
	}
	inst := opencodeLimits(t.TempDir())
	if inst.Known || inst.Queryable || len(inst.Windows) != 0 {
		t.Errorf("OpenCode no tiene límite que leer ni consultar: %+v", inst)
	}
	if inst.Note == "" || inst.Note == l.Note {
		t.Errorf("la nota de instalado debe explicar que no expone cuota: %q", inst.Note)
	}
}

func TestAllListsOpencode(t *testing.T) {
	for _, l := range All() {
		if l.Agent == "opencode" {
			return
		}
	}
	t.Error("All debe incluir a opencode (no omitirlo en silencio)")
}
