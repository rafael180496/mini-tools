package agentctx

import (
	"crypto/sha256"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// Contexto de proyecto para un chat con un servidor de modelos.
//
// Claude Code, Codex y OpenCode leen por su cuenta los archivos de
// instrucciones del proyecto y conocen sus skills; un modelo detrás de Ollama o
// de un servidor compatible con OpenAI no lee nada que no le pasen. Este
// archivo arma lo que se le pasa: el entorno, una guía breve de cómo trabajar,
// las instrucciones del proyecto (y las globales del usuario) y el índice de
// skills — con el mismo orden de precedencia que esos CLIs.
//
// Es PURO: recibe una raíz y un home, lee archivos y devuelve texto. No conoce
// el chat, el vault ni los modos de permiso (eso lo decide quien llama y lo
// pasa en Guidance), así que se prueba con directorios temporales.
//
// Dos reglas que valen para todo el archivo:
//
//   - Tolerante: un archivo que no se puede leer, un import que no existe o un
//     skill sin frontmatter se omite o se lista igual; nunca falla el turno por
//     una instrucción que no se pudo cargar.
//   - Acotado: lo que se carga va al contexto del modelo, que es chico (un
//     modelo local suele tener 4-8k tokens). Hay un tope TOTAL de caracteres y
//     lo que no entra se informa, en vez de cortar en silencio.

// Alcances de lo que se carga.
const (
	ScopeProject = "project"
	ScopeGlobal  = "global"
)

// Topes.
const (
	// MaxInstructionChars es el total de caracteres de instrucciones que se
	// incluyen (todos los archivos juntos, imports incluidos).
	MaxInstructionChars = 32000
	// maxInstructionFileBytes es cuánto se lee de un archivo: más que el tope
	// total, así un solo archivo grande se corta con aviso y no se descarta.
	maxInstructionFileBytes = 256 << 10
	// MaxImportDepth es hasta cuántos saltos de `@archivo.md` se siguen.
	MaxImportDepth = 3
	// MaxSkillsListed es cuántos skills se listan al modelo.
	MaxSkillsListed = 100
	// MaxSkillDescChars recorta la descripción de cada skill en el índice.
	MaxSkillDescChars = 220
)

// InstructionInfo describe un archivo de instrucciones cargado, sin su texto:
// es lo que muestra la pantalla para decir qué se le está pasando al modelo.
type InstructionInfo struct {
	// Path es relativo a la raíz para los del proyecto y empieza con «~/» para
	// los globales.
	Path  string `json:"path"`
	Scope string `json:"scope"`
	// Chars son los caracteres que entraron al contexto.
	Chars int `json:"chars"`
	// Truncated: el archivo se cortó por el tope o ni siquiera entró (Chars 0).
	Truncated bool `json:"truncated"`
}

// SkillInfo es un skill descubierto.
type SkillInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Scope       string `json:"scope"`
	// Path es el SKILL.md: relativo a la raíz o «~/…».
	Path string `json:"path"`
	// Dir es la carpeta real del skill, para las herramientas. No viaja al
	// frontend: no construye rutas con ella.
	Dir string `json:"-"`
}

// ProjectInstruction es un archivo de instrucciones ya leído.
type ProjectInstruction struct {
	InstructionInfo
	// Content es lo que entró al contexto (ya recortado por el tope).
	Content string
	// ImportedFrom es el archivo que lo importó con `@ruta.md`, o "".
	ImportedFrom string
}

// ProjectOptions son las entradas de LoadProject.
type ProjectOptions struct {
	Root string
	// Home es el directorio del usuario ("" = el del sistema). Se inyecta para
	// poder probar sin tocar el home real.
	Home string
	// OS ("" = runtime.GOOS) y Now (cero = ahora) van al bloque de entorno.
	OS  string
	Now time.Time
}

// ProjectContext es todo lo que se descubrió del proyecto.
type ProjectContext struct {
	Root   string
	IsGit  bool
	Branch string
	OS     string
	Today  string

	Instructions []ProjectInstruction
	// OmittedInstructions son los archivos que no entraron por el tope.
	OmittedInstructions []string
	TotalChars          int

	Skills        []SkillInfo
	SkillsOmitted int
}

// instrCandidates son los archivos de instrucciones del proyecto, en orden de
// prioridad (si el tope no alcanza para todos, quedan afuera los últimos).
var instrCandidates = []string{
	"AGENTS.md",
	"CLAUDE.md",
	"CLAUDE.local.md",
	"GEMINI.md",
	filepath.Join(".github", "copilot-instructions.md"),
	".cursorrules",
}

