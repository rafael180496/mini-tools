package sshconn

import (
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

// EmitFunc mirrors query.EmitFunc/redisquery.EmitFunc's shape — injected by
// app.go's startup(), never runtime.EventsEmit called directly from this
// package. See .claude/skills/mini-tools-patterns/SKILL.md's Redis section
// for why the executors never own the Wails runtime import themselves.
type EmitFunc func(event string, data interface{})

// Event is emitted on the sessionID-named Wails event for an open terminal
// session — sessionID doubles as the event name, same pattern as
// query.Event/redisquery.Event's queryID (frontend subscribes with
// EventsOn(sessionId, ...) before calling OpenSSHTerminal, avoiding the race
// between the first emit and the subscription).
//
// El nombre del evento es el sessionID y no el connID justamente porque un
// servidor puede tener varias terminales abiertas: con el connID de nombre,
// las dos pestañas recibirían la salida de las dos.
type Event struct {
	Type string `json:"type"` // "data" | "closed" | "error"
	// Data is base64-encoded raw bytes read from the PTY. The remote shell
	// can emit non-UTF8 bytes (e.g. catting a binary file), which would
	// break JSON string encoding if sent as-is — base64 avoids that at the
	// cost of a decode step on the frontend before term.write().
	Data  string `json:"data,omitempty"`
	Error string `json:"error,omitempty"`
}

const readChunkSize = 4096

type session struct {
	// lease is a borrowed reference to the SHARED client for this
	// connection (see pool.go) — the terminal no longer owns a connection
	// of its own, so closing the terminal cannot drop an SFTP pane that is
	// still using the same host, and vice versa.
	lease *ClientLease
	// connID es la conexión guardada contra la que corre esta sesión. Se
	// guarda además de la clave del mapa porque la clave es el sessionID: sin
	// esto no habría forma de cerrar todas las sesiones de un servidor
	// (CloseConn) ni de contestarle a un agente que pregunta por la conexión
	// y no por una pestaña concreta (ver resolve).
	connID    string
	sshSess   *ssh.Session
	stdin     io.WriteCloser
	agentConn net.Conn // non-nil only when agent forwarding is active
	// scroll retiene las últimas líneas que imprimió el shell, sin escapes
	// ANSI, para poder mostrárselas a un agente cuando algo falla. En memoria
	// y acotado — ver scrollback.go.
	scroll *scrollback
	// lastUsed es cuándo se tecleó en esta sesión por última vez. Solo lo usa
	// resolve para desempatar entre varias sesiones del mismo servidor —
	// "la terminal de ese servidor" es la última en la que estuvo trabajando
	// alguien, no la más vieja ni la que más salida escupe (un `tail -f`
	// olvidado en otra pestaña ganaría siempre si el criterio fuera la salida).
	lastUsed time.Time
}

// SessionManager holds interactive PTY sessions keyed by sessionID — not a
// reusable pool like db.PoolManager/db.RedisPoolManager (see package doc).
//
// La clave es el sessionID y NO el connID: un servidor admite varias
// terminales abiertas a la vez, que es como se trabaja de verdad (una
// compilando, otra mirando un log). Con el connID de clave, abrir la segunda
// pestaña cerraba la primera sin decir nada. Las N sesiones de un mismo
// servidor comparten una sola conexión SSH —cada una es un canal más sobre
// ella— porque el lease sale del ClientPool refcontado (ver pool.go).
type SessionManager struct {
	mu       sync.Mutex
	sessions map[string]*session
	emit     EmitFunc
	pool     *ClientPool
}

// NewSessionManager takes the shared client pool so a terminal and an SFTP
// pane against the same host ride one SSH connection instead of two.
func NewSessionManager(emit EmitFunc, pool *ClientPool) *SessionManager {
	if pool == nil {
		pool = NewClientPool()
	}
	return &SessionManager{sessions: make(map[string]*session), emit: emit, pool: pool}
}

// Open pide un canal con PTY sobre la conexión connID, arranca el shell y
// lanza la goroutine que streamea su stdout/stderr combinado como
// Event{Type:"data"} en el evento llamado sessionID, hasta que el shell remoto
// termina o se cae la conexión (Event{Type:"closed"}).
//
// Se reemplaza (cerrándola antes) la sesión que ya tuviera ESE sessionID, no
// las demás del mismo servidor: una pestaña llama a Open una sola vez por
// (re)apertura, y las otras terminales del mismo host no tienen nada que ver
// con esta.
func (m *SessionManager) Open(sessionID, connID, dsn string, cols, rows int) error {
	_ = m.Close(sessionID)

	// parseDSN is still needed for the terminal-only options (agent
	// forwarding); the connection itself comes from the pool.
	cp, err := parseDSN(dsn)
	if err != nil {
		return err
	}

	lease, err := m.pool.Acquire(connID, dsn)
	if err != nil {
		return err
	}
	client := lease.Client

	sshSess, err := client.NewSession()
	if err != nil {
		lease.Close()
		return fmt.Errorf("sshconn: abriendo sesión: %w", err)
	}

	var agentConn net.Conn
	if cp.agentForwarding {
		agentConn, err = forwardAgent(client, sshSess)
		if err != nil {
			sshSess.Close()
			lease.Close()
			return err
		}
	}

	if err := sshSess.RequestPty("xterm-256color", rows, cols, ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}); err != nil {
		closeAgentConn(agentConn)
		sshSess.Close()
		lease.Close()
		return fmt.Errorf("sshconn: solicitando pty: %w", err)
	}

	stdin, err := sshSess.StdinPipe()
	if err != nil {
		closeAgentConn(agentConn)
		sshSess.Close()
		lease.Close()
		return fmt.Errorf("sshconn: abriendo stdin: %w", err)
	}
	// With a PTY allocated, the remote shell's controlling terminal already
	// merges the stdout/stderr of everything running under it — StdoutPipe
	// alone is enough, no separate stderr reader needed (same as any real
	// interactive SSH terminal).
	stdout, err := sshSess.StdoutPipe()
	if err != nil {
		closeAgentConn(agentConn)
		sshSess.Close()
		lease.Close()
		return fmt.Errorf("sshconn: abriendo stdout: %w", err)
	}

	if err := sshSess.Shell(); err != nil {
		closeAgentConn(agentConn)
		sshSess.Close()
		lease.Close()
		return fmt.Errorf("sshconn: iniciando shell: %w", err)
	}

	m.mu.Lock()
	m.sessions[sessionID] = &session{
		lease:     lease,
		connID:    connID,
		sshSess:   sshSess,
		stdin:     stdin,
		agentConn: agentConn,
		scroll:    newScrollback(),
		lastUsed:  time.Now(),
	}
	m.mu.Unlock()

	go m.streamOutput(sessionID, stdout)

	return nil
}

