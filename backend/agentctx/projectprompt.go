package agentctx

import (
	"fmt"
	"strings"

	"mini-tools/backend/i18n"
)

// Guidance es lo que depende del modo del chat y no del proyecto: qué puede
// hacer el modelo. agentctx no conoce los modos (los decide backend/agentchat);
// quien llama traduce el modo a estos tres datos.
type Guidance struct {
	// CanWrite: se declaran write_file y edit_file.
	CanWrite bool
	// CanRun: se declara run_command.
	CanRun bool
	// ModeRule es la frase que dice cuándo se pregunta al usuario ("las
	// ediciones se aplican directo; los comandos piden permiso…"). Opcional.
	ModeRule string
}

// Prompt arma el mensaje de sistema del proyecto: entorno, guía de trabajo,
// instrucciones y skills. Las secciones van de lo que siempre vale (entorno y
// guía) a lo que más espacio ocupa (instrucciones, skills): si un modelo con
// poco contexto pierde algo, que sea lo último.
func (p ProjectContext) Prompt(g Guidance) string {
	var parts []string
	parts = append(parts, p.environmentSection(g))
	parts = append(parts, guidanceSection(g, len(p.Instructions) > 0))
	if s := p.instructionsSection(); s != "" {
		parts = append(parts, s)
	}
	if s := p.skillsSection(); s != "" {
		parts = append(parts, s)
	}
	return strings.Join(parts, "\n\n")
}

// ToolNames son las herramientas que existen en este contexto, en el orden en
// que se le nombran al modelo.
func (p ProjectContext) ToolNames(g Guidance) []string {
	names := []string{"list_dir", "glob", "search", "read_file"}
	if g.CanWrite {
		names = append(names, "edit_file", "write_file")
	}
	if g.CanRun {
		names = append(names, "run_command")
	}
	if len(p.Skills) > 0 {
		names = append(names, "skill", "read_skill_file")
	}
	return names
}

func (p ProjectContext) environmentSection(g Guidance) string {
	git := i18n.T(i18n.Msg{ES: "no", EN: "no"})
	if p.IsGit {
		switch {
		case p.Branch == "":
			git = i18n.T(i18n.Msg{ES: "sí", EN: "yes"})
		case strings.HasPrefix(p.Branch, "HEAD@"):
			git = i18n.T(i18n.Msg{ES: "sí (HEAD desacoplado en %s)", EN: "yes (detached HEAD at %s)"}, strings.TrimPrefix(p.Branch, "HEAD@"))
		default:
			git = i18n.T(i18n.Msg{ES: "sí (rama %s)", EN: "yes (branch %s)"}, p.Branch)
		}
	}
	var b strings.Builder
	b.WriteString(i18n.T(i18n.Msg{ES: "# Entorno", EN: "# Environment"}) + "\n")
	b.WriteString(i18n.T(i18n.Msg{ES: "- Sistema operativo: %s", EN: "- Operating system: %s"}, p.OS) + "\n")
	b.WriteString(i18n.T(i18n.Msg{ES: "- Raíz del proyecto (directorio de trabajo): %s", EN: "- Project root (working directory): %s"}, p.Root) + "\n")
	b.WriteString(i18n.T(i18n.Msg{ES: "- Repositorio git: %s", EN: "- Git repository: %s"}, git) + "\n")
	b.WriteString(i18n.T(i18n.Msg{ES: "- Fecha de hoy: %s", EN: "- Today's date: %s"}, p.Today) + "\n")
	b.WriteString(i18n.T(i18n.Msg{ES: "- Herramientas de este modo: %s", EN: "- Tools in this mode: %s"}, strings.Join(p.ToolNames(g), ", ")))
	if r := strings.TrimSpace(g.ModeRule); r != "" {
		b.WriteString("\n- " + r)
	}
	return b.String()
}

