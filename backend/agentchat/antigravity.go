package agentchat

import (
	"encoding/json"
	"sort"
	"strings"

	"mini-tools/backend/i18n"
)

// --- Antigravity ----------------------------------------------------------
//
// `agy --print --output-format stream-json`. Una línea por evento con `event`
// en `init|step_update|result`; los fixtures de testdata/antigravity-*.jsonl
// son corridas reales (el de denegación y el de MCP, con el servidor
// renombrado a mini-tools).
//
// El adaptador tiene estado por turno (agyTurn) por tres cosas que una línea
// sola no dice:
//
//   - si la respuesta ya llegó en trozos (`text_delta`): si el CLI cierra con
//     `result.response` y nunca los mandó, esa respuesta sale como texto — sin
//     eso el turno quedaba vacío aunque el CLI sí hubiera contestado;
//   - qué herramienta era cada paso, para nombrar la que se rechazó cuando el
//     paso que falla ya no trae sus argumentos;
//   - cuál es el servidor MCP de mini-tools: Antigravity llama a TODA
//     herramienta MCP como `call_mcp_tool` y la de verdad viaja adentro.

type agyLine struct {
	Event string `json:"event"`
	Init  *struct {
		Cwd   string   `json:"cwd"`
		Tools []string `json:"tools"`
		Model string   `json:"model"`
	} `json:"init"`
	ConversationID string `json:"conversation_id"`
	StepUpdate     *struct {
		ConversationID string `json:"conversation_id"`
		StepIndex      int    `json:"step_index"`
		StepType       string `json:"step_type"`
		State          string `json:"state"`
		// TextDelta se lee CRUDO. Ver rawtext.go: el decodificador estándar
		// reemplaza por U+FFFD el byte suelto de un carácter que quedó
		// partido entre dos trozos, y ahí ya no hay nada que recuperar.
		TextDelta json.RawMessage `json:"text_delta"`
		ToolName  string          `json:"tool_name"`
		ToolInput any             `json:"tool_input"`
		Usage     *agyUsage       `json:"usage"`
	} `json:"step_update"`
	Result *struct {
		ConversationID string    `json:"conversation_id"`
		Status         string    `json:"status"`
		Response       string    `json:"response"`
		Usage          *agyUsage `json:"usage"`
		// Con un estado distinto de SUCCESS el CLI suele explicar por qué.
		Error   json.RawMessage `json:"error"`
		Message string          `json:"message"`
		// DeniedActions: formato NO documentado. Se acepta un arreglo de
		// textos o de objetos (o un solo valor) y de cada uno se saca algo
		// legible; ver deniedActionNames.
		DeniedActions json.RawMessage `json:"denied_actions"`
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

// agyTurn es el estado de un turno de Antigravity.
type agyTurn struct {
	sawText bool
	// server es el nombre extra con el que el CLI tiene registrado mini-tools
	// (Turn.MCPServer); "mini-tools" se acepta siempre.
	server string
	// tools: índice de paso → nombre real de la herramienta que se mostró.
	tools map[int]string
}

// newAntigravityTurn es el adaptador de un turno.
func newAntigravityTurn(t Turn) (adapter, finisher) {
	st := &agyTurn{server: strings.TrimSpace(t.MCPServer), tools: map[int]string{}}
	return func(line []byte) []Event { return agyEvents(line, st) }, nil
}

func (st *agyTurn) isMiniTools(server string) bool {
	server = strings.TrimSpace(server)
	if server == "" {
		return false
	}
	return strings.EqualFold(server, defaultMCPServer) || (st.server != "" && strings.EqualFold(server, st.server))
}

// agyMCPCall es el nombre con que Antigravity llama a TODA herramienta de un
// servidor MCP: el paso es siempre `call_mcp_tool` y la herramienta de verdad
// viaja en sus argumentos (`ServerName`, `ToolName`, `Arguments`).
const agyMCPCall = "call_mcp_tool"

// unwrapMCP vuelve la llamada genérica la herramienta que es, si es de
// mini-tools: `call_mcp_tool{ServerName: mini-tools, ToolName: db_get_schema}`
// se muestra como `db_get_schema` con sus `Arguments` de entrada, igual que
// `mcp__mini-tools__db_get_schema` en Claude Code. Las llamadas a OTROS
// servidores se dejan como llegan.
func (st *agyTurn) unwrapMCP(input any) (tool, args string, ok bool) {
	m, isMap := input.(map[string]any)
	if !isMap {
		return "", "", false
	}
	var server string
	var inner any
	for k, v := range m {
		switch strings.ToLower(k) {
		case "servername", "server_name":
			server, _ = v.(string)
		case "toolname", "tool_name":
			tool, _ = v.(string)
		case "arguments", "args":
			inner = v
		}
	}
	if tool == "" || !st.isMiniTools(server) {
		return "", "", false
	}
	return tool, rawJSON(inner), true
}

// agyStepDetailKeys son, en orden de preferencia, los campos de un paso donde
// Antigravity puede dejar el detalle de una herramienta que falló (o su salida).
// El formato no está documentado: se prueban los nombres que usa y, si ninguno
// aparece, se junta lo que haya.
var agyStepDetailKeys = []string{"tool_info", "error", "error_message", "error_text", "message", "stderr", "output", "tool_output", "result", "stdout", "detail", "details", "status_message", "reason"}

// agyStepKnownKeys son los campos de un paso que NO son detalle.
var agyStepKnownKeys = map[string]bool{
	"conversation_id": true, "step_index": true, "step_type": true, "state": true, "tool_name": true,
	"tool_input": true, "usage": true, "text_delta": true, "duration_seconds": true,
}

// agyStepDetail saca de un paso (JSON crudo) el texto que explica por qué falló.
// Vacío si el CLI no dijo nada.
func agyStepDetail(raw map[string]json.RawMessage) string {
	for _, k := range agyStepDetailKeys {
		if v, ok := raw[k]; ok {
			if t := strings.TrimSpace(agyValueText(v)); t != "" {
				return t
			}
		}
	}
	// Ningún nombre conocido: lo que haya en el paso, clave por clave, antes que
	// nada — un campo nuevo del CLI no puede esconder el motivo.
	var parts []string
	for k, v := range raw {
		if agyStepKnownKeys[k] {
			continue
		}
		if t := strings.TrimSpace(agyValueText(v)); t != "" {
			parts = append(parts, k+": "+t)
		}
	}
	sort.Strings(parts)
	return strings.Join(parts, "\n")
}

// agyValueText vuelve texto un valor JSON: una cadena tal cual; un objeto con
// `message` / `text` / `output`, ese campo; cualquier otra cosa, su JSON.
func agyValueText(raw json.RawMessage) string {
	raw = json.RawMessage(strings.TrimSpace(string(raw)))
	if len(raw) == 0 || string(raw) == "null" || string(raw) == "false" || string(raw) == "true" {
		return ""
	}
	switch raw[0] {
	case '"':
		var s string
		if json.Unmarshal(raw, &s) == nil {
			return s
		}
	case '{':
		var obj map[string]json.RawMessage
		if json.Unmarshal(raw, &obj) == nil {
			for _, k := range []string{"message", "text", "output", "error", "stderr", "stdout"} {
				if v, ok := obj[k]; ok {
					if t := strings.TrimSpace(agyValueText(v)); t != "" {
						return t
					}
				}
			}
		}
	}
	return string(raw)
}

// agyFailedDetail lee el detalle de un `step_update` que terminó mal.
func agyFailedDetail(line []byte) string {
	var env struct {
		StepUpdate map[string]json.RawMessage `json:"step_update"`
	}
	if json.Unmarshal(line, &env) != nil {
		return ""
	}
	return agyStepDetail(env.StepUpdate)
}

// deniedActionNames saca algo legible de `result.denied_actions`. Su formato no
// está documentado: puede ser un arreglo de textos, de objetos, o un solo
// valor, así que de cada elemento se toma el primer campo que parezca un nombre
// y, si no hay, su JSON.
func deniedActionNames(raw json.RawMessage) []string {
	raw = json.RawMessage(strings.TrimSpace(string(raw)))
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var items []json.RawMessage
	if raw[0] == '[' {
		if json.Unmarshal(raw, &items) != nil {
			return nil
		}
	} else {
		items = []json.RawMessage{raw}
	}
	var out []string
	for _, it := range items {
		if name := deniedActionName(it); name != "" {
			out = append(out, name)
		}
	}
	return out
}

var deniedActionKeys = []string{"tool_name", "toolName", "ToolName", "tool", "name", "action", "command", "description", "message", "reason"}

func deniedActionName(raw json.RawMessage) string {
	raw = json.RawMessage(strings.TrimSpace(string(raw)))
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	switch raw[0] {
	case '"':
		var s string
		if json.Unmarshal(raw, &s) == nil {
			return strings.TrimSpace(s)
		}
	case '{':
		var obj map[string]json.RawMessage
		if json.Unmarshal(raw, &obj) == nil {
			for _, k := range deniedActionKeys {
				if v, ok := obj[k]; ok {
					if t := strings.TrimSpace(agyValueText(v)); t != "" {
						return t
					}
				}
			}
		}
	}
	return string(raw)
}

func agyEvents(line []byte, st *agyTurn) []Event {
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
			if delta := jsonRawString(s.TextDelta); delta != "" {
				if strings.TrimSpace(delta) != "" {
					st.sawText = true
				}
				return []Event{{Kind: KindText, Text: delta}}
			}
		case "user_input", "checkpoint", "unknown":
			// Pasos internos: no son nada que mostrar.
			return nil
		default:
			// Cualquier otro step_type con nombre de herramienta se muestra
			// como llamada. Se toma el step_type como nombre cuando no hay uno
			// explícito: es preferible mostrar "algo pasó y se llamaba así" a
			// tragarse la acción entera.
			switch s.State {
			case "ACTIVE":
				name := firstNonEmpty(s.ToolName, s.StepType)
				input := rawJSON(s.ToolInput)
				if name == agyMCPCall {
					if tool, args, ok := st.unwrapMCP(s.ToolInput); ok {
						name, input = tool, args
					}
				}
				st.tools[s.StepIndex] = name
				return []Event{{Kind: KindTool, Tool: newToolCall(name, input)}}
			case "ERROR", "FAILED", "CANCELLED":
				// Un paso que falla por un rechazo de permiso es lo que
				// explica un turno sin respuesta; cualquier otro fallo de
				// herramienta no se registra acá (la tarjeta ya se mostró).
				detail := agyFailedDetail(line)
				if !isPermissionDenial(detail) {
					return nil
				}
				name := firstNonEmpty(mcpNameInText(detail), st.tools[s.StepIndex], s.ToolName, s.StepType)
				return []Event{denied(name)}
			}
		}
		return nil

	case l.Result != nil:
		r := l.Result
		u := r.Usage.common()
		var out []Event
		for _, name := range deniedActionNames(r.DeniedActions) {
			out = append(out, denied(name))
		}
		if r.Status != "" && r.Status != "SUCCESS" {
			msg := i18n.T(i18n.Msg{ES: "el agente terminó con estado %s", EN: "the agent finished with status %s"}, r.Status)
			if why := strings.TrimSpace(firstNonEmpty(agyValueText(r.Error), r.Message)); why != "" {
				msg += ": " + why
			}
			return append(out, Event{Kind: KindError, Error: msg, Usage: u, ConversationID: r.ConversationID})
		}
		if !st.sawText && strings.TrimSpace(r.Response) != "" {
			out = append(out, Event{Kind: KindText, Text: r.Response})
		}
		return append(out, Event{Kind: KindDone, Usage: u, ConversationID: r.ConversationID})
	}
	return nil
}
