// Package agentapprove permite que el agente pregunte, acción por acción, si
// puede hacer algo — y que conteste el usuario desde la ventana.
//
// # El problema y por qué necesita dos procesos
//
// Los CLIs agénticos aceptan delegar sus permisos en una herramienta MCP
// (`--permission-prompt-tool`): antes de cada acción riesgosa llaman a esa
// herramienta y hacen lo que responda. Pero un servidor MCP de stdio **lo
// lanza el CLI**, no esta app: corre como un proceso aparte, sin acceso a la
// ventana. Para preguntarle al usuario tiene que hablar con el proceso de la
// app, y esperar la respuesta.
//
// # Por qué un socket Unix y no un puerto
//
// Es la opción más barata: un listener inactivo no consume nada y no hay nada
// escuchando en la red. Un TCP en localhost funcionaría en más sistemas pero
// abre un puerto en la máquina, que es superficie que esta app no necesita.
//
// El archivo del socket vive en el directorio de datos de la app, con
// permisos 0700 en su directorio: en Unix, quien no puede entrar al directorio
// no puede conectarse.
//
// # Windows
//
// `AF_UNIX` existe en Windows 10 1803 en adelante y Go lo soporta, pero no en
// todas las configuraciones. Si el listener no se puede abrir, la aprobación
// por acción **no se ofrece** y el chat sigue funcionando con la aprobación
// por modo, que ya existía. Degradar así es deliberado: preferimos una función
// menos en esa máquina antes que abrir un puerto para todos.
package agentapprove

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// approveTimeout es cuánto espera el agente una respuesta antes de darse por
// denegado.
//
// Existe porque del otro lado hay una persona: si cerró la ventana o se fue,
// el proceso del agente quedaría colgado para siempre esperando un clic. Al
// vencerse se DENIEGA, nunca se permite — el silencio no es un sí.
const approveTimeout = 5 * time.Minute

// Request es lo que el agente quiere hacer.
type Request struct {
	// ID lo genera el canal; la respuesta lo referencia.
	ID string `json:"id"`
	// Tool es el nombre de la herramienta que el agente quiere usar.
	Tool string `json:"tool"`
	// Input es su argumento, ya serializado y recortado para mostrar.
	Input string `json:"input"`
	// Summary y Detail son la versión legible, con el mismo criterio que en
	// backend/agentchat: qué archivo, de qué tamaño.
	Summary string `json:"summary"`
	Detail  string `json:"detail"`
}

// Decision es lo que contestó el usuario.
type Decision struct {
	Allow bool `json:"allow"`
	// Reason viaja al agente cuando se deniega, para que sepa por qué y no
	// insista con lo mismo.
	Reason string `json:"reason"`
}

// AskFunc lleva la pregunta a la ventana y espera la respuesta. La implementa
// app.go emitiendo un evento de Wails; este paquete no conoce la UI.
type AskFunc func(Request) Decision

// Channel es el extremo que vive en el proceso de la app.
type Channel struct {
	mu       sync.Mutex
	listener net.Listener
	path     string
	ask      AskFunc
	seq      int
}

// SocketPath es dónde se crea el socket. Se expone porque el proceso
// re-ejecutado necesita la misma ruta y la recibe por variable de entorno.
func SocketPath(dataDir string) string {
	return filepath.Join(dataDir, "approve.sock")
}

// Start abre el listener. Un error NO es fatal para la app: significa que en
// esta máquina no hay aprobación por acción, y quien llama lo informa como
// tal en vez de impedir que el chat funcione.
func Start(dataDir string, ask AskFunc) (*Channel, error) {
	path := SocketPath(dataDir)

	// Un socket viejo de una corrida anterior que terminó mal impide escuchar;
	// borrarlo es seguro porque el nombre es de esta app y de este directorio.
	_ = os.Remove(path)

	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("agentapprove: no se pudo preparar el directorio: %w", err)
	}

	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, fmt.Errorf("agentapprove: no se pudo abrir el canal de aprobación: %w", err)
	}
	// Solo el usuario: el permiso del archivo del socket es la única barrera
	// entre "el agente pregunta" y "cualquier proceso de la máquina contesta
	// por él".
	_ = os.Chmod(path, 0o600)

	c := &Channel{listener: ln, path: path, ask: ask}
	go c.accept()
	return c, nil
}

