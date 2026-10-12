package agentchat

import (
	"strings"
	"unicode/utf8"

	"mini-tools/backend/llm"
)

// Registro de lo que pasó en un turno, para guardarlo en el historial.
//
// El Manager no conoce el vault: emite eventos y nada más. Quien los guarda
// (App) los pasa por un TurnRecorder, que los acumula y, cuando el turno
// termina, entrega las filas que hay que escribir. Vive acá y no en App porque
// es lógica pura sobre Event y se prueba sin Wails ni base.

// ErrorRowPrefix marca las filas de historial que son un error y no una
// respuesta. Se guarda como una fila `assistant` cuyo contenido empieza con
// esto, para que el historial lo muestre en el lugar donde ocurrió; el
// frontend lo reconoce por el prefijo y el contexto de un modelo lo descarta.
const ErrorRowPrefix = "⚠ "

// RecordedMessage es una fila lista para guardar.
type RecordedMessage struct {
	// Role es "tool" o "assistant". La fila del usuario no sale de acá: la
	// arma quien manda el mensaje.
	Role string
	// Content: para una herramienta, el resumen (primera línea) y el detalle
	// (segunda, si hay); para el asistente, el texto.
	Content  string
	ToolName string
	// Usage son los tokens del turno, en la última fila que lo cierra.
	Usage *Usage
	// Model es el modelo que anunció el evento start del turno; solo viaja
	// junto con Usage (la fila que cierra el turno), que es donde se guarda.
	Model string
}

// TurnRecorder acumula los eventos de UN turno.
type TurnRecorder struct {
	text  strings.Builder
	tools []ToolCall
	model string
}

// Feed consume un evento. Cuando el evento cierra el turno (done o error)
// devuelve las filas a guardar y true, y el recorder queda listo para otro
// turno; en cualquier otro caso devuelve nil y false.
//
// Orden de las filas: primero las herramientas, en el orden en que se
// llamaron, y al final el texto del asistente — es el mismo orden en que el
// chat dibuja un turno (la lista de herramientas y la respuesta debajo).
//
//   - done: herramientas + la respuesta. Si el turno solo llamó herramientas y
//     no escribió texto, no hay fila de asistente vacía: el uso va en la
//     última herramienta.
//   - error: lo que alcanzó a decir (texto parcial, herramientas) y, aparte,
//     una fila `assistant` con ErrorRowPrefix + el mensaje, que lleva el uso
//     si el CLI lo informó. Un turno cancelado por el usuario cae acá.
//
// El razonamiento (thinking) no se guarda: es ruido de trabajo, no parte de
// lo que se le dijo a la persona.
func (r *TurnRecorder) Feed(ev Event) ([]RecordedMessage, bool) {
	switch ev.Kind {
	case KindStart:
		// El modelo que de verdad contestó (un servidor de modelos resuelve
		// uno por su cuenta cuando el turno no trae ninguno).
		if ev.Model != "" {
			r.model = ev.Model
		}
		return nil, false
	case KindText:
		r.text.WriteString(ev.Text)
		return nil, false
	case KindTool:
		if ev.Tool != nil {
			r.tools = append(r.tools, *ev.Tool)
		}
		return nil, false
	case KindDone:
		return r.close(ev.Usage, ""), true
	case KindError:
		msg := strings.TrimSpace(ev.Error)
		if msg == "" {
			msg = "error"
		}
		return r.close(ev.Usage, msg), true
	}
	return nil, false
}

func (r *TurnRecorder) close(usage *Usage, errMsg string) []RecordedMessage {
	text := strings.TrimSpace(r.text.String())
	var out []RecordedMessage
	for _, t := range r.tools {
		out = append(out, RecordedMessage{Role: "tool", ToolName: t.Name, Content: toolRowContent(t)})
	}
	switch {
	case errMsg != "":
		if text != "" {
			out = append(out, RecordedMessage{Role: "assistant", Content: text})
		}
		out = append(out, RecordedMessage{Role: "assistant", Content: ErrorRowPrefix + errMsg, Usage: usage, Model: r.model})
	case text != "" || len(out) == 0:
		out = append(out, RecordedMessage{Role: "assistant", Content: text, Usage: usage, Model: r.model})
	default:
		out[len(out)-1].Usage = usage
		out[len(out)-1].Model = r.model
	}
	r.text.Reset()
	r.tools = nil
	r.model = ""
	return out
}

