package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"mini-tools/backend/git"
)

// gitIn corre git en un repositorio temporal con identidad propia: el test no
// debe depender de la configuración global de quien lo corre.
func gitIn(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"}, args...)...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func TestGitReviewContext(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git no está instalado")
	}
	a, _ := newChatApp(t)
	a.gitRunner = git.NewRunner()
	repoID, root := addRepo(t, a)
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	gitIn(t, root, "init", "-q")
	write("a.txt", "uno\ndos\n")
	write("b.txt", "bee\n")
	gitIn(t, root, "add", ".")
	gitIn(t, root, "commit", "-q", "-m", "base")

	// Árbol limpio: error claro, no un contexto vacío.
	if _, err := a.GitReviewContext(repoID); err == nil {
		t.Fatal("sin cambios debería fallar")
	}

	write("a.txt", "uno\ndos\ntres\n") // preparado
	gitIn(t, root, "add", "a.txt")
	write("b.txt", "bee\nbe dos\n")    // sin preparar
	write("nuevo.txt", "sin seguir\n") // untracked

	rc, err := a.GitReviewContext(repoID)
	if err != nil {
		t.Fatal(err)
	}
	if len(rc.Files) != 3 {
		t.Fatalf("archivos = %v", rc.Files)
	}
	joined := strings.Join(rc.Files, "|")
	for _, want := range []string{"M  a.txt", " M b.txt", "?? nuevo.txt"} {
		if !strings.Contains(joined, want) {
			t.Errorf("falta %q en %v", want, rc.Files)
		}
	}
	iStaged := strings.Index(rc.Diff, "+tres")
	iWork := strings.Index(rc.Diff, "+be dos")
	if iStaged < 0 || iWork < 0 || iStaged > iWork {
		t.Errorf("el diff debe traer lo preparado antes que lo sin preparar:\n%s", rc.Diff)
	}
	if strings.Contains(rc.Diff, "sin seguir") {
		t.Error("un archivo sin seguimiento no sale en el diff, solo por nombre")
	}
	if rc.Insertions != 2 || rc.Deletions != 0 || rc.Truncated {
		t.Errorf("ins=%d del=%d truncated=%v", rc.Insertions, rc.Deletions, rc.Truncated)
	}

	// Un binario no se lleva puestos los archivos de texto.
	write("img.bin", "x\x00y\x00z")
	gitIn(t, root, "add", "img.bin")
	rc, err = a.GitReviewContext(repoID)
	if err != nil || !strings.Contains(rc.Diff, "+tres") {
		t.Fatalf("el binario tapó el diff de texto (err=%v):\n%s", err, rc.Diff)
	}

	// Pasado el presupuesto se recorta y lo declara.
	write("b.txt", strings.Repeat("linea larga de relleno para pasar el presupuesto\n", 2000))
	rc, err = a.GitReviewContext(repoID)
	if err != nil {
		t.Fatal(err)
	}
	if !rc.Truncated || len(rc.Diff) > reviewDiffBudget {
		t.Errorf("truncated=%v len=%d", rc.Truncated, len(rc.Diff))
	}

	// Solo archivos sin seguimiento: hay contexto (por nombre) y diff vacío.
	gitIn(t, root, "add", "-A")
	gitIn(t, root, "commit", "-q", "-m", "todo")
	write("solo.txt", "x\n")
	rc, err = a.GitReviewContext(repoID)
	if err != nil || len(rc.Files) != 1 || rc.Diff != "" {
		t.Fatalf("solo untracked: files=%v diff=%q err=%v", rc.Files, rc.Diff, err)
	}
}
