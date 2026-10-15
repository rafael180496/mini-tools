package agentchat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"mini-tools/backend/i18n"
	"mini-tools/backend/llm"
)

// Runner HTTP: el segundo "adaptador" del paquete, para los servidores de
// modelos (Ollama, compatibles con OpenAI).
//
// Un agente `llm:<id>` no lanza ningún proceso: habla por HTTP con un
// servidor. Pero para el frontend tiene que ser indistinguible de un CLI, así
// que este runner emite **la misma secuencia de Event** que los adaptadores
// (start → text/thinking → done con Usage, o error) por el mismo emit.
//
// A diferencia de los CLIs, acá la memoria de la conversación SÍ la tiene
// este lado: un servidor de modelos no guarda estado entre pedidos, así que
// cada turno reenvía los mensajes anteriores. Viven en memoria mientras la app
// está abierta; al retomar un chat guardado después de reiniciar, App siembra
// la sesión con los últimos mensajes del historial (Turn.History, ver
// SeedHistory).
//
// El runner no conoce el vault: quien arma el Turn (App) le pasa el cliente
// HTTP ya configurado, con su token.

// LLMPrefix marca los ids de agente que son servidores de modelos.
const LLMPrefix = "llm:"

// IsLLM dice si el agente es un servidor de modelos.
func IsLLM(agentID string) bool { return strings.HasPrefix(agentID, LLMPrefix) }

// llmMaxHistory acota cuántos mensajes previos se reenvían. Es un tope
// grosero para que una conversación larga no reviente el contexto del modelo;
// recortar por tokens necesitaría un tokenizador por modelo que no hay.
const llmMaxHistory = 60

func llmSystemMessage() llm.Message {
	return llm.Message{Role: llm.RoleSystem, Content: i18n.T(replyLanguage)}
}

// defaultModeler lo implementa un cliente que sabe qué modelo usar cuando ni el
// turno ni nadie eligió uno: el que App arma con el `defaultModel` del
// proveedor, o el de Anthropic, que tiene uno propio y no necesita listar.
type defaultModeler interface{ DefaultModel() string }

// resolveLLMModel devuelve el modelo del turno; sin elegir, el predeterminado
// del proveedor y, si no tiene, el primero que informe el servidor.
func resolveLLMModel(ctx context.Context, t Turn) (string, error) {
	if t.Model != "" {
		return t.Model, nil
	}
	if d, ok := t.LLM.(defaultModeler); ok {
		if m := d.DefaultModel(); m != "" {
			return m, nil
		}
	}
	models, err := t.LLM.Models(ctx)
	if err != nil {
		return "", err
	}
	if len(models) == 0 {
		return "", i18n.Errorf(i18n.Msg{ES: "el servidor no tiene ningún modelo disponible", EN: "the server has no models available"})
	}
	return models[0], nil
}

func (m *Manager) sendLLM(t Turn) error {
	if t.LLM == nil {
		return i18n.Errorf(i18n.Msg{ES: "agentchat: falta el cliente del servidor de modelos para %q", EN: "agentchat: the model server client is missing for %q"}, t.AgentID)
	}
	m.mu.Lock()
	if _, busy := m.cancels[t.SessionID]; busy {
		m.mu.Unlock()
		return i18n.Errorf(i18n.Msg{ES: "agentchat: esa sesión todavía está contestando", EN: "agentchat: that session is still replying"})
	}
	history := append([]llm.Message{}, m.llmHistory[t.SessionID]...)
	// El chat pasó a otro proveedor (App.SetAgentChatAgent): la memoria se
	// conserva —es lo que hace que la conversación siga— pero lo opaco que
	// llevan los mensajes del anterior no se reenvía. Ya hoy los clientes
	// ignoran un Raw que no es suyo y Anthropic solo reenvía el del turno
	// abierto; esto lo hace explícito en vez de depender de eso.
	if prev := m.llmHistoryAgent[t.SessionID]; prev != "" && prev != t.AgentID {
		history = withoutRaw(history)
	}
	// Sesión sin memoria (la app se reinició y se retomó un chat guardado):
	// se siembra con el historial que armó quien llama. Con la sesión viva
	// manda la memoria, que ya tiene el turno anterior completo.
	if len(history) == 0 && len(t.History) > 0 {
		history = append([]llm.Message{llmSystemMessage()}, t.History...)
	}
	// El ctx lleva el id de la sesión: las herramientas que piden permiso desde
	// adentro del turno (App.askApprovalCtx) lo leen para rotular la pregunta.
	ctx, cancel := context.WithCancel(WithSessionID(context.Background(), t.SessionID))
	m.cancels[t.SessionID] = cancel
	m.mu.Unlock()

	m.beginTurn(ctx, t)
	m.spawn(func() { m.runLLM(ctx, t, history) })
	return nil
}

