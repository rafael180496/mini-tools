package agentchat

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"mini-tools/backend/llm"
)

// scriptLLM responde con un guion: la vuelta N usa steps[N].
type scriptLLM struct {
	mu       sync.Mutex
	steps    []func(req llm.ChatRequest, on func(llm.Delta)) (llm.ChatResult, error)
	requests []llm.ChatRequest
}

func (s *scriptLLM) Version(context.Context) (string, error)  { return "t", nil }
func (s *scriptLLM) Models(context.Context) ([]string, error) { return []string{"m"}, nil }
func (s *scriptLLM) Chat(ctx context.Context, req llm.ChatRequest, on func(llm.Delta)) (llm.ChatResult, error) {
	s.mu.Lock()
	snap := req
	snap.Messages = append([]llm.Message(nil), req.Messages...)
	idx := len(s.requests)
	s.requests = append(s.requests, snap)
	s.mu.Unlock()
	if idx >= len(s.steps) {
		return llm.ChatResult{}, fmt.Errorf("el guion no tiene la vuelta %d", idx)
	}
	return s.steps[idx](req, on)
}

// say es una vuelta que responde texto y/o pide herramientas.
func say(text string, in, out int64, calls ...llm.ToolCall) func(llm.ChatRequest, func(llm.Delta)) (llm.ChatResult, error) {
	return func(req llm.ChatRequest, on func(llm.Delta)) (llm.ChatResult, error) {
		if on != nil && text != "" {
			on(llm.Delta{Text: text})
		}
		return llm.ChatResult{
			Message: llm.Message{Role: llm.RoleAssistant, Content: text, ToolCalls: calls},
			Usage:   llm.Usage{Input: in, Output: out},
			Model:   req.Model,
		}, nil
	}
}

func call(id, name string, args map[string]any) llm.ToolCall {
	return llm.ToolCall{ID: id, Name: name, Arguments: args}
}

var toolDefs = []llm.ToolDef{
	{Name: "read_file", Parameters: map[string]any{"type": "object"}},
	{Name: "vault_read_note", Parameters: map[string]any{"type": "object"}},
}

func eventsOf(evs []Event, k EventKind) []Event {
	var out []Event
	for _, e := range evs {
		if e.Kind == k {
			out = append(out, e)
		}
	}
	return out
}

func textOf(evs []Event) string {
	var b strings.Builder
	for _, e := range eventsOf(evs, KindText) {
		b.WriteString(e.Text)
	}
	return b.String()
}

func runTurn(t *testing.T, m *Manager, col *collector, turn Turn) []Event {
	t.Helper()
	if err := m.Send(turn); err != nil {
		t.Fatalf("Send: %v", err)
	}
	evs := col.wait(t)
	waitIdle(t, m, turn.SessionID)
	return evs
}

