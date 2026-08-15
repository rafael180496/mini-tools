// Package agents es el catálogo de asistentes de código por línea de
// comandos que el módulo Git puede abrir en una sesión propia: Claude Code,
// Codex CLI y Antigravity CLI — este último es el que antes se llamaba Gemini
// CLI, renombrado por Google, y por eso hay una sola entrada para los dos
// nombres y no dos.
//
// Decisión de fondo: un agente NO se integra por su API, se ejecuta como el
// programa de terminal que ya es. Los tres son CLIs interactivas que corren
// en el repositorio, piden confirmación, editan archivos y muestran diffs;
// reimplementar ese diálogo contra una API sería reescribir el producto de
// otro y quedar desactualizado en cada versión suya. Corriéndolos sobre el
// PTY que backend/localterm ya sabe manejar, la app aporta lo que le falta a
// una terminal suelta: el repositorio, el diff al lado y las sesiones
// organizadas.
//
// Corolario sobre las cuentas: cada CLI maneja su propia autenticación (su
// login por navegador, su token, su archivo de configuración). Esta app NO
// intenta replicar, leer ni interceptar esas credenciales — sería frágil y
// una responsabilidad que nadie le pidió. Lo único que ofrece es guardar,
// OPCIONALMENTE y cifrada bajo la clave maestra, la API key de quien prefiere
// autenticarse por variable de entorno en vez de por login interactivo; ver
// vault.AgentConfig.
package agents

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Agent es una entrada del catálogo, ya resuelta contra esta máquina y contra
// la configuración del usuario. Se envía tal cual al frontend: no lleva
// nunca la API key, solo si hay una guardada (mismo criterio que
// SSHKeySummary con el material de la llave).
type Agent struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// Vendor es quién lo publica, para que la lista no dependa de reconocer
	// el nombre del comando.
	Vendor string `json:"vendor"`
	// Command es lo que se va a escribir en la terminal para arrancarlo: el
	// override del usuario si configuró uno, o el default del catálogo.
	Command string `json:"command"`
	// DefaultCommand es el del catálogo, para poder ofrecer "restaurar".
	DefaultCommand string `json:"defaultCommand"`
	// Path es dónde se encontró el ejecutable, "" si no está instalado.
	Path      string `json:"path"`
	Available bool   `json:"available"`
	// KeyEnv es la variable de entorno con la que ese CLI toma una API key.
	// Vacía significa que ese agente no soporta ese modo y la única vía es su
	// propio login.
	KeyEnv string `json:"keyEnv"`
	// HasKey indica si hay una API key guardada para este agente. El valor
	// nunca cruza el binding.
	HasKey bool `json:"hasKey"`
	// LoginHint es cómo se autentica, en una línea. Es texto y no un comando
	// que la app ejecute a propósito: los CLIs cambian sus subcomandos de
	// login entre versiones, y una app que "sabe" cómo loguearte y se
	// equivoca es peor que una que te abre la terminal y te lo dice.
	LoginHint string `json:"loginHint"`
	Note      string `json:"note"`
	DocsURL   string `json:"docsUrl"`
}

// catalogEntry es la parte fija del catálogo, antes de resolver instalación y
// configuración.
type catalogEntry struct {
	id      string
	label   string
	vendor  string
	bin string
	// altBins son nombres anteriores del mismo ejecutable, para que un
	// renombre del producto no haga desaparecer un agente que sí está.
	altBins []string
	command string
	keyEnv  string
	login   string
	note    string
	docs    string
	// extraPaths son ubicaciones habituales fuera del PATH heredado. Una app
	// abierta desde el Dock no ve ~/.local/bin ni los binarios de npm/bun, que
	// es justo donde se instalan estos CLIs.
	extraPaths []string
}