// DefaultToolRounds es el tope de vueltas del bucle de herramientas. Cada
// vuelta es un pedido al modelo; 25 alcanzan para explorar un repositorio,
// editar y correr los tests, y cortan al modelo que quedó dando vueltas con la
// misma llamada.
const DefaultToolRounds = 25

// maxToolResultChars acota lo que se le devuelve al modelo de UNA herramienta.
// Las de archivos y comandos ya se acotan solas; esto es la red para las del
// servidor MCP (un diff entero, el esquema de una base) y para que un
// resultado enorme no desborde el contexto de un modelo chico.
const maxToolResultChars = 32000

// llmMaxHistoryChars es el presupuesto de caracteres de la memoria de una
// sesión. Con herramientas, lo que más pesa son sus resultados.
const llmMaxHistoryChars = 160000

func (m *Manager) runLLM(ctx context.Context, t Turn, history []llm.Message) {
	defer m.finish(t.SessionID)

	model, err := resolveLLMModel(ctx, t)
	if err != nil {
		m.emitLLMError(ctx, t.SessionID, err)
		return
	}
	// ConversationID = id de la sesión: no hay un id propio del servidor, pero
	// el frontend guarda el que llegue para marcar el chat como retomable.
	m.emit(t.SessionID, Event{Kind: KindStart, Model: model, ConversationID: t.SessionID, Recalled: t.Recalled})

	msgs := append(withSystem(history, t.System), llm.Message{Role: llm.RoleUser, Content: t.Prompt, Images: t.Images, PDFs: t.PDFs})

	tools := t.Tools
	noToolsKey := t.AgentID + "|" + model
	if len(tools) > 0 && m.knownNoTools(noToolsKey) {
		// Ya se vio que este modelo no las soporta: no se reintenta cada turno
		// para volver a fallar. Se avisa una vez por sesión.
		tools = nil
		m.noticeNoTools(t.SessionID, noToolsKey)
	}
	allowed := make(map[string]bool, len(tools))
	for _, td := range tools {
		allowed[td.Name] = true
	}
	maxRounds := t.MaxToolRounds
	if maxRounds <= 0 {
		maxRounds = DefaultToolRounds
	}

	var total llm.Usage
	// genTime acumula lo que el servidor tardó en contestar (una o más
	// llamadas por turno, según las vueltas de herramientas). No incluye lo
	// que tardó una herramienta ni la espera de una aprobación: dividir los
	// tokens por el turno entero daría una velocidad que no es del modelo.
	var genTime time.Duration
	var sawText, sawTool bool
	for round := 1; ; round++ {
		// Entre dos vueltas el texto del modelo se separa con un párrafo: sin
		// eso «Voy a leer el archivo.» y la respuesta final salen pegados.
		roundOpened := false
		onDelta := func(d llm.Delta) {
			if d.Thinking != "" {
				m.emit(t.SessionID, Event{Kind: KindThinking, Text: d.Thinking})
			}
			if d.Text != "" {
				if !roundOpened {
					roundOpened = true
					if sawText && round > 1 {
						m.emit(t.SessionID, Event{Kind: KindText, Text: "\n\n"})
					}
				}
				sawText = true
				m.emit(t.SessionID, Event{Kind: KindText, Text: d.Text})
			}
		}

		m.noticeContextOverflow(t, msgs, tools)

		callStart := time.Now()
		res, err := chatRetry(ctx, t.LLM, llm.ChatRequest{Model: model, Messages: msgs, Tools: tools}, onDelta)
		if err != nil && len(tools) > 0 && ctx.Err() == nil && llm.IsToolsUnsupported(err) {
			// El modelo (o el servidor) no soporta herramientas: se sigue sin
			// ellas en lugar de fallar, y se avisa. El request es el mismo; lo
			// único que cambia es que ya no declara `tools`.
			m.markNoTools(noToolsKey)
			m.noticeNoTools(t.SessionID, noToolsKey)
			tools, allowed = nil, map[string]bool{}
			res, err = chatRetry(ctx, t.LLM, llm.ChatRequest{Model: model, Messages: msgs}, onDelta)
		}
		genTime += time.Since(callStart)
		if err != nil {
			m.emitLLMError(ctx, t.SessionID, err)
			return
		}
		total.Input += res.Usage.Input
		total.Output += res.Usage.Output
		total.CacheRead += res.Usage.CacheRead
		total.CacheWrite += res.Usage.CacheWrite
		total.Thinking += res.Usage.Thinking
		msgs = append(msgs, res.Message)

		calls := res.Message.ToolCalls
		if len(calls) == 0 {
			if !sawText && !sawTool && strings.TrimSpace(res.Message.Content) == "" {
				m.emit(t.SessionID, Event{Kind: KindError, Error: i18n.T(i18n.Msg{ES: "el modelo no devolvió texto", EN: "the model returned no text"})})
				return
			}
			break
		}

		if round >= maxRounds {
			// Tope: las llamadas pendientes no se ejecutan, pero se contestan
			// (el protocolo exige una respuesta por cada una) para que la
			// memoria quede utilizable en el turno siguiente. Lo ya ejecutado
			// ocurrió de verdad, así que se conserva.
			for _, c := range calls {
				msgs = append(msgs, toolMessage(c, "error: "+i18n.T(msgToolRoundsNotRun)))
			}
			m.saveLLMHistory(ctx, t, forgetAttachments(msgs, t))
			m.emit(t.SessionID, Event{Kind: KindError, Error: i18n.T(msgToolRoundsLimit, maxRounds), Usage: usageOf(total, genTime)})
			return
		}

		for _, c := range calls {
			if ctx.Err() != nil {
				m.emitLLMError(ctx, t.SessionID, ctx.Err())
				return
			}
			sawTool = true
			// El evento sale ANTES de ejecutar: si la herramienta pide
			// aprobación, el usuario ya ve de qué acción se trata en el chat.
			m.emit(t.SessionID, Event{Kind: KindTool, Tool: llmToolCall(c)})
			out := runLLMTool(ctx, t, allowed, c)
			msgs = append(msgs, toolMessage(c, out))
		}
		if ctx.Err() != nil {
			m.emitLLMError(ctx, t.SessionID, ctx.Err())
			return
		}
	}

	// Se guarda recién cuando el turno terminó bien, y solo si nadie lo cortó
	// ni reinició la sesión mientras tanto (Reset cancela antes de borrar, así
	// que ctx.Err() bajo el candado es la comprobación completa).
	m.saveLLMHistory(ctx, t, forgetAttachments(msgs, t))
	m.emit(t.SessionID, Event{Kind: KindDone, ConversationID: t.SessionID, Usage: usageOf(total, genTime)})
}

