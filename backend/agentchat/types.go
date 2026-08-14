// Package agentchat corre un CLI agéntico en modo HEADLESS y traduce su
// salida a un solo tipo de evento, para poder dibujar un chat de verdad en vez
// de una terminal.
//
// # Por qué existe, y qué decisión enmienda
//
// El doc de backend/agents dice que un agente NO se integra por su API sino
// que se ejecuta como el programa de terminal que es, sobre el PTY de
// backend/localterm. Eso sigue siendo cierto y ese camino no se toca: es el
// que da la experiencia completa del CLI, con su propio diálogo de permisos y
// su render.
//
// Este paquete es un SEGUNDO camino, en paralelo, para lo que aquel no puede
// dar: un PTY entrega bytes con escapes ANSI, que se pueden mostrar pero no
// entender. No hay forma de saber desde ahí qué herramienta se llamó, con qué
// argumentos, cuántos tokens costó, ni de plegar una llamada. Todo eso sí
// existe en el modo headless que los CLIs ya exponen.
//
// # Lo que se verificó antes de escribir una línea
//
// Los formatos son de otros programas y cambian sin aviso, así que se
// capturaron corridas reales y quedaron como fixtures en testdata/:
//
//   - **Claude Code** (`claude -p --output-format stream-json --verbose`): una
//     línea JSON por evento, con `type` en `system|assistant|user|result|
//     rate_limit_event`. El `system/init` trae sesión, modelo, herramientas,
//     servidores MCP con su estado y los skills resueltos; el `assistant` trae
//     bloques de contenido al estilo de la API de Anthropic (`text`,
//     `tool_use`) y su `usage`; el `result` cierra con el uso total y el costo.
//   - **Antigravity** (`agy --print --output-format stream-json`): una línea
//     por evento con `event` en `init|step_update|result`. Los pasos llevan
//     `step_type` (`user_input`, `agent_response`, `checkpoint`…), `state`
//     (`ACTIVE`/`DONE`) y `text_delta` incremental; el uso de tokens viene en
//     el paso que termina y otra vez en el `result`.
//   - **Codex**: NO verificado, no está instalado. No se escribió su adaptador
//     — la misma regla que en backend/agentusage: un parser a ciegas sobre la
//     salida de otro programa produce algo que parece andar y está mal.
//
// # Multi-turno
//
// Cada turno es un proceso nuevo: los CLIs headless terminan cuando contestan.
// La continuidad la da el id de conversación que ellos mismos devuelven, que
// se guarda y se pasa en el turno siguiente (`--resume` en Claude Code,
// `--conversation` en Antigravity). No hay estado de conversación propio acá:
// duplicarlo sería inventar una segunda memoria que se desincroniza con la del
// CLI.
package agentchat

// EventKind es el vocabulario común al que se traducen los tres formatos. Es
// deliberadamente chico: lo que no se pueda expresar acá con honestidad, no se
// muestra en la UI.
type EventKind string

const (
	// KindStart abre el turno con lo que el CLI informa de sí mismo.
	KindStart EventKind = "start"
	// KindText es texto de la respuesta, incremental.
	KindText EventKind = "text"
	// KindThinking es razonamiento, cuando el CLI lo distingue del texto.
	KindThinking EventKind = "thinking"
	// KindTool es una llamada a herramienta.
	KindTool EventKind = "tool"
	// KindDone cierra el turno con el uso total.
	KindDone EventKind = "done"
	// KindError es un fallo del proceso o de la conversación.
	KindError EventKind = "error"
)

// Usage son los tokens de un turno. Los nombres son los del modelo común, no
// los de ningún CLI: cada adaptador traduce los suyos.
type Usage struct {
	Input     int64 `json:"input"`
	Output    int64 `json:"output"`
	CacheRead int64 `json:"cacheRead"`
	Thinking  int64 `json:"thinking"`
	Total     int64 `json:"total"`
	// CostUSD solo lo informa Claude Code; 0 significa "no lo dice", no
	// "gratis", y la UI tiene que distinguirlo.
	CostUSD float64 `json:"costUsd"`
}

// ToolCall es una llamada a herramienta ya normalizada.
type ToolCall struct {
	Name string `json:"name"`
	// Input es el argumento serializado, recortado: sirve para mostrar QUÉ
	// hizo, no para reejecutarlo.
	Input string `json:"input"`
	// Summary es una línea legible de lo que hizo — "src/app.go", "+18
	// líneas", el comando que corrió. Se deriva de las claves que los tres
	// CLIs usan para lo mismo (`file_path`, `command`, `pattern`…) en vez de
	// mantener una tabla por herramienta de cada agente, que quedaría vieja
	// con cada versión suya. Vacío cuando la herramienta no se reconoce: ahí
	// la UI muestra solo el nombre, que sigue siendo mejor que nada.
	Summary string `json:"summary"`
	// Detail es la segunda línea: el efecto medible cuando se puede calcular
	// (cuántas líneas escribe una edición). Vacío cuando no aplica.
	Detail string `json:"detail"`
}

// Event es lo que viaja al frontend, por el mismo contrato de evento por
// sesión que ya usan localterm y query (el nombre del evento de Wails es el id
// de la sesión).
type Event struct {
	Kind EventKind `json:"kind"`
	Text string    `json:"text"`
	Tool *ToolCall `json:"tool,omitempty"`
	// Usage viene en KindDone.
	Usage *Usage `json:"usage,omitempty"`
	// ConversationID es el id que devuelve el CLI, necesario para encadenar el
	// turno siguiente. Llega con KindStart o con KindDone según el agente.
	ConversationID string `json:"conversationId,omitempty"`
	// Model, Tools y MCPServers los informa el CLI al arrancar. Es SU visión,
	// no la que arma backend/agentctx leyendo archivos: incluye el estado real
	// de cada servidor MCP (conectado, sin autorizar).
	Model      string   `json:"model,omitempty"`
	Tools      []string `json:"tools,omitempty"`
	MCPServers []string `json:"mcpServers,omitempty"`
	// Error acompaña a KindError.
	Error string `json:"error,omitempty"`
}

// EmitFunc publica un evento hacia el frontend. Mismo tipo de indirección que
// localterm.EmitFunc: el paquete no conoce Wails.
type EmitFunc func(sessionID string, ev Event)
