package agents

import (
	"os"
	"strings"
	"testing"
)

// Env tiene que traer el entorno del proceso, no solo el PATH: sin HOME,
// Claude Code no encuentra su sesión y Antigravity aborta al arrancar.
func TestEnvTraeHome(t *testing.T) {
	env := Env("FOO=bar")

	var home, path string
	for _, kv := range env {
		if v, ok := strings.CutPrefix(kv, "HOME="); ok {
			home = v
		}
		if v, ok := strings.CutPrefix(kv, "PATH="); ok {
			path = v
		}
	}
	if home == "" {
		t.Fatal("Env() no incluye HOME")
	}
	if want, _ := os.UserHomeDir(); home != want {
		t.Fatalf("HOME=%q, esperado %q", home, want)
	}
	if !strings.Contains(path, ".local/bin") && !strings.Contains(path, "npm") {
		t.Fatalf("PATH no viene ampliado: %q", path)
	}
	// Una sola definición de PATH: dos entradas iguales dejan al hijo con la
	// que el sistema decida, que no tiene por qué ser la ampliada.
	n := 0
	for _, kv := range env {
		if strings.HasPrefix(kv, "PATH=") {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("PATH aparece %d veces", n)
	}
	if env[len(env)-1] != "FOO=bar" {
		t.Fatal("las variables extra no llegaron")
	}
}
