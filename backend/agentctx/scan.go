// Package agentctx descubre QUÉ le ofrece un repositorio a un CLI agéntico:
// sus skills, sus subagentes, sus comandos y sus archivos de instrucciones.
//
// El problema que resuelve: la app ya sabe ABRIR Claude Code, Codex o
// Antigravity sobre un repositorio (backend/agents + backend/localterm), pero no sabía
// nada de lo que ese repositorio tiene preparado para ellos. Un repo con seis
// skills escritos y un CLAUDE.md de trescientas líneas se veía exactamente
// igual que uno vacío, y la única forma de enterarse era abrir una terminal y
// listar directorios a mano.
//
// Dos reglas de lectura, que valen para todo el paquete:
//
//   - TOLERANTE con lo desconocido. Estos directorios los define cada CLI y
//     su forma cambia entre versiones. Un SKILL.md sin frontmatter, un campo
//     que no se entiende o un archivo de más se listan igual, por su ruta. Un
//     catálogo al que le falta una entrada porque no supo parsearla es peor
//     que uno que la muestra sin descripción.
//   - SOLO LECTURA. Nada de este paquete escribe: son archivos del usuario y
//     de sus herramientas, y reescribirlos como efecto secundario de haberlos
//     mirado sería el tipo de sorpresa que nadie pidió.
package agentctx

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// maxEntries acota cada categoría. Un directorio con miles de archivos es
// siempre un error de configuración, no un catálogo, y enviarlo entero al
// frontend solo cuelga el panel.
const maxEntries = 500

// Scope dice de dónde sale una entrada: del repositorio (viaja con el
// proyecto, la ve todo el equipo) o del home del usuario (solo en esta
// máquina). La distinción importa al leer el panel: un skill personal que
// falta en el repo explica por qué a un compañero "no le anda igual".
type Scope string

const (
	ScopeRepo Scope = "repo"
	ScopeUser Scope = "user"
)

// Entry es un skill, un subagente o un comando ya resuelto.
type Entry struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	// Path es relativo a la raíz del repositorio para las entradas de repo, y
	// absoluto para las del home — el frontend lo muestra tal cual y no
	// construye rutas con él.
	Path  string `json:"path"`
	Scope Scope  `json:"scope"`
}

// Instruction es un archivo de instrucciones del proyecto. Se informan
// también los AUSENTES: la pregunta que contesta el panel no es solo "qué
// tengo" sino "qué le falta a este repo para que el agente que uso lo lea".
type Instruction struct {
	File    string `json:"file"`
	Path    string `json:"path"`
	Present bool   `json:"present"`
	Size    int64  `json:"size"`
	// Agents son los ids del catálogo de backend/agents que leen este archivo.
	Agents []string `json:"agents"`
}

// Context es todo lo que este repositorio le ofrece a un agente.
type Context struct {
	Skills       []Entry       `json:"skills"`
	Agents       []Entry       `json:"agents"`
	Commands     []Entry       `json:"commands"`
	Instructions []Instruction `json:"instructions"`
}

// instructionFiles son los archivos de instrucciones conocidos y qué CLI lee
// cada uno.
//
// Cada agente lee el suyo y NO los de los otros: es exactamente por eso que un
// repo puede estar perfectamente documentado para Claude Code y no decirle
// nada a Codex. Mostrar los tres juntos, presentes y ausentes, es lo que hace
// visible esa asimetría.
var instructionFiles = []struct {
	file   string
	agents []string
}{
	{"CLAUDE.md", []string{"claude"}},
	{"AGENTS.md", []string{"codex"}},
	// GEMINI.md lo lee Antigravity, que es como se llama ahora el CLI de
	// Google: el archivo conservó el nombre viejo aunque el producto se
	// renombró. Atribuirlo a un agente "gemini" que ya no existe en el
	// catálogo lo dejaría sin dueño en el panel.
	{"GEMINI.md", []string{"antigravity"}},
	{filepath.Join(".github", "copilot-instructions.md"), []string{"copilot"}},
}

// skillDirs son los layouts de skills que se reconocen dentro de un
// repositorio. `.claude/skills` es el de Claude Code; `.github/skills` aparece
// en repos que los publican junto al resto de la configuración de GitHub, y
// omitirlo haría que esos proyectos se vieran como si no tuvieran ninguno.
var skillDirs = []string{
	filepath.Join(".claude", "skills"),
	filepath.Join(".github", "skills"),
}

