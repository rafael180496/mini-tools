package workspace

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// newSkillWS arma un workspace con un skill cuya carpeta está FUERA de la raíz
// (como los de ~/.claude/skills) y devuelve ambas carpetas.
func newSkillWS(t *testing.T) (w *Workspace, root, skillDir, outside string) {
	t.Helper()
	skillDir = t.TempDir()
	put(t, skillDir, "SKILL.md", "---\nname: guia\n---\n# Guía\nPasos.\n")
	put(t, skillDir, "references/api.md", "linea1\nlinea2\n")
	put(t, skillDir, "scripts/run.sh", "echo hola\n")
	outside = t.TempDir()
	put(t, outside, "secreto.txt", "NO LEER\n")
	var err error
	w, err = New(t.TempDir(), Options{Skills: []SkillRef{{Name: "guia", Dir: skillDir}}})
	if err != nil {
		t.Fatal(err)
	}
	return w, w.Root(), skillDir, outside
}

func TestSkillToolReturnsContentAndFiles(t *testing.T) {
	w, _, _, _ := newSkillWS(t)
	if !w.HasSkills() {
		t.Fatal("HasSkills")
	}
	out, err := run(t, w, ToolSkill, map[string]any{"name": "GUIA"}) // sin distinguir mayúsculas
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"[skill: guia]", "# Guía", "Pasos.", "- references/api.md", "- scripts/run.sh"} {
		if !strings.Contains(out, want) {
			t.Errorf("falta %q en:\n%s", want, out)
		}
	}
	if strings.Contains(out, "- SKILL.md") {
		t.Error("SKILL.md no se lista entre los archivos auxiliares")
	}
	if _, err := run(t, w, ToolSkill, map[string]any{"name": "no-existe"}); err == nil || !strings.Contains(err.Error(), "guia") {
		t.Errorf("un skill desconocido lista los disponibles: %v", err)
	}
	if _, err := run(t, w, ToolSkill, map[string]any{}); err == nil {
		t.Error("falta name")
	}
	empty, _ := New(t.TempDir(), Options{})
	if empty.HasSkills() {
		t.Error("sin skills")
	}
	if _, err := run(t, empty, ToolSkill, map[string]any{"name": "x"}); err == nil {
		t.Error("sin skills debe fallar")
	}
}

func TestReadSkillFileReadsInsideAndRejectsEscapes(t *testing.T) {
	w, root, skillDir, outside := newSkillWS(t)

	out, err := run(t, w, ToolReadSkillFile, map[string]any{"skill": "guia", "path": "references/api.md"})
	if err != nil || !strings.Contains(out, "linea2") {
		t.Fatalf("lectura = %q, %v", out, err)
	}
	// Con rango, como read_file.
	out, _ = run(t, w, ToolReadSkillFile, map[string]any{"skill": "guia", "path": "references/api.md", "start_line": 2})
	if !strings.Contains(out, "linea2") || strings.Contains(out, "linea1\n") {
		t.Errorf("rango = %q", out)
	}
	// Un directorio devuelve su listado.
	out, err = run(t, w, ToolReadSkillFile, map[string]any{"skill": "guia", "path": "scripts"})
	if err != nil || !strings.Contains(out, "run.sh") {
		t.Errorf("directorio = %q, %v", out, err)
	}
	// El skill NO da acceso al proyecto ni a otros lados con «..».
	put(t, root, "proyecto.txt", "del proyecto")
	for _, p := range []string{
		"../" + filepath.Base(outside) + "/secreto.txt",
		"../../../../../../../etc/hosts",
		filepath.Join(outside, "secreto.txt"),
		filepath.Join(root, "proyecto.txt"),
	} {
		_, err := run(t, w, ToolReadSkillFile, map[string]any{"skill": "guia", "path": p})
		if err == nil || !strings.Contains(err.Error(), "skill") {
			t.Errorf("%q debía rechazarse con el mensaje del skill: %v", p, err)
		}
	}
	// Y read_file del proyecto sigue sin ver la carpeta del skill.
	if _, err := run(t, w, ToolReadFile, map[string]any{"path": filepath.Join(skillDir, "SKILL.md")}); err == nil {
		t.Error("read_file no debe leer fuera de la raíz del proyecto")
	}
	if _, err := run(t, w, ToolReadSkillFile, map[string]any{"skill": "otro", "path": "x"}); err == nil {
		t.Error("skill desconocido")
	}
	if _, err := run(t, w, ToolReadSkillFile, map[string]any{"skill": "guia"}); err == nil {
		t.Error("falta path")
	}
}

func TestReadSkillFileSymlinkEscape(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks")
	}
	w, _, skillDir, outside := newSkillWS(t)
	// Un enlace DENTRO del skill que apunta afuera: ni el archivo ni el
	// directorio ni un enlace colgante dejan salir.
	if err := os.Symlink(filepath.Join(outside, "secreto.txt"), filepath.Join(skillDir, "enlace.txt")); err != nil {
		t.Skip(err)
	}
	if err := os.Symlink(outside, filepath.Join(skillDir, "carpeta")); err != nil {
		t.Skip(err)
	}
	for _, p := range []string{"enlace.txt", "carpeta/secreto.txt", "carpeta"} {
		out, err := run(t, w, ToolReadSkillFile, map[string]any{"skill": "guia", "path": p})
		if err == nil || strings.Contains(out, "NO LEER") {
			t.Errorf("%q salió del skill: %q, %v", p, out, err)
		}
	}
	// skill() tampoco lista lo que hay detrás de un enlace a directorio.
	out, err := run(t, w, ToolSkill, map[string]any{"name": "guia"})
	if err != nil || strings.Contains(out, "secreto.txt") {
		t.Errorf("skill() siguió un enlace: %q, %v", out, err)
	}
}

func TestSkillDirItselfMayBeASymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks")
	}
	// ~/.claude/skills/x -> clon del skill: es la forma habitual de instalarlos.
	real := t.TempDir()
	put(t, real, "SKILL.md", "# enlazado\n")
	put(t, real, "extra.md", "hola\n")
	link := filepath.Join(t.TempDir(), "x")
	if err := os.Symlink(real, link); err != nil {
		t.Skip(err)
	}
	w, err := New(t.TempDir(), Options{Skills: []SkillRef{{Name: "x", Dir: link}}})
	if err != nil {
		t.Fatal(err)
	}
	out, err := run(t, w, ToolReadSkillFile, map[string]any{"skill": "x", "path": "extra.md"})
	if err != nil || !strings.Contains(out, "hola") {
		t.Errorf("leer a través del enlace del skill: %q, %v", out, err)
	}
}

func TestSkillCaps(t *testing.T) {
	w, _, skillDir, _ := newSkillWS(t)
	put(t, skillDir, "SKILL.md", strings.Repeat("linea larga de prueba\n", 5000)) // > 64 KB
	for i := 0; i < maxSkillFiles+10; i++ {
		put(t, skillDir, "assets/f"+itoa(i)+".txt", "x")
	}
	out, err := run(t, w, ToolSkill, map[string]any{"name": "guia"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "64 KB") {
		t.Error("falta el aviso de SKILL.md cortado")
	}
	if n := strings.Count(out, "\n- "); n != maxSkillFiles {
		t.Errorf("archivos listados = %d", n)
	}
	if !strings.Contains(out, "100") {
		t.Error("falta el aviso de lista cortada")
	}
}
