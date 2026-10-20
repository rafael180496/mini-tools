package agentchat

import (
	"context"
	"encoding/json"
	"os/exec"
	"sort"
	"strings"
	"time"

	"mini-tools/backend/agents"
	"mini-tools/backend/i18n"
)

// --- OpenCode -------------------------------------------------------------
//
// `opencode run --format json`, verificado contra corridas reales de la
// versión 2.0.22 guardadas en testdata/opencode-*.jsonl. Es el cuarto formato:
// una línea por evento con `type` en `step_start|text|reasoning|tool_use|
// step_finish|error`, el `sessionID` en todas, y lo que pasó dentro de `part`.
//
// Tres cosas que lo distinguen de los otros y que explican este archivo:
//
//   - **No cierra el turno.** El `step_finish` del ÚLTIMO paso no se emite: la
//     salida termina en el `text` de la respuesta y el proceso sale con 0. Por
//     eso este adaptador tiene estado y un cierre (finisher) que corre cuando
//     el proceso terminó bien; sin él, el chat quedaría "escribiendo" para
//     siempre.
//   - **El uso se lee de la sesión, no del stream.** Sumar los `step_finish`
//     daría un total sin el último paso —que en una respuesta sin herramientas
//     es el único—, y un número parcial rotulado como total es peor que no
//     darlo. `opencode session export` trae los tokens y el modelo de cada
//     mensaje, el último incluido.
//   - **No hay un modo "solo lectura" por bandera.** Por defecto actúa: edita
//     archivos y corre comandos sin preguntar. El modo se arma con su agente
//     `plan` (no edita) y con su configuración de permisos por entorno — ver
//     opencodeEnv y buildArgs.

// opencodeLine es una línea del stream. Solo los campos que se usan.
type opencodeLine struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionID"`
	Part      struct {
		Text  string `json:"text"`
		Tool  string `json:"tool"`
		State struct {
			Status string          `json:"status"`
			Input  json.RawMessage `json:"input"`
		} `json:"state"`
	} `json:"part"`
	Error *struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}

// opencodeTurn es el estado de UN turno: qué sesión se abrió (para encadenar
// y para leer el uso al final) y si el CLI ya informó un error.
type opencodeTurn struct {
	// mcpPrefix es `<servidor>_` de mini-tools: OpenCode nombra una
	// herramienta MCP `mini-tools_db_get_schema`, y sin quitarlo la tarjeta se
	// vería distinta de la misma herramienta con Claude o un servidor.
	mcpPrefix string
	session   string
	started   bool
	failed    bool
}

func newOpencodeTurn() (adapter, finisher) { return newOpencodeTurnFor(defaultMCPServer) }

// newOpencodeTurnFor es el adaptador de un turno con el nombre con que el CLI
// tiene registrado al servidor de mini-tools.
func newOpencodeTurnFor(server string) (adapter, finisher) {
	o := &opencodeTurn{mcpPrefix: mcpSafeName(server) + "_"}
	return o.line, o.finish
}

func (o *opencodeTurn) line(raw []byte) []Event {
	var l opencodeLine
	if err := json.Unmarshal(raw, &l); err != nil {
		return nil
	}
	if l.SessionID != "" {
		o.session = l.SessionID
	}

	var out []Event
	// El primer evento con sesión abre el turno: es el id que permite retomar
	// la conversación (`--session`). Un solo start por turno, aunque haya un
	// step_start por cada vuelta del modelo.
	if !o.started && o.session != "" && l.Type != "error" {
		o.started = true
		out = append(out, Event{Kind: KindStart, ConversationID: o.session})
	}

	switch l.Type {
	case "text":
		if l.Part.Text != "" {
			out = append(out, Event{Kind: KindText, Text: l.Part.Text})
		}
	case "reasoning":
		if l.Part.Text != "" {
			out = append(out, Event{Kind: KindThinking, Text: l.Part.Text})
		}
	case "tool_use":
		// Llega UNA vez por llamada, ya resuelta (completed o error): no hay
		// un started aparte que deduplicar.
		out = append(out, Event{Kind: KindTool, Tool: newToolCall(strings.TrimPrefix(l.Part.Tool, o.mcpPrefix), string(l.Part.State.Input))})
	case "error":
		o.failed = true
		msg := i18n.T(msgAgentFailed)
		if l.Error != nil && l.Error.Message != "" {
			msg = l.Error.Message
		}
		out = append(out, Event{Kind: KindError, Error: msg, ConversationID: l.SessionID})
	}
	return out
}

