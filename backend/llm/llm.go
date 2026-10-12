// Package llm habla con servidores de modelos por HTTP: Ollama y cualquier
// servidor compatible con la API de OpenAI (LM Studio, vLLM, llama.cpp
// server…).
//
// # Por qué a mano y no con un SDK
//
// Son dos protocolos chicos —Ollama transmite NDJSON y la API de OpenAI,
// SSE— y los dos caben en `net/http` + `encoding/json`. Un SDK sumaría una
// dependencia (regla de .claude/rules/technical.md) para ocultar lo único que
// acá hay que mirar de cerca: qué llega en cada trozo del stream.
//
// # Qué NO hace
//
// No conoce el vault ni el chat: recibe una URL, un token opcional y mensajes,
// y devuelve texto en trozos. Quien arma el cliente (App) decide de dónde sale
// el token; quien consume el stream (backend/agentchat) decide cómo mostrarlo.
//
// Los tipos ya cargan herramientas y llamadas a herramientas, aunque el bucle
// que las ejecuta no viva acá: ese bucle lo arma quien llama, con sus propios
// permisos, y este paquete solo tiene que llevarlas y traerlas sin perder
// datos.
package llm

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"mini-tools/backend/i18n"
)

// Tipos de servidor.
const (
	KindOllama = "ollama"
	KindOpenAI = "openai"
)

// Roles de un mensaje.
const (
	RoleSystem    = "system"
	RoleUser      = "user"
	RoleAssistant = "assistant"
	RoleTool      = "tool"
)

// Message es un mensaje de la conversación, en un modelo común a los dos
// protocolos: cada cliente lo traduce al suyo.
type Message struct {
	Role    string
	Content string
	// Images son rutas de archivo. El cliente las lee y las codifica en
	// base64 al armar el request (Ollama las manda en `images`; OpenAI, como
	// partes `image_url` con un data URI): quien llama no carga bytes.
	Images []string
	// ToolCalls son las llamadas que pidió el modelo (rol assistant).
	ToolCalls []ToolCall
	// ToolCallID y Name responden a una llamada (rol tool). OpenAI correlaciona
	// por id; Ollama, por nombre de herramienta.
	ToolCallID string
	Name       string
}

// ToolCall es una llamada a herramienta pedida por el modelo.
type ToolCall struct {
	// ID lo asigna el servidor (OpenAI). Ollama no lo manda: se completa con
	// uno sintético para poder correlacionar la respuesta.
	ID   string
	Name string
	// Arguments ya viene decodificado: Ollama lo manda como objeto y OpenAI
	// como cadena JSON, y el cliente unifica.
	Arguments map[string]any
}

// ToolDef declara una herramienta que el modelo puede pedir.
type ToolDef struct {
	Name        string
	Description string
	// Parameters es un JSON Schema.
	Parameters map[string]any
}

// ChatRequest es un turno a enviar.
type ChatRequest struct {
	Model    string
	Messages []Message
	Tools    []ToolDef
}

// Delta es un trozo de la respuesta que llega en vivo.
type Delta struct {
	Text     string
	Thinking string
}

// Usage son los tokens que informó el servidor. Cero significa "no lo dijo".
type Usage struct {
	Input  int64
	Output int64
}

// ChatResult es la respuesta ya completa.
type ChatResult struct {
	// Message es el mensaje del asistente, con el texto acumulado y las
	// llamadas a herramientas, si las hubo.
	Message Message
	Usage   Usage
	// Model es el que respondió de verdad, que puede diferir del pedido.
	Model string
}

// Client es lo que ofrece un servidor de modelos.
type Client interface {
	// Version informa la versión del servidor. Ollama la publica; el
	// protocolo de OpenAI no, y ahí devuelve "" sin error.
	Version(ctx context.Context) (string, error)
	// Models lista los ids de los modelos disponibles.
	Models(ctx context.Context) ([]string, error)
	// Chat envía la conversación y transmite la respuesta por onDelta (puede
	// ser nil). Devuelve cuando el stream termina.
	Chat(ctx context.Context, req ChatRequest, onDelta func(Delta)) (ChatResult, error)
}

// Options son los datos de conexión de un servidor, todos opcionales.
type Options struct {
	// Token se manda como `Authorization: Bearer <token>`.
	Token string
	// Headers son cabeceras propias que viajan en TODO request (versión,
	// modelos y chat): proxies con su propia clave (`X-Api-Key`), gateways,
	// Cloudflare Access… Quien las arma ya las validó (vault).
	Headers map[string]string
	// InsecureTLS desactiva la verificación del certificado SOLO para este
	// servidor. Ver newHTTPClient por el riesgo.
	InsecureTLS bool
}

