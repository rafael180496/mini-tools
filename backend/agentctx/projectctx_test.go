package agentctx

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func load(t *testing.T, root, home string) ProjectContext {
	t.Helper()
	return LoadProject(ProjectOptions{Root: root, Home: home, OS: "testos", Now: time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)})
}

func paths(pc ProjectContext) string {
	var out []string
	for _, in := range pc.Instructions {
		out = append(out, in.Path+"|"+in.Scope)
	}
	return strings.Join(out, ",")
}

func TestInstructionsProjectAndGlobalOrderAndDedupe(t *testing.T) {
	root, home := t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(root, "AGENTS.md"), "reglas del agente\n")
	writeFile(t, filepath.Join(root, "CLAUDE.md"), "reglas de claude\n")
	writeFile(t, filepath.Join(root, "CLAUDE.local.md"), "preferencias locales\n")
	writeFile(t, filepath.Join(root, "GEMINI.md"), "reglas del agente\n") // copia exacta de AGENTS.md
	writeFile(t, filepath.Join(root, ".github", "copilot-instructions.md"), "copilot\n")
	writeFile(t, filepath.Join(root, ".cursorrules"), "cursor viejo\n")
	writeFile(t, filepath.Join(home, ".claude", "CLAUDE.md"), "global claude\n")
	writeFile(t, filepath.Join(home, ".config", "opencode", "AGENTS.md"), "global opencode\n")
	writeFile(t, filepath.Join(home, ".codex", "AGENTS.md"), "global codex\n")

	pc := load(t, root, home)
	want := "AGENTS.md|project,CLAUDE.md|project,CLAUDE.local.md|project,.github/copilot-instructions.md|project,.cursorrules|project," +
		"~/.claude/CLAUDE.md|global,~/.config/opencode/AGENTS.md|global,~/.codex/AGENTS.md|global"
	if got := paths(pc); got != want {
		t.Errorf("instrucciones =\n%s\nquería\n%s", got, want)
	}
	if pc.TotalChars == 0 {
		t.Error("TotalChars")
	}
}

func TestInstructionsDedupeSymlinkAndMissing(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks")
	}
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "AGENTS.md"), "unico\n")
	if err := os.Symlink("AGENTS.md", filepath.Join(root, "CLAUDE.md")); err != nil {
		t.Skip(err)
	}
	pc := load(t, root, t.TempDir())
	if got := paths(pc); got != "AGENTS.md|project" {
		t.Errorf("CLAUDE.md es un enlace a AGENTS.md y no debe repetirse: %s", got)
	}
	// Sin nada: solo entorno.
	empty := load(t, t.TempDir(), t.TempDir())
	if len(empty.Instructions) != 0 || len(empty.Skills) != 0 {
		t.Errorf("proyecto vacío = %+v", empty)
	}
	instr, skills := empty.Info()
	if instr == nil || skills == nil {
		t.Error("Info debe devolver listas vacías, no nil (JSON [] y no null)")
	}
}

func TestInstructionImports(t *testing.T) {
	root, home := t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(root, "CLAUDE.md"),
		"Principal\n@docs/estilo.md\nContacto a@b.md no es un import\n`@docs/ejemplo.md` tampoco\n```\n@docs/ejemplo.md\n```\n@docs/no-md.txt\n@../fuera.md\n@~/.claude/global.md\n")
	writeFile(t, filepath.Join(root, "docs", "estilo.md"), "Estilo\n@testing.md\n")
	writeFile(t, filepath.Join(root, "docs", "testing.md"), "Testing\n@estilo.md\n@nivel3.md\n") // estilo.md es un ciclo
	writeFile(t, filepath.Join(root, "docs", "nivel3.md"), "Nivel 3\n@nivel4.md\n")
	writeFile(t, filepath.Join(root, "docs", "nivel4.md"), "Nivel 4\n")
	writeFile(t, filepath.Join(root, "docs", "ejemplo.md"), "no debe cargarse\n")
	writeFile(t, filepath.Join(root, "docs", "no-md.txt"), "no debe cargarse\n")
	writeFile(t, filepath.Join(filepath.Dir(root), filepath.Base(root)+"-fuera.md"), "afuera\n")
	writeFile(t, filepath.Join(home, ".claude", "global.md"), "no debe cargarse desde un archivo del proyecto\n")

	pc := load(t, root, home)
	got := paths(pc)
	// CLAUDE.md → estilo (1) → testing (2) → nivel3 (3); nivel4 sería el salto 4.
	if got != "CLAUDE.md|project,docs/estilo.md|project,docs/testing.md|project,docs/nivel3.md|project" {
		t.Errorf("imports = %s", got)
	}
	if pc.Instructions[1].ImportedFrom != "CLAUDE.md" || pc.Instructions[2].ImportedFrom != "docs/estilo.md" {
		t.Errorf("ImportedFrom = %+v", pc.Instructions)
	}
	text := pc.Prompt(Guidance{})
	for _, bad := range []string{"no debe cargarse", "afuera", "Nivel 4"} {
		if strings.Contains(text, bad) {
			t.Errorf("el prompt incluye %q", bad)
		}
	}
}