func TestToolLoopRunsRoundsAndFeedsResultsBack(t *testing.T) {
	f := &scriptLLM{steps: []func(llm.ChatRequest, func(llm.Delta)) (llm.ChatResult, error){
		say("Voy a leer.", 10, 2,
			call("c1", "read_file", map[string]any{"path": "a.go"}),
			call("c2", "vault_read_note", map[string]any{"title": "Runbook"})),
		say("", 20, 3, call("c3", "read_file", map[string]any{"path": "b.go"})),
		say("Listo: todo leído.", 30, 5),
	}}
	var ran []string
	var mu sync.Mutex
	col := newCollector()
	m := NewManager(col.emit)
	evs := runTurn(t, m, col, Turn{
		SessionID: "s", AgentID: "llm:x", Prompt: "leé", LLM: f, Tools: toolDefs,
		RunTool: func(_ context.Context, name string, args map[string]any) (string, error) {
			mu.Lock()
			ran = append(ran, name)
			mu.Unlock()
			return "contenido de " + fmt.Sprint(args), nil
		},
	})

	if got := strings.Join(ran, ","); got != "read_file,vault_read_note,read_file" {
		t.Fatalf("ejecuciones = %s", got)
	}
	tools := eventsOf(evs, KindTool)
	if len(tools) != 3 || tools[0].Tool.Name != "read_file" || tools[0].Tool.Summary != "a.go" {
		t.Fatalf("eventos tool = %+v", tools)
	}
	// Las herramientas del MCP no traen `path`: el resumen sale del título.
	if tools[1].Tool.Name != "vault_read_note" || tools[1].Tool.Summary != "Runbook" || tools[1].Tool.Input == "" {
		t.Fatalf("tool MCP = %+v", tools[1].Tool)
	}
	// El texto de vueltas distintas no sale pegado.
	if txt := textOf(evs); txt != "Voy a leer.\n\nListo: todo leído." {
		t.Fatalf("texto = %q", txt)
	}
	last := evs[len(evs)-1]
	if last.Kind != KindDone || last.Usage == nil || last.Usage.Input != 60 || last.Usage.Output != 10 || last.Usage.Total != 70 {
		t.Fatalf("done = %+v (el uso se acumula entre vueltas)", last)
	}

	// La segunda vuelta lleva la llamada del asistente y una respuesta tool por
	// cada llamada, correlacionada por id y por nombre.
	if len(f.requests) != 3 {
		t.Fatalf("vueltas = %d", len(f.requests))
	}
	r2 := f.requests[1].Messages
	n := len(r2)
	if r2[n-3].Role != llm.RoleAssistant || len(r2[n-3].ToolCalls) != 2 ||
		r2[n-2].Role != llm.RoleTool || r2[n-2].ToolCallID != "c1" || r2[n-2].Name != "read_file" || !strings.Contains(r2[n-2].Content, "a.go") ||
		r2[n-1].Role != llm.RoleTool || r2[n-1].ToolCallID != "c2" || r2[n-1].Name != "vault_read_note" {
		t.Fatalf("segunda vuelta mal armada: %+v", r2)
	}
	for _, req := range f.requests {
		if len(req.Tools) != 2 {
			t.Fatalf("cada vuelta declara las herramientas: %+v", req.Tools)
		}
	}

	// La memoria guarda la charla completa con sus herramientas.
	m.mu.Lock()
	h := m.llmHistory["s"]
	m.mu.Unlock()
	roles := []string{}
	for _, x := range h {
		roles = append(roles, x.Role)
	}
	want := "system,user,assistant,tool,tool,assistant,tool,assistant"
	if strings.Join(roles, ",") != want {
		t.Fatalf("memoria = %s, quería %s", strings.Join(roles, ","), want)
	}
}

func TestToolLoopRoundCap(t *testing.T) {
	steps := []func(llm.ChatRequest, func(llm.Delta)) (llm.ChatResult, error){}
	for i := 0; i < 5; i++ {
		steps = append(steps, say("", 10, 1, call(fmt.Sprintf("c%d", i), "read_file", map[string]any{"path": "x"})))
	}
	f := &scriptLLM{steps: steps}
	runs := 0
	col := newCollector()
	m := NewManager(col.emit)
	evs := runTurn(t, m, col, Turn{
		SessionID: "s", AgentID: "llm:x", Prompt: "dale", LLM: f, Tools: toolDefs, MaxToolRounds: 3,
		RunTool: func(context.Context, string, map[string]any) (string, error) { runs++; return "ok", nil },
	})
	last := evs[len(evs)-1]
	if last.Kind != KindError || !strings.Contains(last.Error, "3") {
		t.Fatalf("tenía que terminar con el error del tope: %+v", last)
	}
	if last.Usage == nil || last.Usage.Input != 30 {
		t.Fatalf("el error del tope lleva el uso acumulado: %+v", last.Usage)
	}
	// Vueltas 1 y 2 ejecutan; la 3ª pide herramientas pero ya es el tope.
	if runs != 2 || len(f.requests) != 3 {
		t.Fatalf("ejecuciones=%d vueltas=%d", runs, len(f.requests))
	}
	// Lo ya hecho ocurrió: la memoria queda y es consistente (toda llamada con
	// su respuesta), así que el chat puede seguir.
	m.mu.Lock()
	h := m.llmHistory["s"]
	m.mu.Unlock()
	pendientes := map[string]bool{}
	for _, x := range h {
		for _, c := range x.ToolCalls {
			pendientes[c.ID] = true
		}
		if x.Role == llm.RoleTool {
			delete(pendientes, x.ToolCallID)
		}
	}
	if len(h) == 0 || len(pendientes) != 0 {
		t.Fatalf("memoria inconsistente (%d mensajes, sin respuesta: %v)", len(h), pendientes)
	}
}

