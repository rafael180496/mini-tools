package mcpserver

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"time"
)

// Puente entre el proceso MCP y la ventana de la aplicación.
//
// **Por qué hay dos procesos.** Un CLI agéntico lanza su servidor MCP como un
// subproceso propio (`mini-tools --mcp`), y ese proceso no tiene —ni puede
// tener— la clave maestra del vault: vive solo en la memoria de la ventana
// abierta. Así que el proceso MCP no lee nada: reenvía cada llamada a la
// ventana por un socket local, y la ventana responde con lo que su
// `vaultgate` le permita.
//
// Eso deja una propiedad que vale la pena decir en voz alta: **si la app no
// está abierta o el vault está bloqueado, el servidor MCP no puede leer nada**,
// ni aunque alguien lance el binario a mano. No hay una segunda ruta a los
// datos.
//
// **Y no hay nada escuchando salvo que el usuario lo encienda.** El listener no
// se abre al arrancar la app: se abre cuando se activa el interruptor y se
// cierra cuando se apaga. Apagado no hay socket, no hay goroutine y no hay
// archivo — que es la diferencia entre una función disponible y una que cuesta
// recursos por si acaso.

// bridgeCall es lo que el proceso MCP le manda a la ventana.
type bridgeCall struct {
	// Op es "list" (qué herramientas hay) o "call".
	Op   string         `json:"op"`
	Tool string         `json:"tool,omitempty"`
	Args map[string]any `json:"args,omitempty"`
}

// bridgeReply es lo que contesta la ventana.
type bridgeReply struct {
	Text  string     `json:"text,omitempty"`
	Tools []ToolInfo `json:"tools,omitempty"`
	Error string     `json:"error,omitempty"`
}

// ToolInfo es la descripción de una herramienta que cruza el puente. No lleva
// el handler: ese vive en la ventana, que es donde está el vault.
type ToolInfo struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

// SocketPath es dónde vive el socket del puente.
func SocketPath(dataDir string) string {
	return filepath.Join(dataDir, "mcp.sock")
}

// --- lado de la ventana ---------------------------------------------------

// Handler resuelve una llamada. Lo implementa la aplicación, que es la que
// tiene el vault abierto.
type Handler interface {
	ListTools() []ToolInfo
	CallTool(name string, args map[string]any) (string, error)
}

// Bridge es el listener de la ventana.
type Bridge struct {
	ln      net.Listener
	path    string
	handler Handler
}

// StartBridge abre el socket. **Solo se llama cuando el usuario enciende el
// servidor MCP**, nunca al arrancar la app.
func StartBridge(dataDir string, h Handler) (*Bridge, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("mcpserver: preparando el directorio: %w", err)
	}
	path := SocketPath(dataDir)
	// Un socket de una corrida anterior que terminó mal impide escuchar.
	_ = os.Remove(path)

	ln, err := listen(path)
	if err != nil {
		return nil, fmt.Errorf("mcpserver: no se pudo abrir el canal: %w", err)
	}

	b := &Bridge{ln: ln, path: path, handler: h}
	go b.accept()
	return b, nil
}

func (b *Bridge) accept() {
	for {
		conn, err := b.ln.Accept()
		if err != nil {
			return
		}
		go b.serve(conn)
	}
}

func (b *Bridge) serve(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Minute))

	dec := json.NewDecoder(bufio.NewReader(conn))
	enc := json.NewEncoder(conn)
	for {
		var call bridgeCall
		if err := dec.Decode(&call); err != nil {
			return
		}
		var reply bridgeReply
		switch call.Op {
		case "list":
			reply.Tools = b.handler.ListTools()
		case "call":
			text, err := b.handler.CallTool(call.Tool, call.Args)
			if err != nil {
				reply.Error = err.Error()
			} else {
				reply.Text = text
			}
		default:
			reply.Error = "operación desconocida"
		}
		if err := enc.Encode(reply); err != nil {
			return
		}
	}
}

// Close cierra el listener y borra el socket.
func (b *Bridge) Close() error {
	if b == nil {
		return nil
	}
	err := b.ln.Close()
	_ = os.Remove(b.path)
	return err
}

// Path es la ruta del socket, para poder mostrarla en la configuración.
func (b *Bridge) Path() string {
	if b == nil {
		return ""
	}
	return b.path
}

// --- lado del proceso MCP -------------------------------------------------

// client habla con la ventana.
type client struct {
	path string
}

// errNoWindow es lo que se le dice al agente cuando la app no está disponible.
//
// El texto es para que lo lea un modelo y se lo explique al usuario: dice qué
// falta y qué hacer, no "connection refused".
const errNoWindow = "mini-tools no está disponible: abrí la aplicación, desbloqueá el vault y " +
	"activá el servidor MCP en Configuración → Acceso de la IA. Mientras esté apagado, " +
	"estas herramientas no pueden leer nada."

func (c *client) call(req bridgeCall) (bridgeReply, error) {
	conn, err := dial(c.path, 5*time.Second)
	if err != nil {
		return bridgeReply{}, fmt.Errorf("%s", errNoWindow)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Minute))

	if err := json.NewEncoder(conn).Encode(req); err != nil {
		return bridgeReply{}, fmt.Errorf("%s", errNoWindow)
	}
	var reply bridgeReply
	if err := json.NewDecoder(bufio.NewReader(conn)).Decode(&reply); err != nil {
		return bridgeReply{}, fmt.Errorf("%s", errNoWindow)
	}
	return reply, nil
}

// RunStdio es el modo `mini-tools --mcp`: atiende un cliente MCP por stdin y
// stdout, reenviando todo a la ventana.
//
// Las herramientas se piden a la ventana en cada `tools/list` y no se cachean:
// activar o desactivar el acceso desde la app tiene que notarse sin reiniciar
// el CLI.
func RunStdio(dataDir string, version string) error {
	c := &client{path: SocketPath(dataDir)}
	s := New("mini-tools", version)

	// El catálogo se arma en el arranque para poder declarar las herramientas;
	// si la ventana no está, se declara vacío y cada llamada explica por qué.
	if reply, err := c.call(bridgeCall{Op: "list"}); err == nil && reply.Error == "" {
		for _, t := range reply.Tools {
			t := t
			s.Register(Tool{
				Name:        t.Name,
				Description: t.Description,
				InputSchema: t.InputSchema,
				Handler: func(args map[string]any) (string, error) {
					r, err := c.call(bridgeCall{Op: "call", Tool: t.Name, Args: args})
					if err != nil {
						return "", err
					}
					if r.Error != "" {
						return "", fmt.Errorf("%s", r.Error)
					}
					return r.Text, nil
				},
			})
		}
	}

	return s.Serve(os.Stdin, os.Stdout)
}
