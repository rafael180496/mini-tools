package workspace

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func lines(s string) []string {
	var out []string
	for _, l := range strings.Split(strings.TrimSpace(s), "\n") {
		if l != "" {
			out = append(out, l)
		}
	}
	return out
}

func TestGlobRegexp(t *testing.T) {
	cases := []struct {
		pat  string
		path string
		want bool
	}{
		{"**/*.go", "main.go", true},
		{"**/*.go", "a/b/c.go", true},
		{"**/*.go", "a/b/c.gox", false},
		{"*.go", "a/main.go", false}, // sin «**» el * no cruza carpetas (el prefijo lo pone glob())
		{"src/**", "src/a/b.txt", true},
		{"src/**", "other/a.txt", false},
		{"src/**/test_*.py", "src/test_a.py", true},
		{"src/**/test_*.py", "src/x/y/test_a.py", true},
		{"src/**/test_*.py", "src/x/y/a.py", false},
		{"*.{ts,tsx}", "a.tsx", true},
		{"*.{ts,tsx}", "a.js", false},
		{"file?.txt", "file1.txt", true},
		{"file?.txt", "file12.txt", false},
		{"[a-c].md", "b.md", true},
		{"[!a-c].md", "b.md", false},
		{"[!a-c].md", "z.md", true},
		{"a.b", "axb", false}, // el punto es literal
		{"a/*/c", "a/b/c", true},
		{"a/*/c", "a/b/x/c", false},
		{`a\*b`, "a*b", true},
	}
	for _, c := range cases {
		re, err := globRegexp(c.pat)
		if err != nil {
			t.Fatalf("%q: %v", c.pat, err)
		}
		if got := re.MatchString(c.path); got != c.want {
			t.Errorf("glob %q vs %q = %v, quería %v", c.pat, c.path, got, c.want)
		}
	}
	if _, err := globRegexp("a/{b,c"); err == nil {
		t.Error("llaves sin cerrar")
	}
}

func TestGlobFindsFilesWalkMode(t *testing.T) {
	w, root := newWS(t)
	put(t, root, "main.go", "x")
	put(t, root, "pkg/a.go", "x")
	put(t, root, "pkg/deep/b.go", "x")
	put(t, root, "pkg/README.md", "x")
	put(t, root, "node_modules/dep/index.go", "x") // carpeta pesada: se salta

	out, err := run(t, w, ToolGlob, map[string]any{"pattern": "**/*.go"})
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(lines(out), ",")
	if got != "main.go,pkg/a.go,pkg/deep/b.go" {
		t.Errorf("glob = %q", got)
	}

	// Un patrón sin «/» se busca a cualquier profundidad.
	out, _ = run(t, w, ToolGlob, map[string]any{"pattern": "*.md"})
	if strings.TrimSpace(out) != "pkg/README.md" {
		t.Errorf("*.md = %q", out)
	}

	// path acota la búsqueda y el patrón es relativo a esa carpeta, pero las
	// rutas devueltas siguen siendo relativas a la raíz.
	out, _ = run(t, w, ToolGlob, map[string]any{"pattern": "*.go", "path": "pkg/deep"})
	if strings.TrimSpace(out) != "pkg/deep/b.go" {
		t.Errorf("con path = %q", out)
	}
	out, _ = run(t, w, ToolGlob, map[string]any{"pattern": "a.go", "path": "pkg"})
	if strings.TrimSpace(out) != "pkg/a.go" {
		t.Errorf("patrón relativo a path = %q", out)
	}

	out, _ = run(t, w, ToolGlob, map[string]any{"pattern": "**/*.rs"})
	if !strings.HasPrefix(out, "No matching") && !strings.HasPrefix(out, "Sin archivos") {
		t.Errorf("sin coincidencias = %q", out)
	}
}

func TestGlobRespectsGitignoreAndSkipsSymlinks(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git no está instalado")
	}
	w, root := newWS(t)
	if out, err := exec.Command("git", "-C", root, "init", "-q").CombinedOutput(); err != nil {
		t.Skipf("git init: %v %s", err, out)
	}
	put(t, root, ".gitignore", "generado/\n*.log\n")
	put(t, root, "src/a.go", "x")
	put(t, root, "generado/b.go", "x")
	put(t, root, "x.log", "x")
	outside := t.TempDir()
	put(t, outside, "s.go", "x")
	if runtime.GOOS != "windows" {
		_ = os.Symlink(filepath.Join(outside, "s.go"), filepath.Join(root, "enlace.go"))
	}
	out, err := run(t, w, ToolGlob, map[string]any{"pattern": "**/*"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "src/a.go") {
		t.Errorf("falta src/a.go: %q", out)
	}
	for _, bad := range []string{"generado", "x.log", "enlace.go"} {
		if strings.Contains(out, bad) {
			t.Errorf("glob incluyó %q: %q", bad, out)
		}
	}
}

func TestGlobValidationAndCap(t *testing.T) {
	w, root := newWS(t)
	if _, err := run(t, w, ToolGlob, map[string]any{}); err == nil {
		t.Error("falta pattern")
	}
	if _, err := run(t, w, ToolGlob, map[string]any{"pattern": "/etc/*"}); err == nil {
		t.Error("un patrón absoluto se rechaza")
	}
	if _, err := run(t, w, ToolGlob, map[string]any{"pattern": "*", "path": "../fuera"}); err == nil {
		t.Error("path fuera de la raíz se rechaza")
	}
	if _, err := run(t, w, ToolGlob, map[string]any{"pattern": "*", "path": "a.txt"}); err == nil {
		t.Error("path tiene que ser un directorio")
	}
	for i := 0; i < maxGlobResults+20; i++ {
		put(t, root, "many/f"+strings.Repeat("x", 1)+itoa(i)+".txt", "x")
	}
	out, err := run(t, w, ToolGlob, map[string]any{"pattern": "many/*.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if n := len(lines(out)); n != maxGlobResults+1 { // + la nota de corte
		t.Errorf("líneas = %d", n)
	}
	if !strings.Contains(out, "narrow") && !strings.Contains(out, "afiná") {
		t.Errorf("falta la nota de corte: %q", out[len(out)-120:])
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
