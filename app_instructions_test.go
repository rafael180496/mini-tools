package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGitCreateInstructionPointer(t *testing.T) {
	a, _ := newChatApp(t)
	repoID, root := addRepo(t, a)
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	read := func(name string) string {
		t.Helper()
		b, err := os.ReadFile(filepath.Join(root, name))
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}

	// Sin ninguna fuente: error y nada escrito.
	if _, err := a.GitCreateInstructionPointer(repoID, "AGENTS.md"); err == nil {
		t.Fatal("sin fuente debería fallar")
	}
	if _, err := os.Stat(filepath.Join(root, "AGENTS.md")); err == nil {
		t.Fatal("no debería haberse creado")
	}

	write("CLAUDE.md", "# reglas\n")

	// Crea el que falta apuntando a la fuente.
	src, err := a.GitCreateInstructionPointer(repoID, "AGENTS.md")
	if err != nil || src != "CLAUDE.md" {
		t.Fatalf("src=%q err=%v", src, err)
	}
	if !strings.Contains(read("AGENTS.md"), "[CLAUDE.md](CLAUDE.md)") {
		t.Errorf("AGENTS.md sin enlace: %q", read("AGENTS.md"))
	}
	src, err = a.GitCreateInstructionPointer(repoID, "GEMINI.md")
	if err != nil || src != "CLAUDE.md" || !strings.Contains(read("GEMINI.md"), "@./CLAUDE.md") {
		t.Fatalf("GEMINI: src=%q err=%v body=%q", src, err, read("GEMINI.md"))
	}

	// Nunca pisa uno existente, ni siquiera el original.
	write("AGENTS.md", "mío")
	if _, err := a.GitCreateInstructionPointer(repoID, "AGENTS.md"); err == nil {
		t.Fatal("pisó un archivo existente")
	}
	if read("AGENTS.md") != "mío" {
		t.Errorf("AGENTS.md cambió: %q", read("AGENTS.md"))
	}
	if _, err := a.GitCreateInstructionPointer(repoID, "CLAUDE.md"); err == nil || read("CLAUDE.md") != "# reglas\n" {
		t.Fatalf("CLAUDE.md existente debe conservarse (err=%v)", err)
	}

	// La fuente respeta el orden: si CLAUDE.md falta, apunta a AGENTS.md.
	if err := os.Remove(filepath.Join(root, "CLAUDE.md")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, "GEMINI.md")); err != nil {
		t.Fatal(err)
	}
	src, err = a.GitCreateInstructionPointer(repoID, "CLAUDE.md")
	if err != nil || src != "AGENTS.md" || !strings.Contains(read("CLAUDE.md"), "\n@AGENTS.md\n") {
		t.Fatalf("CLAUDE: src=%q err=%v body=%q", src, err, read("CLAUDE.md"))
	}

	// Nombres fuera de la lista y rutas con separadores.
	for _, bad := range []string{"README.md", "../CLAUDE.md", "sub/AGENTS.md", `sub\AGENTS.md`, "", ".github/copilot-instructions.md", "claude.md"} {
		if _, err := a.GitCreateInstructionPointer(repoID, bad); err == nil {
			t.Errorf("%q debería rechazarse", bad)
		}
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(root), "CLAUDE.md")); err == nil {
		t.Error("escribió fuera del repo")
	}

	// Repo inexistente.
	if _, err := a.GitCreateInstructionPointer("no-existe", "AGENTS.md"); err == nil {
		t.Error("repo inexistente debería fallar")
	}
}
