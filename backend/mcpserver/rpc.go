package mcpserver

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"sync"
)

// Servidor MCP (Model Context Protocol) nativo, embebido en el propio binario.
//
// **JSON-RPC 2.0 sobre stdio, escrito a mano.** No se suma un SDK de MCP por la
// regla 12 de .claude/rules/technical.md (dependencias mínimas): el protocolo
// que hace falta para exponer herramientas son tres métodos —`initialize`,
// `tools/list` y `tools/call`— sobre un formato que ya sabe hablar
// `encoding/json`. Un SDK traería su propio modelo de transporte, su propia
// gestión de sesiones y su propio ciclo de vida para eso.
//
// **Sin puerto TCP, jamás.** El servidor no escucha en la red: habla por los
// descriptores del proceso que lo lanzó. Un servidor MCP escuchando en un
// puerto sería una puerta al vault del usuario abierta a cualquier cosa que
// corra en su máquina.

// protocolVersion es la del protocolo que se declara en `initialize`. Se
// responde la que el cliente pide cuando la conocemos; si no, la nuestra —
// negociar de más con un cliente futuro es peor que decirle qué hablamos.
const protocolVersion = "2024-11-05"

// Request es un mensaje entrante de JSON-RPC.
//
// `ID` es `json.RawMessage` porque el protocolo permite número o cadena, y
// convertirlo perdería la forma exacta que hay que devolver en la respuesta.
// Una notificación (sin id) no lleva respuesta: eso es lo que distingue
// `notifications/initialized` de una llamada.
type Request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// Response es un mensaje saliente.
type Response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

// RPCError es el error de JSON-RPC.
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// Códigos estándar de JSON-RPC que se usan acá.
const (
	codeParseError     = -32700
	codeInvalidRequest = -32600
	codeMethodNotFound = -32601
	codeInternalError  = -32603
)

// Tool es una herramienta expuesta al agente.
type Tool struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	// InputSchema es JSON Schema. Se escribe a mano por herramienta: son cuatro
	// campos cada una y generarlo por reflexión costaría más de lo que ahorra.
	InputSchema map[string]any `json:"inputSchema"`
	// Handler devuelve el texto que ve el agente. Un error se le devuelve como
	// texto de error, no como fallo de transporte: el agente tiene que poder
	// leer "esa nota es privada" y entenderlo, no recibir un -32603.
	Handler func(args map[string]any) (string, error) `json:"-"`
}

// Server atiende un cliente MCP sobre un par de streams.
type Server struct {
	mu    sync.Mutex
	tools []Tool
	name  string
	// version se informa en initialize, para que el CLI pueda decir con qué
	// está hablando.
	version string
}

func New(name, version string) *Server {
	return &Server{name: name, version: version}
}

// Register agrega una herramienta. Se llama antes de Serve.
func (s *Server) Register(t Tool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tools = append(s.tools, t)
}

// Serve lee peticiones de r y escribe respuestas en w hasta que r se cierra.
//
// Un mensaje por línea (JSON Lines), que es lo que usan los clientes MCP sobre
// stdio. Una línea ilegible se contesta con un error de parseo y **no corta la
// sesión**: un cliente que manda una línea rota puede seguir mandando las
// siguientes bien.
func (s *Server) Serve(r io.Reader, w io.Writer) error {
	scanner := bufio.NewScanner(r)
	// Un mensaje puede traer un esquema entero adentro; el buffer por defecto
	// de bufio (64KB) se queda corto.
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)

	enc := json.NewEncoder(w)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var req Request
		if err := json.Unmarshal(line, &req); err != nil {
			_ = enc.Encode(Response{
				JSONRPC: "2.0",
				Error:   &RPCError{Code: codeParseError, Message: "JSON inválido"},
			})
			continue
		}

		resp, hasResponse := s.handle(req)
		if !hasResponse {
			continue
		}
		if err := enc.Encode(resp); err != nil {
			return fmt.Errorf("mcpserver: escribiendo la respuesta: %w", err)
		}
	}
	return scanner.Err()
}

// handle resuelve una petición. El segundo valor es false para las
// notificaciones, que por definición no llevan respuesta.
func (s *Server) handle(req Request) (Response, bool) {
	if len(req.ID) == 0 {
		// Notificación: se acepta y no se contesta. `notifications/initialized`
		// es la única que mandan los clientes hoy.
		return Response{}, false
	}
	resp := Response{JSONRPC: "2.0", ID: req.ID}

	switch req.Method {
	case "initialize":
		resp.Result = map[string]any{
			"protocolVersion": protocolVersion,
			// Solo se declara `tools`. No hay `resources` ni `prompts` a
			// propósito: declarar una capacidad que después no se atiende hace
			// que el cliente pregunte y se lleve un error.
			"capabilities": map[string]any{"tools": map[string]any{}},
			"serverInfo":   map[string]any{"name": s.name, "version": s.version},
		}

	case "tools/list":
		s.mu.Lock()
		list := make([]Tool, len(s.tools))
		copy(list, s.tools)
		s.mu.Unlock()
		resp.Result = map[string]any{"tools": list}

	case "tools/call":
		resp.Result = s.callTool(req.Params)

	case "ping":
		resp.Result = map[string]any{}

	default:
		resp.Error = &RPCError{Code: codeMethodNotFound, Message: "método no soportado: " + req.Method}
	}
	return resp, true
}

// callTool ejecuta una herramienta y devuelve el resultado en el formato de
// contenido de MCP.
//
// **Un error de la herramienta vuelve como contenido con `isError`, no como
// error de JSON-RPC.** La diferencia importa: un error de transporte lo maneja
// el CLI y el agente no lo ve; un `isError` llega al modelo, que puede leer
// "esa nota está marcada como privada" y explicárselo al usuario en vez de
// reintentar a ciegas.
func (s *Server) callTool(params json.RawMessage) map[string]any {
	var p struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return errorContent("argumentos inválidos")
	}

	s.mu.Lock()
	var tool *Tool
	for i := range s.tools {
		if s.tools[i].Name == p.Name {
			tool = &s.tools[i]
			break
		}
	}
	s.mu.Unlock()

	if tool == nil {
		return errorContent("herramienta desconocida: " + p.Name)
	}
	if p.Arguments == nil {
		p.Arguments = map[string]any{}
	}

	out, err := tool.Handler(p.Arguments)
	if err != nil {
		return errorContent(err.Error())
	}
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": out}},
	}
}

func errorContent(msg string) map[string]any {
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": msg}},
		"isError": true,
	}
}

// StringArg saca un argumento de texto, tolerando que falte.
func StringArg(args map[string]any, key string) string {
	v, _ := args[key].(string)
	return v
}

// IntArg saca un argumento numérico con su valor por defecto. JSON no
// distingue enteros de flotantes, así que llega como float64.
func IntArg(args map[string]any, key string, def int) int {
	f, ok := args[key].(float64)
	if !ok {
		return def
	}
	return int(f)
}

// StringsArg saca una lista de textos.
func StringsArg(args map[string]any, key string) []string {
	raw, ok := args[key].([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, v := range raw {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}
