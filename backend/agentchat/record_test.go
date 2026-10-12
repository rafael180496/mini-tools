package agentchat

import (
	"reflect"
	"strings"
	"testing"

	"mini-tools/backend/llm"
)

func feedAll(r *TurnRecorder, evs ...Event) (out []RecordedMessage, closed bool) {
	for _, ev := range evs {
		if msgs, c := r.Feed(ev); c {
			out, closed = msgs, true
		}
	}
	return
}

func TestTurnRecorderDone(t *testing.T) {
	var r TurnRecorder
	u := &Usage{Input: 10, Output: 5, Total: 15}
	msgs, closed := feedAll(&r,
		Event{Kind: KindStart, Model: "m"},
		Event{Kind: KindThinking, Text: "pienso"},
		Event{Kind: KindText, Text: "Voy a leer "},
		Event{Kind: KindTool, Tool: &ToolCall{Name: "Read", Summary: "src/app.go", Detail: "120 líneas", Input: `{"file_path":"src/app.go"}`}},
		Event{Kind: KindText, Text: "el archivo."},
		Event{Kind: KindDone, Usage: u},
	)
	if !closed || len(msgs) != 2 {
		t.Fatalf("closed=%v msgs=%+v", closed, msgs)
	}
	if msgs[0].Role != "tool" || msgs[0].ToolName != "Read" || msgs[0].Content != "src/app.go\n120 líneas" || msgs[0].Usage != nil {
		t.Fatalf("tool: %+v", msgs[0])
	}
	if msgs[1].Role != "assistant" || msgs[1].Content != "Voy a leer el archivo." || msgs[1].Usage != u {
		t.Fatalf("assistant: %+v", msgs[1])
	}

	// El recorder queda limpio para el turno siguiente.
	msgs, closed = feedAll(&r, Event{Kind: KindText, Text: "otro"}, Event{Kind: KindDone})
	if !closed || len(msgs) != 1 || msgs[0].Content != "otro" {
		t.Fatalf("segundo turno arrastró estado: %+v", msgs)
	}
}

func TestTurnRecorderOnlyToolsPutsUsageOnLastTool(t *testing.T) {
	var r TurnRecorder
	u := &Usage{Total: 3}
	msgs, _ := feedAll(&r,
		Event{Kind: KindTool, Tool: &ToolCall{Name: "A", Summary: "a"}},
		Event{Kind: KindTool, Tool: &ToolCall{Name: "B", Input: strings.Repeat("x ", 300)}},
		Event{Kind: KindDone, Usage: u},
	)
	if len(msgs) != 2 || msgs[0].Usage != nil || msgs[1].Usage != u {
		t.Fatalf("msgs: %+v", msgs)
	}
	// Sin resumen ni detalle se guarda el argumento recortado.
	if !strings.HasSuffix(msgs[1].Content, "…") || len([]rune(msgs[1].Content)) > 201 {
		t.Fatalf("contenido sin recortar: %q", msgs[1].Content)
	}
}

func TestTurnRecorderErrorKeepsPartialAndMarksError(t *testing.T) {
	var r TurnRecorder
	msgs, closed := feedAll(&r,
		Event{Kind: KindText, Text: "a medias"},
		Event{Kind: KindError, Error: "turno cancelado"},
	)
	if !closed || len(msgs) != 2 {
		t.Fatalf("msgs: %+v", msgs)
	}
	if msgs[0].Content != "a medias" || msgs[1].Content != ErrorRowPrefix+"turno cancelado" || msgs[1].Role != "assistant" {
		t.Fatalf("msgs: %+v", msgs)
	}

	// Error sin nada dicho: solo la fila de error.
	msgs, _ = feedAll(&r, Event{Kind: KindError, Error: "boom", Usage: &Usage{Total: 1}})
	if len(msgs) != 1 || msgs[0].Usage == nil || !strings.HasPrefix(msgs[0].Content, ErrorRowPrefix) {
		t.Fatalf("msgs: %+v", msgs)
	}
}

func TestSplitToolRowRoundTrip(t *testing.T) {
	c := toolRowContent(ToolCall{Name: "Edit", Summary: "a.go", Detail: "+3 líneas"})
	s, d := SplitToolRow(c)
	if s != "a.go" || d != "+3 líneas" {
		t.Fatalf("%q %q", s, d)
	}
	if s, d := SplitToolRow("solo resumen"); s != "solo resumen" || d != "" {
		t.Fatalf("%q %q", s, d)
	}
}