var catalog = []catalogEntry{
	{
		id:      "claude",
		label:   "Claude Code",
		vendor:  "Anthropic",
		bin:     "claude",
		command: "claude",
		keyEnv:  "ANTHROPIC_API_KEY",
		login:   "Se autentica con su propio login: abrí una sesión y usá el comando /login dentro de Claude Code. Como alternativa acepta una API key por la variable ANTHROPIC_API_KEY.",
		note:    "Asistente de Anthropic. Trabaja sobre el repositorio abierto: lee archivos, propone cambios y los aplica pidiendo confirmación.",
		docs:    "https://claude.com/claude-code",
	},
	{
		id:      "codex",
		label:   "Codex CLI",
		vendor:  "OpenAI",
		bin:     "codex",
		command: "codex",
		keyEnv:  "OPENAI_API_KEY",
		login:   "Se autentica con su propio login (o con una API key en la variable OPENAI_API_KEY). Abrí una sesión y seguí lo que indique el CLI.",
		note:    "Asistente de OpenAI por línea de comandos, sobre el repositorio abierto.",
		docs:    "https://developers.openai.com/codex/cli",
	},
	{
		id:    "antigravity",
		label: "Antigravity CLI",
		// El binario se llama `agy`, no "antigravity" — vale la pena decirlo
		// porque es lo que hace que la detección funcione y lo que hay que
		// escribir si se configura un comando propio.
		bin: "agy",
		// El CLI de Google se llamaba **Gemini CLI** y ahora se llama
		// Antigravity: es el mismo producto renombrado, no dos. Por eso hay
		// una sola entrada y no dos —una segunda diría "no instalado" para
		// siempre en cualquier máquina moderna—, y por eso se busca también
		// el binario viejo: quien todavía tenga `gemini` lo ve detectado acá,
		// bajo el nombre actual.
		altBins: []string{"gemini"},
		command: "agy",
		// Sin variable de API key a propósito: Antigravity se autentica con su
		// propio login de Google y no documenta un modo por variable de
		// entorno. Inventar acá un nombre de variable haría aparecer un campo
		// que no sirve para nada.
		keyEnv: "",
		login:  "Se autentica con su propio login de Google: abrí una sesión y seguí lo que indique el CLI. El consumo y el límite restante se ven con /usage dentro de la sesión.",
		note:   "Asistente de Google por línea de comandos (binario `agy`), sobre el repositorio abierto. Trae sus propios skills y modos de ejecución.",
		docs:   "https://antigravity.google/",
	},
}

// extraLookupDirs son los directorios donde suelen quedar instalados estos
// CLIs y que el PATH de una app de escritorio no incluye. Se calculan una vez
// por llamada porque dependen del home del usuario.
func extraLookupDirs() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	if runtime.GOOS == "windows" {
		return []string{
			filepath.Join(home, "AppData", "Roaming", "npm"),
			filepath.Join(home, ".bun", "bin"),
		}
	}
	return []string{
		filepath.Join(home, ".local", "bin"),
		filepath.Join(home, ".bun", "bin"),
		filepath.Join(home, ".npm-global", "bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
	}
}

// resolveBin busca el ejecutable en el PATH y después en las ubicaciones
// habituales. Devuelve "" si no está instalado.
func resolveBin(bin string) string {
	if p, err := exec.LookPath(bin); err == nil {
		return p
	}
	for _, dir := range extraLookupDirs() {
		for _, name := range binNames(bin) {
			p := filepath.Join(dir, name)
			if info, err := os.Stat(p); err == nil && !info.IsDir() {
				return p
			}
		}
	}
	return ""
}

// binNames son los nombres de archivo que puede tener ese ejecutable.
//
// En Windows importa y no alcanza con `.exe`: los tres CLIs se instalan por
// npm, y npm no deja un `.exe` sino un **shim `.cmd`** en `%APPDATA%\npm`.
// Buscar solo `claude.exe` ahí es garantía de no encontrarlo nunca en la
// máquina donde justamente está instalado.
func binNames(bin string) []string {
	if runtime.GOOS != "windows" {
		return []string{bin}
	}
	return []string{bin + ".cmd", bin + ".exe", bin + ".bat"}
}

// Resolve es resolveBin para el resto de la app: dónde está de verdad ese
// ejecutable, o "" si no está.
func Resolve(bin string) string { return resolveBin(bin) }

// Env es el entorno con el que hay que lanzar un agente: **el del proceso
// entero**, con el PATH ampliado y las variables extra que se le pasen.
//
// Que herede todo no es comodidad, es requisito. `cmd.Env` REEMPLAZA el
// entorno del hijo, no lo agrega: armar una lista con solo el PATH deja al
// agente sin `HOME`, y sin HOME ninguno de los tres funciona —
//
//   - **Claude Code** guarda ahí su sesión, así que contesta "Not logged in ·
//     Please run /login" en una máquina donde el login está hecho.
//   - **Antigravity** directamente aborta con "$HOME is not defined" antes de
//     leer el prompt.
//
// Y no es solo HOME: quedaban afuera también el resto de las variables del
// perfil de las que un CLI puede depender. La terminal integrada nunca tuvo
// este problema porque siempre partió de os.Environ() (ver
// localterm.terminalEnv); esto es lo mismo para el chat.
func Env(extra ...string) []string {
	base := os.Environ()
	out := make([]string, 0, len(base)+len(extra)+1)
	for _, kv := range base {
		// El PATH se reemplaza por el ampliado: el heredado por una app
		// abierta desde Finder no incluye los directorios donde se instalan
		// los CLIs ni las herramientas que ellos lanzan.
		if strings.HasPrefix(kv, "PATH=") {
			continue
		}
		out = append(out, kv)
	}
	out = append(out, "PATH="+PathEnv())
	return append(out, extra...)
}

