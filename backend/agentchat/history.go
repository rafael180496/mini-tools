package agentchat

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Recuperar los mensajes de una conversación anterior, para que al retomar un
// chat el panel no arranque vacío.
//
// # Qué se puede y qué no, por agente
//
// Se revisó dónde guarda cada uno sus mensajes. **No sale igual para los
// tres**, y eso es parte del contrato de esta función:
//
//   - **Claude Code**: `~/.claude/projects/<slug>/<sesión>.jsonl`, una línea
//     por evento con el contenido. Se lee entero y sin ambigüedad.
//   - **Codex**: `~/.codex/sessions/AAAA/MM/DD/rollout-*-<hilo>.jsonl`. Se lee,
//     pero mezcla mensajes INYECTADOS con rol `user` y `developer` (el prompt
//     de sistema, la lista de plugins recomendados) junto al mensaje real de la
//     persona, sin ningún campo que los distinga — se comprobó: comparten hasta
//     el `internal_chat_message_metadata_passthrough`. La única vía es mirar el
//     texto, y eso es una heurística; ver injectedMessage.
//   - **Antigravity**: la tabla `steps` de su SQLite guarda blobs protobuf que
//     sin el esquema no se pueden leer de forma honesta, y por eso esto
//     devolvía vacío. Pero el CLI escribe ADEMÁS un transcript en JSONL —
//     `brain/<conversación>/.system_generated/logs/transcript_full.jsonl`, la
//     misma ruta que sus propios pasos referencian—, con un objeto por paso y
//     el contenido en claro. Se lee de ahí; ver antigravityHistory.
//
// Lo que se devuelve es SOLO para volver a dibujar lo que ya pasó. El historial
// real lo sigue teniendo el CLI: esta app no lo reescribe ni lo usa para
// encadenar — eso lo hace el id de conversación.

// PastTurn es un turno recuperado de un transcript.
type PastTurn struct {
	// Role es "user" o "agent".
	Role  string     `json:"role"`
	Text  string     `json:"text"`
	Tools []ToolCall `json:"tools"`
}

// History devuelve los turnos de una conversación anterior.
//
// Una conversación que no se encuentra NO es un error: puede haberse borrado
// desde el propio CLI, o ser de un agente cuyo formato no se puede leer. En
// los dos casos el chat abre vacío y sigue funcionando, que es mejor que
// negarse a abrirlo.
func History(agentID, conversationID string) ([]PastTurn, error) {
	if conversationID == "" {
		return nil, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}

	switch agentID {
	case "claude":
		return claudeHistory(home, conversationID)
	case "codex":
		return codexHistory(home, conversationID)
	case "antigravity":
		return antigravityHistory(home, conversationID)
	}
	// Cualquier agente futuro sin lector: vacío, sin error.
	return nil, nil
}

// --- Claude Code ----------------------------------------------------------

func claudeHistory(home, sessionID string) ([]PastTurn, error) {
	// El archivo se llama como la sesión. Se busca en TODOS los proyectos y no
	// solo en el del repositorio abierto: una conversación puede haber
	// empezado con otro directorio de trabajo, y no encontrarla por eso sería
	// un vacío inexplicable.
	matches, _ := filepath.Glob(filepath.Join(home, ".claude", "projects", "*", sessionID+".jsonl"))
	if len(matches) == 0 {
		return nil, nil
	}

	f, err := os.Open(matches[0])
	if err != nil {
		return nil, nil
	}
	defer f.Close()

	var out []PastTurn
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), maxLineBytes)

	for sc.Scan() {
		var e struct {
			Type    string `json:"type"`
			Message struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if err := json.Unmarshal(sc.Bytes(), &e); err != nil {
			continue
		}
		switch e.Type {
		case "user":
			// El contenido de un mensaje del usuario puede ser un string suelto
			// o una lista de bloques; los resultados de herramientas llegan
			// como bloques y NO son algo que la persona escribió.
			if text := plainText(e.Message.Content); text != "" {
				out = append(out, PastTurn{Role: "user", Text: text})
			}
		case "assistant":
			turn := assistantTurn(e.Message.Content)
			if turn.Text != "" || len(turn.Tools) > 0 {
				out = append(out, turn)
			}
		}
	}
	return merge(out), sc.Err()
}

// plainText saca el texto de un contenido que puede ser un string o una lista
// de bloques. Devuelve "" si lo único que hay son bloques que no son texto
// (un resultado de herramienta, una imagen).
func plainText(raw json.RawMessage) string {
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return strings.TrimSpace(s)
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return ""
	}
	var b strings.Builder
	for _, blk := range blocks {
		if blk.Type == "text" {
			b.WriteString(blk.Text)
		}
	}
	return strings.TrimSpace(b.String())
}

func assistantTurn(raw json.RawMessage) PastTurn {
	turn := PastTurn{Role: "agent"}
	var blocks []struct {
		Type  string          `json:"type"`
		Text  string          `json:"text"`
		Name  string          `json:"name"`
		Input json.RawMessage `json:"input"`
	}
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return turn
	}
	for _, b := range blocks {
		switch b.Type {
		case "text":
			turn.Text += b.Text
		case "tool_use":
			turn.Tools = append(turn.Tools, *newToolCall(b.Name, string(b.Input)))
		}
	}
	turn.Text = strings.TrimSpace(turn.Text)
	return turn
}

