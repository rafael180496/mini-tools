package hidewin

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// En Windows, todo proceso hijo que no pasa por Hide abre su propia ventana de
// consola (o una pestaña de Windows Terminal). Pasó de verdad: el grafo de Git
// corre muchos `git` seguidos y cada uno abría una "Terminal". Este test
// recorre el código de la app y falla si un archivo que puede compilar en
// Windows crea un proceso sin ocultar su consola.
var spawnRe = regexp.MustCompile(`exec\.Command(Context)?\(|execCommand\(`)

func TestEveryChildProcessHidesConsole(t *testing.T) {
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			switch d.Name() {
			case "node_modules", "frontend", "build", "releases", ".git", ".agents", ".claude", "share":
				return filepath.SkipDir
			}
			return nil
		}
		name := d.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") ||
			strings.HasSuffix(name, "_darwin.go") || strings.HasSuffix(name, "_unix.go") ||
			strings.HasSuffix(name, "_linux.go") {
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		src := string(b)
		if strings.Contains(src, "//go:build !windows") || strings.Contains(src, "//go:build darwin") ||
			strings.Contains(src, "//go:build unix") || strings.Contains(src, "//go:build linux") {
			return nil
		}
		// La línea donde runner.go declara el alias no crea ningún proceso.
		src = strings.ReplaceAll(src, "var execCommand = exec.CommandContext", "")
		spawns := 0
		for _, line := range strings.Split(src, "\n") {
			l := strings.TrimSpace(line)
			if strings.HasPrefix(l, "//") {
				continue
			}
			spawns += len(spawnRe.FindAllString(l, -1))
		}
		if spawns == 0 {
			return nil
		}
		if !strings.Contains(src, "hidewin.Hide(") && !strings.Contains(src, "hidewin.NoConsole(") && !strings.Contains(src, "setupProc(cmd)") {
			rel, _ := filepath.Rel(root, path)
			t.Errorf("%s crea %d proceso(s) sin hidewin.Hide: en Windows cada uno abriría una consola", rel, spawns)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