func TestToolLoopToolErrorGoesToModelNotToTurn(t *testing.T) {
	f := &scriptLLM{steps: []func(llm.ChatRequest, func(llm.Delta)) (llm.ChatResult, error){
		say("", 1, 1, call("c1", "read_file", map[string]any{"path": "x"})),
		say("No pude leerlo.", 1, 1),
	}}
	col := newCollector()
	m := NewManager(col.emit)
	evs := runTurn(t, m, col, Turn{
		SessionID: "s", AgentID: "llm:x", Prompt: "leé", LLM: f, Tools: toolDefs,
		RunTool: func(context.Context, string, map[string]any) (string, error) { return "", errors.New("no existe x") },
	})
	if last := evs[len(evs)-1]; last.Kind != KindDone {
		t.Fatalf("un error de herramienta no falla el turno: %+v", last)
	}
	msgs := f.requests[1].Messages
	tm := msgs[len(msgs)-1]
	if tm.Role != llm.RoleTool || tm.Content != "error: no existe x" {
		t.Fatalf("el modelo debía recibir «error: …»: %+v", tm)
	}
}

func TestToolLoopRejectsUndeclaredAndBadArgsAndPanics(t *testing.T) {
	f := &scriptLLM{steps: []func(llm.ChatRequest, func(llm.Delta)) (llm.ChatResult, error){
		say("", 1, 1,
			call("c1", "run_command", map[string]any{"command": "rm -rf /"}), // no declarada
			call("c2", "read_file", map[string]any{"_raw": "{mal json"}),
			call("c3", "read_file", map[string]any{"path": "boom"}),
			call("c4", "read_file", map[string]any{"path": "vacio"}),
			call("c5", "read_file", map[string]any{"path": "grande"})),
		say("fin", 1, 1),
	}}
	var ranNames []string
	col := newCollector()
	m := NewManager(col.emit)
	evs := runTurn(t, m, col, Turn{
		SessionID: "s", AgentID: "llm:x", Prompt: "x", LLM: f, Tools: toolDefs,
		RunTool: func(_ context.Context, name string, args map[string]any) (string, error) {
			ranNames = append(ranNames, name)
			switch args["path"] {
			case "boom":
				panic("kaboom")
			case "vacio":
				return "  ", nil
			case "grande":
				return strings.Repeat("é", maxToolResultChars+500), nil
			}
			return "ok", nil
		},
	})
	if last := evs[len(evs)-1]; last.Kind != KindDone {
		t.Fatalf("turno: %+v", last)
	}
	if strings.Contains(strings.Join(ranNames, ","), "run_command") {
		t.Fatal("se ejecutó una herramienta no declarada")
	}
	msgs := f.requests[1].Messages
	tool := msgs[len(msgs)-5:]
	if !strings.HasPrefix(tool[0].Content, "error:") || !strings.Contains(tool[0].Content, "run_command") {
		t.Errorf("no declarada: %q", tool[0].Content)
	}
	if !strings.HasPrefix(tool[1].Content, "error:") || !strings.Contains(tool[1].Content, "JSON") {
		t.Errorf("args crudos: %q", tool[1].Content)
	}
	if !strings.HasPrefix(tool[2].Content, "error:") || !strings.Contains(tool[2].Content, "kaboom") {
		t.Errorf("pánico: %q", tool[2].Content)
	}
	if strings.TrimSpace(tool[3].Content) == "" {
		t.Errorf("un resultado vacío no se manda vacío")
	}
	if r := []rune(tool[4].Content); len(r) > maxToolResultChars+200 || !strings.Contains(tool[4].Content, "[") {
		t.Errorf("resultado sin recortar: %d runas", len(r))
	}
	// Una no declarada igual se ve en el chat (el usuario ve lo que el modelo intentó).
	if got := len(eventsOf(evs, KindTool)); got != 5 {
		t.Errorf("eventos tool = %d", got)
	}
}

