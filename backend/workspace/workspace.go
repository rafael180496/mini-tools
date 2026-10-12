// Package workspace son las herramientas de código local que se le ofrecen a
// un modelo de un servidor HTTP (Ollama, compatible con OpenAI): leer, buscar,
// escribir y editar archivos y ejecutar comandos DENTRO de un directorio de
// trabajo.
//
// # Por qué un paquete aparte
//
// El modelo puede estar en otra máquina, pero **las herramientas corren
// siempre en la del usuario**. Eso las convierte en la superficie más delicada
// del chat: cada una es un permiso que se le da a un texto generado. Por eso
// viven acá, sin conocer el chat, el vault ni los modos de permiso (eso lo
// decide backend/agentchat, que es quien sabe a quién preguntar): este paquete
// solo garantiza lo que NO depende del modo.
//
//   - **Confinamiento.** Toda ruta se resuelve contra la raíz, se siguen los
//     symlinks y una ruta que termina fuera se rechaza (ErrOutside). Un
//     `../..` o un enlace simbólico dentro del repositorio que apunta a
//     `/etc` no son una forma de salir.
//   - **`.git/` es intocable por escritura.** Los commits, ramas y config se
//     tocan con `git` a través de run_command —que pregunta—, no pisando
//     objetos a mano. Y `.git/config` ni se lee: puede traer credenciales en
//     la URL de un remoto.
//   - **Salida acotada.** Un archivo, una búsqueda o un comando devuelven a lo
//     sumo unas decenas de KB: lo que no entra en el contexto del modelo solo
//     lo ahoga.
//   - **Entorno mínimo para los comandos.** Una lista blanca de variables, no
//     el entorno de la app: ver env().
//
// # Qué NO hace
//
// No decide si una acción se permite (modo, aprobación): expone Kind por
// herramienta y Risk por comando para que quien llama lo decida.
package workspace

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"mini-tools/backend/i18n"
)

// Kind clasifica una herramienta por lo que puede hacer, que es lo que los
// modos de permiso necesitan saber.
type Kind int

const (
	// KindRead no modifica nada.
	KindRead Kind = iota
	// KindWrite crea o cambia archivos dentro del directorio de trabajo.
	KindWrite
	// KindCommand ejecuta un programa: puede hacer cualquier cosa que el
	// usuario pueda hacer, así que es el más sensible.
	KindCommand
)

// Tool describe una herramienta que se declara al modelo.
type Tool struct {
	Name        string
	Kind        Kind
	Description string
	// Parameters es un JSON Schema de objeto.
	Parameters map[string]any
}

// Nombres de las herramientas.
const (
	ToolReadFile   = "read_file"
	ToolListDir    = "list_dir"
	ToolSearch     = "search"
	ToolGlob       = "glob"
	ToolWriteFile  = "write_file"
	ToolEditFile   = "edit_file"
	ToolRunCommand = "run_command"
	// Las dos de skills leen archivos de la carpeta de un skill, que puede
	// estar FUERA del proyecto (~/.claude/skills): ver skills.go.
	ToolSkill         = "skill"
	ToolReadSkillFile = "read_skill_file"
)

// Topes. Ver el doc del paquete: están pensados para el contexto del modelo,
// no para el disco.
const (
	// maxReadBytes es cuánto de un archivo se devuelve en una llamada.
	maxReadBytes = 64 * 1024
	// maxFileBytes es el archivo más grande que se abre. Uno más grande no es
	// algo que un modelo deba leer entero; para eso están el rango y search.
	maxFileBytes = 8 << 20
	// maxLineChars recorta una línea suelta (código minificado, un JSON en una
	// línea).
	maxLineChars = 4000
	// maxWriteBytes acota lo que se escribe de una vez.
	maxWriteBytes = 2 << 20
	// maxDirEntries acota list_dir.
	maxDirEntries = 500
	// maxSearchDefault y maxSearchCap acotan las coincidencias de search.
	maxSearchDefault = 100
	maxSearchCap     = 300
	// maxSearchFileBytes es el archivo más grande en el que search busca.
	maxSearchFileBytes = 1 << 20
	// maxSearchFiles acota cuántos archivos recorre una búsqueda.
	maxSearchFiles = 30000
	// MaxCommandOutput es cuánto de la salida de un comando ve el modelo.
	MaxCommandOutput = 30 * 1024
	// DefaultCommandTimeout y maxCommandTimeout acotan run_command.
	DefaultCommandTimeout = 2 * time.Minute
	maxCommandTimeout     = 10 * time.Minute
)