// globalInstrCandidates son los globales del usuario, relativos al home.
var globalInstrCandidates = []string{
	filepath.Join(".claude", "CLAUDE.md"),
	filepath.Join(".config", "opencode", "AGENTS.md"),
	filepath.Join(".codex", "AGENTS.md"),
}

// LoadProject descubre el contexto de un proyecto. Nunca falla: un proyecto sin
// nada de esto devuelve un contexto con solo el entorno.
func LoadProject(opts ProjectOptions) ProjectContext {
	root := opts.Root
	if abs, err := filepath.Abs(root); err == nil {
		root = abs
	}
	if real, err := filepath.EvalSymlinks(root); err == nil {
		root = real
	}
	home := opts.Home
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}
	goos := opts.OS
	if goos == "" {
		goos = runtime.GOOS
	}

	pc := ProjectContext{Root: root, OS: goos, Today: now.Format("2006-01-02")}
	pc.IsGit, pc.Branch = gitHead(root)

	ld := &instrLoader{root: root, home: home, realHome: realOr(home), budget: MaxInstructionChars, seenPath: map[string]bool{}, seenSum: map[[32]byte]bool{}}
	for _, rel := range instrCandidates {
		ld.add(filepath.Join(root, rel), ScopeProject, root, "", 0, nil)
	}
	ld.addCursorRules()
	if home != "" {
		for _, rel := range globalInstrCandidates {
			full := filepath.Join(home, rel)
			ld.add(full, ScopeGlobal, filepath.Dir(full), "", 0, nil)
		}
	}
	pc.Instructions, pc.OmittedInstructions = ld.out, ld.omitted
	for _, in := range pc.Instructions {
		pc.TotalChars += in.Chars
	}

	pc.Skills, pc.SkillsOmitted = loadSkills(root, home)
	return pc
}

// Info es el resumen sin texto, para la pantalla.
func (p ProjectContext) Info() (instructions []InstructionInfo, skills []SkillInfo) {
	instructions = make([]InstructionInfo, 0, len(p.Instructions)+len(p.OmittedInstructions))
	for _, in := range p.Instructions {
		instructions = append(instructions, in.InstructionInfo)
	}
	for _, path := range p.OmittedInstructions {
		scope := ScopeProject
		if strings.HasPrefix(path, "~/") {
			scope = ScopeGlobal
		}
		instructions = append(instructions, InstructionInfo{Path: path, Scope: scope, Truncated: true})
	}
	skills = p.Skills
	if skills == nil {
		skills = []SkillInfo{}
	}
	return instructions, skills
}

// --- Instrucciones ---------------------------------------------------------

type instrLoader struct {
	root, home string
	// realHome es el home con los symlinks resueltos: los imports se
	// resuelven a su ruta real, y en macOS /var es un enlace a /private/var.
	realHome string
	budget   int
	seenPath map[string]bool
	seenSum  map[[32]byte]bool
	out      []ProjectInstruction
	omitted  []string
}

// add carga un archivo (y sus imports). transform, si no es nil, convierte el
// texto crudo en el que se incluye (false = descartar el archivo).
func (l *instrLoader) add(file, scope, base, importedFrom string, depth int, transform func(string) (string, bool)) {
	fi, err := os.Stat(file)
	if err != nil || !fi.Mode().IsRegular() {
		return
	}
	real, err := filepath.EvalSymlinks(file)
	if err != nil {
		return
	}
	// Un archivo ya cargado (por otro nombre, un symlink o un ciclo de
	// imports) no se repite.
	if l.seenPath[real] {
		return
	}
	data, err := readCapped(real, maxInstructionFileBytes)
	if err != nil {
		return
	}
	text := strings.ToValidUTF8(string(data), "�")
	if transform != nil {
		var ok bool
		if text, ok = transform(text); !ok {
			return
		}
	}
	if strings.TrimSpace(text) == "" {
		return
	}
	l.seenPath[real] = true
	// El mismo texto bajo dos nombres (CLAUDE.md copia de AGENTS.md) tampoco.
	sum := sha256.Sum256([]byte(text))
	if l.seenSum[sum] {
		return
	}
	l.seenSum[sum] = true

	display := l.display(file, scope)
	if l.budget <= 0 {
		l.omitted = append(l.omitted, display)
		return
	}
	text = strings.TrimRight(text, " \t\r\n")
	truncated := false
	if n := utf8.RuneCountInString(text); n > l.budget {
		text = string([]rune(text)[:l.budget])
		truncated = true
	}
	chars := utf8.RuneCountInString(text)
	l.budget -= chars
	l.out = append(l.out, ProjectInstruction{
		InstructionInfo: InstructionInfo{Path: display, Scope: scope, Chars: chars, Truncated: truncated},
		Content:         text,
		ImportedFrom:    importedFrom,
	})

	if depth >= MaxImportDepth {
		return
	}
	for _, imp := range findImports(text) {
		target, ok := l.resolveImport(imp, filepath.Dir(file), base)
		if !ok {
			continue
		}
		l.add(target, scope, base, display, depth+1, nil)
	}
}