func TestToolsUnsupportedFallsBackAndNoticesOnce(t *testing.T) {
	reject := func(req llm.ChatRequest, on func(llm.Delta)) (llm.ChatResult, error) {
		if len(req.Tools) == 0 {
			t.Error("la primera vuelta tenía que declarar herramientas")
		}
		return llm.ChatResult{}, &llm.StatusError{Base: "http://x", Status: 400, Msg: "registry.ollama.ai/library/gemma:2b does not support tools"}
	}
	f := &scriptLLM{steps: []func(llm.ChatRequest, func(llm.Delta)) (llm.ChatResult, error){
		reject,
		say("Hola sin herramientas", 5, 2),
		// Segundo turno de la misma sesión: ni siquiera se intenta con herramientas.
		say("Otra vez", 5, 2),
	}}
	called := false
	col := newCollector()
	m := NewManager(col.emit)
	turn := Turn{SessionID: "s", AgentID: "llm:x", Prompt: "hola", LLM: f, Tools: toolDefs,
		RunTool: func(context.Context, string, map[string]any) (string, error) { called = true; return "", nil }}

	evs := runTurn(t, m, col, turn)
	if last := evs[len(evs)-1]; last.Kind != KindDone {
		t.Fatalf("eventos = %+v", evs)
	}
	txt := textOf(evs)
	if !strings.Contains(txt, "herramientas") && !strings.Contains(strings.ToLower(txt), "tools") || !strings.Contains(txt, "Hola sin herramientas") {
		t.Fatalf("falta el aviso o la respuesta: %q", txt)
	}
	if strings.Index(txt, "Hola sin") < strings.Index(txt, "⚠") {
		t.Errorf("el aviso va antes de la respuesta: %q", txt)
	}
	if len(f.requests) != 2 || len(f.requests[1].Tools) != 0 {
		t.Fatalf("el reintento no debe llevar herramientas: %+v", f.requests)
	}
	if called {
		t.Error("no debía ejecutarse ninguna herramienta")
	}
	// Una uso solo se cuenta una vez: el rechazo no consumió tokens.
	if u := evs[len(evs)-1].Usage; u.Input != 5 {
		t.Errorf("uso = %+v", u)
	}

	// Segundo turno: sin intento con herramientas y sin repetir el aviso.
	turn.Prompt = "de nuevo"
	evs = runTurn(t, m, col, turn)
	if len(f.requests) != 3 || len(f.requests[2].Tools) != 0 {
		t.Fatalf("segundo turno: %+v", f.requests[2])
	}
	if strings.Contains(textOf(evs), "⚠") {
		t.Errorf("el aviso se repitió: %q", textOf(evs))
	}
	// Otro error cualquiera con herramientas NO dispara el reintento.
	g := &scriptLLM{steps: []func(llm.ChatRequest, func(llm.Delta)) (llm.ChatResult, error){
		func(llm.ChatRequest, func(llm.Delta)) (llm.ChatResult, error) {
			return llm.ChatResult{}, &llm.StatusError{Base: "http://x", Status: 400, Msg: "context length exceeded"}
		},
	}}
	evs = runTurn(t, m, col, Turn{SessionID: "s2", AgentID: "llm:y", Prompt: "x", LLM: g, Tools: toolDefs})
	if last := evs[len(evs)-1]; last.Kind != KindError || len(g.requests) != 1 {
		t.Fatalf("un error común no se reintenta: %+v (%d pedidos)", last, len(g.requests))
	}
}

func TestToolLoopCancelStopsPromptly(t *testing.T) {
	f := &scriptLLM{steps: []func(llm.ChatRequest, func(llm.Delta)) (llm.ChatResult, error){
		say("", 1, 1, call("c1", "read_file", map[string]any{"path": "x"})),
		say("no debería llegar", 1, 1),
	}}
	started := make(chan struct{})
	col := newCollector()
	m := NewManager(col.emit)
	if err := m.Send(Turn{
		SessionID: "s", AgentID: "llm:x", Prompt: "x", LLM: f, Tools: toolDefs,
		RunTool: func(ctx context.Context, _ string, _ map[string]any) (string, error) {
			close(started)
			<-ctx.Done() // una herramienta larga que respeta el contexto
			return "", ctx.Err()
		},
	}); err != nil {
		t.Fatal(err)
	}
	<-started
	begin := time.Now()
	m.Cancel("s")
	evs := col.wait(t)
	if time.Since(begin) > 2*time.Second {
		t.Error("cancelar tardó demasiado")
	}
	last := evs[len(evs)-1]
	if last.Kind != KindError || !strings.Contains(last.Error, "cancel") {
		t.Fatalf("eventos = %+v", evs)
	}
	waitIdle(t, m, "s")
	if len(f.requests) != 1 {
		t.Errorf("no debe pedir otra vuelta tras cancelar: %d", len(f.requests))
	}
	m.mu.Lock()
	n := len(m.llmHistory["s"])
	m.mu.Unlock()
	if n != 0 {
		t.Errorf("un turno cancelado no entra a la memoria (%d mensajes)", n)
	}
}