func (m *SessionManager) streamOutput(sessionID string, stdout io.Reader) {
	buf := make([]byte, readChunkSize)
	for {
		n, err := stdout.Read(buf)
		if n > 0 {
			m.emit(sessionID, Event{Type: "data", Data: base64.StdEncoding.EncodeToString(buf[:n])})
			// El buffer se llena en el mismo lugar donde se emite, y no en el
			// frontend: lo que un agente necesita leer no puede depender de
			// que una pestaña esté abierta y montada.
			if s := m.get(sessionID); s != nil {
				s.scroll.write(string(buf[:n]))
			}
		}
		if err != nil {
			break
		}
	}
	m.emit(sessionID, Event{Type: "closed"})
	_ = m.Close(sessionID)
}

// Write forwards data (keystrokes/paste, generated by xterm.js — always
// valid text/ANSI sequences) to sessionID's shell stdin.
//
// Exige el sessionID exacto: nunca cae a "alguna sesión de ese servidor" como
// hace resolve. Escribir en la shell equivocada porque el id no era el que se
// creía es de las pocas cosas que este código no puede permitirse — lo que
// viaja acá son teclas que van a ejecutarse.
func (m *SessionManager) Write(sessionID, data string) error {
	s := m.getAndTouch(sessionID)
	if s == nil {
		return fmt.Errorf("sshconn: no hay una sesión abierta para %q", sessionID)
	}
	_, err := s.stdin.Write([]byte(data))
	return err
}

// Resize reflows sessionID's PTY after the frontend's xterm.js FitAddon
// recomputes cols/rows. Exacto por sessionID, igual que Write.
func (m *SessionManager) Resize(sessionID string, cols, rows int) error {
	s := m.get(sessionID)
	if s == nil {
		return fmt.Errorf("sshconn: no hay una sesión abierta para %q", sessionID)
	}
	return s.sshSess.WindowChange(rows, cols)
}

// getAndTouch busca la sesión y la marca como la última usada de su servidor,
// bajo el mismo lock — ver session.lastUsed y resolve.
func (m *SessionManager) getAndTouch(sessionID string) *session {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[sessionID]
	if !ok {
		return nil
	}
	s.lastUsed = time.Now()
	return s
}