// Path es la ruta del socket, para pasársela al proceso re-ejecutado.
func (c *Channel) Path() string {
	if c == nil {
		return ""
	}
	return c.path
}

// Close cierra el listener y borra el archivo.
func (c *Channel) Close() error {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.listener == nil {
		return nil
	}
	err := c.listener.Close()
	c.listener = nil
	_ = os.Remove(c.path)
	return err
}

func (c *Channel) accept() {
	for {
		conn, err := c.listener.Accept()
		if err != nil {
			// El listener cerrado es el camino normal de salida.
			return
		}
		go c.serve(conn)
	}
}

// serve atiende una conexión: una petición por línea, una respuesta por línea.
//
// Línea por línea y no un protocolo con marco propio porque lo que viaja es
// JSON de una sola profundidad y los dos extremos son este mismo binario:
// inventar un framing sería complejidad sin beneficio.
func (c *Channel) serve(conn net.Conn) {
	defer conn.Close()

	sc := bufio.NewScanner(conn)
	sc.Buffer(make([]byte, 0, 8*1024), 1<<20)

	for sc.Scan() {
		var req Request
		if err := json.Unmarshal(sc.Bytes(), &req); err != nil {
			// Una petición que no se entiende se DENIEGA, no se ignora: el
			// agente está esperando y el silencio lo colgaría.
			writeJSON(conn, Decision{Allow: false, Reason: "petición ilegible"})
			continue
		}

		c.mu.Lock()
		c.seq++
		req.ID = fmt.Sprintf("approve-%d", c.seq)
		c.mu.Unlock()

		// El timeout vive de este lado, que es donde está la persona: si
		// nadie contesta, se deniega.
		done := make(chan Decision, 1)
		go func() { done <- c.ask(req) }()

		select {
		case d := <-done:
			writeJSON(conn, d)
		case <-time.After(approveTimeout):
			writeJSON(conn, Decision{Allow: false, Reason: "nadie respondió a tiempo"})
		}
	}
}

func writeJSON(conn net.Conn, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	_, _ = conn.Write(append(b, '\n'))
}

// Ask es el extremo del proceso re-ejecutado: se conecta, pregunta y espera.
//
// Cualquier fallo devuelve denegado. Es la única respuesta correcta: si no se
// puede preguntar, no se puede haber aprobado.
func Ask(socketPath string, req Request) Decision {
	conn, err := net.DialTimeout("unix", socketPath, 5*time.Second)
	if err != nil {
		return Decision{Reason: "no se pudo contactar a mini-tools para pedir la aprobación"}
	}
	defer conn.Close()

	// El deadline cubre el tiempo que tarda la persona en decidir, así que es
	// más largo que el del dial y coincide con el del otro extremo.
	_ = conn.SetDeadline(time.Now().Add(approveTimeout + 30*time.Second))

	b, err := json.Marshal(req)
	if err != nil {
		return Decision{Reason: "no se pudo serializar la petición"}
	}
	if _, err := conn.Write(append(b, '\n')); err != nil {
		return Decision{Reason: "no se pudo enviar la petición"}
	}

	sc := bufio.NewScanner(conn)
	sc.Buffer(make([]byte, 0, 8*1024), 1<<20)
	if !sc.Scan() {
		return Decision{Reason: "no llegó respuesta"}
	}

	var d Decision
	if err := json.Unmarshal(sc.Bytes(), &d); err != nil {
		return Decision{Reason: "respuesta ilegible"}
	}
	return d
}
