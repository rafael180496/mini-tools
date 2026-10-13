package agentchat

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"mini-tools/backend/llm"
)

// infoOf lee el estado interno de una sesión.
func infoOf(m *Manager, id string) (AgentSessionInfo, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.reg[id]
	if e == nil {
		return AgentSessionInfo{}, false
	}
	return e.info, true
}

// waitInfo espera a que la sesión cumpla la condición (el estado final se
// asienta DESPUÉS de entregar el evento, así que no se puede leer de golpe).
func waitInfo(t *testing.T, m *Manager, id string, ok func(AgentSessionInfo) bool) AgentSessionInfo {
	t.Helper()
	for i := 0; i < 400; i++ {
		if info, found := infoOf(m, id); found && ok(info) {
			return info
		}
		time.Sleep(5 * time.Millisecond)
	}
	info, _ := infoOf(m, id)
	t.Fatalf("la sesión %s no llegó al estado esperado: %+v", id, info)
	return info
}

func TestSessionTransitionsRunningApprovalIdleUnread(t *testing.T) {
	inTool := make(chan struct{})
	proceed := make(chan struct{})
	f := &scriptLLM{steps: []func(llm.ChatRequest, func(llm.Delta)) (llm.ChatResult, error){
		say("Voy a leer.", 10, 2, call("c1", "read_file", map[string]any{"path": "x"})),
		say("Listo, ya lo leí.", 5, 3),
	}}
	col := newCollector()
	m := NewManager(col.emit)

	err := m.Send(Turn{
		SessionID: "s1", AgentID: "llm:x", AgentLabel: "Ollama", Title: "Mi chat", Module: "git", ContextID: "repo1",
		Mode: ModeApprove, Prompt: "leé", LLM: f, Tools: toolDefs,
		RunTool: func(ctx context.Context, _ string, _ map[string]any) (string, error) {
			close(inTool)
			<-proceed
			return "contenido", nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	<-inTool
	info := waitInfo(t, m, "s1", func(i AgentSessionInfo) bool { return i.Status == StatusRunning })
	if info.AgentID != "llm:x" || info.AgentLabel != "Ollama" || info.Title != "Mi chat" || info.Module != "git" ||
		info.ContextID != "repo1" || info.Mode != "approve" || info.ChatID != "s1" || info.Unread {
		t.Fatalf("rótulos de la sesión: %+v", info)
	}
	if info.StartedAt == 0 || info.TurnStartedAt == 0 || info.LastEventAt < info.TurnStartedAt {
		t.Fatalf("marcas de tiempo: %+v", info)
	}
	if info.Model != "m" || !strings.Contains(info.LastText, "Voy a leer") {
		t.Fatalf("modelo/vista previa: %+v", info)
	}

	// Una pregunta de permiso sin contestar frena la sesión.
	m.BeginApproval("s1", "a1")
	info, _ = infoOf(m, "s1")
	if info.Status != StatusAwaitingApproval || info.PendingApprovalID != "a1" {
		t.Fatalf("esperando aprobación: %+v", info)
	}
	m.BeginApproval("s1", "a2")
	m.EndApproval("s1", "a1")
	info, _ = infoOf(m, "s1")
	if info.Status != StatusAwaitingApproval || info.PendingApprovalID != "a2" {
		t.Fatalf("con otra pendiente sigue esperando, ahora por a2: %+v", info)
	}
	m.EndApproval("s1", "a2")
	info, _ = infoOf(m, "s1")
	if info.Status != StatusRunning || info.PendingApprovalID != "" {
		t.Fatalf("sin pendientes vuelve a running: %+v", info)
	}

	// Corriendo se lista.
	if l := m.Sessions(); len(l) != 1 || l[0].SessionID != "s1" {
		t.Fatalf("listado corriendo: %+v", l)
	}

	close(proceed)
	col.wait(t)
	info = waitInfo(t, m, "s1", func(i AgentSessionInfo) bool { return i.Status == StatusIdle })
	if !info.Unread || info.PendingApprovalID != "" {
		t.Fatalf("terminó: idle y sin leer: %+v", info)
	}
	if info.Usage == nil || info.Usage.Total == 0 {
		t.Fatalf("el uso del turno debería estar al terminar: %+v", info.Usage)
	}
	if !strings.Contains(info.LastText, "Listo") {
		t.Fatalf("vista previa: %q", info.LastText)
	}
	if l := m.Sessions(); len(l) != 1 {
		t.Fatalf("terminada sin leer sigue en el listado: %+v", l)
	}

	// Leída deja el listado, pero el registro la conserva para el reenganche.
	m.MarkRead("s1")
	if l := m.Sessions(); len(l) != 0 {
		t.Fatalf("leída no se lista: %+v", l)
	}
	if r := m.Replay("s1"); len(r) == 0 {
		t.Fatal("el último turno debería seguir disponible para Replay")
	}

	// Un turno nuevo la vuelve a abrir, sin leer=false y con búfer nuevo.
	f2 := &scriptLLM{steps: []func(llm.ChatRequest, func(llm.Delta)) (llm.ChatResult, error){say("otra", 1, 1)}}
	if err := m.Send(Turn{SessionID: "s1", AgentID: "llm:x", Prompt: "dale", LLM: f2}); err != nil {
		t.Fatal(err)
	}
	col.wait(t)
	waitInfo(t, m, "s1", func(i AgentSessionInfo) bool { return i.Status == StatusIdle && i.Unread })
	for _, e := range m.Replay("s1") {
		if e.Kind == KindTool {
			t.Fatalf("el búfer es del turno nuevo: %+v", e)
		}
	}
}

func TestSessionErrorAndCancelled(t *testing.T) {
	col := newCollector()
	m := NewManager(col.emit)
	if err := m.Send(Turn{SessionID: "e", AgentID: "llm:x", Prompt: "x", LLM: &fakeLLM{models: []string{"m"}, err: errors.New("boom")}}); err != nil {
		t.Fatal(err)
	}
	col.wait(t)
	info := waitInfo(t, m, "e", func(i AgentSessionInfo) bool { return i.Status == StatusError })
	if !info.Unread || info.Error == "" {
		t.Fatalf("un fallo queda sin leer y con su mensaje: %+v", info)
	}

	// Cortarlo a mano: cancelled, y NO sin leer (lo hizo la persona).
	block := &fakeLLM{models: []string{"m"}, block: make(chan struct{})}
	if err := m.Send(Turn{SessionID: "c", AgentID: "llm:x", Prompt: "x", LLM: block}); err != nil {
		t.Fatal(err)
	}
	waitInfo(t, m, "c", func(i AgentSessionInfo) bool { return i.Status == StatusRunning })
	m.Cancel("c")
	col.wait(t)
	info = waitInfo(t, m, "c", func(i AgentSessionInfo) bool { return i.Status == StatusCancelled })
	if info.Unread {
		t.Fatalf("cancelar a mano no deja sin leer: %+v", info)
	}
	for _, s := range m.Sessions() {
		if s.SessionID == "c" {
			t.Fatal("una sesión cancelada y leída no se lista")
		}
	}

	// Reset la saca del registro.
	m.Reset("e")
	if _, ok := infoOf(m, "e"); ok {
		t.Fatal("Reset debería olvidar la sesión")
	}
}

func TestReplayCoalescesTextAndSeqIsMonotonic(t *testing.T) {
	f := &fakeLLM{models: []string{"m"}, reply: "uno dos tres cuatro", thinking: "pienso"}
	col := newCollector()
	m := NewManager(col.emit)
	if err := m.Send(Turn{SessionID: "r", AgentID: "llm:x", Prompt: "x", LLM: f}); err != nil {
		t.Fatal(err)
	}
	live := col.wait(t)
	waitInfo(t, m, "r", func(i AgentSessionInfo) bool { return i.Status == StatusIdle })

	var last int64
	for _, e := range live {
		if e.Seq <= last {
			t.Fatalf("seq no monótono en vivo: %d tras %d", e.Seq, last)
		}
		last = e.Seq
	}

	rep := m.Replay("r")
	// start, thinking (1 solo), text (1 solo), done.
	kinds := []EventKind{}
	for _, e := range rep {
		kinds = append(kinds, e.Kind)
	}
	if len(rep) != 4 || kinds[0] != KindStart || kinds[1] != KindThinking || kinds[2] != KindText || kinds[3] != KindDone {
		t.Fatalf("replay = %v", kinds)
	}
	if rep[2].Text != "uno dos tres cuatro" {
		t.Fatalf("los deltas de texto se funden en uno: %q", rep[2].Text)
	}
	prev := int64(0)
	for _, e := range rep {
		if e.Seq <= prev {
			t.Fatalf("seq del replay no monótono: %+v", rep)
		}
		prev = e.Seq
	}
	// El seq del texto fundido es el de su último delta: un evento en vivo con
	// seq <= ese se ignora, y el que sigue (done) no.
	var lastTextLive int64
	for _, e := range live {
		if e.Kind == KindText {
			lastTextLive = e.Seq
		}
	}
	if rep[2].Seq != lastTextLive {
		t.Fatalf("seq del texto fundido = %d, el último delta en vivo = %d", rep[2].Seq, lastTextLive)
	}
	if rep[3].Seq != live[len(live)-1].Seq {
		t.Fatal("el done del replay es el mismo evento que el vivo")
	}

	if got := m.Replay("no-existe"); got == nil || len(got) != 0 {
		t.Fatalf("sesión desconocida: lista vacía, no nil: %#v", got)
	}
}

func TestReplayBounds(t *testing.T) {
	// Por cantidad.
	e := &sessionEntry{}
	for i := int64(1); i <= replayMaxEvents+500; i++ {
		e.appendReplay(Event{Kind: KindTool, Seq: i, Tool: &ToolCall{Name: "t"}})
	}
	if len(e.buf) != replayMaxEvents {
		t.Fatalf("tope de eventos: %d", len(e.buf))
	}
	if e.buf[0].Seq != 501 || e.buf[len(e.buf)-1].Seq != replayMaxEvents+500 {
		t.Fatalf("se descarta del principio: %d..%d", e.buf[0].Seq, e.buf[len(e.buf)-1].Seq)
	}

	// Por bytes.
	e = &sessionEntry{}
	big := strings.Repeat("x", 100<<10)
	for i := int64(1); i <= 40; i++ {
		e.appendReplay(Event{Kind: KindTool, Seq: i, Tool: &ToolCall{Name: "t", Input: big}})
	}
	if e.bufBytes > replayMaxBytes || len(e.buf) >= 40 || e.buf[len(e.buf)-1].Seq != 40 {
		t.Fatalf("tope de bytes: %d bytes, %d eventos", e.bufBytes, len(e.buf))
	}

	// Un único texto fundido que excede el tope conserva el final y no corta
	// un carácter a la mitad.
	e = &sessionEntry{}
	chunk := strings.Repeat("ñ", 600<<10) // 2 bytes por runa
	for i := int64(1); i <= 4; i++ {
		e.appendReplay(Event{Kind: KindText, Seq: i, Text: chunk})
	}
	if len(e.buf) != 1 || e.buf[0].Seq != 4 {
		t.Fatalf("el texto contiguo es un solo evento: %d", len(e.buf))
	}
	txt := e.buf[0].Text
	if len(txt) > replayMaxBytes || !strings.HasPrefix(txt, "ñ") || strings.ContainsRune(txt, '�') {
		t.Fatalf("texto recortado mal: %d bytes", len(txt))
	}

	// Texto y razonamiento intercalados NO se funden entre sí.
	e = &sessionEntry{}
	e.appendReplay(Event{Kind: KindText, Seq: 1, Text: "a"})
	e.appendReplay(Event{Kind: KindThinking, Seq: 2, Text: "b"})
	e.appendReplay(Event{Kind: KindText, Seq: 3, Text: "c"})
	if len(e.buf) != 3 {
		t.Fatalf("no se funden tipos distintos: %d", len(e.buf))
	}
}

func TestLastTextKeepsTail(t *testing.T) {
	if got := tailRunes(strings.Repeat("á", 500), lastTextRunes); len([]rune(got)) != lastTextRunes {
		t.Fatalf("tailRunes: %d runas", len([]rune(got)))
	}
	if tailRunes("corto", lastTextRunes) != "corto" {
		t.Fatal("lo corto no se toca")
	}
}

func TestSessionsBroadcastThrottled(t *testing.T) {
	m := NewManager(func(string, Event) {})
	m.bcEvery = 60 * time.Millisecond
	var mu sync.Mutex
	var got [][]AgentSessionInfo
	m.SetSessionsEmitter(func(l []AgentSessionInfo) {
		mu.Lock()
		got = append(got, l)
		mu.Unlock()
	})

	m.beginTurn(context.Background(), Turn{SessionID: "b", AgentID: "llm:x"})
	start := time.Now()
	for i := 0; i < 200; i++ {
		m.BeginApproval("b", "p")
		m.EndApproval("b", "p")
	}
	m.BeginApproval("b", "final")
	time.Sleep(200 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	// 400+ cambios en unos pocos ms: como mucho una difusión por intervalo.
	maxExpected := int(time.Since(start)/m.bcEvery) + 2
	if len(got) == 0 || len(got) > maxExpected || len(got) > 6 {
		t.Fatalf("difusiones = %d (máximo esperado %d)", len(got), maxExpected)
	}
	// La última palabra siempre sale (extremo final de la ventana).
	last := got[len(got)-1]
	if len(last) != 1 || last[0].Status != StatusAwaitingApproval || last[0].PendingApprovalID != "final" {
		t.Fatalf("la última difusión tiene que reflejar el estado final: %+v", last)
	}
}

func TestSessionsBroadcastNilEmitterAndShutdown(t *testing.T) {
	m := NewManager(func(string, Event) {})
	m.beginTurn(context.Background(), Turn{SessionID: "n"}) // sin emisor: no hace nada

	var n atomic.Int32
	m.bcEvery = time.Millisecond
	m.SetSessionsEmitter(func([]AgentSessionInfo) { n.Add(1) })
	m.Shutdown(10 * time.Millisecond)
	m.BeginApproval("n", "x")
	time.Sleep(20 * time.Millisecond)
	if n.Load() != 0 {
		t.Fatal("tras Shutdown no se difunde más")
	}
}

func TestSessionTTLPrunesIdleReadSessions(t *testing.T) {
	now := time.Now()
	m := NewManager(func(string, Event) {})
	m.now = func() time.Time { return now }

	mk := func(id, status string, unread bool) {
		m.mu.Lock()
		m.registryLocked()[id] = &sessionEntry{info: AgentSessionInfo{SessionID: id, Status: status, Unread: unread, LastEventAt: now.UnixMilli()}}
		m.mu.Unlock()
	}
	mk("idle-read", StatusIdle, false)
	mk("idle-unread", StatusIdle, true)
	mk("running", StatusRunning, false)
	mk("cancelled", StatusCancelled, false)

	now = now.Add(29 * time.Minute)
	if _, ok := infoOf(m, "idle-read"); !ok {
		t.Fatal("antes de los 30 minutos sigue")
	}
	m.Sessions() // poda perezosa
	if _, ok := infoOf(m, "idle-read"); !ok {
		t.Fatal("a los 29 minutos sigue")
	}

	now = now.Add(2 * time.Minute)
	list := m.Sessions()
	for _, id := range []string{"idle-read", "cancelled"} {
		if _, ok := infoOf(m, id); ok {
			t.Fatalf("%s pasó los 30 minutos leída: debería haberse podado", id)
		}
	}
	// Lo que reclama atención no caduca por inactividad.
	if _, ok := infoOf(m, "idle-unread"); !ok {
		t.Fatal("sin leer no se poda")
	}
	if _, ok := infoOf(m, "running"); !ok {
		t.Fatal("corriendo no se poda")
	}
	if len(list) != 2 || list[0].SessionID != "idle-unread" && list[1].SessionID != "idle-unread" {
		t.Fatalf("listado = %+v", list)
	}
	if r := m.Replay("idle-read"); len(r) != 0 {
		t.Fatalf("replay de una podada: %v", r)
	}
}

func TestShutdownCancelsRunningTurnsAndWaits(t *testing.T) {
	col := newCollector()
	m := NewManager(col.emit)
	block := &fakeLLM{models: []string{"m"}, block: make(chan struct{})}
	if err := m.Send(Turn{SessionID: "k", AgentID: "llm:x", Prompt: "x", LLM: block}); err != nil {
		t.Fatal(err)
	}
	waitInfo(t, m, "k", func(i AgentSessionInfo) bool { return i.Status == StatusRunning })

	start := time.Now()
	m.Shutdown(3 * time.Second)
	if time.Since(start) > 2*time.Second {
		t.Fatal("Shutdown debería volver apenas terminan los turnos cortados")
	}
	if m.Busy("k") {
		t.Fatal("el turno tendría que haber terminado")
	}
	evs := col.wait(t)
	if last := evs[len(evs)-1]; last.Kind != KindError {
		t.Fatalf("el turno cortado emite su error final (App lo graba): %+v", last)
	}
	info, _ := infoOf(m, "k")
	if info.Status != StatusCancelled {
		t.Fatalf("estado tras Shutdown: %+v", info)
	}
}

func TestTurnContextCarriesSessionAndCancels(t *testing.T) {
	col := newCollector()
	m := NewManager(col.emit)
	var seen string
	inTool := make(chan struct{})
	f := &scriptLLM{steps: []func(llm.ChatRequest, func(llm.Delta)) (llm.ChatResult, error){
		say("", 1, 1, call("c1", "read_file", map[string]any{"path": "x"})),
		say("ok", 1, 1),
	}}
	if err := m.Send(Turn{
		SessionID: "ctx", AgentID: "llm:x", Prompt: "x", LLM: f, Tools: toolDefs,
		RunTool: func(ctx context.Context, _ string, _ map[string]any) (string, error) {
			seen = SessionIDFromContext(ctx)
			close(inTool)
			return "ok", nil
		},
	}); err != nil {
		t.Fatal(err)
	}
	<-inTool
	col.wait(t)
	if seen != "ctx" {
		t.Fatalf("la herramienta ve la sesión en su ctx: %q", seen)
	}
	waitInfo(t, m, "ctx", func(i AgentSessionInfo) bool { return i.Status == StatusIdle })
	if m.TurnContext("ctx").Err() != nil || m.TurnContext("nope").Err() != nil {
		t.Fatal("sin turno vivo el contexto no se cancela")
	}

	block := &fakeLLM{models: []string{"m"}, block: make(chan struct{})}
	if err := m.Send(Turn{SessionID: "ctx2", AgentID: "llm:x", Prompt: "x", LLM: block}); err != nil {
		t.Fatal(err)
	}
	waitInfo(t, m, "ctx2", func(i AgentSessionInfo) bool { return i.Status == StatusRunning })
	tc := m.TurnContext("ctx2")
	m.Cancel("ctx2")
	select {
	case <-tc.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("cancelar el turno cancela su contexto")
	}
	col.wait(t)
}

// Cerrar la pestaña de un chat que trabaja NO lo corta: queda detached, sigue
// corriendo, y al terminar sigue listado (idle y leído) hasta que se lo cierra.
func TestDetachedSessionSurvivesTabCloseAndStaysListed(t *testing.T) {
	block := &fakeLLM{models: []string{"m"}, block: make(chan struct{})}
	col := newCollector()
	m := NewManager(col.emit)
	m.AttachSession("d1") // la pestaña lo adjunta ANTES de que exista el turno
	if err := m.Send(Turn{SessionID: "d1", AgentID: "llm:x", Title: "Largo", Prompt: "x", LLM: block}); err != nil {
		t.Fatal(err)
	}
	info := waitInfo(t, m, "d1", func(i AgentSessionInfo) bool { return i.Status == StatusRunning })
	if !info.Attached || info.Detached {
		t.Fatalf("con pestaña: attached=%v detached=%v", info.Attached, info.Detached)
	}

	// Se cierra la pestaña: el turno sigue y la sesión queda abierta en
	// segundo plano.
	m.DetachSession("d1")
	info, _ = infoOf(m, "d1")
	if info.Attached || !info.Detached || info.Status != StatusRunning || !m.Busy("d1") {
		t.Fatalf("detach no debe cortar el turno: %+v busy=%v", info, m.Busy("d1"))
	}

	// Terminarlo a mano (Detener) NO cierra el chat: sigue listado.
	m.Cancel("d1")
	col.wait(t)
	waitInfo(t, m, "d1", func(i AgentSessionInfo) bool { return i.Status == StatusCancelled })
	found := false
	for _, s := range m.Sessions() {
		if s.SessionID == "d1" {
			found = s.Detached && !s.Unread
		}
	}
	if !found {
		t.Fatalf("detenida y detached sigue listada: %+v", m.Sessions())
	}
}

func TestDetachedIdleSessionDoesNotExpireUntilClosed(t *testing.T) {
	now := time.Now()
	m := NewManager(func(string, Event) {})
	m.now = func() time.Time { return now }
	mk := func(id string, attached, detached bool) {
		m.mu.Lock()
		m.registryLocked()[id] = &sessionEntry{info: AgentSessionInfo{SessionID: id, Status: StatusIdle, Attached: attached, Detached: detached, LastEventAt: now.UnixMilli()}}
		m.mu.Unlock()
	}
	mk("det", false, true)
	mk("att", true, false)
	mk("none", false, false)

	now = now.Add(3 * time.Hour)
	list := m.Sessions()
	if _, ok := infoOf(m, "none"); ok {
		t.Fatal("sin pestaña ni marca de abierta caduca")
	}
	if _, ok := infoOf(m, "att"); !ok {
		t.Fatal("una sesión que una pestaña muestra no caduca: al cerrar la pestaña tiene que poder quedar detached")
	}
	if len(list) != 1 || list[0].SessionID != "det" {
		t.Fatalf("se lista la detached y no la attached quieta: %+v", list)
	}

	// Cerrar de verdad la saca.
	m.CloseSession("det")
	if _, ok := infoOf(m, "det"); ok || len(m.Sessions()) != 0 {
		t.Fatal("CloseSession quita la sesión del registro")
	}
}

func TestCloseSessionCancelsRunningTurnAndDropsMemory(t *testing.T) {
	col := newCollector()
	m := NewManager(col.emit)
	if err := m.Send(Turn{SessionID: "k", AgentID: "llm:x", Prompt: "hola", LLM: &fakeLLM{models: []string{"m"}, reply: "ok"}}); err != nil {
		t.Fatal(err)
	}
	col.wait(t)
	waitIdle(t, m, "k")
	m.mu.Lock()
	hasMem := len(m.llmHistory["k"]) > 0
	m.mu.Unlock()
	if !hasMem {
		t.Fatal("el turno debía dejar memoria")
	}

	block := &fakeLLM{models: []string{"m"}, block: make(chan struct{})}
	if err := m.Send(Turn{SessionID: "k", AgentID: "llm:x", Prompt: "otra", LLM: block}); err != nil {
		t.Fatal(err)
	}
	waitInfo(t, m, "k", func(i AgentSessionInfo) bool { return i.Status == StatusRunning })
	m.DetachSession("k")
	m.CloseSession("k")
	col.wait(t) // el turno cortado emite su error final
	waitIdle(t, m, "k")
	if _, ok := infoOf(m, "k"); ok {
		t.Fatal("cerrada: fuera del registro")
	}
	m.mu.Lock()
	mem, shown := len(m.llmHistory["k"]), m.tabShown["k"]
	m.mu.Unlock()
	if mem != 0 || shown {
		t.Fatalf("memoria=%d tabShown=%v: Close suelta ambas", mem, shown)
	}
	// Cerrar una desconocida no es un error ni deja rastro.
	m.CloseSession("nunca")
	m.DetachSession("nunca")
	if len(m.Sessions()) != 0 {
		t.Fatal("nada que listar")
	}
}

// Detach de una sesión que el Manager no conoce no inventa una entrada, y un
// Attach posterior la deja adjunta cuando el turno la cree.
func TestAttachBeforeTurnAndReattach(t *testing.T) {
	col := newCollector()
	m := NewManager(col.emit)
	m.DetachSession("z")
	if _, ok := infoOf(m, "z"); ok {
		t.Fatal("detach no crea entradas")
	}
	if err := m.Send(Turn{SessionID: "z", AgentID: "llm:x", Prompt: "x", LLM: &fakeLLM{models: []string{"m"}, reply: "ok"}}); err != nil {
		t.Fatal(err)
	}
	col.wait(t)
	info := waitInfo(t, m, "z", func(i AgentSessionInfo) bool { return i.Status == StatusIdle })
	if info.Attached || info.Detached {
		t.Fatalf("un chat de panel lateral no es de ninguna pestaña: %+v", info)
	}
	m.DetachSession("z")
	m.AttachSession("z") // se reabre en una pestaña
	info, _ = infoOf(m, "z")
	if !info.Attached || info.Detached {
		t.Fatalf("reabierta: %+v", info)
	}
}

// El gancho de estado avisa del arranque de un turno y de cómo termina —bien,
// con fallo o cortado—, que es lo que App guarda para que el estado sobreviva
// a un reinicio. ActiveSessionIDs lista las que siguen vivas.
func TestStatusHookReportsStartAndOutcome(t *testing.T) {
	col := newCollector()
	m := NewManager(col.emit)
	var mu sync.Mutex
	seen := map[string][]string{}
	m.SetStatusHook(func(id, status string) {
		mu.Lock()
		seen[id] = append(seen[id], status)
		mu.Unlock()
	})
	got := func(id string) string {
		mu.Lock()
		defer mu.Unlock()
		return strings.Join(seen[id], ",")
	}
	waitHook := func(id, want string) {
		t.Helper()
		for i := 0; i < 400 && got(id) != want; i++ {
			time.Sleep(5 * time.Millisecond)
		}
		if got(id) != want {
			t.Fatalf("%s: estados = %q, quería %q", id, got(id), want)
		}
	}

	if err := m.Send(Turn{SessionID: "ok", AgentID: "llm:x", Prompt: "x", LLM: &fakeLLM{models: []string{"m"}, reply: "hola"}}); err != nil {
		t.Fatal(err)
	}
	waitHook("ok", "running,idle")

	if err := m.Send(Turn{SessionID: "bad", AgentID: "llm:x", Prompt: "x", LLM: &fakeLLM{models: []string{"m"}, err: errors.New("boom")}}); err != nil {
		t.Fatal(err)
	}
	waitHook("bad", "running,error")

	block := &fakeLLM{models: []string{"m"}, block: make(chan struct{})}
	if err := m.Send(Turn{SessionID: "cut", AgentID: "llm:x", Prompt: "x", LLM: block}); err != nil {
		t.Fatal(err)
	}
	waitInfo(t, m, "cut", func(i AgentSessionInfo) bool { return i.Status == StatusRunning })
	if ids := m.ActiveSessionIDs(); len(ids) != 1 || ids[0] != "cut" {
		t.Fatalf("ActiveSessionIDs = %v", ids)
	}
	m.Cancel("cut")
	waitHook("cut", "running,cancelled")
	if ids := m.ActiveSessionIDs(); len(ids) != 0 {
		t.Fatalf("ya no hay activas: %v", ids)
	}
}
