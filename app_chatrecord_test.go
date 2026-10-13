package main

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"mini-tools/backend/agentchat"
	"mini-tools/backend/appdata"
	"mini-tools/backend/llm"
	"mini-tools/backend/vault"
	"mini-tools/backend/vaultgate"
)

// fakeChatLLM contesta con un texto fijo (o falla) y guarda lo que recibe.
type fakeChatLLM struct {
	mu       sync.Mutex
	reply    string
	err      error
	requests []llm.ChatRequest
}

func (f *fakeChatLLM) Version(context.Context) (string, error)  { return "t", nil }
func (f *fakeChatLLM) Models(context.Context) ([]string, error) { return []string{"m"}, nil }
func (f *fakeChatLLM) Chat(_ context.Context, req llm.ChatRequest, on func(llm.Delta)) (llm.ChatResult, error) {
	f.mu.Lock()
	f.requests = append(f.requests, req)
	f.mu.Unlock()
	if f.err != nil {
		return llm.ChatResult{}, f.err
	}
	if on != nil {
		on(llm.Delta{Text: f.reply})
	}
	return llm.ChatResult{Message: llm.Message{Role: llm.RoleAssistant, Content: f.reply}, Usage: llm.Usage{Input: 7, Output: 3}, Model: req.Model}, nil
}

func newChatApp(t *testing.T) (*App, chan agentchat.Event) {
	t.Helper()
	t.Setenv(appdata.OverrideEnv, t.TempDir())
	// Las instrucciones y skills globales (~/.claude…) no se leen del home real
	// de quien corre las pruebas.
	llmProjectHome = t.TempDir()
	t.Cleanup(func() { llmProjectHome = "" })
	gate := vaultgate.New()
	store, err := vault.Open(gate)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	if err := store.Initialize("correct-horse"); err != nil {
		t.Fatal(err)
	}
	a := &App{gate: gate, vault: store}
	events := make(chan agentchat.Event, 32)
	a.agentChats = agentchat.NewManager(func(sessionID string, ev agentchat.Event) {
		a.recordChatEvent(sessionID, ev)
		events <- ev
	})
	a.wireChatStatus()
	return a, events
}

func waitTurnEnd(t *testing.T, a *App, events chan agentchat.Event, session string) {
	t.Helper()
	timeout := time.After(5 * time.Second)
	for {
		select {
		case ev := <-events:
			if ev.Kind == agentchat.KindDone || ev.Kind == agentchat.KindError {
				for i := 0; i < 200 && a.agentChats.Busy(session); i++ {
					time.Sleep(5 * time.Millisecond)
				}
				return
			}
		case <-timeout:
			t.Fatal("el turno no terminó")
		}
	}
}

