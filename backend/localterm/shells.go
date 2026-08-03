// Package localterm abre shells interactivas en ESTA máquina sobre un
// pseudo-terminal (PTY) real, y las expone con el mismo contrato de eventos
// que backend/sshconn usa para las sesiones remotas.
//
// Por qué un paquete aparte y no una rama dentro de sshconn: una sesión
// local no tiene DSN, ni host, ni autenticación, ni pool que compartir con
// un panel SFTP — lo único que comparte con la remota es el envoltorio
// PTY↔xterm.js. Mezclarlas obligaría a que cada método de sshconn empiece
// preguntando "¿esto es local?", que es exactamente el tipo de rama que la
// separación redisquery/query ya evitó en su momento.
//
// Restricción técnica: el PTY sale de github.com/aymanbagabas/go-pty, que
// es Go puro (openpty por syscalls en Unix, ConPTY en Windows) — sigue
// cross-compilando a Windows desde Mac sin toolchain de C, así que no viola
// el punto 1 de .claude/rules/technical.md (sin cgo). Verificado con
// CGO_ENABLED=0 GOOS=windows/linux go build antes de agregarlo.
package localterm

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// Shell es un intérprete de comandos que la app puede lanzar. Se envía tal
// cual al frontend para poblar el selector de Configuración → Terminal:
// nunca lleva nada sensible (solo nombres y rutas de ejecutables del
// sistema), así que no aplica la regla del DSN opaco.
type Shell struct {
	// ID es la clave estable que se guarda en settings.local_shell. Nunca
	// se persiste la ruta: un ejecutable puede mudarse entre versiones del
	// sistema (o entre máquinas que comparten un backup del vault), y en ese
	// caso lo correcto es volver a resolverlo, no fallar con una ruta muerta.
	ID    string `json:"id"`
	Label string `json:"label"`
	// Path es la ruta resuelta al ejecutable, "" si no está instalado.
	// Se muestra en el selector como subtítulo para que quede claro CUÁL de
	// los varios bash de una máquina se va a usar.
	Path string `json:"path"`
	// Args son los argumentos de arranque. Los shells Unix se lanzan como
	// login shell (-l) a propósito: una app abierta desde Finder/el Dock
	// hereda un PATH mínimo, así que sin leer el perfil del usuario la
	// terminal no encontraría git, node, pyenv ni nada instalado por
	// Homebrew — el síntoma clásico de "en mi terminal anda y acá no".
	Args      []string `json:"args"`
	Available bool     `json:"available"`
	// Note explica para qué sirve este shell en una línea, para el título
	// del selector. Escrito para alguien que no sabe la diferencia entre
	// PowerShell y cmd, no como repetición del label.
	Note string `json:"note"`
}

// candidate es una entrada del registro antes de resolver si existe.
type candidate struct {
	id    string
	label string
	// bin es el nombre a buscar en PATH.
	bin string
	// fallbacks son rutas absolutas a probar si PATH no lo tiene — el caso
	// real en macOS es la app lanzada desde el Dock, cuyo PATH no incluye
	// /opt/homebrew/bin.
	fallbacks []string
	args      []string
	note      string
}

var unixCandidates = []candidate{
	{
		id: "zsh", label: "zsh", bin: "zsh",
		fallbacks: []string{"/bin/zsh", "/usr/bin/zsh", "/opt/homebrew/bin/zsh", "/usr/local/bin/zsh"},
		args:      []string{"-l"},
		note:      "El shell por defecto de macOS desde Catalina. Lee tu ~/.zshrc, así que alias y PATH son los mismos que en Terminal.app.",
	},
	{
		id: "bash", label: "bash", bin: "bash",
		fallbacks: []string{"/bin/bash", "/usr/bin/bash", "/opt/homebrew/bin/bash", "/usr/local/bin/bash"},
		args:      []string{"-l"},
		note:      "El shell clásico de Unix. Elegilo si tus scripts o tu ~/.bashrc asumen bash y no zsh.",
	},
	{
		id: "fish", label: "fish", bin: "fish",
		fallbacks: []string{"/opt/homebrew/bin/fish", "/usr/local/bin/fish", "/usr/bin/fish"},
		args:      []string{"-l"},
		note:      "Shell con autocompletado y colores por defecto. Su sintaxis NO es compatible con bash: un script copiado de internet puede no correr tal cual.",
	},
	{
		id: "sh", label: "sh", bin: "sh",
		fallbacks: []string{"/bin/sh"},
		args:      []string{"-l"},
		note:      "El shell POSIX mínimo. Sin historial ni autocompletado; útil solo para reproducir el entorno más austero posible.",
	},
}

