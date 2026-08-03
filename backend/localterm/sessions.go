package localterm

import (
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/aymanbagabas/go-pty"
)

// EmitFunc mirrors sshconn.EmitFunc/query.EmitFunc's shape — inyectada por
// app.go's startup(), nunca runtime.EventsEmit llamado directo desde este
// paquete (misma razón que el resto de los executors: el paquete no importa
// el runtime de Wails).
type EmitFunc func(event string, data interface{})

// Event es idéntico a sshconn.Event a propósito: el componente de terminal
// del frontend es el mismo widget xterm.js para una sesión local y una
// remota, y duplicar el contrato solo obligaría a escribir dos decodificadores
// para el mismo stream de bytes.
type Event struct {
	Type string `json:"type"` // "data" | "closed" | "error"
	// Data es base64 de los bytes crudos del PTY — un shell local puede
	// emitir bytes no-UTF8 igual que uno remoto (un `cat` de un binario, una
	// codificación de página distinta en Windows), y eso rompería el
	// encoding JSON si viajara como string.
	Data  string `json:"data,omitempty"`
	Error string `json:"error,omitempty"`
}

const readChunkSize = 4096

type session struct {
	pty pty.Pty
	cmd *pty.Cmd
}

// SessionManager tiene una shell interactiva por sessionID — mismo diseño
// "abrir, streamear, cerrar como una unidad" que sshconn.SessionManager, sin
// pool detrás: un proceso local no es una conexión reutilizable.
type SessionManager struct {
	mu       sync.Mutex
	sessions map[string]*session
	emit     EmitFunc
}

func NewSessionManager(emit EmitFunc) *SessionManager {
	return &SessionManager{sessions: make(map[string]*session), emit: emit}
}

// Open lanza shellID (o el default del sistema si viene vacío o no está
// instalado) sobre un PTY nuevo, con el directorio de trabajo en cwd, y
// arranca la goroutine que streamea su salida como Event{Type:"data"} en el
// evento llamado sessionID hasta que el proceso termina (Event{Type:"closed"}).
//
// Cualquier sesión previa con ese sessionID se cierra primero — es lo que
// hace que el botón "Reiniciar" de la terminal sea una sola llamada.
func (m *SessionManager) Open(sessionID, cwd, shellID string, cols, rows int) error {
	return m.OpenWith(sessionID, cwd, shellID, cols, rows, nil, "")
}

// OpenWith es Open con dos añadidos para las sesiones de agente:
//
//   - extraEnv se suma al entorno del proceso ("ANTHROPIC_API_KEY=…"). Es la
//     ÚNICA vía por la que una credencial entra a una sesión: pasarla en la
//     línea de comandos la dejaría visible en `ps` para cualquier proceso de
//     la máquina y en el historial del propio shell.
//   - initialCommand se ESCRIBE en el shell como si lo hubiera tecleado el
//     usuario, en vez de reemplazar al shell. La diferencia importa: cuando
//     el agente termina (o lo cortás con Ctrl+C) te queda el shell vivo en el
//     mismo directorio para seguir trabajando, en lugar de una sesión muerta.
func (m *SessionManager) OpenWith(sessionID, cwd, shellID string, cols, rows int, extraEnv []string, initialCommand string) error {
	_ = m.Close(sessionID)

	sh, ok := lookupShell(shellID)
	if !ok {
		return fmt.Errorf("localterm: no se encontró ningún shell instalado en este sistema")
	}

	// Un cwd que ya no existe (el repo se movió o se borró estando la
	// pestaña abierta) haría fallar el arranque del proceso con un error
	// críptico del SO. Arrancar en el home y dejar que el usuario navegue es
	// mejor que no dar terminal.
	if cwd != "" {
		if info, err := os.Stat(cwd); err != nil || !info.IsDir() {
			cwd = ""
		}
	}
	if cwd == "" {
		if home, err := os.UserHomeDir(); err == nil {
			cwd = home
		}
	}

	p, err := pty.New()
	if err != nil {
		return fmt.Errorf("localterm: abriendo pty: %w", err)
	}

	if cols > 0 && rows > 0 {
		// Un fallo acá no es fatal: el PTY arranca en 80x24 y el primer
		// ResizeLocalTerminal del frontend (que dispara su ResizeObserver
		// apenas monta) lo corrige.
		_ = p.Resize(cols, rows)
	}

	cmd := p.Command(sh.Path, sh.Args...)
	cmd.Dir = cwd
	cmd.Env = append(terminalEnv(), extraEnv...)

	if err := cmd.Start(); err != nil {
		p.Close()
		return fmt.Errorf("localterm: iniciando %s: %w", sh.Label, err)
	}

	m.mu.Lock()
	m.sessions[sessionID] = &session{pty: p, cmd: cmd}
	m.mu.Unlock()

	go m.streamOutput(sessionID, p)
	go m.waitExit(sessionID, cmd)

	if initialCommand != "" {
		// \r y no \n: es el byte que manda una tecla Enter real, el mismo
		// que escribe xterm.js desde el frontend.
		//
		// El comando se manda desde otra goroutine y con una pausa porque un
		// shell interactivo todavía está montando su prompt cuando volvemos
		// de Shell(): escribir antes de eso hace que el propio shell repita
		// (eco) el comando a medias sobre su prompt. No es una carrera con
		// consecuencias —el comando llega igual, lo que cambia es cómo se
		// ve—, así que una espera corta alcanza y no hace falta sincronizar
		// con el prompt, que no es observable de forma portable.
		go func() {
			time.Sleep(250 * time.Millisecond)
			_ = m.Write(sessionID, initialCommand+"\r")
		}()
	}

	return nil
}