// --- Codex ----------------------------------------------------------------

func codexHistory(home, threadID string) ([]PastTurn, error) {
	// El nombre del rollout lleva la fecha y el id del hilo, y está anidado por
	// año/mes/día. Se busca por sufijo en vez de reconstruir la fecha: el id es
	// lo único que se sabe con certeza.
	matches, _ := filepath.Glob(filepath.Join(home, ".codex", "sessions", "*", "*", "*", "rollout-*"+threadID+".jsonl"))
	if len(matches) == 0 {
		return nil, nil
	}

	f, err := os.Open(matches[0])
	if err != nil {
		return nil, nil
	}
	defer f.Close()

	var out []PastTurn
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), maxLineBytes)

	for sc.Scan() {
		var e struct {
			Type    string `json:"type"`
			Payload struct {
				Type    string `json:"type"`
				Role    string `json:"role"`
				Name    string `json:"name"`
				Input   string `json:"input"`
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(sc.Bytes(), &e); err != nil || e.Type != "response_item" {
			continue
		}

		switch e.Payload.Type {
		case "message":
			// `developer` es siempre prompt de sistema.
			if e.Payload.Role == "developer" {
				continue
			}
			var b strings.Builder
			for _, c := range e.Payload.Content {
				b.WriteString(c.Text)
			}
			text := strings.TrimSpace(b.String())
			if text == "" || injectedMessage(text) {
				continue
			}
			role := "agent"
			if e.Payload.Role == "user" {
				role = "user"
			}
			out = append(out, PastTurn{Role: role, Text: text})

		case "custom_tool_call":
			out = append(out, PastTurn{Role: "agent", Tools: []ToolCall{*newToolCall(e.Payload.Name, e.Payload.Input)}})
		}
	}
	return merge(out), sc.Err()
}

// --- Antigravity ----------------------------------------------------------

// antigravityBrain es donde el CLI deja el rastro LEGIBLE de cada
// conversación, una carpeta por id. Cuelga de ~/.gemini y no de ~/.antigravity
// —el binario se llama `agy` pero su estado vive ahí—, igual que el directorio
// que ya lee el panel de consumo.
const antigravityBrain = ".gemini/antigravity-cli/brain"

// antigravityHistory lee el transcript en JSONL de una conversación.
//
// # Por qué no se leen los blobs del SQLite
//
// La tabla `steps` de `conversations/<id>.db` guarda cada paso como protobuf
// sin esquema publicado. Pero uno de esos pasos referencia una ruta propia —
// `.../logs/transcript.jsonl`— y ahí está lo mismo en claro: un objeto por
// paso con `source`, `type` y `content`. Es la fuente que el propio CLI
// declara, así que se lee esa en vez de adivinar campos de un binario.
//
// Se prefiere `transcript_full.jsonl`: es el mismo archivo con el contenido
// SIN recortar (`transcript.jsonl` acorta los mensajes largos, que es
// justamente lo que uno vuelve a buscar al retomar un chat).
//
// # Qué se muestra
//
//   - `USER_EXPLICIT` → lo que escribió la persona. El CLI lo envuelve en
//     `<USER_REQUEST>` y le agrega bloques suyos detrás (la hora local, el
//     cambio de modelo); se toma SOLO lo de adentro del envoltorio. A
//     diferencia de Codex acá no hace falta heurística: el límite es
//     estructural.
//   - `MODEL` + `PLANNER_RESPONSE` → la respuesta del agente.
//   - `MODEL` + cualquier otro tipo → una llamada a herramienta, con el tipo
//     como nombre (en minúsculas, igual que la vista en vivo, que lo toma del
//     `step_type` del stream).
//   - `SYSTEM` → nada: son los checkpoints, los resúmenes de contexto y los
//     avisos del servidor. Dibujarlos sería llenar el panel de cosas que la
//     conversación no tuvo.
func antigravityHistory(home, conversationID string) ([]PastTurn, error) {
	// El id viene del CLI, pero termina en un filepath.Join: un id con
	// separadores o `..` saldría de la carpeta de conversaciones.
	if conversationID != filepath.Base(conversationID) || strings.ContainsAny(conversationID, `/\`) {
		return nil, nil
	}
	dir := filepath.Join(home, filepath.FromSlash(antigravityBrain), conversationID, ".system_generated", "logs")

	f, err := os.Open(filepath.Join(dir, "transcript_full.jsonl"))
	if err != nil {
		if f, err = os.Open(filepath.Join(dir, "transcript.jsonl")); err != nil {
			// Sin transcript no hay nada que dibujar, y eso no es un error: la
			// conversación sigue encadenando por su id.
			return nil, nil
		}
	}
	defer f.Close()

	var out []PastTurn
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), maxLineBytes)

	for sc.Scan() {
		var e struct {
			Source  string `json:"source"`
			Type    string `json:"type"`
			Content string `json:"content"`
		}
		if err := json.Unmarshal(sc.Bytes(), &e); err != nil {
			continue
		}
		switch e.Source {
		case "USER_EXPLICIT":
			if text := userRequestBlock(e.Content); text != "" {
				out = append(out, PastTurn{Role: "user", Text: text})
			}
		case "MODEL":
			if e.Type == "PLANNER_RESPONSE" {
				if text := strings.TrimSpace(e.Content); text != "" {
					out = append(out, PastTurn{Role: "agent", Text: text})
				}
				continue
			}
			// El contenido de una herramienta es su salida entera —un archivo
			// completo en VIEW_FILE—, así que NO va como argumento: se le saca
			// la línea que dice sobre qué actuó y el resto se descarta. Lo que
			// se quiere ver al releer es "acá miró tal archivo".
			out = append(out, PastTurn{
				Role:  "agent",
				Tools: []ToolCall{{Name: strings.ToLower(e.Type), Summary: antigravityToolTarget(e.Content)}},
			})
		}
		// SYSTEM y cualquier origen desconocido: no se dibujan.
	}
	return merge(out), sc.Err()
}

// userRequestBlock devuelve lo que la persona escribió de verdad.
//
// El CLI arma el mensaje como `<USER_REQUEST>…</USER_REQUEST>` seguido de sus
// propios bloques (`<ADDITIONAL_METADATA>` con la hora local,
// `<USER_SETTINGS_CHANGE>` cuando se cambió de modelo). Sin recortar, cada
// mensaje del historial arrastraría ese ruido.
//
// Un contenido sin el envoltorio se devuelve tal cual: si el formato cambia,
// mostrar de más es mejor que mostrar nada.
func userRequestBlock(content string) string {
	const openTag, closeTag = "<USER_REQUEST>", "</USER_REQUEST>"
	i := strings.Index(content, openTag)
	if i < 0 {
		return strings.TrimSpace(content)
	}
	rest := content[i+len(openTag):]
	if j := strings.Index(rest, closeTag); j >= 0 {
		rest = rest[:j]
	}
	return strings.TrimSpace(rest)
}

// antigravityToolTarget saca sobre qué actuó una herramienta.
//
// Su contenido arranca con un encabezado de líneas `Clave: valor` antes de la
// salida propiamente dicha; `File Path` es la que dice qué se tocó. Se mira
// solo ese encabezado —no el archivo entero, que puede tener miles de líneas—
// y se devuelve vacío cuando no está, que la UI ya sabe mostrar (queda el
// nombre de la herramienta, que sigue siendo mejor que nada).
func antigravityToolTarget(content string) string {
	for _, line := range strings.SplitN(content, "\n", antigravityHeaderLines+1) {
		v, ok := strings.CutPrefix(line, "File Path:")
		if !ok {
			continue
		}
		v = strings.Trim(strings.TrimSpace(v), "`")
		return strings.TrimPrefix(v, "file://")
	}
	return ""
}

// antigravityHeaderLines es hasta dónde se busca el encabezado. Un tope y no
// el archivo entero: pasado eso ya es la salida de la herramienta, y una línea
// del contenido que dijera `File Path:` no sería el encabezado.
const antigravityHeaderLines = 10

// tagPrefix reconoce un mensaje que empieza con una etiqueta, como
// `<recommended_plugins>` o `<skills_instructions>`.
var tagPrefix = regexp.MustCompile(`^<[a-z_]+>`)

// injectedMessage decide si un mensaje con rol `user` lo escribió la persona o
// se lo inyectó el CLI.
//
// **Es una heurística, y se documenta como tal.** Se comprobó en transcripts
// reales que los mensajes inyectados y los del usuario comparten TODOS sus
// campos —incluido el metadata interno—, así que no hay forma estructural de
// distinguirlos: lo único que los separa es que los inyectados empiezan con una
// etiqueta.
//
// Modo de fallo, dicho para que nadie se sorprenda: un mensaje que la persona
// empiece literalmente con `<algo>` no se va a mostrar en el historial. Es raro
// y no pierde nada —el mensaje sigue en el transcript del CLI y la conversación
// continúa igual—, mientras que la alternativa es llenar el panel con el prompt
// de sistema en cada chat que se retoma.
func injectedMessage(text string) bool {
	return tagPrefix.MatchString(text)
}

// merge junta turnos consecutivos del mismo lado.
//
// Los transcripts parten un turno del agente en varios eventos (texto, una
// herramienta, más texto), y dibujar cada uno como una burbuja aparte
// mostraría una conversación que no se parece a la que pasó.
func merge(turns []PastTurn) []PastTurn {
	if len(turns) == 0 {
		return nil
	}
	out := []PastTurn{turns[0]}
	for _, t := range turns[1:] {
		last := &out[len(out)-1]
		if last.Role != t.Role {
			out = append(out, t)
			continue
		}
		if t.Text != "" {
			if last.Text != "" {
				last.Text += "\n"
			}
			last.Text += t.Text
		}
		last.Tools = append(last.Tools, t.Tools...)
	}
	return out
}