func TestSystemNoteIsPerTurn(t *testing.T) {
	f := &scriptLLM{steps: []func(llm.ChatRequest, func(llm.Delta)) (llm.ChatResult, error){say("a", 1, 1), say("b", 1, 1), say("c", 1, 1)}}
	col := newCollector()
	m := NewManager(col.emit)
	runTurn(t, m, col, Turn{SessionID: "s", AgentID: "llm:x", Prompt: "1", LLM: f, System: "MODO-UNO"})
	runTurn(t, m, col, Turn{SessionID: "s", AgentID: "llm:x", Prompt: "2", LLM: f, System: "MODO-DOS"})
	runTurn(t, m, col, Turn{SessionID: "s", AgentID: "llm:x", Prompt: "3", LLM: f})
	s1, s2, s3 := f.requests[0].Messages[0], f.requests[1].Messages[0], f.requests[2].Messages[0]
	if s1.Role != llm.RoleSystem || !strings.Contains(s1.Content, "MODO-UNO") {
		t.Errorf("turno 1: %q", s1.Content)
	}
	if !strings.Contains(s2.Content, "MODO-DOS") || strings.Contains(s2.Content, "MODO-UNO") {
		t.Errorf("turno 2 debe reemplazar el texto del anterior: %q", s2.Content)
	}
	if strings.Contains(s3.Content, "MODO") {
		t.Errorf("turno 3 sin texto extra: %q", s3.Content)
	}
	for _, r := range f.requests {
		systems := 0
		for _, m := range r.Messages {
			if m.Role == llm.RoleSystem {
				systems++
			}
		}
		if systems != 1 {
			t.Errorf("hay %d mensajes de sistema", systems)
		}
	}
}

func TestTrimLLMHistoryNeverStartsMidTurn(t *testing.T) {
	msgs := []llm.Message{{Role: llm.RoleSystem, Content: "sys"}}
	for i := 0; i < 40; i++ {
		msgs = append(msgs,
			llm.Message{Role: llm.RoleUser, Content: "u"},
			llm.Message{Role: llm.RoleAssistant, ToolCalls: []llm.ToolCall{{ID: "c", Name: "t"}}},
			llm.Message{Role: llm.RoleTool, ToolCallID: "c", Content: "r"},
			llm.Message{Role: llm.RoleAssistant, Content: "fin"})
	}
	out := trimLLMHistory(msgs)
	if out[0].Role != llm.RoleSystem || out[1].Role != llm.RoleUser {
		t.Fatalf("la memoria recortada tiene que empezar en un mensaje del usuario: %v %v", out[0].Role, out[1].Role)
	}
	if len(out) > llmMaxHistory+1 {
		t.Errorf("%d mensajes", len(out))
	}

	// El turno que acaba de terminar no se recorta por grande que sea.
	big := []llm.Message{
		{Role: llm.RoleSystem, Content: "sys"},
		{Role: llm.RoleUser, Content: "viejo"},
		{Role: llm.RoleAssistant, Content: "x"},
		{Role: llm.RoleUser, Content: "nuevo"},
		{Role: llm.RoleAssistant, ToolCalls: []llm.ToolCall{{ID: "c", Name: "t"}}},
		{Role: llm.RoleTool, ToolCallID: "c", Content: strings.Repeat("z", llmMaxHistoryChars+10)},
		{Role: llm.RoleAssistant, Content: "listo"},
	}
	out = trimLLMHistory(big)
	if len(out) != 5 || out[1].Content != "nuevo" {
		t.Fatalf("out = %+v", out)
	}
}

func TestAskDoesNotUseTools(t *testing.T) {
	f := &scriptLLM{steps: []func(llm.ChatRequest, func(llm.Delta)) (llm.ChatResult, error){say("SELECT 1", 1, 1)}}
	m := NewManager(func(string, Event) {})
	got, err := m.Ask(context.Background(), Turn{AgentID: "llm:x", Prompt: "sql", LLM: f, Tools: toolDefs,
		RunTool: func(context.Context, string, map[string]any) (string, error) { return "", nil }})
	if err != nil || got != "SELECT 1" {
		t.Fatalf("Ask = %q, %v", got, err)
	}
	if len(f.requests[0].Tools) != 0 {
		t.Fatal("Ask (los botones de un turno) no declara herramientas")
	}
}
