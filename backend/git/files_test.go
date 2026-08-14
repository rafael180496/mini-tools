package git

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// Las guardas de ruta de files.go son la parte donde un error no es un bug de
// UI sino un agujero: editablePath es lo único que separa "editá un archivo de
// tu repositorio" de "escribí en cualquier lado del disco". Por eso se prueba
// acá aunque el resto del paquete se verifique a mano.

// newTestRepo crea un repositorio real y devuelve su raíz. Se usa git de
// verdad y no un .git falso porque resolveRepo pregunta por rev-parse.
func newTestRepo(t *testing.T) (*Runner, string) {
	t.Helper()
	r := NewRunner()
	if !r.Probe().Available {
		t.Skip("git no está instalado en este equipo")
	}

	// t.TempDir en macOS cuelga de /var, que es un symlink a /private/var —
	// justo el caso que editablePath tiene que tolerar.
	root := t.TempDir()
	if _, err := r.runLocal(root, "init"); err != nil {
		t.Fatalf("git init: %v", err)
	}
	return r, root
}

func write(t *testing.T, root, rel, content string) {
	t.Helper()
	full := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestListWorkTree(t *testing.T) {
	r, root := newTestRepo(t)

	write(t, root, ".gitignore", "ignorado.txt\nnode_modules/\n")
	write(t, root, "seguido.go", "package main\n")
	write(t, root, "sin-rastrear.ts", "export {}\n")
	write(t, root, "ignorado.txt", "no debería aparecer\n")
	write(t, root, "node_modules/dep/index.js", "module.exports = {}\n")
	write(t, root, "borrado.md", "# se borra\n")

	if _, err := r.runLocal(root, "add", "seguido.go", "borrado.md", ".gitignore"); err != nil {
		t.Fatalf("git add: %v", err)
	}
	if err := os.Remove(filepath.Join(root, "borrado.md")); err != nil {
		t.Fatal(err)
	}

	tree, err := r.ListWorkTree(root)
	if err != nil {
		t.Fatalf("ListWorkTree: %v", err)
	}

	got := map[string]bool{}
	for _, p := range tree.Files {
		got[p] = true
	}

	for _, want := range []string{"seguido.go", "sin-rastrear.ts", ".gitignore"} {
		if !got[want] {
			t.Errorf("falta %q en el listado: %v", want, tree.Files)
		}
	}
	// Lo ignorado es lo que hace utilizable el árbol: sin --exclude-standard,
	// node_modules entero entra y el listado deja de servir.
	for _, unwanted := range []string{"ignorado.txt", "node_modules/dep/index.js"} {
		if got[unwanted] {
			t.Errorf("%q está ignorado y no debería aparecer: %v", unwanted, tree.Files)
		}
	}
	// Sigue en el índice, pero abrirlo daría "no existe".
	if got["borrado.md"] {
		t.Errorf("un archivo borrado del árbol de trabajo no debería listarse: %v", tree.Files)
	}
}

func TestEditablePathRejectsEscapes(t *testing.T) {
	r, root := newTestRepo(t)
	write(t, root, "adentro.txt", "ok\n")

	// Un secreto fuera del repositorio, que es lo que estas rutas intentan
	// alcanzar.
	outside := filepath.Join(filepath.Dir(root), "afuera.txt")
	if err := os.WriteFile(outside, []byte("secreto\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	cases := []struct{ name, path string }{
		{"padre directo", "../afuera.txt"},
		{"padre encubierto", "sub/../../afuera.txt"},
		{"absoluta", outside},
		{"interna de git", ".git/config"},
		{"hook de git", ".git/hooks/pre-commit"},
		{"vacía", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := r.editablePath(root, c.path); err == nil {
				t.Errorf("editablePath(%q) fue aceptada y debía rechazarse", c.path)
			}
		})
	}

	// El caso legítimo tiene que seguir andando, o la guarda sería inútil.
	if _, err := r.editablePath(root, "adentro.txt"); err != nil {
		t.Errorf("editablePath rechazó un archivo válido del repositorio: %v", err)
	}
}

func TestEditablePathRejectsSymlinkOutsideRepo(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("los symlinks en Windows requieren privilegios")
	}
	r, root := newTestRepo(t)

	outside := filepath.Join(filepath.Dir(root), "secreto.txt")
	if err := os.WriteFile(outside, []byte("clave\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	// Un symlink versionado que apunta afuera: pasa cualquier comprobación
	// puramente textual de prefijo, que es exactamente por qué editablePath
	// resuelve symlinks antes de aprobar.
	if err := os.Symlink(outside, filepath.Join(root, "trampa.txt")); err != nil {
		t.Fatal(err)
	}
	if _, err := r.editablePath(root, "trampa.txt"); err == nil {
		t.Error("un symlink que apunta fuera del repositorio fue aceptado")
	}

	// Un directorio enlazado hacia afuera es el mismo problema un escalón más
	// arriba, y aparece al guardar un archivo que todavía no existe.
	if err := os.Symlink(filepath.Dir(root), filepath.Join(root, "salida")); err != nil {
		t.Fatal(err)
	}
	if _, err := r.editablePath(root, "salida/nuevo.txt"); err == nil {
		t.Error("un archivo nuevo bajo un directorio enlazado hacia afuera fue aceptado")
	}
}

func TestReadWorkFileReportsBinaryAndSize(t *testing.T) {
	r, root := newTestRepo(t)

	write(t, root, "texto.go", "package main\n")
	if err := os.WriteFile(filepath.Join(root, "bin.dat"), []byte{0x7f, 'E', 'L', 'F', 0x00, 0x01}, 0o644); err != nil {
		t.Fatal(err)
	}

	f, err := r.ReadWorkFile(root, "texto.go")
	if err != nil {
		t.Fatalf("ReadWorkFile: %v", err)
	}
	if f.Binary || f.TooLarge || f.Content != "package main\n" {
		t.Errorf("archivo de texto mal leído: %+v", f)
	}
	if f.ModTimeUnix == 0 {
		t.Error("ModTimeUnix vacío: sin él, guardar es un pisado a ciegas")
	}

	// Binario se REPORTA, no se devuelve como error: la UI tiene que poder
	// decir por qué no lo abre.
	b, err := r.ReadWorkFile(root, "bin.dat")
	if err != nil {
		t.Fatalf("ReadWorkFile sobre un binario devolvió error en vez de reportarlo: %v", err)
	}
	if !b.Binary || b.Content != "" {
		t.Errorf("no se detectó como binario: %+v", b)
	}
}

func TestWriteWorkFileDetectsExternalChange(t *testing.T) {
	r, root := newTestRepo(t)
	write(t, root, "app.ts", "const a = 1\n")

	f, err := r.ReadWorkFile(root, "app.ts")
	if err != nil {
		t.Fatal(err)
	}

	// Alguien más escribe mientras el archivo está abierto — en esta app, la
	// sesión del agente en el panel de al lado. El mtime se fija a mano porque
	// Unix() tiene resolución de un segundo y el test es más rápido que eso.
	full := filepath.Join(root, "app.ts")
	if err := os.WriteFile(full, []byte("const a = 2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(10 * time.Second)
	if err := os.Chtimes(full, future, future); err != nil {
		t.Fatal(err)
	}

	if _, err := r.WriteWorkFile(root, "app.ts", "const a = 3\n", f.ModTimeUnix); err != ErrWorkFileChanged {
		t.Errorf("se esperaba ErrWorkFileChanged, se obtuvo %v", err)
	}
	if data, _ := os.ReadFile(full); string(data) != "const a = 2\n" {
		t.Errorf("el cambio externo fue pisado pese al conflicto: %q", data)
	}

	// 0 es "guardar igual", lo que manda el diálogo después de avisar.
	if _, err := r.WriteWorkFile(root, "app.ts", "const a = 3\n", 0); err != nil {
		t.Fatalf("el guardado forzado falló: %v", err)
	}
	if data, _ := os.ReadFile(full); string(data) != "const a = 3\n" {
		t.Errorf("el guardado forzado no escribió: %q", data)
	}
}

func TestWriteWorkFilePreservesModeAndCreatesNew(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("los bits de permiso de Unix no aplican en Windows")
	}
	r, root := newTestRepo(t)

	script := filepath.Join(root, "deploy.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\necho hola\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	if _, err := r.WriteWorkFile(root, "deploy.sh", "#!/bin/sh\necho chau\n", 0); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(script)
	if err != nil {
		t.Fatal(err)
	}
	// Reescribir un script ejecutable como 0644 lo rompe de una forma que no
	// se nota hasta que alguien lo corre.
	if info.Mode().Perm() != 0o755 {
		t.Errorf("el bit de ejecución se perdió al guardar: %v", info.Mode().Perm())
	}

	// Crear un archivo cuyo directorio TAMPOCO existe todavía es el caso real
	// del panel de agentes: ofrecer ".github/copilot-instructions.md" en un
	// repositorio que no tiene .github.
	if _, err := r.WriteWorkFile(root, "nuevo/anidado.md", "# hola\n", 0); err != nil {
		t.Fatalf("crear un archivo junto con su directorio falló: %v", err)
	}
	if data, _ := os.ReadFile(filepath.Join(root, "nuevo", "anidado.md")); string(data) != "# hola\n" {
		t.Errorf("el archivo nuevo no tiene el contenido esperado: %q", data)
	}

	// El temporal de la escritura atómica no debe quedar tirado en el
	// directorio del usuario.
	entries, err := os.ReadDir(filepath.Join(root, "nuevo"))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".mini-tools-") {
			t.Errorf("quedó un temporal sin limpiar: %s", e.Name())
		}
	}
}