func TestGlobalImportStaysInsideGlobalDirAndSymlinkEscape(t *testing.T) {
	root, home := t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(home, ".claude", "CLAUDE.md"), "Global\n@estilo.md\n@../secreto.md\n")
	writeFile(t, filepath.Join(home, ".claude", "estilo.md"), "Estilo global\n")
	writeFile(t, filepath.Join(home, "secreto.md"), "fuera de ~/.claude\n")
	pc := load(t, root, home)
	if got := paths(pc); got != "~/.claude/CLAUDE.md|global,~/.claude/estilo.md|global" {
		t.Errorf("import global = %s", got)
	}

	if runtime.GOOS == "windows" {
		return
	}
	// Un enlace dentro del proyecto que apunta afuera no es una forma de salir.
	outside := t.TempDir()
	writeFile(t, filepath.Join(outside, "robado.md"), "secreto\n")
	root2 := t.TempDir()
	writeFile(t, filepath.Join(root2, "AGENTS.md"), "@enlace.md\n")
	if err := os.Symlink(filepath.Join(outside, "robado.md"), filepath.Join(root2, "enlace.md")); err != nil {
		t.Skip(err)
	}
	if got := paths(load(t, root2, t.TempDir())); got != "AGENTS.md|project" {
		t.Errorf("el enlace que sale del proyecto se siguió: %s", got)
	}
}

func TestInstructionImportCycle(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "AGENTS.md"), "A\n@b.md\n")
	writeFile(t, filepath.Join(root, "b.md"), "B\n@AGENTS.md\n@b.md\n")
	pc := load(t, root, t.TempDir())
	if got := paths(pc); got != "AGENTS.md|project,b.md|project" {
		t.Errorf("ciclo = %s", got)
	}
}

func TestInstructionCaps(t *testing.T) {
	root, home := t.TempDir(), t.TempDir()
	big := strings.Repeat("a", 20000)
	writeFile(t, filepath.Join(root, "AGENTS.md"), big)
	writeFile(t, filepath.Join(root, "CLAUDE.md"), strings.Repeat("b", 20000))
	writeFile(t, filepath.Join(root, "GEMINI.md"), "tercero\n")
	writeFile(t, filepath.Join(home, ".claude", "CLAUDE.md"), "global\n")
	pc := load(t, root, home)
	if pc.TotalChars != MaxInstructionChars {
		t.Errorf("TotalChars = %d, quería el tope %d", pc.TotalChars, MaxInstructionChars)
	}
	if len(pc.Instructions) != 2 || pc.Instructions[0].Truncated || !pc.Instructions[1].Truncated || pc.Instructions[1].Chars != 12000 {
		t.Errorf("el segundo debía cortarse a 12000: %+v", pc.Instructions)
	}
	// Los que ya no entran se informan por nombre y no desaparecen.
	if got := strings.Join(pc.OmittedInstructions, ","); got != "GEMINI.md,~/.claude/CLAUDE.md" {
		t.Errorf("omitidos = %q", got)
	}
	instr, _ := pc.Info()
	last := instr[len(instr)-1]
	if last.Path != "~/.claude/CLAUDE.md" || last.Scope != ScopeGlobal || last.Chars != 0 || !last.Truncated {
		t.Errorf("Info de un omitido = %+v", last)
	}
	text := pc.Prompt(Guidance{})
	if !strings.Contains(text, "Instructions truncated") && !strings.Contains(text, "Instrucciones truncadas") {
		t.Error("falta la nota de truncado")
	}
	if !strings.Contains(text, "GEMINI.md") {
		t.Error("la nota debe nombrar lo que no entró")
	}
	if n := utf8.RuneCountInString(pc.Instructions[1].Content); n != 12000 {
		t.Errorf("contenido = %d", n)
	}
}

func TestCursorRulesOnlyAlwaysApply(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, ".cursor", "rules", "siempre.mdc"), "---\ndescription: x\nalwaysApply: true\n---\nRegla fija\n")
	writeFile(t, filepath.Join(root, ".cursor", "rules", "por-glob.mdc"), "---\nglobs: *.go\nalwaysApply: false\n---\nSolo en Go\n")
	writeFile(t, filepath.Join(root, ".cursor", "rules", "sin-front.mdc"), "Sin frontmatter\n")
	pc := load(t, root, t.TempDir())
	if got := paths(pc); got != ".cursor/rules/siempre.mdc|project" {
		t.Errorf("reglas de cursor = %s", got)
	}
	if strings.Contains(pc.Instructions[0].Content, "alwaysApply") || !strings.Contains(pc.Instructions[0].Content, "Regla fija") {
		t.Errorf("debe incluir solo el cuerpo: %q", pc.Instructions[0].Content)
	}
}