// guidanceSection es la guía de trabajo. Cada pauta lleva su motivo: un
// modelo que sabe por qué conviene leer antes de editar lo hace también cuando
// la situación no es exactamente la del ejemplo.
func guidanceSection(g Guidance, hasInstructions bool) string {
	var b strings.Builder
	b.WriteString(i18n.T(i18n.Msg{ES: "# Cómo trabajar", EN: "# How to work"}) + "\n")
	b.WriteString(i18n.T(i18n.Msg{
		ES: "Sos un agente de programación que trabaja dentro del proyecto de arriba. Tus herramientas corren en la máquina del usuario y las rutas son relativas a la raíz del proyecto.",
		EN: "You are a coding agent working inside the project above. Your tools run on the user's machine and paths are relative to the project root.",
	}) + "\n")
	line := func(m i18n.Msg) { b.WriteString("\n- " + i18n.T(m)) }

	line(i18n.Msg{
		ES: "Explorá antes de actuar: con list_dir, glob, search y read_file mirá cómo está organizado el código y qué convenciones sigue. Un cambio hecho sin leer lo que lo rodea suele chocar con ello.",
		EN: "Explore before acting: use list_dir, glob, search and read_file to see how the code is organized and which conventions it follows. A change made without reading its surroundings tends to clash with them.",
	})
	if g.CanWrite {
		line(i18n.Msg{
			ES: "Hacé cambios chicos y enfocados: para modificar un archivo existente usá edit_file con un fragmento exacto y único, y reservá write_file para archivos nuevos o reescrituras completas. Así el cambio es fácil de revisar y no pisás lo que no querías tocar.",
			EN: "Make small, focused changes: to modify an existing file use edit_file with an exact, unique fragment, and keep write_file for new files or full rewrites. That way the change is easy to review and you do not overwrite what you did not mean to touch.",
		})
	} else {
		line(i18n.Msg{
			ES: "En este modo no podés modificar archivos: proponé los cambios indicando el archivo, el fragmento y el motivo, para que el usuario los aplique o cambie a un modo que permita editar.",
			EN: "In this mode you cannot modify files: propose the changes giving the file, the fragment and the reason, so the user can apply them or switch to a mode that allows editing.",
		})
	}
	if g.CanRun && g.CanWrite {
		line(i18n.Msg{
			ES: "Después de cambiar código, corré las pruebas o el build del proyecto con run_command (las instrucciones o los archivos del proyecto dicen cómo) y corregí lo que rompiste antes de darlo por terminado. Si no pudiste verificarlo, decilo.",
			EN: "After changing code, run the project's tests or build with run_command (the instructions or the project files say how) and fix what you broke before calling it done. If you could not verify it, say so.",
		})
	} else if !g.CanRun {
		line(i18n.Msg{
			ES: "En este modo no podés ejecutar comandos: no digas que probaste algo que no corriste.",
			EN: "In this mode you cannot run commands: do not claim you tested something you did not run.",
		})
	}
	if hasInstructions {
		line(i18n.Msg{
			ES: "Seguí las instrucciones del proyecto de más abajo: las escribió quien conoce el código y valen más que tus preferencias.",
			EN: "Follow the project instructions below: they were written by someone who knows the code and outweigh your preferences.",
		})
	}
	line(i18n.Msg{
		ES: "No inventes rutas, funciones ni resultados: lo que no sepas, buscalo en el proyecto o preguntalo.",
		EN: "Do not invent paths, functions or results: what you do not know, look up in the project or ask.",
	})
	line(i18n.Msg{
		ES: "Al terminar, contá en pocas líneas qué cambiaste (archivos y motivo) y qué verificaste.",
		EN: "When you finish, say in a few lines what you changed (files and reason) and what you verified.",
	})
	return b.String()
}

func scopeLabel(scope string) string {
	if scope == ScopeGlobal {
		return i18n.T(i18n.Msg{ES: "global", EN: "global"})
	}
	return i18n.T(i18n.Msg{ES: "proyecto", EN: "project"})
}

func (p ProjectContext) instructionsSection() string {
	if len(p.Instructions) == 0 && len(p.OmittedInstructions) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString(i18n.T(i18n.Msg{ES: "# Instrucciones del proyecto", EN: "# Project instructions"}) + "\n")
	b.WriteString(i18n.T(i18n.Msg{
		ES: "Estos archivos los escribió el usuario para quien trabaje en el proyecto. Si una instrucción global choca con una del proyecto, vale la del proyecto.",
		EN: "These files were written by the user for whoever works on the project. If a global instruction conflicts with a project one, the project one wins.",
	}))
	truncated := false
	for _, in := range p.Instructions {
		label := fmt.Sprintf("%s (%s)", in.Path, scopeLabel(in.Scope))
		if in.ImportedFrom != "" {
			label += i18n.T(i18n.Msg{ES: ", importado desde %s", EN: ", imported from %s"}, in.ImportedFrom)
		}
		b.WriteString("\n\n--- " + label + " ---\n")
		b.WriteString(in.Content)
		if in.Truncated {
			truncated = true
			b.WriteString("\n" + i18n.T(i18n.Msg{ES: "[archivo cortado por el tope de instrucciones]", EN: "[file cut by the instructions limit]"}))
		}
		b.WriteString("\n--- " + i18n.T(i18n.Msg{ES: "fin de %s", EN: "end of %s"}, in.Path) + " ---")
	}
	if truncated || len(p.OmittedInstructions) > 0 {
		note := i18n.T(i18n.Msg{
			ES: "[Instrucciones truncadas: se llegó al tope de %d caracteres.",
			EN: "[Instructions truncated: the limit of %d characters was reached.",
		}, MaxInstructionChars)
		if len(p.OmittedInstructions) > 0 {
			note += i18n.T(i18n.Msg{ES: " No se incluyeron: %s.", EN: " Not included: %s."}, strings.Join(p.OmittedInstructions, ", "))
		}
		b.WriteString("\n\n" + note + i18n.T(i18n.Msg{ES: " Lo que falta se puede leer con read_file.]", EN: " What is missing can be read with read_file.]"}))
	}
	return b.String()
}

func (p ProjectContext) skillsSection() string {
	if len(p.Skills) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString(i18n.T(i18n.Msg{ES: "# Skills disponibles", EN: "# Available skills"}) + "\n")
	b.WriteString(i18n.T(i18n.Msg{
		ES: "Un skill es una guía especializada para un tipo de tarea. Si lo que te piden coincide con la descripción de uno, cargalo con skill(name) ANTES de empezar y seguí lo que dice; sus archivos auxiliares se leen con read_skill_file(skill, path).",
		EN: "A skill is a specialized guide for a kind of task. If what you are asked matches the description of one, load it with skill(name) BEFORE starting and follow it; its auxiliary files are read with read_skill_file(skill, path).",
	}))
	for _, s := range p.Skills {
		b.WriteString("\n- " + s.Name)
		if s.Scope == ScopeGlobal {
			b.WriteString(" (" + scopeLabel(s.Scope) + ")")
		}
		if s.Description != "" {
			b.WriteString(": " + s.Description)
		}
	}
	if p.SkillsOmitted > 0 {
		b.WriteString("\n" + i18n.T(i18n.Msg{ES: "[… y %d skills más que no entran en la lista]", EN: "[… and %d more skills not shown in the list]"}, p.SkillsOmitted))
	}
	return b.String()
}