var (
	msgToolRoundsLimit  = i18n.Msg{ES: "el modelo llegó al tope de %d vueltas de herramientas sin terminar; lo que ya hizo quedó hecho. Pedile que siga, o dividí la tarea", EN: "the model reached the limit of %d tool rounds without finishing; what it already did stays done. Ask it to continue, or split the task"}
	msgToolRoundsNotRun = i18n.Msg{ES: "se alcanzó el tope de vueltas de herramientas: esta llamada no se ejecutó", EN: "the tool round limit was reached: this call was not run"}
	msgContextNotice    = i18n.Msg{ES: "_⚠ El mensaje, con las instrucciones del proyecto y el historial, pesa unos %d tokens y la ventana de contexto del servidor es de %d: el servidor puede recortar el principio sin avisar. Subila en Utilidades → Servidores de modelos._", EN: "_⚠ The message, with the project instructions and the history, weighs about %d tokens and the server's context window is %d: the server may silently cut off the start. Raise it in Utilities → Model servers._"}
	msgNoToolsNotice    = i18n.Msg{ES: "_⚠ Este modelo no admite herramientas: sigo sin ellas._", EN: "_⚠ This model does not support tools: continuing without them._"}
)

// llmRetryDelay es la espera antes del segundo intento (variable para que los
// tests no esperen un segundo de verdad).
var llmRetryDelay = time.Second