func TestSkillsIndexDirsDedupeAndFrontmatter(t *testing.T) {
	root, home := t.TempDir(), t.TempDir()
	skill := func(base, dir, name, body string) {
		writeFile(t, filepath.Join(base, filepath.FromSlash(dir), name, "SKILL.md"), body)
	}
	skill(root, ".claude/skills", "uno", "---\nname: uno\ndescription: Primero\n---\n")
	skill(root, ".github/skills", "dos", "---\ndescription: Sin nombre en frontmatter\n---\n")
	skill(root, ".opencode/skill", "tres", "---\nname: tres\ndescription: >\n  Descripción en\n  varias líneas\n---\n")
	skill(root, ".opencode/skills", "cuatro", "---\nname: cuatro\ndescription: |\n  Bloque literal\n---\n")
	skill(root, ".agents/skills", "cinco", "# sin frontmatter\n")
	skill(home, ".claude/skills", "uno", "---\nname: uno\ndescription: Global que tapa el del proyecto\n---\n")
	skill(home, ".claude/skills", "g-claude", "---\nname: g-claude\ndescription: Global de Claude\n---\n")
	skill(home, ".config/opencode/skill", "g-oc1", "---\ndescription: Global OpenCode skill\n---\n")
	skill(home, ".config/opencode/skills", "g-oc2", "---\ndescription: Global OpenCode skills\n---\n")
	skill(home, ".agents/skills", "g-agents", "---\ndescription: Global agents\n---\n")
	if err := os.MkdirAll(filepath.Join(root, ".claude", "skills", "carpeta-suelta"), 0o755); err != nil {
		t.Fatal(err)
	}

	pc := load(t, root, home)
	byName := map[string]SkillInfo{}
	for _, s := range pc.Skills {
		if _, dup := byName[strings.ToLower(s.Name)]; dup {
			t.Errorf("nombre repetido: %s", s.Name)
		}
		byName[strings.ToLower(s.Name)] = s
	}
	if len(pc.Skills) != 9 {
		t.Fatalf("skills = %d: %+v", len(pc.Skills), pc.Skills)
	}
	if s := byName["uno"]; s.Scope != ScopeProject || s.Description != "Primero" || s.Path != ".claude/skills/uno/SKILL.md" {
		t.Errorf("el del proyecto debe ganar: %+v", s)
	}
	if s := byName["dos"]; s.Description != "Sin nombre en frontmatter" || s.Dir == "" {
		t.Errorf("sin name usa la carpeta: %+v", s)
	}
	if s := byName["tres"]; s.Description != "Descripción en varias líneas" {
		t.Errorf("descripción plegada = %q", s.Description)
	}
	if s := byName["cuatro"]; s.Description != "Bloque literal" {
		t.Errorf("descripción en bloque = %q", s.Description)
	}
	if s := byName["cinco"]; s.Description != "" {
		t.Errorf("sin frontmatter = %+v", s)
	}
	for _, n := range []string{"g-claude", "g-oc1", "g-oc2", "g-agents"} {
		if s := byName[n]; s.Scope != ScopeGlobal || !strings.HasPrefix(s.Path, "~/") {
			t.Errorf("%s = %+v", n, s)
		}
	}
	if _, ok := byName["carpeta-suelta"]; ok {
		t.Error("una carpeta sin SKILL.md no es un skill")
	}
}

func TestSkillsCapAndDescriptionLength(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < MaxSkillsListed+5; i++ {
		name := "s" + string(rune('a'+i/26)) + string(rune('a'+i%26))
		writeFile(t, filepath.Join(root, ".claude", "skills", name, "SKILL.md"),
			"---\nname: "+name+"\ndescription: "+strings.Repeat("palabra ", 100)+"\n---\n")
	}
	pc := load(t, root, t.TempDir())
	if len(pc.Skills) != MaxSkillsListed || pc.SkillsOmitted != 5 {
		t.Errorf("skills = %d, omitidos = %d", len(pc.Skills), pc.SkillsOmitted)
	}
	if n := utf8.RuneCountInString(pc.Skills[0].Description); n > MaxSkillDescChars+1 {
		t.Errorf("descripción de %d caracteres", n)
	}
	if !strings.Contains(pc.Prompt(Guidance{}), "5 more skills") && !strings.Contains(pc.Prompt(Guidance{}), "5 skills más") {
		t.Error("falta el aviso de skills omitidos")
	}
}