// opencodeExportTimeout acota la lectura del uso. Es un proceso local que
// tarda menos de un segundo; si tarda más, el turno cierra sin uso en vez de
// dejar el chat esperando.
const opencodeExportTimeout = 15 * time.Second

// finish cierra el turno con el uso real de la sesión.
func (o *opencodeTurn) finish(t Turn) []Event {
	if o.failed {
		return nil
	}
	done := Event{Kind: KindDone, ConversationID: o.session}
	if o.session != "" {
		done.Usage = opencodeTurnUsage(t, o.session)
	}
	return []Event{done}
}

// opencodeTurnUsage lee la sesión exportada y suma los mensajes del asistente
// posteriores al último mensaje del usuario: eso es ESTE turno, aunque la
// sesión venga de antes. nil = no se pudo saber (no "cero tokens").
func opencodeTurnUsage(t Turn, session string) *Usage {
	argv := opencodeArgv(t)
	if len(argv) == 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), opencodeExportTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], append(argv[1:], "session", "export", session, "--standalone")...)
	cmd.Dir = t.Cwd
	cmd.Env = append(append([]string{}, t.Env...), opencodeEnv(t.Cwd, "", nil)...)
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	return opencodeUsageFromExport(out)
}

// opencodeArgv es el ejecutable sin los argumentos fijos que el usuario haya
// puesto en el comando: esos son para `run`, no para los otros subcomandos.
func opencodeArgv(t Turn) []string {
	if len(t.Exec) > 0 {
		return t.Exec
	}
	if base := strings.Fields(t.Command); len(base) > 0 {
		return base[:1]
	}
	return nil
}

type opencodeTokens struct {
	Input     int64 `json:"input"`
	Output    int64 `json:"output"`
	Reasoning int64 `json:"reasoning"`
	Cache     struct {
		Read  int64 `json:"read"`
		Write int64 `json:"write"`
	} `json:"cache"`
}

