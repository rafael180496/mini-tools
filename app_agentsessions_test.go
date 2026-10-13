package main

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"mini-tools/backend/agentapprove"
	"mini-tools/backend/agentchat"
	"mini-tools/backend/llm"
)

// toolOnceLLM pide una herramienta en la primera vuelta y contesta en la
// segunda.
type toolOnceLLM struct {
	mu    sync.Mutex
	calls int
}

func (f *toolOnceLLM) Version(context.Context) (string, error)  { return "t", nil }
func (f *toolOnceLLM) Models(context.Context) ([]string, error) { return []string{"m"}, nil }
func (f *toolOnceLLM) Chat(_ context.Context, req llm.ChatRequest, on func(llm.Delta)) (llm.ChatResult, error) {
	f.mu.Lock()
	f.calls++
	n := f.calls
	f.mu.Unlock()
	if n == 1 {
		return llm.ChatResult{Message: llm.Message{Role: llm.RoleAssistant, ToolCalls: []llm.ToolCall{{ID: "c1", Name: "write_file", Arguments: map[string]any{"path": "a.txt"}}}}, Model: req.Model}, nil
	}
	if on != nil {
		on(llm.Delta{Text: "hecho"})
	}
	return llm.ChatResult{Message: llm.Message{Role: llm.RoleAssistant, Content: "hecho"}, Usage: llm.Usage{Input: 4, Output: 2}, Model: req.Model}, nil
}

// blockLLM espera a que lo cancelen.
type blockLLM struct{}

func (blockLLM) Version(context.Context) (string, error)  { return "t", nil }
func (blockLLM) Models(context.Context) ([]string, error) { return []string{"m"}, nil }
func (blockLLM) Chat(ctx context.Context, _ llm.ChatRequest, _ func(llm.Delta)) (llm.ChatResult, error) {
	<-ctx.Done()
	return llm.ChatResult{}, ctx.Err()
}

type approvalSink struct {
	mu      sync.Mutex
	reqs    chan agentapprove.Request
	dismiss chan string
}

func newApprovalSink() *approvalSink {
	return &approvalSink{reqs: make(chan agentapprove.Request, 8), dismiss: make(chan string, 8)}
}

func (s *approvalSink) emit(event string, data any) {
	switch event {
	case "agent-approval":
		s.reqs <- data.(agentapprove.Request)
	case "agent-approval-dismiss":
		s.dismiss <- data.(string)
	}
}

// drain evita que newChatApp bloquee el turno con su canal de eventos.
func drain(events chan agentchat.Event) {
	go func() {
		for range events {
		}
	}()
}

