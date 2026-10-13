package main

import (
	"errors"
	"testing"
	"time"

	"mini-tools/backend/agentchat"
	"mini-tools/backend/vault"
)

// chatByID lee una conversación del vault (open o no).
func chatByID(t *testing.T, a *App, id string) (vault.AgentChat, bool) {
	t.Helper()
	all, err := a.vault.ListAllAgentChats()
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range all {
		if c.ID == id {
			return c, true
		}
	}
	return vault.AgentChat{}, false
}

// waitChatStatus espera a que last_status llegue (el gancho corre en la
// goroutine del turno, después de entregar el evento final).
func waitChatStatus(t *testing.T, a *App, id, want string) vault.AgentChat {
	t.Helper()
	var c vault.AgentChat
	for i := 0; i < 400; i++ {
		c, _ = chatByID(t, a, id)
		if c.LastStatus == want {
			return c
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("%s: last_status = %q, quería %q", id, c.LastStatus, want)
	return c
}

// Un chat nuevo existe desde que se crea la pestaña: figura en Abiertas sin
// título, con lo elegido, y el primer mensaje lo nombra SOLO si seguía sin
// nombre.
func TestNewChatIsPersistedAndFirstMessageNamesOnlyAnUntitledOne(t *testing.T) {
	a, events := newChatApp(t)
	if err := a.CreateAgentChatDraft("nuevo", "llm:x", "qwen3", "utilities", "ws:1"); err != nil {
		t.Fatal(err)
	}
	if err := a.CreateAgentChatDraft("nombrado", "llm:x", "", "utilities", ""); err != nil {
		t.Fatal(err)
	}
	if err := a.RenameAgentChat("nombrado", "Mi análisis"); err != nil {
		t.Fatal(err)
	}

	open, err := a.ListOpenAgentChats()
	if err != nil || len(open) != 2 {
		t.Fatalf("open = %+v, %v", open, err)
	}
	for _, c := range open {
		if c.ID == "nuevo" && (c.Title != "" || c.Model != "qwen3" || c.ContextID != "ws:1" || c.LastStatus != "" || !c.Open) {
			t.Errorf("borrador = %+v", c)
		}
	}

	sendLLMAs := func(id, text string) {
		f := &fakeChatLLM{reply: "ok"}
		if err := a.sendRecorded("utilities", "", text, agentchat.Turn{SessionID: id, AgentID: "llm:x", Prompt: text, LLM: f}); err != nil {
			t.Fatal(err)
		}
		waitTurnEnd(t, a, events, id)
	}
	sendLLMAs("nuevo", "revisá el módulo de pagos")
	sendLLMAs("nombrado", "otra cosa distinta")

	if c, _ := chatByID(t, a, "nuevo"); c.Title != "revisá el módulo de pagos" {
		t.Errorf("el primer mensaje nombra un chat sin título: %q", c.Title)
	}
	if c, _ := chatByID(t, a, "nombrado"); c.Title != "Mi análisis" {
		t.Errorf("un nombre elegido no se pisa: %q", c.Title)
	}
	// Siguen abiertos, y ya con estado.
	waitChatStatus(t, a, "nuevo", vault.ChatStatusIdle)
	if open, _ := a.ListOpenAgentChats(); len(open) != 2 {
		t.Errorf("seguían abiertos: %+v", open)
	}
}

func TestOpenPinnedBindingsAndRestartSemantics(t *testing.T) {
	a, _ := newChatApp(t)
	for _, id := range []string{"a", "b"} {
		if err := a.CreateAgentChatDraft(id, "llm:x", "", "utilities", ""); err != nil {
			t.Fatal(err)
		}
	}
	if err := a.SetAgentChatPinned("a", true); err != nil {
		t.Fatal(err)
	}
	// Un chat del historial (cerrado) se abre y se cierra con el binding.
	if err := a.vault.CreateAgentChat("hist", "", "llm:x", "viejo", "utilities", ""); err != nil {
		t.Fatal(err)
	}
	if err := a.SetAgentChatOpen("hist", true); err != nil {
		t.Fatal(err)
	}
	open, _ := a.ListOpenAgentChats()
	if len(open) != 3 || open[0].ID != "a" || !open[0].Pinned {
		t.Fatalf("las fijadas van primero: %+v", open)
	}
	if err := a.SetAgentChatOpen("hist", false); err != nil {
		t.Fatal(err)
	}
	if c, ok := chatByID(t, a, "hist"); !ok || c.Open {
		t.Errorf("cerrar deja la conversación en el historial: %+v ok=%v", c, ok)
	}
	if err := a.SetAgentChatPinned("fantasma", true); err == nil {
		t.Error("fijar una inexistente debe fallar")
	}
}

// Cerrar la app corta lo que corre pero deja la conversación abierta y marcada
// «interrumpida». Una que ya había terminado conserva su estado.
func TestShutdownMarksRunningChatsInterruptedAndKeepsThemOpen(t *testing.T) {
	a, events := newChatApp(t)
	drain(events)
	for _, id := range []string{"corre", "quieta"} {
		if err := a.CreateAgentChatDraft(id, "llm:x", "", "utilities", ""); err != nil {
			t.Fatal(err)
		}
	}
	// «quieta» termina bien.
	if err := a.sendRecorded("utilities", "", "hola", agentchat.Turn{SessionID: "quieta", AgentID: "llm:x", Prompt: "hola", LLM: &fakeChatLLM{reply: "ok"}}); err != nil {
		t.Fatal(err)
	}
	waitChatStatus(t, a, "quieta", vault.ChatStatusIdle)
	// «corre» queda bloqueado en el modelo.
	if err := a.sendRecorded("utilities", "", "trabajá", agentchat.Turn{SessionID: "corre", AgentID: "llm:x", Prompt: "trabajá", LLM: blockLLM{}}); err != nil {
		t.Fatal(err)
	}
	waitSession(t, a, "corre", func(s agentchat.AgentSessionInfo) bool { return s.Status == agentchat.StatusRunning })
	// Mientras corre ya figura como interrumpida: si el proceso muriera sin
	// cierre ordenado, eso es lo que le pasó.
	waitChatStatus(t, a, "corre", vault.ChatStatusInterrupted)

	a.stopChatsForShutdown(2 * time.Second)

	c, _ := chatByID(t, a, "corre")
	if c.LastStatus != vault.ChatStatusInterrupted || !c.Open {
		t.Errorf("corre = %+v", c)
	}
	// Dar un momento: el gancho del turno cortado no debe pisar «interrumpida».
	time.Sleep(60 * time.Millisecond)
	if c, _ := chatByID(t, a, "corre"); c.LastStatus != vault.ChatStatusInterrupted {
		t.Errorf("el corte del turno pisó el estado: %q", c.LastStatus)
	}
	if c, _ := chatByID(t, a, "quieta"); c.LastStatus != vault.ChatStatusIdle || !c.Open {
		t.Errorf("quieta = %+v", c)
	}
	// Al reabrir la app nada arranca solo: el registro nuevo está vacío y la
	// lista persistente conserva las dos.
	a.agentChats = agentchat.NewManager(func(string, agentchat.Event) {})
	if list, _ := a.ListAgentSessions(); len(list) != 0 {
		t.Errorf("nada corre solo al arrancar: %+v", list)
	}
	if open, _ := a.ListOpenAgentChats(); len(open) != 2 {
		t.Errorf("open = %+v", open)
	}
}

func TestTurnOutcomesArePersisted(t *testing.T) {
	a, events := newChatApp(t)
	drain(events)
	for _, id := range []string{"mal", "corte"} {
		if err := a.CreateAgentChatDraft(id, "llm:x", "", "utilities", ""); err != nil {
			t.Fatal(err)
		}
	}
	if err := a.sendRecorded("utilities", "", "x", agentchat.Turn{SessionID: "mal", AgentID: "llm:x", Prompt: "x", LLM: &fakeChatLLM{err: errors.New("servidor caído")}}); err != nil {
		t.Fatal(err)
	}
	waitChatStatus(t, a, "mal", vault.ChatStatusError)

	if err := a.sendRecorded("utilities", "", "x", agentchat.Turn{SessionID: "corte", AgentID: "llm:x", Prompt: "x", LLM: blockLLM{}}); err != nil {
		t.Fatal(err)
	}
	waitSession(t, a, "corte", func(s agentchat.AgentSessionInfo) bool { return s.Status == agentchat.StatusRunning })
	a.agentChats.Cancel("corte")
	waitChatStatus(t, a, "corte", vault.ChatStatusCancelled)
}

// Cerrar el chat (CloseAgentSession) lo saca de Abiertas pero conserva su
// historial; un borrador vacío se descarta. Eliminar lo borra todo, incluso una
// sesión que corría.
func TestCloseAndDeleteSemantics(t *testing.T) {
	a, events := newChatApp(t)
	drain(events)
	for _, id := range []string{"usado", "vacio", "corriendo"} {
		if err := a.CreateAgentChatDraft(id, "llm:x", "", "utilities", ""); err != nil {
			t.Fatal(err)
		}
	}
	if err := a.sendRecorded("utilities", "", "hola", agentchat.Turn{SessionID: "usado", AgentID: "llm:x", Prompt: "hola", LLM: &fakeChatLLM{reply: "ok"}}); err != nil {
		t.Fatal(err)
	}
	waitChatStatus(t, a, "usado", vault.ChatStatusIdle)
	if err := a.SetAgentChatPinned("usado", true); err != nil {
		t.Fatal(err)
	}

	if err := a.CloseAgentSession("usado"); err != nil {
		t.Fatal(err)
	}
	if c, ok := chatByID(t, a, "usado"); !ok || c.Open || c.Pinned {
		t.Errorf("usado = %+v ok=%v", c, ok)
	}
	if msgs, _ := a.AgentChatMessages("usado"); len(msgs) != 2 {
		t.Errorf("cerrar no borra el historial: %+v", msgs)
	}
	if err := a.CloseAgentSession("vacio"); err != nil {
		t.Fatal(err)
	}
	if _, ok := chatByID(t, a, "vacio"); ok {
		t.Error("un borrador vacío cerrado se descarta")
	}

	// Eliminar una conversación que está corriendo: se corta y desaparece.
	if err := a.sendRecorded("utilities", "", "largo", agentchat.Turn{SessionID: "corriendo", AgentID: "llm:x", Prompt: "largo", LLM: blockLLM{}}); err != nil {
		t.Fatal(err)
	}
	waitSession(t, a, "corriendo", func(s agentchat.AgentSessionInfo) bool { return s.Status == agentchat.StatusRunning })
	if err := a.DeleteAgentChat("corriendo"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(60 * time.Millisecond)
	if _, ok := chatByID(t, a, "corriendo"); ok {
		t.Error("eliminar borra la fila (el estado del turno cortado no la resucita)")
	}
	if msgs, _ := a.AgentChatMessages("corriendo"); len(msgs) != 0 {
		t.Errorf("mensajes huérfanos: %+v", msgs)
	}
	for _, s := range a.agentChats.Sessions() {
		if s.SessionID == "corriendo" {
			t.Error("la sesión viva debía salir del registro")
		}
	}
	// Una cerrada también se elimina.
	if err := a.DeleteAgentChat("usado"); err != nil {
		t.Fatal(err)
	}
	if _, ok := chatByID(t, a, "usado"); ok {
		t.Error("usado debía borrarse")
	}
}

// Cerrar una pestaña no toca nada del vault: ni Detach ni Attach cambian open.
func TestDetachingATabNeverClosesTheChat(t *testing.T) {
	a, _ := newChatApp(t)
	if err := a.CreateAgentChatDraft("x", "llm:x", "", "utilities", ""); err != nil {
		t.Fatal(err)
	}
	if err := a.AttachAgentSession("x"); err != nil {
		t.Fatal(err)
	}
	if err := a.DetachAgentSession("x"); err != nil {
		t.Fatal(err)
	}
	if c, ok := chatByID(t, a, "x"); !ok || !c.Open {
		t.Errorf("x = %+v ok=%v", c, ok)
	}
}
