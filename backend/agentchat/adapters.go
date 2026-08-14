package agentchat

import (
	"encoding/json"
	"fmt"
	"strings"

	"mini-tools/backend/agentapprove"
)

// Adaptadores: una función por CLI que traduce UNA línea de su salida a cero o
// más eventos comunes.
//
// La forma es "línea → []Event" y no un parser con estado porque los tres
// formatos son NDJSON sin contexto entre líneas: cada una se entiende sola.
// Una línea que no se entiende devuelve nil y se descarta — nunca aborta el
// turno, porque un evento nuevo que agregue el CLI en su próxima versión no
// puede ser motivo de que la conversación se corte.

// maxToolInput recorta el argumento de una herramienta. Se muestra QUÉ hizo el
// agente, no se reejecuta: un `Write` con un archivo entero adentro llenaría
// el chat con el contenido que justamente se va a ver en el diff.
const maxToolInput = 400

type adapter func(line []byte) []Event

// --- Claude Code ----------------------------------------------------------

type claudeLine struct {
	Type    string `json:"type"`
	Subtype string `json:"subtype"`
	Model   string `json:"model"`
	// SessionID es el id de conversación para encadenar con --resume.
	SessionID string   `json:"session_id"`
	Tools     []string `json:"tools"`
	MCP       []struct {
		Name   string `json:"name"`
		Status string `json:"status"`
	} `json:"mcp_servers"`
	Message struct {
		Model   string `json:"model"`
		Content []struct {
			Type  string          `json:"type"`
			Text  string          `json:"text"`
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
		} `json:"content"`
	} `json:"message"`
	Usage      claudeUsage `json:"usage"`
	TotalCost  float64     `json:"total_cost_usd"`
	IsError    bool        `json:"is_error"`
	Result     string      `json:"result"`
	StopReason string      `json:"stop_reason"`
}

type claudeUsage struct {
	Input      int64 `json:"input_tokens"`
	Output     int64 `json:"output_tokens"`
	CacheRead  int64 `json:"cache_read_input_tokens"`
	CacheWrite int64 `json:"cache_creation_input_tokens"`
	Details    struct {
		Thinking int64 `json:"thinking_tokens"`
	} `json:"output_tokens_details"`
}

func claudeAdapter(line []byte) []Event {
	var l claudeLine
	if err := json.Unmarshal(line, &l); err != nil {
		return nil
	}

	switch l.Type {
	case "system":
		if l.Subtype != "init" {
			return nil
		}
		// El init de Claude Code trae SU visión de los servidores MCP, con el
		// estado real de cada uno. Es información que backend/mcpconf no puede
		// dar leyendo archivos: ahí se ve qué está configurado, acá qué está
		// efectivamente conectado.
		servers := make([]string, 0, len(l.MCP))
		for _, s := range l.MCP {
			servers = append(servers, fmt.Sprintf("%s (%s)", s.Name, s.Status))
		}
		return []Event{{
			Kind:           KindStart,
			Model:          l.Model,
			Tools:          l.Tools,
			MCPServers:     servers,
			ConversationID: l.SessionID,
		}}

	case "assistant":
		var out []Event
		for _, c := range l.Message.Content {
			switch c.Type {
			case "text":
				if c.Text != "" {
					out = append(out, Event{Kind: KindText, Text: c.Text})
				}
			case "thinking":
				if c.Text != "" {
					out = append(out, Event{Kind: KindThinking, Text: c.Text})
				}
			case "tool_use":
				out = append(out, Event{Kind: KindTool, Tool: newToolCall(c.Name, string(c.Input))})
			}
		}
		return out

	case "result":
		u := Usage{
			Input:     l.Usage.Input + l.Usage.CacheWrite,
			Output:    l.Usage.Output,
			CacheRead: l.Usage.CacheRead,
			Thinking:  l.Usage.Details.Thinking,
			CostUSD:   l.TotalCost,
		}
		u.Total = u.Input + u.Output + u.CacheRead
		if l.IsError {
			return []Event{{Kind: KindError, Error: firstNonEmpty(l.Result, "el agente terminó con error"), Usage: &u, ConversationID: l.SessionID}}
		}
		return []Event{{Kind: KindDone, Usage: &u, ConversationID: l.SessionID}}
	}
	return nil
}

// --- Antigravity ----------------------------------------------------------

