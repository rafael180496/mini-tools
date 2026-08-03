// Package agents es el catálogo de asistentes de código por línea de
// comandos que el módulo Git puede abrir en una sesión propia (Claude Code,
// Codex, Gemini CLI).
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
	bin     string
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
		id:      "gemini",
		label:   "Gemini CLI",
		vendor:  "Google",
		bin:     "gemini",
		command: "gemini",
		keyEnv:  "GEMINI_API_KEY",
		login:   "Se autentica con su propio login de Google (o con una API key en la variable GEMINI_API_KEY). Abrí una sesión y seguí lo que indique el CLI.",
		note:    "Asistente de Google por línea de comandos, sobre el repositorio abierto.",
		docs:    "https://google-gemini.github.io/gemini-cli/",
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
	name := bin
	if runtime.GOOS == "windows" {
		name = bin + ".exe"
	}
	if p, err := exec.LookPath(bin); err == nil {
		return p
	}
	for _, dir := range extraLookupDirs() {
		p := filepath.Join(dir, name)
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			return p
		}
	}
	return ""
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