// chatRetry es Chat con un reintento para el fallo de conexión transitorio: el
// servidor remoto se reinició, la conexión se cayó, un hipo de red. Se
// reintenta UNA vez, tras ~1s, y solo si:
//
//   - el fallo es de conexión (rechazada, reset, EOF, timeout… ver
//     llm.IsRetryable): un 4xx/5xx o un error de certificado no se curan solos;
//   - todavía no llegó ningún trozo de la respuesta: con el stream ya abierto,
//     reintentar repetiría en pantalla texto que la persona ya leyó;
//   - nadie canceló: un ctx muerto (cancelación o tope) corta de inmediato.
func chatRetry(ctx context.Context, c llm.Client, req llm.ChatRequest, onDelta func(llm.Delta)) (llm.ChatResult, error) {
	started := false
	res, err := c.Chat(ctx, req, func(d llm.Delta) {
		started = true
		if onDelta != nil {
			onDelta(d)
		}
	})
	if err == nil || started || ctx.Err() != nil || !llm.IsRetryable(err) {
		return res, err
	}
	timer := time.NewTimer(llmRetryDelay)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-ctx.Done():
		return llm.ChatResult{}, ctx.Err()
	}
	return c.Chat(ctx, req, onDelta)
}

func usageOf(u llm.Usage, gen time.Duration) *Usage {
	return &Usage{Input: u.Input, Output: u.Output, CacheRead: u.CacheRead, CacheWrite: u.CacheWrite, Thinking: u.Thinking, Total: u.Input + u.Output, DurationMs: gen.Milliseconds()}
}

func (m *Manager) saveLLMHistory(ctx context.Context, t Turn, msgs []llm.Message) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if ctx.Err() == nil {
		m.llmHistory[t.SessionID] = trimLLMHistory(msgs)
		m.llmHistoryAgent[t.SessionID] = t.AgentID
	}
}

// withoutRaw devuelve los mensajes sin su contenido original de proveedor
// (Message.Raw). No toca el slice recibido.
func withoutRaw(msgs []llm.Message) []llm.Message {
	out := make([]llm.Message, len(msgs))
	for i, msg := range msgs {
		msg.Raw = nil
		out[i] = msg
	}
	return out
}

func (m *Manager) knownNoTools(key string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.llmNoTools[key]
}

func (m *Manager) markNoTools(key string) {
	m.mu.Lock()
	m.llmNoTools[key] = true
	m.mu.Unlock()
}

// noticeNoTools avisa UNA vez por sesión y modelo que se sigue sin
// herramientas. Va como una línea de texto del asistente —lo único que el chat
// ya dibuja sin código nuevo— en cursiva y como párrafo aparte; queda en el
// historial guardado como parte de esa respuesta, que es donde ocurrió.
func (m *Manager) noticeNoTools(sessionID, key string) {
	k := sessionID + "|" + key
	m.mu.Lock()
	seen := m.llmNoticed[k]
	m.llmNoticed[k] = true
	m.mu.Unlock()
	if !seen {
		m.emit(sessionID, Event{Kind: KindText, Text: i18n.T(msgNoToolsNotice) + "\n\n"})
	}
}

// estimateTokens aproxima los tokens de lo que se va a enviar con la regla
// común de ~4 caracteres por token. Es una estimación a propósito: un
// tokenizador exacto es por modelo y acá solo hace falta saber si el orden de
// magnitud ya no entra.
func estimateTokens(msgs []llm.Message, tools []llm.ToolDef) int {
	chars := 0
	for _, m := range msgs {
		chars += len(m.Content)
		for _, c := range m.ToolCalls {
			chars += len(c.Name)
			for k, v := range c.Arguments {
				chars += len(k) + len(fmt.Sprint(v))
			}
		}
	}
	for _, td := range tools {
		chars += len(td.Name) + len(td.Description)
		if td.Parameters != nil {
			if b, err := json.Marshal(td.Parameters); err == nil {
				chars += len(b)
			}
		}
	}
	return chars / 4
}