func (l *instrLoader) display(file, scope string) string {
	if scope == ScopeGlobal {
		for _, h := range []string{l.home, l.realHome} {
			if h == "" {
				continue
			}
			if rel, err := filepath.Rel(h, file); err == nil && !strings.HasPrefix(rel, "..") {
				return "~/" + filepath.ToSlash(rel)
			}
		}
	}
	if rel, err := filepath.Rel(l.root, file); err == nil && !strings.HasPrefix(rel, "..") {
		return filepath.ToSlash(rel)
	}
	return filepath.ToSlash(file)
}

// addCursorRules suma las reglas de Cursor que se aplican siempre
// (`alwaysApply: true`). Las que dependen de globs de archivos se omiten: son
// condicionales y volcarlas todas gastaría contexto en reglas que casi nunca
// aplican a lo que el modelo está haciendo.
func (l *instrLoader) addCursorRules() {
	dir := filepath.Join(l.root, ".cursor", "rules")
	items, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	names := make([]string, 0, len(items))
	for _, it := range items {
		ext := strings.ToLower(filepath.Ext(it.Name()))
		if !it.IsDir() && (ext == ".mdc" || ext == ".md") {
			names = append(names, it.Name())
		}
	}
	sort.Strings(names)
	for _, n := range names {
		l.add(filepath.Join(dir, n), ScopeProject, l.root, "", 0, cursorAlwaysApply)
	}
}

var alwaysApplyRe = regexp.MustCompile(`(?mi)^alwaysApply:\s*true\s*$`)

// cursorAlwaysApply devuelve el cuerpo de una regla de Cursor si es de las que
// se aplican siempre.
func cursorAlwaysApply(text string) (string, bool) {
	rest, ok := strings.CutPrefix(strings.TrimPrefix(text, "\ufeff"), "---")
	if !ok {
		return "", false
	}
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return "", false
	}
	if !alwaysApplyRe.MatchString(rest[:end]) {
		return "", false
	}
	body := rest[end+len("\n---"):]
	if nl := strings.IndexByte(body, '\n'); nl >= 0 {
		body = body[nl+1:]
	} else {
		body = ""
	}
	return body, true
}

var (
	importTokenRe = regexp.MustCompile(`(?:^|\s)@(\S+)`)
	inlineCodeRe  = regexp.MustCompile("`[^`]*`")
)

// findImports devuelve las rutas `@algo.md` de un texto, como las entiende
// CLAUDE.md: un token que empieza con «@», sigue una ruta y termina en .md.
// Se ignoran los bloques de código y el código en línea (ahí `@usuario.md`
// es un ejemplo, no un import) y los «@» pegados a otra palabra (un correo).
func findImports(text string) []string {
	var out []string
	seen := map[string]bool{}
	inFence := false
	for _, line := range strings.Split(text, "\n") {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "```") || strings.HasPrefix(t, "~~~") {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		line = inlineCodeRe.ReplaceAllString(line, "")
		for _, m := range importTokenRe.FindAllStringSubmatch(line, -1) {
			p := strings.TrimRight(m[1], ".,;:!?)]}>\"'")
			if !strings.HasSuffix(strings.ToLower(p), ".md") || seen[p] {
				continue
			}
			seen[p] = true
			out = append(out, p)
		}
	}
	return out
}