// Launcher convierte una ruta de ejecutable en el argv con el que se lanza.
//
// Casi siempre es la ruta sola. La excepción es Windows con un shim `.cmd` o
// `.bat`: **CreateProcess no sabe ejecutar un archivo por lotes**, así que hay
// que pasar por `cmd.exe /c` o el lanzado falla con un error de formato — que
// es exactamente el caso de los CLIs instalados por npm, o sea el normal.
//
// NOTA: sin verificar en una Windows real (ver releases/windows/README.md).
func Launcher(path string) []string {
	if runtime.GOOS == "windows" {
		switch strings.ToLower(filepath.Ext(path)) {
		case ".cmd", ".bat":
			shell := os.Getenv("COMSPEC")
			if shell == "" {
				shell = "cmd.exe"
			}
			return []string{shell, "/c", path}
		}
	}
	return []string{path}
}

// Override es la parte configurable por el usuario de un agente. La define
// el vault (vault.AgentConfig) y se pasa acá para no invertir la dependencia:
// este paquete no conoce la base de datos.
type Override struct {
	Command string
	HasKey  bool
}

// List devuelve el catálogo completo resuelto contra esta máquina, instalados
// y no instalados.
//
// Los no instalados se devuelven igual, con Available=false: omitirlos haría
// imposible distinguir "esta app no soporta Gemini" de "no lo tenés
// instalado", y solo lo segundo se puede resolver.
func List(overrides map[string]Override) []Agent {
	out := make([]Agent, 0, len(catalog))
	for _, c := range catalog {
		ov := overrides[c.id]

		command := strings.TrimSpace(ov.Command)
		if command == "" {
			command = c.command
		}

		// La detección mira el binario del catálogo, no el comando
		// configurado: un override puede ser una línea entera con argumentos
		// ("claude --model x") o pasar por otro programa, y tratar eso como
		// nombre de ejecutable daría "no instalado" a algo que anda.
		path := resolveBin(c.bin)
		for _, alt := range c.altBins {
			if path != "" {
				break
			}
			path = resolveBin(alt)
		}

		out = append(out, Agent{
			ID:             c.id,
			Label:          c.label,
			Vendor:         c.vendor,
			Command:        command,
			DefaultCommand: c.command,
			Path:           path,
			Available:      path != "",
			KeyEnv:         c.keyEnv,
			HasKey:         ov.HasKey,
			LoginHint:      c.login,
			Note:           c.note,
			DocsURL:        c.docs,
		})
	}
	return out
}

// Find devuelve la entrada del catálogo con ese id.
func Find(id string) (Agent, bool) {
	for _, a := range List(nil) {
		if a.ID == id {
			return a, true
		}
	}
	return Agent{}, false
}

// KeyEnvFor es la variable de entorno de la API key de ese agente, o "" si no
// la conoce. Se usa para armar el entorno de la sesión sin que el resto del
// código tenga que conocer el catálogo.
func KeyEnvFor(id string) string {
	for _, c := range catalog {
		if c.id == id {
			return c.keyEnv
		}
	}
	return ""
}

// PathEnv devuelve el valor de PATH que hay que darle a una sesión de agente:
// el heredado más los directorios habituales de instalación.
//
// Sin esto, el agente arranca (lo encontramos con resolveBin y lo invocamos
// por nombre desde un login shell que sí lee el perfil) pero los subprocesos
// que él lance pueden no encontrar node, bun o git — el mismo problema de
// PATH recortado que resuelve abrir la shell como login shell, un escalón más
// abajo.
func PathEnv() string {
	current := os.Getenv("PATH")
	sep := ":"
	if runtime.GOOS == "windows" {
		sep = ";"
	}
	parts := strings.Split(current, sep)
	seen := make(map[string]bool, len(parts))
	for _, p := range parts {
		seen[p] = true
	}
	for _, dir := range extraLookupDirs() {
		if !seen[dir] {
			parts = append(parts, dir)
			seen[dir] = true
		}
	}
	return strings.Join(parts, sep)
}
