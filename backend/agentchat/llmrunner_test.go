package agentchat

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"mini-tools/backend/llm"
)

// fakeLLM es un servidor de modelos de mentira que registra lo que recibe.
type fakeLLM struct {
	mu       sync.Mutex
	models   []string
	requests []llm.ChatRequest
	reply    string
	thinking string
	usage    llm.Usage
	err      error
	block    chan struct{} // si no es nil, Chat espera a que se cancele
}

func (f *fakeLLM) Version(context.Context) (string, error) { return "test", nil }
func (f *fakeLLM) Models(context.Context) ([]string, error) {
	return f.models, nil
}

func (f *fakeLLM) Chat(ctx context.Context, req llm.ChatRequest, onDelta func(llm.Delta)) (llm.ChatResult, error) {
	f.mu.Lock()
	f.requests = append(f.requests, req)
	f.mu.Unlock()
	if f.block != nil {
		<-ctx.Done()
		return llm.ChatResult{}, ctx.Err()
	}
	if f.err != nil {
		return llm.ChatResult{}, f.err
	}
	if onDelta != nil {
		if f.thinking != "" {
			onDelta(llm.Delta{Thinking: f.thinking})
		}
		for _, w := range strings.SplitAfter(f.reply, " ") {
			onDelta(llm.Delta{Text: w})
		}
	}
	return llm.ChatResult{Message: llm.Message{Role: llm.RoleAssistant, Content: f.reply}, Usage: f.usage, Model: req.Model}, nil
}

type collector struct {
	mu     sync.Mutex
	events []Event
	done   chan struct{}
}

func newCollector() *collector { return &collector{done: make(chan struct{}, 8)} }

func (c *collector) emit(_ string, ev Event) {
	c.mu.Lock()
	c.events = append(c.events, ev)
	c.mu.Unlock()
	if ev.Kind == KindDone || ev.Kind == KindError {
		c.done <- struct{}{}
	}
}