type agyLine struct {
	Event string `json:"event"`
	Init  *struct {
		Cwd   string   `json:"cwd"`
		Tools []string `json:"tools"`
		Model string   `json:"model"`
	} `json:"init"`
	ConversationID string `json:"conversation_id"`
	StepUpdate     *struct {
		ConversationID string    `json:"conversation_id"`
		StepIndex      int       `json:"step_index"`
		StepType       string    `json:"step_type"`
		State          string    `json:"state"`
		TextDelta      string    `json:"text_delta"`
		ToolName       string    `json:"tool_name"`
		ToolInput      any       `json:"tool_input"`
		Usage          *agyUsage `json:"usage"`
	} `json:"step_update"`
	Result *struct {
		ConversationID string    `json:"conversation_id"`
		Status         string    `json:"status"`
		Response       string    `json:"response"`
		Usage          *agyUsage `json:"usage"`
	} `json:"result"`
}

type agyUsage struct {
	Input     int64 `json:"input_tokens"`
	Output    int64 `json:"output_tokens"`
	Thinking  int64 `json:"thinking_tokens"`
	CacheRead int64 `json:"cache_read_tokens"`
	Total     int64 `json:"total_tokens"`
}

func (u *agyUsage) common() *Usage {
	if u == nil {
		return nil
	}
	return &Usage{Input: u.Input, Output: u.Output, CacheRead: u.CacheRead, Thinking: u.Thinking, Total: u.Total}
}

func antigravityAdapter(line []byte) []Event {
	var l agyLine
	if err := json.Unmarshal(line, &l); err != nil {
		return nil
	}

	switch {
	case l.Init != nil:
		return []Event{{Kind: KindStart, Model: l.Init.Model, Tools: l.Init.Tools, ConversationID: l.ConversationID}}

	case l.StepUpdate != nil:
		s := l.StepUpdate
		// El texto llega como deltas incrementales, así que se reenvía tal
		// cual y quien lo muestra concatena. Acumularlo acá para mandarlo
		// entero al final tiraría abajo lo único que hace que un chat se
		// sienta vivo.
		switch s.StepType {
		case "agent_response":
			if s.TextDelta != "" {
				return []Event{{Kind: KindText, Text: s.TextDelta}}
			}
		case "user_input", "checkpoint", "unknown":
			// Pasos internos: no son nada que mostrar.
			return nil
		default:
			// Cualquier otro step_type con nombre de herramienta se muestra
			// como llamada. Se toma el step_type como nombre cuando no hay uno
			// explícito: es preferible mostrar "algo pasó y se llamaba así" a
			// tragarse la acción entera.
			if s.State == "ACTIVE" {
				name := firstNonEmpty(s.ToolName, s.StepType)
				return []Event{{Kind: KindTool, Tool: newToolCall(name, rawJSON(s.ToolInput))}}
			}
		}
		return nil

	case l.Result != nil:
		u := l.Result.Usage.common()
		if l.Result.Status != "" && l.Result.Status != "SUCCESS" {
			return []Event{{Kind: KindError, Error: fmt.Sprintf("el agente terminó con estado %s", l.Result.Status), Usage: u, ConversationID: l.Result.ConversationID}}
		}
		return []Event{{Kind: KindDone, Usage: u, ConversationID: l.Result.ConversationID}}
	}
	return nil
}

// --- Codex ----------------------------------------------------------------