// ErrOutside es el error de una ruta que sale del directorio de trabajo.
var ErrOutside = i18n.New(i18n.Msg{
	ES: "la ruta sale del directorio de trabajo: solo se puede operar dentro del repositorio",
	EN: "the path leaves the working directory: only paths inside the repository are allowed",
})

// ErrProtected es el error de escribir dentro de `.git/`.
var ErrProtected = i18n.New(i18n.Msg{
	ES: "no se escribe dentro de .git/: usá comandos de git para cambiar el repositorio",
	EN: "writing inside .git/ is not allowed: use git commands to change the repository",
})

// Options configura un Workspace.
type Options struct {
	// ShellID es el shell elegido en Configuración → Terminal ("" = el default
	// del sistema). run_command usa el mismo mecanismo que la terminal local.
	ShellID string
	// CommandTimeout es el tope por defecto de run_command (0 = 2 minutos).
	CommandTimeout time.Duration
	// Skills son los skills que se pueden cargar con las herramientas skill y
	// read_skill_file. Vacío = esas herramientas no se declaran.
	Skills []SkillRef
}

// Workspace son las herramientas atadas a un directorio.
type Workspace struct {
	root string // ruta real (symlinks resueltos)
	// given es la ruta tal como se recibió, para aceptar rutas absolutas que
	// el modelo arme con ella aunque la real sea otra (macOS: /var → /private/var).
	given string
	opts  Options
}

// New abre un Workspace sobre root, que tiene que ser un directorio.
func New(root string, opts Options) (*Workspace, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, i18n.Errorf(i18n.Msg{ES: "workspace: no se pudo abrir %q: %w", EN: "workspace: could not open %q: %w"}, root, err)
	}
	fi, err := os.Stat(real)
	if err != nil || !fi.IsDir() {
		return nil, i18n.Errorf(i18n.Msg{ES: "workspace: %q no es un directorio", EN: "workspace: %q is not a directory"}, root)
	}
	if opts.CommandTimeout <= 0 {
		opts.CommandTimeout = DefaultCommandTimeout
	}
	return &Workspace{root: real, given: abs, opts: opts}, nil
}

// Root es la ruta real del directorio de trabajo.
func (w *Workspace) Root() string { return w.root }

// Run ejecuta una herramienta. Un nombre desconocido es un error.
//
// El resultado es texto para el modelo. Un fallo de la herramienta (archivo
// inexistente, edición ambigua) vuelve como error: quien llama se lo muestra
// al modelo, que es quien puede corregirlo.
func (w *Workspace) Run(ctx context.Context, name string, args map[string]any) (string, error) {
	if raw, ok := args["_raw"].(string); ok && len(args) == 1 {
		return "", i18n.Errorf(i18n.Msg{ES: "los argumentos no son un JSON válido: %s", EN: "the arguments are not valid JSON: %s"}, clip(raw, 200))
	}
	switch name {
	case ToolReadFile:
		return w.readFile(args)
	case ToolListDir:
		return w.listDir(args)
	case ToolSearch:
		return w.search(ctx, args)
	case ToolGlob:
		return w.glob(ctx, args)
	case ToolSkill:
		return w.skill(args)
	case ToolReadSkillFile:
		return w.readSkillFile(args)
	case ToolWriteFile:
		return w.writeFile(args)
	case ToolEditFile:
		return w.editFile(args)
	case ToolRunCommand:
		return w.runCommand(ctx, args)
	}
	return "", i18n.Errorf(i18n.Msg{ES: "herramienta desconocida: %s", EN: "unknown tool: %s"}, name)
}

// --- Rutas -----------------------------------------------------------------