// Close tears down sessionID's session, if any is open. Idempotent — safe to
// call from both the explicit CloseSSHTerminal binding (terminal tab
// closed) and streamOutput's own cleanup on remote EOF.
//
// Cierra UNA terminal, no las del servidor: las otras pestañas contra el mismo
// host siguen vivas sobre la misma conexión. Para bajarlas todas está
// CloseConn.
func (m *SessionManager) Close(sessionID string) error {
	m.mu.Lock()
	s, ok := m.sessions[sessionID]
	if !ok {
		m.mu.Unlock()
		return nil
	}
	delete(m.sessions, sessionID)
	m.mu.Unlock()

	closeSession(s)
	return nil
}

// CloseConn cierra TODAS las terminales abiertas contra connID.
//
// Es lo que necesitan los caminos que hablan de la conexión y no de una
// pestaña: desconectar, borrar o editar una conexión guardada. Con una sola
// sesión por servidor eso era Close(connID); ahora Close espera un sessionID
// y llamarlo con un connID sería un no-op silencioso — la desconexión no
// desconectaría nada.
func (m *SessionManager) CloseConn(connID string) {
	m.mu.Lock()
	var closing []*session
	for id, s := range m.sessions {
		if s.connID == connID {
			closing = append(closing, s)
			delete(m.sessions, id)
		}
	}
	m.mu.Unlock()

	for _, s := range closing {
		closeSession(s)
	}
}

func closeSession(s *session) {
	s.sshSess.Close()
	// Release the lease, never close the client: the connection is shared,
	// and an SFTP pane on the same host may still be holding it. The pool
	// drops it when the last holder lets go.
	s.lease.Close()
	closeAgentConn(s.agentConn)
}

// CloseAll closes every open session — used on app shutdown.
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

// resolve acepta un sessionID O un connID y devuelve la sesión, o nil.
//
// Existe por los dos tipos de llamador que tiene la parte de solo lectura de
// este paquete (el scrollback que leen los agentes):
//
//   - una pestaña de terminal sabe su sessionID y quiere EXACTAMENTE su buffer;
//   - el resolvedor `@ssh:` y la herramienta MCP hablan de una CONEXIÓN — no
//     tienen ninguna pestaña delante, solo el nombre del servidor.
//
// Con varias terminales sobre el mismo host el segundo caso necesita elegir
// una, y la elegida es la última en la que se tecleó (session.lastUsed): "la
// terminal de ese servidor", para quien pregunta, es en la que está trabajando.
// Solo lo usa la lectura — Write y Resize exigen el sessionID exacto.
func (m *SessionManager) resolve(key string) *session {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.sessions[key]; ok {
		return s
	}
	var best *session
	for _, s := range m.sessions {
		if s.connID != key {
			continue
		}
		if best == nil || s.lastUsed.After(best.lastUsed) {
			best = s
		}
	}
	return best
}

func closeAgentConn(c net.Conn) {
	if c != nil {
		c.Close()
	}
}

// forwardAgent connects to the local ssh-agent (via SSH_AUTH_SOCK, a Unix
// socket) and forwards it to the remote host so commands run there can use
// it for onward auth (e.g. `git clone` of another host, `ssh` a further
// jump). Unix-only for now (Windows' agent uses a named pipe, not
// SSH_AUTH_SOCK) — out of scope for v1, same "documented, not silently
// missing" precedent as redisConnector's sentinel-auth scoping note.
func forwardAgent(client *ssh.Client, sess *ssh.Session) (net.Conn, error) {
	sock := os.Getenv("SSH_AUTH_SOCK")
	if sock == "" {
		return nil, fmt.Errorf("sshconn: agent forwarding solicitado pero SSH_AUTH_SOCK no está seteado (no hay un ssh-agent local corriendo)")
	}
	conn, err := net.Dial("unix", sock)
	if err != nil {
		return nil, fmt.Errorf("sshconn: conectando al ssh-agent local: %w", err)
	}
	ag := agent.NewClient(conn)
	if err := agent.ForwardToAgent(client, ag); err != nil {
		conn.Close()
		return nil, fmt.Errorf("sshconn: forwarding del ssh-agent: %w", err)
	}
	if err := agent.RequestAgentForwarding(sess); err != nil {
		conn.Close()
		return nil, fmt.Errorf("sshconn: solicitando agent forwarding: %w", err)
	}
	return conn, nil
}