// streamOutput bombea el PTY hacia el frontend. Termina cuando el PTY se
// cierra (proceso terminado, o Close explícito).
func (m *SessionManager) streamOutput(sessionID string, r io.Reader) {
	buf := make([]byte, readChunkSize)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			m.emit(sessionID, Event{Type: "data", Data: base64.StdEncoding.EncodeToString(buf[:n])})
		}
		if err != nil {
			break
		}
	}
	m.emit(sessionID, Event{Type: "closed"})
	_ = m.Close(sessionID)
}

// waitExit cosecha el proceso. Sin esto quedaría un zombi por cada shell
// cerrada con `exit` en Unix, y en Windows el handle del proceso nunca se
// liberaría — la terminal se puede abrir y cerrar decenas de veces en una
// sesión de trabajo, así que no es un detalle académico.
func (m *SessionManager) waitExit(sessionID string, cmd *pty.Cmd) {
	_ = cmd.Wait()
	// Cerrar el PTY desbloquea el Read de streamOutput, que es quien emite
	// el "closed" — un solo camino de aviso, venga el fin del proceso o de
	// un Close explícito.
	if s := m.get(sessionID); s != nil && s.cmd == cmd {
		_ = s.pty.Close()
	}
}

// Write reenvía las teclas/pegado que manda xterm.js al stdin de la shell.
func (m *SessionManager) Write(sessionID, data string) error {
	s := m.get(sessionID)
	if s == nil {
		return fmt.Errorf("localterm: no hay una terminal abierta para %q", sessionID)
	}
	_, err := s.pty.Write([]byte(data))
	return err
}

// Resize reflowa el PTY después de que el FitAddon del frontend recalcula
// cols/rows — sin esto, `vim`, `top` o cualquier prompt que se acomode al
// ancho dibujan sobre un tamaño equivocado.
func (m *SessionManager) Resize(sessionID string, cols, rows int) error {
	s := m.get(sessionID)
	if s == nil {
		return fmt.Errorf("localterm: no hay una terminal abierta para %q", sessionID)
	}
	if cols <= 0 || rows <= 0 {
		return nil
	}
	return s.pty.Resize(cols, rows)
}

// Close mata la shell de sessionID, si hay alguna abierta. Idempotente —
// la llaman tanto el cierre explícito desde el frontend como la limpieza de
// streamOutput cuando el proceso terminó por su cuenta.
func (m *SessionManager) Close(sessionID string) error {
	m.mu.Lock()
	s, ok := m.sessions[sessionID]
	if !ok {
		m.mu.Unlock()
		return nil
	}
	delete(m.sessions, sessionID)
	m.mu.Unlock()

	// Matar antes de cerrar el PTY: un proceso vivo con su terminal cerrada
	// puede quedar colgado escribiendo en un descriptor muerto.
	if s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
	return s.pty.Close()
}

// CloseAll cierra todas las terminales abiertas — se llama en el shutdown
// de la app. A diferencia de un pool de base de datos, acá lo que queda
// vivo es un proceso del sistema operativo: no cerrarlo deja shells
// huérfanas corriendo después de cerrar la ventana.
func (m *SessionManager) CloseAll() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.sessions))
	for id := range m.sessions {
		ids = append(ids, id)
	}
	m.mu.Unlock()

	for _, id := range ids {
		_ = m.Close(id)
	}
}

func (m *SessionManager) get(sessionID string) *session {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[sessionID]
}

// terminalEnv toma el entorno del proceso y le fija las variables que
// describen la terminal en la que corre la shell. TERM es lo que hace que
// un programa sepa que puede usar colores y posicionar el cursor; sin él
// (o con el "dumb" que hereda una app de escritorio) `git log` sale sin
// paginador y `vim` se niega a arrancar.
func terminalEnv() []string {
	base := os.Environ()
	out := make([]string, 0, len(base)+2)
	for _, kv := range base {
		if strings.HasPrefix(kv, "TERM=") || strings.HasPrefix(kv, "COLORTERM=") {
			continue
		}
		out = append(out, kv)
	}
	// xterm-256color es lo que anuncia el propio xterm.js del frontend, y el
	// mismo valor que sshconn pide en su RequestPty.
	out = append(out, "TERM=xterm-256color", "COLORTERM=truecolor")
	return out
}

// ShellLabelFor devuelve la etiqueta legible del shell que Open usaría para
// id — lo que la barra de la terminal muestra ("zsh", "Git Bash") sin tener
// que replicar el fallback al default en el frontend.
func ShellLabelFor(id string) string {
	if sh, ok := lookupShell(id); ok {
		return sh.Label
	}
	return ""
}

// HomeDir es el directorio donde arranca una terminal sin repositorio
// asociado. Expuesto para que el frontend pueda mostrar dónde va a abrir.
func HomeDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Clean(home)
}