// resolve convierte la ruta que pidió el modelo en una ruta real DENTRO de la
// raíz, y la devuelve también relativa (con `/`) para mostrar.
//
// Cómo se cierra cada escape:
//
//   - `../x` y `a/../../x`: filepath.Join limpia la ruta y la comparación
//     léxica contra la raíz lo rechaza.
//   - Ruta absoluta: se acepta solo si cae bajo la raíz (la real o la dada).
//   - Symlink dentro del árbol que apunta afuera: se resuelve el ancestro más
//     profundo que EXISTE (EvalSymlinks) y se vuelve a comprobar. Para una
//     ruta nueva (write_file de un archivo que no existe) los componentes que
//     faltan no pueden ser enlaces, así que alcanza con resolver el ancestro.
//   - Enlace colgante: Lstat lo ve pero EvalSymlinks falla; se rechaza en vez
//     de dejar que un write lo cree del otro lado.
func (w *Workspace) resolve(p string) (abs, rel string, err error) {
	p = strings.TrimSpace(p)
	if strings.ContainsRune(p, 0) {
		return "", "", ErrOutside
	}
	if p == "" {
		p = "."
	}
	var cand string
	if filepath.IsAbs(p) {
		cand = filepath.Clean(p)
		if within(w.given, cand) && !within(w.root, cand) {
			// La ruta dada con el prefijo no resuelto: se reubica en la real.
			r, _ := filepath.Rel(w.given, cand)
			cand = filepath.Join(w.root, r)
		}
	} else {
		cand = filepath.Join(w.root, p)
	}
	if !within(w.root, cand) {
		return "", "", ErrOutside
	}
	real, err := evalDeepest(cand)
	if err != nil {
		return "", "", i18n.Errorf(i18n.Msg{ES: "no se pudo resolver la ruta %q: %w", EN: "could not resolve the path %q: %w"}, p, err)
	}
	if !within(w.root, real) {
		return "", "", ErrOutside
	}
	r, err := filepath.Rel(w.root, real)
	if err != nil {
		return "", "", ErrOutside
	}
	return real, filepath.ToSlash(r), nil
}

// resolveWrite además rechaza `.git/`.
func (w *Workspace) resolveWrite(p string) (abs, rel string, err error) {
	abs, rel, err = w.resolve(p)
	if err != nil {
		return "", "", err
	}
	for _, part := range strings.Split(rel, "/") {
		if strings.EqualFold(part, ".git") {
			return "", "", ErrProtected
		}
	}
	return abs, rel, nil
}

// isGitConfig reconoce `.git/config`, que no se lee: las URLs de los remotos
// pueden llevar un token.
func isGitConfig(rel string) bool {
	parts := strings.Split(rel, "/")
	return len(parts) == 2 && strings.EqualFold(parts[0], ".git") && strings.EqualFold(parts[1], "config")
}

// within dice si p es root o está debajo de él.
func within(root, p string) bool {
	if runtime.GOOS == "windows" {
		root, p = strings.ToLower(root), strings.ToLower(p)
	}
	if p == root {
		return true
	}
	if !strings.HasSuffix(root, string(filepath.Separator)) {
		root += string(filepath.Separator)
	}
	return strings.HasPrefix(p, root)
}

// evalDeepest resuelve los symlinks del ancestro más profundo que existe y
// le vuelve a colgar lo que falta.
func evalDeepest(p string) (string, error) {
	cur := p
	var tail []string
	for {
		if _, err := os.Lstat(cur); err == nil {
			real, err := filepath.EvalSymlinks(cur)
			if err != nil {
				return "", err
			}
			for i := len(tail) - 1; i >= 0; i-- {
				real = filepath.Join(real, tail[i])
			}
			return real, nil
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return p, nil
		}
		tail = append(tail, filepath.Base(cur))
		cur = parent
	}
}

// --- Argumentos ------------------------------------------------------------

func strArg(args map[string]any, key string) string {
	v, _ := args[key].(string)
	return v
}

// intArg lee un entero opcional. JSON llega como float64, pero un modelo
// chico a veces manda el número como cadena: se acepta también.
func intArg(args map[string]any, key string, def int) int {
	switch v := args[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case string:
		n := 0
		neg := false
		s := strings.TrimSpace(v)
		if s == "" {
			return def
		}
		for i, c := range s {
			if i == 0 && c == '-' {
				neg = true
				continue
			}
			if c < '0' || c > '9' {
				return def
			}
			n = n*10 + int(c-'0')
		}
		if neg {
			n = -n
		}
		return n
	}
	return def
}

func boolArg(args map[string]any, key string) bool {
	switch v := args[key].(type) {
	case bool:
		return v
	case string:
		return strings.EqualFold(v, "true")
	}
	return false
}

func clip(s string, n int) string {
	if len([]rune(s)) <= n {
		return s
	}
	return string([]rune(s)[:n]) + "…"
}

func missing(name string) error {
	return i18n.Errorf(i18n.Msg{ES: "falta el argumento «%s»", EN: "the argument “%s” is missing"}, name)
}