func waitSession(t *testing.T, a *App, id string, ok func(agentchat.AgentSessionInfo) bool) agentchat.AgentSessionInfo {
	t.Helper()
	for i := 0; i < 400; i++ {
		list, err := a.ListAgentSessions()
		if err != nil {
			t.Fatal(err)
		}
		for _, s := range list {
			if s.SessionID == id && ok(s) {
				return s
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("la sesión %s no llegó al estado esperado", id)
	return agentchat.AgentSessionInfo{}
}

func TestPendingApprovalsAndSessionLifecycle(t *testing.T) {
	a, events := newChatApp(t)
	drain(events)
	sink := newApprovalSink()
	a.approvalEmit = sink.emit
	if err := a.vault.CreateAgentChat("chat-1", "", "llm:x", "Revisar el repo", "utilities", ""); err != nil {
		t.Fatal(err)
	}

	err := a.sendRecorded("utilities", "", "revisá el repo", agentchat.Turn{
		SessionID: "chat-1", AgentID: "llm:x", AgentLabel: "Ollama", Prompt: "revisá el repo", LLM: &toolOnceLLM{},
		Tools: []llm.ToolDef{{Name: "write_file", Parameters: map[string]any{"type": "object"}}},
		RunTool: func(ctx context.Context, _ string, _ map[string]any) (string, error) {
			d := a.askApprovalCtx(ctx, agentapprove.Request{Tool: "write_file", Summary: "a.txt"})
			if !d.Allow {
				return "", context.Canceled
			}
			return "escrito", nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	var req agentapprove.Request
	select {
	case req = <-sink.reqs:
	case <-time.After(5 * time.Second):
		t.Fatal("no llegó la pregunta de permiso")
	}
	// La pregunta sabe de qué chat es aunque nadie tenga su pestaña abierta.
	if req.SessionID != "chat-1" || req.Title != "Revisar el repo" || req.AgentLabel != "Ollama" || req.CreatedAt == 0 {
		t.Fatalf("pregunta sin rótulos: %+v", req)
	}

	// Una interfaz que se monta después la ve.
	pending, err := a.ListPendingApprovals()
	if err != nil || len(pending) != 1 || pending[0].ID != req.ID || pending[0].SessionID != "chat-1" {
		t.Fatalf("pendientes = %+v (%v)", pending, err)
	}
	s := waitSession(t, a, "chat-1", func(s agentchat.AgentSessionInfo) bool { return s.Status == agentchat.StatusAwaitingApproval })
	if s.PendingApprovalID != req.ID || s.Title != "Revisar el repo" || s.Module != "utilities" {
		t.Fatalf("sesión esperando: %+v", s)
	}

	if err := a.RespondAgentApproval(req.ID, true, ""); err != nil {
		t.Fatal(err)
	}
	s = waitSession(t, a, "chat-1", func(s agentchat.AgentSessionInfo) bool { return s.Status == agentchat.StatusIdle })
	if !s.Unread || !strings.Contains(s.LastText, "hecho") {
		t.Fatalf("terminada: %+v", s)
	}
	if pending, _ = a.ListPendingApprovals(); len(pending) != 0 {
		t.Fatalf("contestada ya no figura: %+v", pending)
	}

	// El turno se grabó en el historial aunque nadie estuviera mirando.
	msgs, err := a.vault.ListAgentChatMessages("chat-1")
	if err != nil || len(msgs) < 3 {
		t.Fatalf("historial = %d filas (%v)", len(msgs), err)
	}

	replay, err := a.AgentSessionReplay("chat-1")
	if err != nil || len(replay) == 0 || replay[0].Seq == 0 {
		t.Fatalf("replay = %+v (%v)", replay, err)
	}

	if err := a.MarkAgentSessionRead("chat-1"); err != nil {
		t.Fatal(err)
	}
	if list, _ := a.ListAgentSessions(); len(list) != 0 {
		t.Fatalf("leída no se lista: %+v", list)
	}
}

// La pregunta de un CLI (hook) con su sesión: se descarta sola al cortar el
// turno, en vez de quedar esperando para siempre.
func TestCLIApprovalDismissedWhenTurnCancelled(t *testing.T) {
	a, events := newChatApp(t)
	drain(events)
	sink := newApprovalSink()
	a.approvalEmit = sink.emit

	if err := a.sendRecorded("utilities", "", "hola", agentchat.Turn{SessionID: "cli-1", AgentID: "llm:x", Prompt: "hola", LLM: blockLLM{}}); err != nil {
		t.Fatal(err)
	}
	waitSession(t, a, "cli-1", func(s agentchat.AgentSessionInfo) bool { return s.Status == agentchat.StatusRunning })

	got := make(chan agentapprove.Decision, 1)
	go func() {
		got <- a.askApproval(agentapprove.Request{ID: "approve-9", Tool: "Bash", SessionID: "cli-1"})
	}()
	req := <-sink.reqs
	if req.ID != "approve-9" || req.SessionID != "cli-1" {
		t.Fatalf("pregunta: %+v", req)
	}
	waitSession(t, a, "cli-1", func(s agentchat.AgentSessionInfo) bool { return s.PendingApprovalID == "approve-9" })

	a.agentChats.Cancel("cli-1")
	select {
	case d := <-got:
		if d.Allow {
			t.Fatal("cortar el turno deniega")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("la pregunta siguió esperando tras cortar el turno")
	}
	if id := <-sink.dismiss; id != "approve-9" {
		t.Fatalf("dismiss = %q", id)
	}
	if pending, _ := a.ListPendingApprovals(); len(pending) != 0 {
		t.Fatalf("quedó pendiente: %+v", pending)
	}
}

// Sin sesión conocida la pregunta se muestra igual, sin rótulo.
func TestApprovalWithoutSessionStillListed(t *testing.T) {
	a, _ := newChatApp(t)
	sink := newApprovalSink()
	a.approvalEmit = sink.emit
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		a.askApprovalWith(ctx, agentapprove.Request{Tool: "Bash"}, time.Minute, sink.emit)
		close(done)
	}()
	req := <-sink.reqs
	if req.SessionID != "" || !strings.HasPrefix(req.ID, "llm-approve-") {
		t.Fatalf("req = %+v", req)
	}
	if pending, _ := a.ListPendingApprovals(); len(pending) != 1 {
		t.Fatalf("pendientes = %+v", pending)
	}
	cancel()
	<-done
}

// Cerrar la pestaña no cierra el chat: el binding Detach lo deja abierto en
// segundo plano; solo CloseAgentSession lo quita.
func TestDetachKeepsChatListedUntilClosed(t *testing.T) {
	a, events := newChatApp(t)
	drain(events)
	if err := a.vault.CreateAgentChat("bg-1", "", "llm:x", "Revisar", "utilities", ""); err != nil {
		t.Fatal(err)
	}
	if err := a.AttachAgentSession("bg-1"); err != nil {
		t.Fatal(err)
	}
	if err := a.sendRecorded("utilities", "", "hola", agentchat.Turn{SessionID: "bg-1", AgentID: "llm:x", Prompt: "hola", LLM: blockLLM{}}); err != nil {
		t.Fatal(err)
	}
	waitSession(t, a, "bg-1", func(s agentchat.AgentSessionInfo) bool { return s.Status == agentchat.StatusRunning && s.Attached })

	if err := a.DetachAgentSession("bg-1"); err != nil {
		t.Fatal(err)
	}
	s := waitSession(t, a, "bg-1", func(s agentchat.AgentSessionInfo) bool { return s.Detached })
	if s.Status != agentchat.StatusRunning || s.Attached || !a.agentChats.Busy("bg-1") {
		t.Fatalf("cerrar la pestaña no corta el turno: %+v", s)
	}

	if err := a.CloseAgentSession("bg-1"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 400 && a.agentChats.Busy("bg-1"); i++ {
		time.Sleep(5 * time.Millisecond)
	}
	if a.agentChats.Busy("bg-1") {
		t.Fatal("cerrar el chat corta el turno")
	}
	if list, _ := a.ListAgentSessions(); len(list) != 0 {
		t.Fatalf("cerrado no se lista: %+v", list)
	}
	// La entrada del historial sigue: el chat se puede volver a abrir.
	if chats, err := a.vault.ListAllAgentChats(); err != nil || len(chats) != 1 {
		t.Fatalf("historial = %d (%v)", len(chats), err)
	}
}