var windowsCandidates = []candidate{
	{
		id: "pwsh", label: "PowerShell 7", bin: "pwsh.exe",
		fallbacks: []string{
			`C:\Program Files\PowerShell\7\pwsh.exe`,
			`C:\Program Files (x86)\PowerShell\7\pwsh.exe`,
		},
		args: []string{"-NoLogo"},
		note: "La versión moderna y multiplataforma de PowerShell (se instala aparte). Es la que conviene si la tenés: mejor autocompletado y colores que Windows PowerShell.",
	},
	{
		id: "powershell", label: "Windows PowerShell", bin: "powershell.exe",
		fallbacks: []string{`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`},
		args:      []string{"-NoLogo"},
		note:      "El PowerShell 5.1 que viene incluido en Windows. Siempre está disponible, aunque es una versión vieja del lenguaje.",
	},
	{
		id: "cmd", label: "Símbolo del sistema (cmd)", bin: "cmd.exe",
		fallbacks: []string{`C:\Windows\System32\cmd.exe`},
		note:      "El intérprete histórico de Windows. Sin colores ni autocompletado modernos, pero es lo que esperan muchos .bat y herramientas viejas.",
	},
	{
		id: "gitbash", label: "Git Bash", bin: "bash.exe",
		fallbacks: []string{
			`C:\Program Files\Git\bin\bash.exe`,
			`C:\Program Files (x86)\Git\bin\bash.exe`,
		},
		args: []string{"--login", "-i"},
		note: "El bash que instala Git para Windows. Es la opción práctica si seguís instrucciones escritas para Linux/macOS (rutas con /, ls, grep, ssh).",
	},
	{
		id: "wsl", label: "WSL (Linux)", bin: "wsl.exe",
		fallbacks: []string{`C:\Windows\System32\wsl.exe`},
		note:      "Abre tu distribución de Linux instalada en WSL. Ojo: el sistema de archivos es el de Linux, así que la ruta del repositorio de Windows se ve bajo /mnt/c.",
	},
}

// candidates devuelve el registro del sistema operativo actual.
func candidates() []candidate {
	if runtime.GOOS == "windows" {
		return windowsCandidates
	}
	return unixCandidates
}

// resolve busca el ejecutable de c: primero en PATH, después en las rutas
// absolutas conocidas. Devuelve "" si no está instalado.
func resolve(c candidate) string {
	if p, err := exec.LookPath(c.bin); err == nil {
		return p
	}
	for _, p := range c.fallbacks {
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			return p
		}
	}
	return ""
}

// ListShells devuelve TODOS los shells del registro del SO actual, con
// Available marcando cuáles están realmente instalados.
//
// Se devuelven también los no instalados a propósito: un selector que
// simplemente omite Git Bash no distingue "no existe en Windows" de "no lo
// tenés instalado todavía", y la segunda es accionable.
func ListShells() []Shell {
	list := candidates()
	out := make([]Shell, 0, len(list))
	for _, c := range list {
		path := resolve(c)
		out = append(out, Shell{
			ID:        c.id,
			Label:     c.label,
			Path:      path,
			Args:      c.args,
			Available: path != "",
			Note:      c.note,
		})
	}
	return out
}

// DefaultShellID es el shell que se usa cuando settings.local_shell está
// vacío (instalación nueva, o el guardado ya no está instalado).
//
// En Unix se respeta $SHELL —el que el usuario eligió para su cuenta— y
// solo si no coincide con ninguno del registro se cae al primer disponible.
// En Windows no hay equivalente de $SHELL, así que se prefiere el más
// capaz de los instalados, en el orden del registro.
func DefaultShellID() string {
	list := ListShells()

	if runtime.GOOS != "windows" {
		if env := os.Getenv("SHELL"); env != "" {
			name := filepath.Base(env)
			for _, s := range list {
				if s.ID == name && s.Available {
					return s.ID
				}
			}
		}
	}

	for _, s := range list {
		if s.Available {
			return s.ID
		}
	}
	return ""
}

// lookupShell resuelve el id guardado a un Shell ejecutable. Un id vacío,
// desconocido o que apunta a algo desinstalado cae al default en vez de
// fallar: el vault se sincroniza entre máquinas (backup/restore), así que
// "elegí fish en la portátil y en esta no está" es un caso normal, no un
// error que deba dejar sin terminal al usuario.
func lookupShell(id string) (Shell, bool) {
	list := ListShells()
	for _, s := range list {
		if s.ID == id && s.Available {
			return s, true
		}
	}
	for _, s := range list {
		if s.ID == DefaultShellID() {
			return s, s.Available
		}
	}
	return Shell{}, false
}