func sendLLM(t *testing.T, a *App, f *fakeChatLLM, session, typed string) {
	t.Helper()
	err := a.sendRecorded("note", "n1", typed, agentchat.Turn{
		SessionID: session, AgentID: "llm:x", Prompt: typed + " [EXPANDIDO]", LLM: f,
		History: agentchat.SeedHistory(a.llmSeedHistory(session), llmSeedMessages, llmSeedChars),
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestSendRecordedStoresTurnAndCreatesChatRow(t *testing.T) {
	a, events := newChatApp(t)
	f := &fakeChatLLM{reply: "Hola Ana"}

	sendLLM(t, a, f, "chat-1", "mi nombre es Ana\nsegunda línea")
	waitTurnEnd(t, a, events, "chat-1")

	// La fila del chat la creó el App (el frontend no pasó por acá).
	chats, _ := a.vault.ListAllAgentChats()
	if len(chats) != 1 || chats[0].ID != "chat-1" || chats[0].AgentID != "llm:x" || chats[0].Title != "mi nombre es Ana" ||
		chats[0].Module != "note" || chats[0].ContextID != "n1" || chats[0].RepoID != "" {
		t.Fatalf("chats = %+v", chats)
	}

	msgs, err := a.AgentChatMessages("chat-1")
	if err != nil || len(msgs) != 2 {
		t.Fatalf("msgs = %+v, %v", msgs, err)
	}
	// Se guarda lo escrito, no lo que se le mandó al modelo.
	if msgs[0].Role != "user" || msgs[0].Content != "mi nombre es Ana\nsegunda línea" || strings.Contains(msgs[0].Content, "EXPANDIDO") {
		t.Fatalf("user: %+v", msgs[0])
	}
	if msgs[1].Role != "assistant" || msgs[1].Content != "Hola Ana" || msgs[1].Usage == nil || msgs[1].Usage.Total != 10 || msgs[1].Seq != 2 {
		t.Fatalf("assistant: %+v", msgs[1])
	}
	// El modelo sí recibió el prompt expandido.
	if got := f.requests[0].Messages; got[len(got)-1].Content != "mi nombre es Ana\nsegunda línea [EXPANDIDO]" {
		t.Fatalf("prompt al modelo: %+v", got)
	}

	// AgentChatHistory lee del vault también para un llm: (el id de conversación es el del chat).
	past, err := a.AgentChatHistory("llm:x", "chat-1")
	if err != nil || len(past) != 2 || past[0].Role != "user" || past[1].Role != "agent" || past[1].Text != "Hola Ana" {
		t.Fatalf("past = %+v, %v", past, err)
	}
}

func TestSendRecordedErrorIsStoredAndNotFedBack(t *testing.T) {
	a, events := newChatApp(t)

	bad := &fakeChatLLM{err: errors.New("servidor caído")}
	sendLLM(t, a, bad, "chat-1", "primera")
	waitTurnEnd(t, a, events, "chat-1")

	msgs, _ := a.AgentChatMessages("chat-1")
	if len(msgs) != 2 || msgs[0].Role != "user" || msgs[1].Role != "assistant" ||
		msgs[1].Content != agentchat.ErrorRowPrefix+"servidor caído" {
		t.Fatalf("msgs = %+v", msgs)
	}

	// El turno siguiente no arrastra el que falló.
	good := &fakeChatLLM{reply: "ok"}
	sendLLM(t, a, good, "chat-1", "segunda")
	waitTurnEnd(t, a, events, "chat-1")
	for _, m := range good.requests[0].Messages {
		if m.Content == "primera" || strings.HasPrefix(m.Content, agentchat.ErrorRowPrefix) {
			t.Fatalf("el turno fallido llegó al modelo: %+v", good.requests[0].Messages)
		}
	}
	msgs, _ = a.AgentChatMessages("chat-1")
	if len(msgs) != 4 || msgs[2].Content != "segunda" || msgs[3].Content != "ok" {
		t.Fatalf("msgs = %+v", msgs)
	}
}

// Después de reiniciar la app el Manager no tiene memoria: el contexto sale del vault.
func TestResumedChatSeedsModelFromVault(t *testing.T) {
	a, events := newChatApp(t)
	f1 := &fakeChatLLM{reply: "Hola Ana"}
	sendLLM(t, a, f1, "chat-1", "mi nombre es Ana")
	waitTurnEnd(t, a, events, "chat-1")

	// "Reinicio": otro Manager sin memoria, mismo vault.
	a.agentChats = agentchat.NewManager(func(sessionID string, ev agentchat.Event) {
		a.recordChatEvent(sessionID, ev)
		events <- ev
	})
	f2 := &fakeChatLLM{reply: "Ana"}
	sendLLM(t, a, f2, "chat-1", "¿cómo me llamo?")
	waitTurnEnd(t, a, events, "chat-1")

	got := f2.requests[0].Messages
	if len(got) != 4 || got[1].Content != "mi nombre es Ana" || got[2].Content != "Hola Ana" || !strings.HasPrefix(got[3].Content, "¿cómo me llamo?") {
		t.Fatalf("contexto sembrado: %+v", got)
	}
	// Y el mensaje nuevo no quedó duplicado en el historial.
	msgs, _ := a.AgentChatMessages("chat-1")
	if len(msgs) != 4 {
		t.Fatalf("msgs = %+v", msgs)
	}
}

func TestSendRecordedBusySessionDoesNotRecord(t *testing.T) {
	a, events := newChatApp(t)
	block := make(chan struct{})
	slow := &blockingChatLLM{release: block}
	if err := a.sendRecorded("db", "", "uno", agentchat.Turn{SessionID: "c", AgentID: "llm:x", Prompt: "uno", LLM: slow}); err != nil {
		t.Fatal(err)
	}
	// Con el primer turno en curso, un segundo envío se rechaza y no escribe nada.
	if err := a.sendRecorded("db", "", "dos", agentchat.Turn{SessionID: "c", AgentID: "llm:x", Prompt: "dos", LLM: slow}); err == nil {
		t.Fatal("debería rechazarse por ocupada")
	}
	close(block)
	waitTurnEnd(t, a, events, "c")
	msgs, _ := a.AgentChatMessages("c")
	if len(msgs) != 2 || msgs[0].Content != "uno" || msgs[1].Content != "listo" {
		t.Fatalf("msgs = %+v", msgs)
	}
}

type blockingChatLLM struct{ release chan struct{} }

func (b *blockingChatLLM) Version(context.Context) (string, error)  { return "", nil }
func (b *blockingChatLLM) Models(context.Context) ([]string, error) { return []string{"m"}, nil }
func (b *blockingChatLLM) Chat(_ context.Context, req llm.ChatRequest, on func(llm.Delta)) (llm.ChatResult, error) {
	<-b.release
	on(llm.Delta{Text: "listo"})
	return llm.ChatResult{Message: llm.Message{Role: llm.RoleAssistant, Content: "listo"}, Model: req.Model}, nil
}

func TestResetAndDeleteChatDropMessages(t *testing.T) {
	a, events := newChatApp(t)
	sendLLM(t, a, &fakeChatLLM{reply: "r"}, "chat-1", "hola")
	waitTurnEnd(t, a, events, "chat-1")

	if err := a.ResetAgentChat("chat-1"); err != nil {
		t.Fatal(err)
	}
	if msgs, _ := a.AgentChatMessages("chat-1"); len(msgs) != 0 {
		t.Fatalf("Reset no borró: %+v", msgs)
	}
	if ok, _ := a.vault.AgentChatExists("chat-1"); !ok {
		t.Fatal("Reset no debe borrar la entrada del historial")
	}

	// Tras el Reset, el siguiente turno arranca sin contexto previo.
	f := &fakeChatLLM{reply: "r2"}
	sendLLM(t, a, f, "chat-1", "de cero")
	waitTurnEnd(t, a, events, "chat-1")
	if got := f.requests[0].Messages; len(got) != 2 {
		t.Fatalf("contexto tras reset: %+v", got)
	}

	if err := a.DeleteAgentChat("chat-1"); err != nil {
		t.Fatal(err)
	}
	if msgs, _ := a.AgentChatMessages("chat-1"); len(msgs) != 0 {
		t.Fatalf("Delete no borró: %+v", msgs)
	}
}

func TestSearchAgentChatsBinding(t *testing.T) {
	a, events := newChatApp(t)
	sendLLM(t, a, &fakeChatLLM{reply: "revisá el tablespace"}, "chat-1", "problema de espacio")
	waitTurnEnd(t, a, events, "chat-1")
	got, err := a.SearchAgentChats("TABLESPACE")
	if err != nil || len(got) != 1 || got[0].ID != "chat-1" {
		t.Fatalf("got=%+v err=%v", got, err)
	}
	if got, _ := a.SearchAgentChats("inexistente"); len(got) != 0 {
		t.Fatalf("got=%+v", got)
	}
}

func TestChatTitleFrom(t *testing.T) {
	if got := chatTitleFrom("  hola\nmundo"); got != "hola" {
		t.Fatalf("%q", got)
	}
	if got := chatTitleFrom(strings.Repeat("é", 100)); len([]rune(got)) != chatTitleMax {
		t.Fatalf("len=%d", len([]rune(got)))
	}
	if got := chatTitleFrom("  \n "); got == "" {
		t.Fatal("título vacío")
	}
	// Las referencias @tipo:valor y los bloques de código no son el título.
	if got := chatTitleFrom("@file:main.go  revisá   este error"); got != "revisá este error" {
		t.Fatalf("referencia en el título: %q", got)
	}
	if got := chatTitleFrom("```sql\nselect 1\n```\n¿por qué tarda?"); got != "¿por qué tarda?" {
		t.Fatalf("bloque de código en el título: %q", got)
	}
	// Solo una referencia: mejor ella que un título vacío.
	if got := chatTitleFrom("@db:Prod/clientes"); got != "@db:Prod/clientes" {
		t.Fatalf("solo referencia: %q", got)
	}
}

// El chat que se registró al abrirlo (módulo git) no tiene nombre: con el primer
// mensaje se nombra solo; uno que ya tiene nombre no se pisa.
func TestNameUntitledChat(t *testing.T) {
	a, _ := newChatApp(t)
	_ = a.vault.CreateAgentChat("s1", "r", "claude", "", "git", "r")
	a.nameUntitledChat("s1", "  ¿Cómo reviso los locks?\nsegunda línea")
	if got := a.vault.AgentChatTitle("s1"); got != "¿Cómo reviso los locks?" {
		t.Fatalf("título: %q", got)
	}
	a.nameUntitledChat("s1", "otro mensaje")
	if got := a.vault.AgentChatTitle("s1"); got != "¿Cómo reviso los locks?" {
		t.Fatalf("pisó un título existente: %q", got)
	}
}

func TestRenameAgentChatValidates(t *testing.T) {
	a, _ := newChatApp(t)
	_ = a.vault.CreateAgentChat("s1", "", "claude", "viejo", "utilities", "")
	if err := a.RenameAgentChat("s1", "   "); err == nil {
		t.Fatal("un nombre vacío tiene que rechazarse")
	}
	if got := a.vault.AgentChatTitle("s1"); got != "viejo" {
		t.Fatalf("el rechazo cambió el título: %q", got)
	}
	if err := a.RenameAgentChat("s1", "  Plan   de   migración  "); err != nil {
		t.Fatal(err)
	}
	if got := a.vault.AgentChatTitle("s1"); got != "Plan de migración" {
		t.Fatalf("título: %q", got)
	}
	if err := a.RenameAgentChat("s1", strings.Repeat("x", 300)); err != nil {
		t.Fatal(err)
	}
	if got := a.vault.AgentChatTitle("s1"); len([]rune(got)) != maxChatTitle {
		t.Fatalf("largo=%d", len([]rune(got)))
	}
}

// Un turno de CLI (eventos con herramientas) se graba igual, vía el gancho.
func TestRecordChatEventStoresToolsForCLIAgents(t *testing.T) {
	a, _ := newChatApp(t)
	_ = a.vault.CreateAgentChat("s1", "", "claude", "t", "git", "r")
	rt := a.beginChatTurn("s1", "arreglá el bug")
	a.writeChatUser("s1", rt)
	a.recordChatEvent("s1", agentchat.Event{Kind: agentchat.KindText, Text: "Miro "})
	a.recordChatEvent("s1", agentchat.Event{Kind: agentchat.KindTool, Tool: &agentchat.ToolCall{Name: "Read", Summary: "a.go"}})
	a.recordChatEvent("s1", agentchat.Event{Kind: agentchat.KindText, Text: "listo"})
	a.recordChatEvent("s1", agentchat.Event{Kind: agentchat.KindDone, Usage: &agentchat.Usage{Total: 5}})
	// Un evento tardío (p. ej. un error posterior al done) ya no se graba.
	a.recordChatEvent("s1", agentchat.Event{Kind: agentchat.KindError, Error: "tarde"})

	msgs, _ := a.AgentChatMessages("s1")
	if len(msgs) != 3 || msgs[0].Role != "user" || msgs[1].Role != "tool" || msgs[1].ToolName != "Read" ||
		msgs[1].Content != "a.go" || msgs[2].Content != "Miro listo" || msgs[2].Usage.Total != 5 {
		t.Fatalf("msgs = %+v", msgs)
	}
	past, _ := a.AgentChatHistory("claude", "") // sin conversación guardada: cae al CLI (vacío)
	if len(past) != 0 {
		t.Fatalf("past = %+v", past)
	}
}

// Un turno que nunca cerró se cierra como error cuando llega el siguiente.
func TestBeginChatTurnClosesLeakedTurn(t *testing.T) {
	a, _ := newChatApp(t)
	_ = a.vault.CreateAgentChat("s1", "", "claude", "t", "git", "r")
	rt := a.beginChatTurn("s1", "uno")
	a.writeChatUser("s1", rt)
	a.recordChatEvent("s1", agentchat.Event{Kind: agentchat.KindText, Text: "parcial"})
	a.beginChatTurn("s1", "dos")

	msgs, _ := a.AgentChatMessages("s1")
	if len(msgs) != 3 || msgs[1].Content != "parcial" || !strings.HasPrefix(msgs[2].Content, agentchat.ErrorRowPrefix) {
		t.Fatalf("msgs = %+v", msgs)
	}
}