func TestSeedHistory(t *testing.T) {
	stored := []HistoryMessage{
		{Role: "assistant", Content: "cola de un turno anterior"}, // ventana cortada: se ignora
		{Role: "user", Content: "u1"},
		{Role: "tool", Content: "x", ToolName: "Read"},
		{Role: "assistant", Content: "a1"},
		{Role: "user", Content: "u2 que falló"},
		{Role: "assistant", Content: "a medias"},
		{Role: "assistant", Content: ErrorRowPrefix + "boom"},
		{Role: "user", Content: "u3"},
		{Role: "assistant", Content: "a3"},
	}
	got := SeedHistory(stored, 40, 24000)
	want := []llm.Message{
		{Role: llm.RoleUser, Content: "u1"},
		{Role: llm.RoleAssistant, Content: "a1"},
		{Role: llm.RoleUser, Content: "u3"},
		{Role: llm.RoleAssistant, Content: "a3"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}

	// Tope de mensajes: queda lo más reciente y siempre arranca en el usuario.
	got = SeedHistory(stored, 3, 24000)
	if len(got) != 2 || got[0].Content != "u3" {
		t.Fatalf("tope de mensajes: %+v", got)
	}
	// Tope de caracteres.
	got = SeedHistory(stored, 40, 4)
	if len(got) != 2 || got[0].Content != "u3" {
		t.Fatalf("tope de caracteres: %+v", got)
	}
	if got := SeedHistory(nil, 40, 100); len(got) != 0 {
		t.Fatalf("vacío: %+v", got)
	}
}

func TestPastTurnsFromStored(t *testing.T) {
	got := PastTurnsFromStored([]HistoryMessage{
		{Role: "user", Content: "hola"},
		{Role: "tool", ToolName: "Read", Content: "a.go\n10 líneas"},
		{Role: "assistant", Content: "texto parcial"},
		{Role: "assistant", Content: ErrorRowPrefix + "boom"},
		{Role: "user", Content: "otra"},
		{Role: "tool", ToolName: "Bash", Content: "ls"},
	})
	if len(got) != 4 {
		t.Fatalf("turnos: %+v", got)
	}
	if got[0].Role != "user" || got[0].Text != "hola" {
		t.Fatalf("0: %+v", got[0])
	}
	a := got[1]
	if a.Role != "agent" || len(a.Tools) != 1 || a.Tools[0].Name != "Read" || a.Tools[0].Summary != "a.go" || a.Tools[0].Detail != "10 líneas" ||
		a.Text != "texto parcial\n\n"+ErrorRowPrefix+"boom" {
		t.Fatalf("1: %+v", a)
	}
	if got[3].Role != "agent" || got[3].Text != "" || len(got[3].Tools) != 1 {
		t.Fatalf("3: %+v", got[3])
	}
}

func TestTurnRecorderCarriesModelToTheClosingRow(t *testing.T) {
	var r TurnRecorder
	u := &Usage{Input: 4, Output: 2, Total: 6}
	msgs, _ := feedAll(&r,
		Event{Kind: KindStart, Model: "llama3"},
		Event{Kind: KindTool, Tool: &ToolCall{Name: "Read", Summary: "a"}},
		Event{Kind: KindText, Text: "listo"},
		Event{Kind: KindDone, Usage: u},
	)
	// El modelo viaja en la fila que lleva el uso, no en la herramienta.
	if len(msgs) != 2 || msgs[0].Model != "" || msgs[1].Model != "llama3" {
		t.Fatalf("msgs: %+v", msgs)
	}
	// Solo-herramientas: el uso (y el modelo) van en la última.
	msgs, _ = feedAll(&r, Event{Kind: KindStart, Model: "qwen"}, Event{Kind: KindTool, Tool: &ToolCall{Name: "A", Summary: "a"}}, Event{Kind: KindDone, Usage: u})
	if len(msgs) != 1 || msgs[0].Model != "qwen" {
		t.Fatalf("solo herramientas: %+v", msgs)
	}
	// Un error también conserva el modelo, y el recorder no lo arrastra al turno siguiente.
	msgs, _ = feedAll(&r, Event{Kind: KindStart, Model: "m1"}, Event{Kind: KindError, Error: "boom", Usage: u})
	if msgs[len(msgs)-1].Model != "m1" {
		t.Fatalf("error: %+v", msgs)
	}
	msgs, _ = feedAll(&r, Event{Kind: KindText, Text: "x"}, Event{Kind: KindDone, Usage: u})
	if msgs[0].Model != "" {
		t.Fatalf("el modelo del turno anterior se arrastró: %+v", msgs)
	}
}