// New arma el cliente del tipo pedido.
func New(kind, baseURL string, opt Options) (Client, error) {
	base, err := NormalizeBaseURL(baseURL)
	if err != nil {
		return nil, err
	}
	r := requester{base: base, token: opt.Token, headers: opt.Headers, insecure: opt.InsecureTLS, http: newHTTPClient(opt.InsecureTLS)}
	switch kind {
	case KindOllama:
		return &ollamaClient{requester: r}, nil
	case KindOpenAI:
		return &openaiClient{requester: r}, nil
	}
	return nil, i18n.Errorf(i18n.Msg{ES: "llm: tipo de servidor desconocido %q", EN: "llm: unknown server kind %q"}, kind)
}

// NormalizeBaseURL valida que sea http(s) con host y le saca la barra final.
func NormalizeBaseURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", i18n.Errorf(i18n.Msg{ES: "llm: la URL del servidor tiene que ser http:// o https:// con un host", EN: "llm: the server URL must be http:// or https:// with a host"})
	}
	return strings.TrimRight(raw, "/"), nil
}

// controlTimeout acota las llamadas cortas (versión, modelos). El chat no lo
// usa: un modelo grande puede tardar minutos en cargarse antes del primer
// byte, y ahí manda el contexto de quien llama.
const controlTimeout = 10 * time.Second

// maxErrBody es cuánto del cuerpo de un error se incluye en el mensaje.
const maxErrBody = 300

// StatusError es una respuesta HTTP que no fue 2xx. Es un tipo propio y no un
// fmt.Errorf para que quien llama pueda mirar el status (IsToolsUnsupported)
// sin parsear el texto, que sigue siendo el mismo de siempre.
type StatusError struct {
	Base   string
	Status int
	Msg    string
}

func (e *StatusError) Error() string {
	return i18n.T(i18n.Msg{ES: "el servidor %s respondió %d: %s", EN: "the server %s answered %d: %s"}, e.Base, e.Status, e.Msg)
}

// IsToolsUnsupported dice si el servidor rechazó el request por las
// herramientas: el modelo no las soporta (Ollama: «… does not support tools»,
// HTTP 400) o el servidor no tiene el function calling encendido (vLLM:
// «"auto" tool choice requires --enable-auto-tool-choice», llama.cpp: «tools
// param requires --jinja flag»). Quien llama reintenta sin herramientas.
//
// Se decide por el texto además del status porque los servidores compatibles
// con OpenAI no se ponen de acuerdo ni en el código (400, 422 y hasta 500) ni
// en las palabras; lo que sí comparten es mencionar «tool» o «function
// call» junto a un «not supported / requires». Un error de red o un 401 nunca
// llegan acá: no mencionan herramientas.
func IsToolsUnsupported(err error) bool {
	if err == nil {
		return false
	}
	var se *StatusError
	if errors.As(err, &se) && se.Status != 400 && se.Status != 422 && se.Status != 500 && se.Status != 501 {
		return false
	}
	msg := strings.ToLower(err.Error())
	if !strings.Contains(msg, "tool") && !strings.Contains(msg, "function call") {
		return false
	}
	for _, w := range []string{"not support", "unsupported", "requires", "not enabled", "not available", "--jinja"} {
		if strings.Contains(msg, w) {
			return true
		}
	}
	return false
}

// errorSnippet saca el mensaje de un cuerpo de error. Los dos protocolos
// responden JSON con `error` como texto (Ollama) u objeto con `message`
// (OpenAI); si no es ninguno, se muestra el comienzo del cuerpo crudo.
func errorSnippet(body []byte) string {
	return trimSnippet(errorFromBody(body), body)
}

func trimSnippet(msg string, body []byte) string {
	if msg == "" {
		msg = strings.TrimSpace(string(body))
	}
	if len(msg) > maxErrBody {
		msg = msg[:maxErrBody] + "…"
	}
	if msg == "" {
		return "-"
	}
	return msg
}

// readImage lee una imagen y la devuelve en base64 y con su tipo MIME.
func readImage(path string) (b64, mime string, err error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", "", i18n.Errorf(i18n.Msg{ES: "no se pudo leer la imagen %q: %w", EN: "could not read the image %q: %w"}, filepath.Base(path), err)
	}
	mime = http.DetectContentType(data)
	if !strings.HasPrefix(mime, "image/") {
		return "", "", i18n.Errorf(i18n.Msg{ES: "%q no es una imagen", EN: "%q is not an image"}, filepath.Base(path))
	}
	return base64.StdEncoding.EncodeToString(data), mime, nil
}

// maxLine acota una línea del stream. Un trozo con razonamiento largo no se
// acerca a esto; una línea de 8 MB significa que no es lo que creemos.
const maxLine = 8 << 20

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