func opencodeUsageFromExport(raw []byte) *Usage {
	var doc struct {
		Messages []struct {
			Type  string `json:"type"`
			Model struct {
				ID         string `json:"id"`
				ProviderID string `json:"providerID"`
			} `json:"model"`
			Cost   float64         `json:"cost"`
			Tokens *opencodeTokens `json:"tokens"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil
	}

	from := 0
	for i, m := range doc.Messages {
		if m.Type == "user" {
			from = i + 1
		}
	}
	var u Usage
	seen := false
	for _, m := range doc.Messages[from:] {
		if m.Type != "assistant" || m.Tokens == nil {
			continue
		}
		seen = true
		// `input` NO incluye lo leído de la caché (se comprobó: input + cache.read
		// es el prompt entero). Lo escrito en caché se suma a la entrada, igual
		// que en Claude Code, para que los números de los agentes se comparen.
		u.Input += m.Tokens.Input + m.Tokens.Cache.Write
		u.CacheWrite += m.Tokens.Cache.Write
		u.Output += m.Tokens.Output
		u.CacheRead += m.Tokens.Cache.Read
		u.Thinking += m.Tokens.Reasoning
		u.CostUSD += m.Cost
		if m.Model.ID != "" {
			u.Model = m.Model.ID
			if m.Model.ProviderID != "" {
				u.Model = m.Model.ProviderID + "/" + m.Model.ID
			}
		}
	}
	if !seen {
		return nil
	}
	u.Total = u.Input + u.Output + u.CacheRead
	return &u
}

// opencodeConfig es la configuración que se le pasa a cada turno por
// OPENCODE_CONFIG_CONTENT, que OpenCode mezcla por encima de la del usuario.
//
// Le quita la herramienta de comandos (`bash` en su configuración, `shell` en
// el stream) en TODOS los modos. Sin esto, su modo por defecto corre cualquier
// comando sin preguntar, y en headless no hay a quién preguntarle: es la misma
// línea que en los otros CLIs separa "edita el repositorio, se ve en el diff"
// de "hace cualquier cosa en la máquina" (ver buildArgs). Verificado: con
// esta configuración el modelo no recibe la herramienta.
//
// Además permite POR NOMBRE cada herramienta del servidor de mini-tools
// (`<servidor>_<herramienta>`): un `ask` global del usuario las dejaba
// esperando una respuesta que en headless nadie da. Sin comodines: una
// herramienta que el servidor no declara no queda habilitada.
//
// Requiere `--standalone`: el servicio en segundo plano de OpenCode ya
// arrancó con su propio entorno e ignora el de quien lo llama.
func opencodeConfig(server string, tools []string) string {
	perm := map[string]string{"bash": "deny"}
	if server = strings.TrimSpace(server); server == "" {
		server = defaultMCPServer
	}
	for _, tool := range tools {
		if tool = strings.TrimSpace(tool); tool != "" {
			perm[mcpSafeName(server)+"_"+mcpSafeName(tool)] = "allow"
		}
	}
	b, err := json.Marshal(map[string]any{"permission": perm})
	if err != nil {
		return `{"permission":{"bash":"deny"}}`
	}
	return string(b)
}

// opencodeEnv suma además PWD: OpenCode toma el directorio de trabajo de esa
// variable y no del directorio real del proceso. Heredada de la app, apunta a
// donde se abrió mini-tools, y el agente lee rutas relativas —y lista las
// sesiones— de otro proyecto (se vio: «a.txt no existe» con el archivo ahí).
//
// server y tools son los del turno (Turn.MCPServer / Turn.MCPTools). Las
// lecturas que no corren un turno (listar y exportar sesiones) pasan nil: ahí
// basta con el `bash: deny`.
func opencodeEnv(cwd, server string, tools []string) []string {
	env := []string{"OPENCODE_CONFIG_CONTENT=" + opencodeConfig(server, tools)}
	if cwd != "" {
		env = append(env, "PWD="+cwd)
	}
	return env
}

// --- Conversaciones --------------------------------------------------------

// opencodeListTimeout acota el listado: es una lectura de su base local.
const opencodeListTimeout = 10 * time.Second

// opencodeConversations le pide al CLI las sesiones del proyecto. Las guarda
// en una base SQLite propia; leerla directo sería atarse a su esquema, y
// `session list --format json` es la interfaz que el CLI publica para eso.
func opencodeConversations(repoRoot string) ([]Conversation, error) {
	bin := agents.Resolve("opencode")
	if bin == "" {
		return nil, nil
	}
	argv := agents.Launcher(bin)
	ctx, cancel := context.WithTimeout(context.Background(), opencodeListTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], append(argv[1:], "session", "list", "--format", "json", "--standalone")...)
	cmd.Dir = repoRoot
	cmd.Env = agents.Env(opencodeEnv(repoRoot, "", nil)...)
	out, err := cmd.Output()
	if err != nil {
		// Un CLI que no puede listar no impide abrir un chat nuevo.
		return nil, nil
	}
	return parseOpencodeSessions(out), nil
}

func parseOpencodeSessions(raw []byte) []Conversation {
	var rows []struct {
		ID      string `json:"id"`
		Title   string `json:"title"`
		Updated int64  `json:"updated"`
	}
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil
	}
	out := make([]Conversation, 0, len(rows))
	for _, r := range rows {
		// Una sesión sin título no llegó a tener un primer mensaje: sería una
		// fila que no se puede reconocer.
		title := strings.TrimSpace(r.Title)
		if r.ID == "" || title == "" {
			continue
		}
		if len([]rune(title)) > titleLimit {
			title = string([]rune(title)[:titleLimit]) + "…"
		}
		// `updated` viene en milisegundos.
		out = append(out, Conversation{ID: r.ID, Agent: "opencode", Title: title, UpdatedAt: r.Updated / 1000})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].UpdatedAt > out[j].UpdatedAt })
	return out
}