// noticeContextOverflow avisa UNA vez por sesión que el prompt estimado supera
// la ventana de contexto configurada del servidor. No bloquea ni recorta: es
// información para que la persona suba el valor. Sin ventana conocida
// (ContextTokens = 0) no hay contra qué comparar y no dice nada.
func (m *Manager) noticeContextOverflow(t Turn, msgs []llm.Message, tools []llm.ToolDef) {
	if t.ContextTokens <= 0 {
		return
	}
	est := estimateTokens(msgs, tools)
	if est <= t.ContextTokens {
		return
	}
	k := t.SessionID + "|ctx"
	m.mu.Lock()
	seen := m.llmNoticed[k]
	m.llmNoticed[k] = true
	m.mu.Unlock()
	if !seen {
		m.emit(t.SessionID, Event{Kind: KindText, Text: i18n.T(msgContextNotice, est, t.ContextTokens) + "\n\n"})
	}
}

// withSystem deja el mensaje de sistema al frente, con el idioma y el texto
// extra de ESTE turno. Se regenera siempre: el modo (y con él qué
// herramientas hay) puede cambiar de un mensaje al siguiente, y el idioma de
// la app también.
func withSystem(history []llm.Message, extra string) []llm.Message {
	sys := llmSystemMessage()
	if strings.TrimSpace(extra) != "" {
		sys.Content += "\n\n" + strings.TrimSpace(extra)
	}
	out := make([]llm.Message, 0, len(history)+2)
	out = append(out, sys)
	for i, h := range history {
		if i == 0 && h.Role == llm.RoleSystem {
			continue
		}
		out = append(out, h)
	}
	return out
}

func toolMessage(c llm.ToolCall, content string) llm.Message {
	return llm.Message{Role: llm.RoleTool, ToolCallID: c.ID, Name: c.Name, Content: content}
}

// runLLMTool ejecuta una llamada y devuelve el texto que se le da al modelo.
// Nunca falla el turno: un error de la herramienta —o un pánico— vuelve como
// «error: …» para que el modelo lo lea y corrija.
func runLLMTool(ctx context.Context, t Turn, allowed map[string]bool, c llm.ToolCall) (out string) {
	defer func() {
		if r := recover(); r != nil {
			out = "error: " + i18n.T(i18n.Msg{ES: "falló la herramienta por dentro: %v", EN: "the tool failed internally: %v"}, r)
		}
	}()
	if !allowed[c.Name] {
		return "error: " + i18n.T(i18n.Msg{ES: "la herramienta %q no está disponible en este chat", EN: "the tool %q is not available in this chat"}, c.Name)
	}
	if raw, ok := c.Arguments["_raw"].(string); ok && len(c.Arguments) == 1 {
		return "error: " + i18n.T(i18n.Msg{ES: "los argumentos no son un JSON válido: %s", EN: "the arguments are not valid JSON: %s"}, trim(raw))
	}
	if t.RunTool == nil {
		return "error: " + i18n.T(i18n.Msg{ES: "este chat no puede ejecutar herramientas", EN: "this chat cannot run tools"})
	}
	res, err := t.RunTool(ctx, c.Name, c.Arguments)
	if err != nil {
		return "error: " + err.Error()
	}
	if strings.TrimSpace(res) == "" {
		return i18n.T(i18n.Msg{ES: "(resultado vacío)", EN: "(empty result)"})
	}
	if r := []rune(res); len(r) > maxToolResultChars {
		res = string(r[:maxToolResultChars]) + "\n" + i18n.T(i18n.Msg{ES: "[resultado recortado: %d caracteres de %d]", EN: "[result trimmed: %d characters of %d]"}, maxToolResultChars, len(r))
	}
	return res
}

// llmToolCall arma el evento de una llamada con el MISMO describidor que los
// CLIs (newToolCall → agentapprove.Describe), para que el chat la dibuje igual
// y la fila del historial diga lo mismo que la pregunta de permiso.
//
// Las herramientas del servidor MCP no usan las claves que Describe conoce
// (`title`, `connection`, `repo`…): sin resumen la fila quedaría con el JSON
// crudo, así que se completa con el primer argumento de texto reconocible.
func llmToolCall(c llm.ToolCall) *ToolCall {
	tc := newToolCall(c.Name, rawJSON(c.Arguments))
	if tc.Summary == "" {
		tc.Summary = genericToolSummary(c.Arguments)
	}
	return tc
}

