package agentctx

import (
	"strings"
	"testing"

	"mini-tools/backend/i18n"
)

func TestInstructionPointerSyntaxPerTarget(t *testing.T) {
	i18n.SetLang("es")
	t.Cleanup(func() { i18n.SetLang("en") })

	cases := []struct {
		target, source string
		want           []string
		notWant        []string
	}{
		// Claude Code: import `@ruta` en su propia línea.
		{"CLAUDE.md", "AGENTS.md", []string{"\n@AGENTS.md\n"}, []string{"@./"}},
		// Gemini/Antigravity: import `@./ruta`.
		{"GEMINI.md", "CLAUDE.md", []string{"\n@./CLAUDE.md\n"}, nil},
		// Codex/OpenCode no importan: enlace markdown, sin `@` al inicio de línea.
		{"AGENTS.md", "CLAUDE.md", []string{"[CLAUDE.md](CLAUDE.md)"}, []string{"\n@CLAUDE.md", "\n@./CLAUDE.md"}},
	}
	for _, c := range cases {
		got := InstructionPointer(c.target, c.source)
		if got == "" {
			t.Fatalf("%s <- %s: vacío", c.target, c.source)
		}
		for _, w := range c.want {
			if !strings.Contains(got, w) {
				t.Errorf("%s <- %s: falta %q en:\n%s", c.target, c.source, w, got)
			}
		}
		for _, n := range c.notWant {
			if strings.Contains(got, n) {
				t.Errorf("%s <- %s: no debería contener %q en:\n%s", c.target, c.source, n, got)
			}
		}
	}
}

func TestInstructionPointerRejectsInvalid(t *testing.T) {
	for _, c := range [][2]string{
		{"README.md", "CLAUDE.md"},
		{"CLAUDE.md", "CLAUDE.md"},
		{"AGENTS.md", ""},
		{".github/copilot-instructions.md", "CLAUDE.md"},
	} {
		if got := InstructionPointer(c[0], c[1]); got != "" {
			t.Errorf("(%q, %q) debería ser vacío, fue %q", c[0], c[1], got)
		}
	}
}

func TestInstructionPointerFollowsLanguage(t *testing.T) {
	t.Cleanup(func() { i18n.SetLang("en") })
	i18n.SetLang("es")
	es := InstructionPointer("AGENTS.md", "CLAUDE.md")
	i18n.SetLang("en")
	en := InstructionPointer("AGENTS.md", "CLAUDE.md")
	if es == en || !strings.Contains(es, "Instrucciones") || !strings.Contains(en, "instructions") {
		t.Errorf("el idioma no cambia el texto:\nES=%s\nEN=%s", es, en)
	}
}
