package agentctx

import (
	"os"
	"path/filepath"
	"testing"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func find(list []Entry, name string) *Entry {
	for i := range list {
		if list[i].Name == name {
			return &list[i]
		}
	}
	return nil
}

// Los dos layouts que existen de verdad en los repos del usuario:
// .claude/skills (mini-tools) y .github/skills (support-lab). Omitir el
// segundo haría que ese proyecto se viera como si no tuviera ningún skill.
func TestScanFindsBothSkillLayouts(t *testing.T) {
	root := t.TempDir()

	writeFile(t, filepath.Join(root, ".claude", "skills", "mini-tools-patterns", "SKILL.md"),
		"---\nname: mini-tools-patterns\ndescription: Patrones de conectores de base de datos\n---\n\n# Contenido\n")
	writeFile(t, filepath.Join(root, ".github", "skills", "backend-support-lab", "SKILL.md"),
		"---\nname: backend-support-lab\ndescription: 'Reglas del backend Go/Fiber'\n---\n")

	// Una carpeta sin SKILL.md no es un skill: listarla daría una entrada que
	// ningún CLI va a cargar.
	if err := os.MkdirAll(filepath.Join(root, ".claude", "skills", "carpeta-suelta"), 0o755); err != nil {
		t.Fatal(err)
	}

	ctx := Scan(root)

	if len(ctx.Skills) != 2 {
		t.Fatalf("se esperaban 2 skills, hay %d: %+v", len(ctx.Skills), ctx.Skills)
	}
	if s := find(ctx.Skills, "mini-tools-patterns"); s == nil || s.Description != "Patrones de conectores de base de datos" {
		t.Errorf("skill de .claude/skills mal leído: %+v", s)
	}
	// Las comillas simples del YAML no son parte del valor.
	if s := find(ctx.Skills, "backend-support-lab"); s == nil || s.Description != "Reglas del backend Go/Fiber" {
		t.Errorf("skill de .github/skills mal leído: %+v", s)
	}
	for _, s := range ctx.Skills {
		if s.Scope != ScopeRepo {
			t.Errorf("%q debería ser del repo, es %q", s.Name, s.Scope)
		}
		if filepath.IsAbs(s.Path) {
			t.Errorf("la ruta de una entrada del repo debe ser relativa: %q", s.Path)
		}
	}
}

// Un archivo sin frontmatter, o con uno que no trae `name`, se lista igual —
// un catálogo al que le falta una entrada porque no supo parsearla es peor que
// uno que la muestra sin descripción.
func TestScanToleratesMissingFrontmatter(t *testing.T) {
	root := t.TempDir()

	writeFile(t, filepath.Join(root, ".claude", "skills", "sin-frontmatter", "SKILL.md"), "# Solo un título\n")
	writeFile(t, filepath.Join(root, ".claude", "agents", "revisor.md"), "---\ndescription: Revisa código\n---\n")
	writeFile(t, filepath.Join(root, ".claude", "commands", "deploy.md"), "Sin frontmatter.\n")
	// Lo que no es .md no es un comando.
	writeFile(t, filepath.Join(root, ".claude", "commands", "notas.txt"), "nada\n")

	ctx := Scan(root)

	if s := find(ctx.Skills, "sin-frontmatter"); s == nil {
		t.Errorf("un skill sin frontmatter debe listarse por el nombre de su carpeta: %+v", ctx.Skills)
	}
	if a := find(ctx.Agents, "revisor"); a == nil || a.Description != "Revisa código" {
		t.Errorf("subagente sin `name` debe caer al nombre del archivo: %+v", ctx.Agents)
	}
	if len(ctx.Commands) != 1 || ctx.Commands[0].Name != "deploy" {
		t.Errorf("se esperaba solo el comando deploy: %+v", ctx.Commands)
	}
}

// Los ausentes se informan igual: la pregunta que contesta el panel no es solo
// "qué tengo" sino "qué le falta a este repo para que el agente que uso lo lea".
func TestScanReportsMissingInstructions(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "CLAUDE.md"), "# Proyecto\n")

	ctx := Scan(root)

	if len(ctx.Instructions) != len(instructionFiles) {
		t.Fatalf("se esperaban %d archivos de instrucciones, hay %d", len(instructionFiles), len(ctx.Instructions))
	}
	byFile := map[string]Instruction{}
	for _, i := range ctx.Instructions {
		byFile[i.File] = i
	}
	if c := byFile["CLAUDE.md"]; !c.Present || c.Size == 0 {
		t.Errorf("CLAUDE.md existe y debería reportarse presente y con tamaño: %+v", c)
	}
	for _, missing := range []string{"AGENTS.md", "GEMINI.md"} {
		if byFile[missing].Present {
			t.Errorf("%s no existe y se reportó como presente", missing)
		}
	}
	if got := byFile["AGENTS.md"].Agents; len(got) != 1 || got[0] != "codex" {
		t.Errorf("AGENTS.md debería atribuirse a codex, dice %v", got)
	}
	// La ruta anidada se normaliza con "/" en todas las plataformas.
	if _, ok := byFile[".github/copilot-instructions.md"]; !ok {
		t.Errorf("falta copilot-instructions.md en el listado: %+v", ctx.Instructions)
	}
}

// Un repositorio sin nada de esto es el caso NORMAL y no es un error.
func TestScanEmptyRepo(t *testing.T) {
	ctx := Scan(t.TempDir())

	if len(ctx.Skills) != 0 || len(ctx.Agents) != 0 || len(ctx.Commands) != 0 {
		t.Errorf("un repo vacío no debería tener entradas: %+v", ctx)
	}
	// Listas vacías, no nil: en JSON la diferencia es [] contra null, y el
	// frontend hace .map() sobre esto.
	if ctx.Skills == nil || ctx.Agents == nil || ctx.Commands == nil {
		t.Error("las listas vacías deben serializar como [] y no como null")
	}
	// Los archivos de instrucciones se informan igual, todos ausentes.
	if len(ctx.Instructions) != len(instructionFiles) {
		t.Errorf("los ausentes también se listan: %+v", ctx.Instructions)
	}
}