func TestSkillSymlinkedFolderIsListed(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks")
	}
	home := t.TempDir()
	clone := t.TempDir()
	writeFile(t, filepath.Join(clone, "SKILL.md"), "---\nname: enlazado\ndescription: Instalado por enlace\n---\n")
	if err := os.MkdirAll(filepath.Join(home, ".claude", "skills"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(clone, filepath.Join(home, ".claude", "skills", "enlazado")); err != nil {
		t.Skip(err)
	}
	pc := load(t, t.TempDir(), home)
	if len(pc.Skills) != 1 || pc.Skills[0].Name != "enlazado" {
		t.Errorf("skill instalado por enlace = %+v", pc.Skills)
	}
}

func TestGitHeadVariants(t *testing.T) {
	root := t.TempDir()
	if isGit, _ := gitHead(root); isGit {
		t.Error("sin .git no es un repositorio")
	}
	writeFile(t, filepath.Join(root, ".git", "HEAD"), "ref: refs/heads/feature/x\n")
	if isGit, br := gitHead(root); !isGit || br != "feature/x" {
		t.Errorf("rama = %v %q", isGit, br)
	}
	writeFile(t, filepath.Join(root, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n")
	if _, br := gitHead(root); br != "HEAD@0123456" {
		t.Errorf("HEAD desacoplado = %q", br)
	}
	// Worktree/submódulo: .git es un archivo que apunta al directorio real.
	wt := t.TempDir()
	real := filepath.Join(t.TempDir(), "gitdir")
	writeFile(t, filepath.Join(real, "HEAD"), "ref: refs/heads/wt\n")
	writeFile(t, filepath.Join(wt, ".git"), "gitdir: "+real+"\n")
	if isGit, br := gitHead(wt); !isGit || br != "wt" {
		t.Errorf("worktree = %v %q", isGit, br)
	}
}

func TestPromptStructure(t *testing.T) {
	root, home := t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(root, ".git", "HEAD"), "ref: refs/heads/main\n")
	writeFile(t, filepath.Join(root, "AGENTS.md"), "Usá tabs.\n")
	writeFile(t, filepath.Join(root, ".claude", "skills", "mi-skill", "SKILL.md"), "---\nname: mi-skill\ndescription: Hace cosas\n---\n")
	pc := load(t, root, home)

	full := pc.Prompt(Guidance{CanWrite: true, CanRun: true, ModeRule: "REGLA-DEL-MODO"})
	realRoot, _ := filepath.EvalSymlinks(root)
	for _, want := range []string{
		"testos", realRoot, "main", "2026-10-12", "REGLA-DEL-MODO",
		"list_dir, glob, search, read_file, edit_file, write_file, run_command, skill, read_skill_file",
		"edit_file", "run_command",
		"--- AGENTS.md (", "Usá tabs.", "mi-skill: Hace cosas",
	} {
		if !strings.Contains(full, want) {
			t.Errorf("falta %q en el prompt:\n%s", want, full)
		}
	}
	// Orden: entorno, guía, instrucciones, skills.
	iEnv, iGuide, iInstr, iSkills := strings.Index(full, "testos"), strings.Index(full, "edit_file con"), strings.Index(full, "Usá tabs."), strings.Index(full, "mi-skill: Hace")
	if iGuide < 0 {
		iGuide = strings.Index(full, "edit_file with")
	}
	if !(iEnv < iGuide && iGuide < iInstr && iInstr < iSkills) {
		t.Errorf("orden de secciones: env=%d guía=%d instr=%d skills=%d", iEnv, iGuide, iInstr, iSkills)
	}

	// Solo lectura: no promete editar ni correr.
	ro := pc.Prompt(Guidance{})
	if strings.Contains(ro, "write_file") || strings.Contains(ro, "run_command") {
		t.Errorf("en un modo de solo lectura no se nombran las herramientas de escritura:\n%s", ro)
	}
	if !strings.Contains(ro, "cannot modify") && !strings.Contains(ro, "no podés modificar") {
		t.Errorf("falta la pauta de proponer en vez de editar:\n%s", ro)
	}
	// Sin skills ni instrucciones, sin esas secciones.
	bare := load(t, t.TempDir(), t.TempDir()).Prompt(Guidance{CanWrite: true, CanRun: true})
	if strings.Contains(bare, "# Available skills") || strings.Contains(bare, "# Project instructions") || strings.Contains(bare, "# Skills disponibles") || strings.Contains(bare, "# Instrucciones del proyecto") {
		t.Errorf("sin skills ni instrucciones no hay secciones:\n%s", bare)
	}
}