// Scan recorre el repositorio y el home del usuario.
//
// No devuelve error por un directorio que no existe —que es el caso normal, la
// mayoría de los repos no tiene nada de esto— ni por uno que no se puede leer:
// el resultado es simplemente una categoría vacía.
func Scan(repoRoot string) Context {
	ctx := Context{
		Skills:       []Entry{},
		Agents:       []Entry{},
		Commands:     []Entry{},
		Instructions: []Instruction{},
	}
	if repoRoot == "" {
		return ctx
	}

	for _, dir := range skillDirs {
		ctx.Skills = append(ctx.Skills, scanSkills(filepath.Join(repoRoot, dir), repoRoot, ScopeRepo)...)
	}
	// append y no asignación: scanDocs devuelve nil cuando el directorio no
	// existe (el caso normal), y asignarlo pisaría la lista vacía de arriba
	// con un nil, que en JSON es `null` y rompe el .map() del frontend.
	ctx.Agents = append(ctx.Agents, scanDocs(filepath.Join(repoRoot, ".claude", "agents"), repoRoot, ScopeRepo)...)
	ctx.Commands = append(ctx.Commands, scanDocs(filepath.Join(repoRoot, ".claude", "commands"), repoRoot, ScopeRepo)...)

	// Lo del home aplica a CUALQUIER repositorio que se abra en esta máquina,
	// así que se suma acá y se marca como tal en vez de mezclarse sin
	// distinción con lo que viaja en el proyecto.
	if home, err := os.UserHomeDir(); err == nil {
		ctx.Skills = append(ctx.Skills, scanSkills(filepath.Join(home, ".claude", "skills"), "", ScopeUser)...)
		ctx.Agents = append(ctx.Agents, scanDocs(filepath.Join(home, ".claude", "agents"), "", ScopeUser)...)
		ctx.Commands = append(ctx.Commands, scanDocs(filepath.Join(home, ".claude", "commands"), "", ScopeUser)...)
	}

	ctx.Instructions = scanInstructions(repoRoot)

	sortEntries(ctx.Skills)
	sortEntries(ctx.Agents)
	sortEntries(ctx.Commands)
	return ctx
}

// scanSkills lee un directorio de skills. Cada skill es un subdirectorio con
// un SKILL.md adentro — la carpeta suelta sin SKILL.md no es un skill, es una
// carpeta, y listarla daría entradas que ningún CLI va a cargar.
func scanSkills(dir, relTo string, scope Scope) []Entry {
	items, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}

	out := make([]Entry, 0, len(items))
	for _, it := range items {
		if len(out) >= maxEntries {
			break
		}
		if !it.IsDir() {
			continue
		}
		skillPath := filepath.Join(dir, it.Name(), "SKILL.md")
		if _, err := os.Stat(skillPath); err != nil {
			continue
		}
		name, desc := frontmatter(skillPath)
		if name == "" {
			// El nombre del directorio es el fallback correcto: es lo que el
			// CLI usa para referirse al skill cuando el frontmatter no lo dice.
			name = it.Name()
		}
		out = append(out, Entry{Name: name, Description: desc, Path: displayPath(skillPath, relTo), Scope: scope})
	}
	return out
}

// scanDocs lee un directorio de subagentes o de comandos: un .md por entrada,
// sin subdirectorio de por medio.
func scanDocs(dir, relTo string, scope Scope) []Entry {
	items, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}

	out := make([]Entry, 0, len(items))
	for _, it := range items {
		if len(out) >= maxEntries {
			break
		}
		if it.IsDir() || !strings.EqualFold(filepath.Ext(it.Name()), ".md") {
			continue
		}
		full := filepath.Join(dir, it.Name())
		name, desc := frontmatter(full)
		if name == "" {
			name = strings.TrimSuffix(it.Name(), filepath.Ext(it.Name()))
		}
		out = append(out, Entry{Name: name, Description: desc, Path: displayPath(full, relTo), Scope: scope})
	}
	return out
}

func scanInstructions(repoRoot string) []Instruction {
	out := make([]Instruction, 0, len(instructionFiles))
	for _, f := range instructionFiles {
		full := filepath.Join(repoRoot, f.file)
		ins := Instruction{File: filepath.ToSlash(f.file), Path: filepath.ToSlash(f.file), Agents: f.agents}
		if info, err := os.Stat(full); err == nil && !info.IsDir() {
			ins.Present = true
			ins.Size = info.Size()
		}
		out = append(out, ins)
	}
	return out
}

// displayPath devuelve la ruta relativa a relTo, o la absoluta si relTo está
// vacío (las entradas del home, que no cuelgan del repositorio).
func displayPath(full, relTo string) string {
	if relTo == "" {
		return full
	}
	if rel, err := filepath.Rel(relTo, full); err == nil {
		return filepath.ToSlash(rel)
	}
	return full
}

// sortEntries deja primero las del repositorio y después las del home, cada
// grupo alfabético: lo que viaja con el proyecto es lo que se busca primero.
func sortEntries(list []Entry) {
	sort.SliceStable(list, func(i, j int) bool {
		if list[i].Scope != list[j].Scope {
			return list[i].Scope == ScopeRepo
		}
		return strings.ToLower(list[i].Name) < strings.ToLower(list[j].Name)
	})
}