// resolveImport convierte el token en una ruta y comprueba que se pueda
// seguir: existe, es un .md y su ruta REAL está dentro de base (la raíz del
// proyecto, o la carpeta del archivo global). Un import que sale de ahí —con
// «..», un enlace o una ruta absoluta— se ignora: un CLAUDE.md de un
// repositorio clonado no puede hacer que se lean archivos de otra parte del
// disco hacia el prompt.
func (l *instrLoader) resolveImport(token, fromDir, base string) (string, bool) {
	var p string
	switch {
	case strings.HasPrefix(token, "~/"):
		if l.home == "" {
			return "", false
		}
		p = filepath.Join(l.home, filepath.FromSlash(token[2:]))
	case filepath.IsAbs(filepath.FromSlash(token)):
		p = filepath.Clean(filepath.FromSlash(token))
	default:
		p = filepath.Join(fromDir, filepath.FromSlash(token))
	}
	if !strings.EqualFold(filepath.Ext(p), ".md") {
		return "", false
	}
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		return "", false
	}
	realBase, err := filepath.EvalSymlinks(base)
	if err != nil {
		realBase = base
	}
	if !pathWithin(realBase, real) {
		return "", false
	}
	return real, true
}

// realOr devuelve p con los symlinks resueltos, o p si no se puede.
func realOr(p string) string {
	if p == "" {
		return ""
	}
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	return p
}

func pathWithin(base, p string) bool {
	rel, err := filepath.Rel(base, p)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

func readCapped(path string, max int) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	buf := make([]byte, max)
	n, err := f.Read(buf)
	if err != nil && n == 0 {
		// Un archivo vacío devuelve EOF sin bytes: no es un error.
		if errors.Is(err, io.EOF) {
			return nil, nil
		}
		return nil, err
	}
	return buf[:n], nil
}

// --- Skills ----------------------------------------------------------------

// loadSkills descubre los skills del proyecto y del home. Gana el primero que
// aparece con un nombre (los del proyecto van antes y, dentro de cada grupo,
// en el orden de skillDirs/userSkillDirs): un skill del proyecto tapa a un
// global del mismo nombre, que es lo que haría el CLI.
func loadSkills(root, home string) (list []SkillInfo, omitted int) {
	seen := map[string]bool{}
	add := func(dir, relTo string, scope string) {
		for _, f := range listSkillFolders(dir) {
			name, desc := frontmatter(f.file)
			if name == "" {
				name = f.dirName
			}
			key := strings.ToLower(name)
			if seen[key] {
				continue
			}
			seen[key] = true
			if len(list) >= MaxSkillsListed {
				omitted++
				continue
			}
			path := filepath.ToSlash(f.file)
			if rel, err := filepath.Rel(relTo, f.file); err == nil && !strings.HasPrefix(rel, "..") {
				path = filepath.ToSlash(rel)
				if scope == ScopeGlobal {
					path = "~/" + path
				}
			}
			list = append(list, SkillInfo{
				Name: name, Description: oneLine(desc, MaxSkillDescChars),
				Scope: scope, Path: path, Dir: f.dir,
			})
		}
	}
	for _, d := range skillDirs {
		add(filepath.Join(root, d), root, ScopeProject)
	}
	if home != "" {
		for _, d := range userSkillDirs {
			add(filepath.Join(home, d), home, ScopeGlobal)
		}
	}
	return list, omitted
}

// oneLine junta los espacios y recorta a n caracteres.
func oneLine(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > n {
		return strings.TrimSpace(string(r[:n])) + "…"
	}
	return s
}

// --- Git -------------------------------------------------------------------

// gitHead dice si la raíz es un repositorio y en qué rama está, leyendo
// `.git/HEAD` — sin lanzar `git`: se corre en cada turno y esto es un archivo
// de una línea. `.git` puede ser un archivo («gitdir: …») en worktrees y
// submódulos.
func gitHead(root string) (isGit bool, branch string) {
	dotGit := filepath.Join(root, ".git")
	fi, err := os.Stat(dotGit)
	if err != nil {
		return false, ""
	}
	gitDir := dotGit
	if !fi.IsDir() {
		data, err := readCapped(dotGit, 4096)
		if err != nil {
			return true, ""
		}
		target, ok := strings.CutPrefix(strings.TrimSpace(string(data)), "gitdir:")
		if !ok {
			return true, ""
		}
		gitDir = strings.TrimSpace(target)
		if !filepath.IsAbs(gitDir) {
			gitDir = filepath.Join(root, gitDir)
		}
	}
	data, err := readCapped(filepath.Join(gitDir, "HEAD"), 4096)
	if err != nil {
		return true, ""
	}
	head := strings.TrimSpace(string(data))
	if ref, ok := strings.CutPrefix(head, "ref:"); ok {
		ref = strings.TrimSpace(ref)
		return true, strings.TrimPrefix(ref, "refs/heads/")
	}
	if len(head) >= 7 {
		return true, "HEAD@" + head[:7]
	}
	return true, ""
}