func genericToolSummary(args map[string]any) string {
	for _, k := range []string{"title", "connection", "repo", "server", "table", "name"} {
		if v, ok := args[k].(string); ok && strings.TrimSpace(v) != "" {
			return trim(strings.TrimSpace(v))
		}
	}
	return ""
}

// emitLLMError distingue un corte pedido por el usuario de un fallo real.
func (m *Manager) emitLLMError(ctx context.Context, sessionID string, err error) {
	if ctx.Err() != nil || errors.Is(err, context.Canceled) {
		m.emit(sessionID, Event{Kind: KindError, Error: i18n.T(i18n.Msg{ES: "turno cancelado", EN: "turn cancelled"})})
		return
	}
	m.emit(sessionID, Event{Kind: KindError, Error: err.Error()})
}

// trimLLMHistory conserva el mensaje de sistema y la cola de la conversación:
// hasta llmMaxHistory mensajes y llmMaxHistoryChars caracteres, siempre
// empezando por un mensaje del usuario.
//
// Recortar el principio EDITA el prefijo de la conversación, y eso invalida los
// bloques de pensamiento firmados de Anthropic de los turnos que quedan
// ("preserved thinking"). No es un problema acá a propósito: el cliente de
// Anthropic reenvía el contenido original del asistente (Message.Raw) solo
// dentro del turno abierto y los turnos anteriores sin pensamiento (ver
// backend/llm/anthropic.go), así que el recorte —como un cambio de modo, que
// cambia el system y las herramientas— no puede romper ninguna firma. Empezar en medio de un turno dejaría
// un resultado de herramienta (rol tool) sin la llamada que lo originó, que
// los servidores rechazan.
func trimLLMHistory(msgs []llm.Message) []llm.Message {
	if len(msgs) == 0 {
		return msgs
	}
	var sys []llm.Message
	rest := msgs
	if msgs[0].Role == llm.RoleSystem {
		sys, rest = msgs[:1], msgs[1:]
	}
	start := 0
	if len(rest) > llmMaxHistory {
		start = len(rest) - llmMaxHistory
	}
	used := 0
	for i := len(rest) - 1; i >= start; i-- {
		used += len(rest[i].Content)
		if used > llmMaxHistoryChars {
			start = i + 1
			break
		}
	}
	for start < len(rest) && rest[start].Role != llm.RoleUser {
		start++
	}
	// El turno que acaba de terminar no se recorta nunca, por grande que sea:
	// sin él el modelo perdería lo último que hizo.
	for i := len(rest) - 1; i >= 0; i-- {
		if rest[i].Role == llm.RoleUser {
			if start > i {
				start = i
			}
			break
		}
	}
	out := make([]llm.Message, 0, len(sys)+len(rest)-start)
	out = append(out, sys...)
	return append(out, rest[start:]...)
}

// askLLM es Ask para un servidor de modelos: un turno suelto, sin historial.
func (m *Manager) askLLM(ctx context.Context, t Turn) (string, error) {
	if t.LLM == nil {
		return "", i18n.Errorf(i18n.Msg{ES: "agentchat: falta el cliente del servidor de modelos para %q", EN: "agentchat: the model server client is missing for %q"}, t.AgentID)
	}
	model, err := resolveLLMModel(ctx, t)
	if err != nil {
		return "", err
	}
	res, err := chatRetry(ctx, t.LLM, llm.ChatRequest{
		Model: model,
		Messages: []llm.Message{
			llmSystemMessage(),
			{Role: llm.RoleUser, Content: t.Prompt, Images: t.Images, PDFs: t.PDFs},
		},
	}, nil)
	if err != nil {
		return "", err
	}
	text := strings.TrimSpace(res.Message.Content)
	if text == "" {
		return "", i18n.Errorf(i18n.Msg{ES: "el agente no devolvió texto", EN: "the agent returned no text"})
	}
	return text, nil
}