func (c *collector) wait(t *testing.T) []Event {
	t.Helper()
	select {
	case <-c.done:
	case <-time.After(5 * time.Second):
		t.Fatal("el turno no terminó")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	out := c.events
	c.events = nil
	return out
}

func waitIdle(t *testing.T, m *Manager, session string) {
	t.Helper()
	for i := 0; i < 200; i++ {
		m.mu.Lock()
		_, busy := m.cancels[session]
		m.mu.Unlock()
		if !busy {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("la sesión siguió ocupada")
}

func TestSupportsAndModesForLLM(t *testing.T) {
	if !Supports("llm:abc") || !IsLLM("llm:abc") || IsLLM("claude") {
		t.Fatal("Supports/IsLLM mal")
	}
	// Los cinco modos, con o sin canal de aprobación de los CLIs: la
	// aprobación de un servidor de modelos es en proceso.
	want := []string{"", "plan", "approve", "edit", "auto"}
	for _, ready := range []bool{true, false} {
		modes := ModesFor("llm:abc", ready)
		if strings.Join(modes, ",") != strings.Join(want, ",") {
			t.Fatalf("ModesFor(approveReady=%v) = %v", ready, modes)
		}
	}
}

func TestLLMSendStreamsAndKeepsHistory(t *testing.T) {
	f := &fakeLLM{models: []string{"qwen2.5:3b", "otro"}, reply: "Hola mundo", thinking: "pienso", usage: llm.Usage{Input: 10, Output: 4}}
	col := newCollector()
	m := NewManager(col.emit)

	if err := m.Send(Turn{SessionID: "s1", AgentID: "llm:abc", Prompt: "hola", LLM: f}); err != nil {
		t.Fatalf("Send: %v", err)
	}
	evs := col.wait(t)
	if evs[0].Kind != KindStart || evs[0].Model != "qwen2.5:3b" {
		t.Fatalf("start = %+v (debería usar el primer modelo del servidor)", evs[0])
	}
	var text, think strings.Builder
	for _, e := range evs {
		switch e.Kind {
		case KindText:
			text.WriteString(e.Text)
		case KindThinking:
			think.WriteString(e.Text)
		}
	}
	last := evs[len(evs)-1]
	if text.String() != "Hola mundo" || think.String() != "pienso" || last.Kind != KindDone || last.Usage == nil || last.Usage.Total != 14 {
		t.Fatalf("eventos = %+v", evs)
	}
	waitIdle(t, m, "s1")

	first := f.requests[0].Messages
	if len(first) != 2 || first[0].Role != llm.RoleSystem || !strings.Contains(first[0].Content, "español") && !strings.Contains(first[0].Content, "English") {
		t.Fatalf("el primer mensaje debe ser el system con el idioma: %+v", first)
	}

	// El segundo mensaje arrastra la charla anterior y respeta el modelo pedido.
	if err := m.Send(Turn{SessionID: "s1", AgentID: "llm:abc", Prompt: "¿y ahora?", Model: "otro", LLM: f}); err != nil {
		t.Fatalf("Send 2: %v", err)
	}
	col.wait(t)
	waitIdle(t, m, "s1")
	second := f.requests[1]
	if second.Model != "otro" || len(second.Messages) != 4 || second.Messages[1].Content != "hola" || second.Messages[2].Role != llm.RoleAssistant {
		t.Fatalf("segundo request = %+v", second)
	}

	// Reset borra la memoria.
	m.Reset("s1")
	if err := m.Send(Turn{SessionID: "s1", AgentID: "llm:abc", Prompt: "otra", LLM: f}); err != nil {
		t.Fatal(err)
	}
	col.wait(t)
	if got := len(f.requests[2].Messages); got != 2 {
		t.Fatalf("tras Reset el request llevó %d mensajes", got)
	}
}

func TestLLMSendErrors(t *testing.T) {
	col := newCollector()
	m := NewManager(col.emit)

	if err := m.Send(Turn{SessionID: "s", AgentID: "llm:x", Prompt: "hola"}); err == nil {
		t.Fatal("sin cliente debería fallar")
	}

	f := &fakeLLM{models: []string{"m"}, err: errors.New("boom")}
	if err := m.Send(Turn{SessionID: "s", AgentID: "llm:x", Prompt: "hola", LLM: f}); err != nil {
		t.Fatal(err)
	}
	evs := col.wait(t)
	if last := evs[len(evs)-1]; last.Kind != KindError || last.Error != "boom" {
		t.Fatalf("eventos = %+v", evs)
	}
	waitIdle(t, m, "s")
	// Un turno fallido no entra al historial.
	m.mu.Lock()
	n := len(m.llmHistory["s"])
	m.mu.Unlock()
	if n != 0 {
		t.Fatalf("el historial guardó %d mensajes de un turno fallido", n)
	}

	// Sin modelos en el servidor y sin modelo pedido.
	empty := &fakeLLM{models: nil}
	_ = m.Send(Turn{SessionID: "s", AgentID: "llm:x", Prompt: "hola", LLM: empty})
	evs = col.wait(t)
	if evs[len(evs)-1].Kind != KindError {
		t.Fatalf("eventos = %+v", evs)
	}
}

func TestLLMCancel(t *testing.T) {
	f := &fakeLLM{models: []string{"m"}, block: make(chan struct{})}
	col := newCollector()
	m := NewManager(col.emit)
	if err := m.Send(Turn{SessionID: "s", AgentID: "llm:x", Prompt: "hola", LLM: f}); err != nil {
		t.Fatal(err)
	}
	// Una segunda mientras contesta se rechaza.
	time.Sleep(50 * time.Millisecond)
	if err := m.Send(Turn{SessionID: "s", AgentID: "llm:x", Prompt: "otra", LLM: f}); err == nil {
		t.Fatal("la sesión ocupada debería rechazar")
	}
	m.Cancel("s")
	evs := col.wait(t)
	last := evs[len(evs)-1]
	if last.Kind != KindError || !strings.Contains(last.Error, "cancel") {
		t.Fatalf("eventos = %+v", evs)
	}
}

func TestLLMAsk(t *testing.T) {
	f := &fakeLLM{models: []string{"m1"}, reply: "  SELECT 1  "}
	m := NewManager(func(string, Event) {})
	got, err := m.Ask(context.Background(), Turn{AgentID: "llm:x", Prompt: "dame sql", LLM: f})
	if err != nil || got != "SELECT 1" {
		t.Fatalf("Ask = %q, %v", got, err)
	}
	if f.requests[0].Model != "m1" || len(f.requests[0].Messages) != 2 {
		t.Fatalf("request = %+v", f.requests[0])
	}
	if _, err := m.Ask(context.Background(), Turn{AgentID: "llm:x", Prompt: "x", Mode: ModeEdit, LLM: f}); err == nil {
		t.Fatal("ModeEdit debería rechazarse")
	}
	if _, err := m.Ask(context.Background(), Turn{AgentID: "llm:x", Prompt: "x", LLM: &fakeLLM{models: []string{"m"}, err: errors.New("caído")}}); err == nil {
		t.Fatal("el error del servidor debería propagarse")
	}
}

// Tras reiniciar la app el Manager arranca sin memoria: el historial guardado
// que arma App (Turn.History) siembra la sesión, y solo mientras no haya
// memoria propia.
func TestLLMSendSeedsFromStoredHistoryOnlyWhenMemoryIsEmpty(t *testing.T) {
	f := &fakeLLM{models: []string{"m"}, reply: "ok"}
	col := newCollector()
	mgr := NewManager(col.emit)
	seed := []llm.Message{
		{Role: llm.RoleUser, Content: "mi nombre es Ana"},
		{Role: llm.RoleAssistant, Content: "Hola Ana"},
	}

	if err := mgr.Send(Turn{SessionID: "s1", AgentID: "llm:x", Prompt: "¿cómo me llamo?", LLM: f, History: seed}); err != nil {
		t.Fatal(err)
	}
	col.wait(t)
	waitIdle(t, mgr, "s1")

	got := f.requests[0].Messages
	if len(got) != 4 || got[0].Role != llm.RoleSystem || got[1].Content != "mi nombre es Ana" ||
		got[2].Content != "Hola Ana" || got[3].Content != "¿cómo me llamo?" {
		t.Fatalf("primer turno: %+v", got)
	}

	// Segundo turno con otra semilla: manda la memoria, no la semilla.
	if err := mgr.Send(Turn{SessionID: "s1", AgentID: "llm:x", Prompt: "gracias", LLM: f,
		History: []llm.Message{{Role: llm.RoleUser, Content: "OTRA COSA"}}}); err != nil {
		t.Fatal(err)
	}
	col.wait(t)
	waitIdle(t, mgr, "s1")

	got = f.requests[1].Messages
	if len(got) != 6 || got[1].Content != "mi nombre es Ana" || got[4].Content != "ok" || got[5].Content != "gracias" {
		t.Fatalf("segundo turno: %+v", got)
	}
	for _, m := range got {
		if m.Content == "OTRA COSA" {
			t.Fatal("la semilla no debe usarse si la sesión ya tiene memoria")
		}
	}
}

// --- Reintento por fallo de conexión ---------------------------------------

// retryLLM responde a cada Chat con el siguiente paso del guion.
type retryLLM struct {
	mu    sync.Mutex
	steps []func(onDelta func(llm.Delta)) (llm.ChatResult, error)
	calls int
}

func (s *retryLLM) Version(context.Context) (string, error) { return "", nil }
func (s *retryLLM) Models(context.Context) ([]string, error) {
	return []string{"m"}, nil
}
func (s *retryLLM) Chat(_ context.Context, _ llm.ChatRequest, onDelta func(llm.Delta)) (llm.ChatResult, error) {
	s.mu.Lock()
	i := s.calls
	s.calls++
	s.mu.Unlock()
	if i >= len(s.steps) {
		return llm.ChatResult{}, errors.New("sin más pasos")
	}
	return s.steps[i](onDelta)
}

func (s *retryLLM) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

func refused() error {
	return &llm.ConnError{Base: "http://gpu", Kind: llm.ConnRefused, Err: errors.New("refused")}
}

func okReply(text string) func(func(llm.Delta)) (llm.ChatResult, error) {
	return func(onDelta func(llm.Delta)) (llm.ChatResult, error) {
		if onDelta != nil {
			onDelta(llm.Delta{Text: text})
		}
		return llm.ChatResult{Message: llm.Message{Role: llm.RoleAssistant, Content: text}}, nil
	}
}

func fail(err error) func(func(llm.Delta)) (llm.ChatResult, error) {
	return func(func(llm.Delta)) (llm.ChatResult, error) { return llm.ChatResult{}, err }
}

func fastRetry(t *testing.T) {
	t.Helper()
	old := llmRetryDelay
	llmRetryDelay = time.Millisecond
	t.Cleanup(func() { llmRetryDelay = old })
}

// Un fallo de conexión antes de cualquier trozo se reintenta una vez y, si el
// segundo intento anda, el turno termina bien sin que se note.
func TestChatRetriesConnectionFailureOnce(t *testing.T) {
	fastRetry(t)
	s := &retryLLM{steps: []func(func(llm.Delta)) (llm.ChatResult, error){fail(refused()), okReply("hola")}}
	col := newCollector()
	m := NewManager(col.emit)
	if err := m.Send(Turn{SessionID: "r", AgentID: "llm:x", Prompt: "hi", LLM: s}); err != nil {
		t.Fatal(err)
	}
	evs := col.wait(t)
	if last := evs[len(evs)-1]; last.Kind != KindDone {
		t.Fatalf("eventos = %+v", evs)
	}
	if s.count() != 2 {
		t.Errorf("Chat se llamó %d veces, quería 2", s.count())
	}

	// Ask (turno suelto) tiene el mismo reintento.
	s2 := &retryLLM{steps: []func(func(llm.Delta)) (llm.ChatResult, error){fail(refused()), okReply("listo")}}
	got, err := m.Ask(context.Background(), Turn{AgentID: "llm:x", Prompt: "x", LLM: s2})
	if err != nil || got != "listo" || s2.count() != 2 {
		t.Fatalf("Ask = %q, %v, llamadas %d", got, err, s2.count())
	}
}

// Dos fallos seguidos: se reintenta una sola vez y el error llega.
func TestChatRetriesOnlyOnce(t *testing.T) {
	fastRetry(t)
	s := &retryLLM{steps: []func(func(llm.Delta)) (llm.ChatResult, error){fail(refused()), fail(refused()), okReply("nunca")}}
	if _, err := (&Manager{}).askLLM(context.Background(), Turn{AgentID: "llm:x", Prompt: "x", LLM: s}); err == nil {
		t.Fatal("debería fallar")
	}
	if s.count() != 2 {
		t.Errorf("Chat se llamó %d veces, quería 2", s.count())
	}
}

// No se reintenta: un 4xx, un fallo con el stream ya abierto, ni un
// cancelado.
func TestChatDoesNotRetry(t *testing.T) {
	fastRetry(t)
	reset := &llm.ConnError{Base: "http://gpu", Kind: llm.ConnReset, Err: errors.New("reset")}
	cases := map[string]*retryLLM{
		"HTTP 4xx": {steps: []func(func(llm.Delta)) (llm.ChatResult, error){fail(&llm.StatusError{Base: "http://gpu", Status: 404, Msg: "no model"}), okReply("x")}},
		"stream abierto": {steps: []func(func(llm.Delta)) (llm.ChatResult, error){
			func(onDelta func(llm.Delta)) (llm.ChatResult, error) {
				onDelta(llm.Delta{Text: "par"})
				return llm.ChatResult{}, reset
			}, okReply("x")}},
		"error común": {steps: []func(func(llm.Delta)) (llm.ChatResult, error){fail(errors.New("boom")), okReply("x")}},
	}
	for name, s := range cases {
		if _, err := (&Manager{}).askLLM(context.Background(), Turn{AgentID: "llm:x", Prompt: "x", LLM: s}); err == nil {
			t.Errorf("%s: debería fallar", name)
		}
		if s.count() != 1 {
			t.Errorf("%s: Chat se llamó %d veces, quería 1", name, s.count())
		}
	}

	// Cancelado durante la espera: no hay segundo intento.
	old := llmRetryDelay
	llmRetryDelay = time.Hour
	defer func() { llmRetryDelay = old }()
	ctx, cancel := context.WithCancel(context.Background())
	s := &retryLLM{steps: []func(func(llm.Delta)) (llm.ChatResult, error){
		func(func(llm.Delta)) (llm.ChatResult, error) { cancel(); return llm.ChatResult{}, refused() },
		okReply("x"),
	}}
	if _, err := (&Manager{}).askLLM(ctx, Turn{AgentID: "llm:x", Prompt: "x", LLM: s}); err == nil || s.count() != 1 {
		t.Fatalf("err = %v, llamadas %d", err, s.count())
	}
}
