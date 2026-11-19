package git

import (
	"strings"
	"testing"
)

// Un archivo sin seguimiento (`?` en la lista de cambios) se mostraba como
// "Sin cambios de contenido": `git diff` no lo compara porque no está en el
// índice. Ahora llega como archivo nuevo, con todas sus líneas agregadas.
func TestGetDiffUntrackedFile(t *testing.T) {
	r, root := newTestRepo(t)
	write(t, root, "tools/pbctl/config.go", "package main\n\nfunc main() {}\n")
	write(t, root, "Makefile", "build:\n\tgo build") // sin salto final

	d, err := r.GetDiff(root, DiffTarget{Mode: "worktree", Path: "tools/pbctl/config.go"})
	if err != nil {
		t.Fatal(err)
	}
	if d.IsBinary || d.Stat.Insertions != 3 {
		t.Fatalf("esperaba 3 líneas agregadas de texto, llegó %+v", d)
	}
	for _, want := range []string{"new file mode", "--- /dev/null", "+++ b/tools/pbctl/config.go", "@@ -0,0 +1,3 @@", "+package main", "+func main() {}"} {
		if !strings.Contains(d.Patch, want) {
			t.Errorf("al parche le falta %q:\n%s", want, d.Patch)
		}
	}

	m, err := r.GetDiff(root, DiffTarget{Mode: "worktree", Path: "Makefile"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(m.Patch, "+\tgo build\n\\ No newline at end of file\n") {
		t.Errorf("falta el aviso de fin de línea:\n%s", m.Patch)
	}
	// El parche sirve para preparar el archivo desde el visor (git apply --cached).
	if err := r.runWithStdin(root, m.Patch, "apply", "--cached", "--check"); err != nil {
		t.Errorf("git apply rechaza el parche: %v", err)
	}
}

func TestGetDiffUntrackedBinary(t *testing.T) {
	r, root := newTestRepo(t)
	write(t, root, "logo.bin", "PNG\x00\x01\x02")
	d, err := r.GetDiff(root, DiffTarget{Mode: "worktree", Path: "logo.bin"})
	if err != nil {
		t.Fatal(err)
	}
	if !d.IsBinary || d.Patch != "" {
		t.Fatalf("un binario sin seguimiento tiene que llegar como binario: %+v", d)
	}
}