// codexLine es una línea de `codex exec --json`. Verificado contra corridas
// reales guardadas en testdata/codex-stream.jsonl.
//
// Su forma es la tercera distinta de las tres: eventos con `type` en
// `thread.started|turn.started|item.started|item.completed|turn.completed`,
// donde lo que pasó vive en `item` y el uso llega al cerrar el turno.
type codexLine struct {
	Type     string `json:"type"`
	ThreadID string `json:"thread_id"`
	Item     *struct {
		ID   string `json:"id"`
		Type string `json:"type"`
		// Text lo trae agent_message.
		Text string `json:"text"`
		// Command y su salida los trae command_execution.
		Command    string `json:"command"`
		Aggregated string `json:"aggregated_output"`
		Status     string `json:"status"`
		// Los cambios de archivo traen su ruta.
		Path    string `json:"path"`
		Changes any    `json:"changes"`
	} `json:"item"`
	Usage *struct {
		Input      int64 `json:"input_tokens"`
		Cached     int64 `json:"cached_input_tokens"`
		CacheWrite int64 `json:"cache_write_input_tokens"`
		Output     int64 `json:"output_tokens"`
		Reasoning  int64 `json:"reasoning_output_tokens"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func codexAdapter(line []byte) []Event {
	var l codexLine
	if err := json.Unmarshal(line, &l); err != nil {
		return nil
	}

	switch l.Type {
	case "thread.started":
		// El thread_id es lo que permite retomar la conversación
		// (`codex exec resume <id>`).
		return []Event{{Kind: KindStart, ConversationID: l.ThreadID}}

	case "item.started", "item.completed":
		if l.Item == nil {
			return nil
		}
		switch l.Item.Type {
		case "agent_message":
			// Solo al completarse: el mensaje no llega en deltas, así que
			// emitirlo dos veces lo duplicaría en pantalla.
			if l.Type == "item.completed" && l.Item.Text != "" {
				return []Event{{Kind: KindText, Text: l.Item.Text}}
			}
		case "reasoning":
			if l.Type == "item.completed" && l.Item.Text != "" {
				return []Event{{Kind: KindThinking, Text: l.Item.Text}}
			}
		default:
			// Toda otra clase de item es una acción. Se muestra al EMPEZAR y
			// no al terminar, que es lo que hace que se vea trabajando en vez
			// de aparecer todo junto al final.
			if l.Type != "item.started" {
				return nil
			}
			raw := l.Item.Command
			if raw == "" {
				raw = l.Item.Path
			}
			tool := &ToolCall{Name: l.Item.Type, Input: trim(raw), Summary: trim(raw)}
			return []Event{{Kind: KindTool, Tool: tool}}
		}
		return nil

	case "turn.completed":
		u := Usage{}
		if l.Usage != nil {
			u = Usage{
				// `input_tokens` de Codex ya incluye los cacheados, así que
				// restarlos es lo que hace comparable el número con el de los
				// otros dos agentes — si no, la entrada se contaría dos veces.
				Input:     l.Usage.Input - l.Usage.Cached + l.Usage.CacheWrite,
				Output:    l.Usage.Output,
				CacheRead: l.Usage.Cached,
				Thinking:  l.Usage.Reasoning,
			}
			u.Total = u.Input + u.Output + u.CacheRead
		}
		return []Event{{Kind: KindDone, Usage: &u}}

	case "turn.failed", "error":
		msg := "el agente terminó con error"
		if l.Error != nil && l.Error.Message != "" {
			msg = l.Error.Message
		}
		return []Event{{Kind: KindError, Error: msg}}
	}
	return nil
}

// --- Registro -------------------------------------------------------------

// adapters son los agentes con adaptador VERIFICADO contra una corrida real.
// Codex no está: ver el doc del paquete.
var adapters = map[string]adapter{
	"claude":      claudeAdapter,
	"antigravity": antigravityAdapter,
	"codex":       codexAdapter,
}

// Supports informa si un agente puede usar el chat nativo. La UI lo necesita
// para ofrecer el chat solo donde funciona y dejar la terminal para el resto,
// en vez de mostrar un chat que se queda mudo.
func Supports(agentID string) bool {
	_, ok := adapters[agentID]
	return ok
}

// newToolCall arma la llamada ya descrita, en un solo lugar para que los dos
// adaptadores no puedan divergir.
func newToolCall(name, rawInput string) *ToolCall {
	// La descripción la arma agentapprove: es la MISMA pregunta ("qué está por
	// hacer esta herramienta") que se le muestra al usuario cuando tiene que
	// autorizarla, y dos copias de esa lógica se desincronizarían — el chat
	// diría una cosa y el diálogo de permiso otra sobre la misma acción.
	summary, detail := agentapprove.Describe(rawInput)
	return &ToolCall{Name: name, Input: trim(rawInput), Summary: trim(summary), Detail: detail}
}

func trim(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > maxToolInput {
		return s[:maxToolInput] + "…"
	}
	return s
}

// rawJSON serializa el argumento sin recortarlo: el recorte lo hace
// newToolCall después de describirlo, para no romper el JSON antes de poder
// leerle las claves.
func rawJSON(v any) string {
	if v == nil {
		return ""
	}
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(b)
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