// toolRowContent es lo que se guarda de una herramienta: qué hizo (resumen) y,
// en una segunda línea, el efecto medible (detalle). Si el CLI no dio ninguno
// de los dos, el argumento recortado, que sigue siendo mejor que una fila
// muda. El resumen se aplana a una línea para poder separarlo del detalle al
// leerlo.
func toolRowContent(t ToolCall) string {
	summary := strings.Join(strings.Fields(t.Summary), " ")
	detail := strings.TrimSpace(t.Detail)
	if summary == "" && detail == "" {
		summary = strings.Join(strings.Fields(t.Input), " ")
		if utf8.RuneCountInString(summary) > 200 {
			summary = string([]rune(summary)[:200]) + "…"
		}
	}
	if detail == "" {
		return summary
	}
	return summary + "\n" + detail
}

// SplitToolRow es la inversa de toolRowContent: devuelve resumen y detalle.
func SplitToolRow(content string) (summary, detail string) {
	summary, detail, _ = strings.Cut(content, "\n")
	return summary, detail
}

// --- Contexto de un modelo desde el historial guardado ---------------------

// HistoryMessage es una fila guardada, en lo que le importa a SeedHistory.
type HistoryMessage struct {
	Role     string
	Content  string
	ToolName string
}

// SeedHistory arma los mensajes previos de un servidor de modelos a partir de
// las filas guardadas de un chat, para continuarlo después de reiniciar la
// app (el historial en memoria del Manager no sobrevive).
//
//   - Solo van el usuario y el asistente: las herramientas no se reenvían.
//   - Un turno que terminó en error se descarta entero (su mensaje del usuario
//     incluido), igual que hace el historial en memoria con un turno fallido.
//   - Se conservan los últimos maxMsgs mensajes y, como mucho, maxChars
//     caracteres, empezando siempre por un mensaje del usuario. Recortar por
//     tokens necesitaría un tokenizador por modelo; los caracteres son una
//     cota gruesa pero suficiente para no reventar el contexto.
//
// stored viene en orden cronológico. Lo que haya antes del primer mensaje del
// usuario (una ventana que cortó un turno por la mitad) se ignora.
func SeedHistory(stored []HistoryMessage, maxMsgs, maxChars int) []llm.Message {
	// 1. Partir en turnos que empiezan en cada mensaje del usuario.
	type turn struct {
		msgs   []llm.Message
		failed bool
	}
	var turns []*turn
	for _, m := range stored {
		switch m.Role {
		case "user":
			turns = append(turns, &turn{msgs: []llm.Message{{Role: llm.RoleUser, Content: m.Content}}})
		case "assistant":
			if len(turns) == 0 {
				continue
			}
			t := turns[len(turns)-1]
			if strings.HasPrefix(m.Content, ErrorRowPrefix) {
				t.failed = true
				continue
			}
			t.msgs = append(t.msgs, llm.Message{Role: llm.RoleAssistant, Content: m.Content})
		}
	}

	// 2. Quedarse con los turnos buenos, aplanados.
	var flat []llm.Message
	for _, t := range turns {
		if !t.failed {
			flat = append(flat, t.msgs...)
		}
	}

	// 3. Recortar por la cola: lo más reciente es lo que más importa.
	start := len(flat)
	used := 0
	for i := len(flat) - 1; i >= 0; i-- {
		n := utf8.RuneCountInString(flat[i].Content)
		if len(flat)-i > maxMsgs || (maxChars > 0 && used+n > maxChars) {
			break
		}
		used += n
		start = i
	}
	flat = flat[start:]
	for len(flat) > 0 && flat[0].Role != llm.RoleUser {
		flat = flat[1:]
	}
	return flat
}

// PastTurnsFromStored vuelve a armar, desde las filas guardadas, los turnos
// con la forma que ya dibuja el chat al retomar una conversación (PastTurn).
//
// Todo lo que hay entre dos mensajes del usuario es UN turno del agente: sus
// herramientas, su texto y, si falló, el error —que se muestra a continuación
// del texto parcial—, igual que lo dibuja el chat en vivo. Una herramienta
// guardada recupera el resumen y el detalle, pero no el argumento crudo.
func PastTurnsFromStored(stored []HistoryMessage) []PastTurn {
	out := []PastTurn{}
	var cur *PastTurn // turno del agente en construcción
	flush := func() {
		if cur != nil {
			out = append(out, *cur)
			cur = nil
		}
	}
	for _, m := range stored {
		switch m.Role {
		case "user":
			flush()
			out = append(out, PastTurn{Role: "user", Text: m.Content, Tools: []ToolCall{}})
		case "tool":
			if cur == nil {
				cur = &PastTurn{Role: "agent", Tools: []ToolCall{}}
			}
			summary, detail := SplitToolRow(m.Content)
			cur.Tools = append(cur.Tools, ToolCall{Name: m.ToolName, Summary: summary, Detail: detail})
		case "assistant":
			if cur == nil {
				cur = &PastTurn{Role: "agent", Tools: []ToolCall{}}
			}
			if cur.Text != "" {
				cur.Text += "\n\n"
			}
			cur.Text += m.Content
		}
	}
	flush()
	return out
}
