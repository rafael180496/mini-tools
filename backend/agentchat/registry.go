package agentchat

import (
	"context"
	"sort"
	"sync"
	"time"
	"unicode/utf8"
)

// Registro de sesiones: qué chats están corriendo (o terminaron sin que nadie
// lo viera) aunque su pestaña esté cerrada.
//
// # Por qué existe
//
// Un turno corre en una goroutine del Manager, no en la pestaña: cerrarla no lo
// toca (ningún hook de cierre cancela nada). Lo que faltaba era poder SABERLO
// desde afuera — listar las sesiones vivas, ver cuánto llevan, volver a
// engancharse para ver el progreso y atender una aprobación que esperaba con
// la pestaña cerrada.
//
// El registro NO es otra fuente de verdad del chat: el historial sigue siendo
// el del vault (App graba al terminar el turno) y la conversación, la del CLI.
// Esto es solo el estado de EJECUCIÓN, en memoria, y se pierde al cerrar la app
// (los turnos también: Shutdown los cancela).
//
// # Estados
//
//	running            el turno está corriendo
//	awaiting_approval  corre, pero está frenado esperando que alguien apruebe
//	idle               terminó bien
//	error              terminó con un fallo
//	cancelled          lo cortó el usuario (Cancel/Reset)
//
// Las transiciones salen del flujo de eventos que ya existía (start/done/error)
// más BeginApproval/EndApproval. Un cierre sin evento final (un CLI que se
// fue sin decir nada) lo cubre finish: pasa a idle.
//
// # Reenganche (protocolo)
//
// Cada Event lleva un Seq. AgentSessionReplay devuelve los eventos del turno
// actual o del último (acotado, con los deltas de texto contiguos fundidos en
// uno). Para enganchar sin perder nada ni duplicar:
//
//  1. suscribirse al evento de la sesión y ENCOLAR lo que llegue;
//  2. llamar a Replay y dibujar sus eventos (el último seq es `last`);
//  3. aplicar lo encolado y lo que siga llegando, ignorando seq <= last.
//
// Suscribirse DESPUÉS de Replay deja una ventana en la que los eventos se
// pierden: por eso el orden es suscribir, replay, fusionar.
//
// # Qué se lista
//
// Sessions devuelve las que tienen turno vivo (running/awaiting_approval), las
// terminadas sin leer (unread) y las ABIERTAS EN SEGUNDO PLANO (detached).
// Una terminada, leída y que ninguna pestaña mira sigue en el registro 30
// minutos (sessionIdleTTL) para poder rehidratar su último turno, pero no se
// lista: el sidebar es de lo que reclama atención.
//
// # Abierta, adjunta y cerrada
//
// Cerrar una PESTAÑA no es cerrar el CHAT. El frontend avisa qué chats muestra
// alguna pestaña (AttachSession) y cuáles dejó de mostrar (DetachSession):
//
//	attached   alguna pestaña la muestra. No caduca (la pestaña la necesita)
//	detached   se cerró su pestaña y sigue abierta en segundo plano: se lista
//	           y no caduca hasta que alguien la cierre de verdad
//	ninguna    sesión de un panel lateral o ya olvidada: caduca como siempre
//
// Lo único que quita una sesión detached es CloseSession (acción explícita):
// corta el turno si lo hay, la saca del registro y suelta la memoria del
// modelo. La conversación guardada en el vault no se toca.
const (
	StatusRunning          = "running"
	StatusAwaitingApproval = "awaiting_approval"
	StatusIdle             = "idle"
	StatusError            = "error"
	StatusCancelled        = "cancelled"
)

const (
	// sessionIdleTTL es cuánto vive en el registro una sesión sin turno vivo y
	// ya leída.
	sessionIdleTTL = 30 * time.Minute
	// replayMaxEvents y replayMaxBytes acotan el búfer de reenganche por
	// sesión: lo que pase de cualquiera de los dos se descarta del principio.
	replayMaxEvents = 3000
	replayMaxBytes  = 2 << 20
	// lastTextRunes es el largo de la vista previa para el sidebar.
	lastTextRunes = 200
	// broadcastEvery es el intervalo mínimo entre dos difusiones del listado
	// (~4 por segundo).
	broadcastEvery = 250 * time.Millisecond
)

// AgentSessionInfo es una sesión tal como la ve el sidebar. Es el contrato del
// binding ListAgentSessions y del evento "agent-sessions".
type AgentSessionInfo struct {
	SessionID string `json:"sessionId"`
	// ChatID es el id del chat en el historial. Hoy coincide con SessionID (el
	// frontend usa el mismo para las dos cosas); se expone aparte para que el
	// día que dejen de coincidir no cambie el contrato.
	ChatID     string `json:"chatId"`
	AgentID    string `json:"agentId"`
	AgentLabel string `json:"agentLabel"`
	Model      string `json:"model"`
	// Mode es el modo del turno ("" = ask).
	Mode      string `json:"mode"`
	Module    string `json:"module"`
	ContextID string `json:"contextId"`
	Title     string `json:"title"`
	Status    string `json:"status"`
	// StartedAt es cuándo entró la sesión al registro; TurnStartedAt, cuándo
	// arrancó el turno actual o el último; LastEventAt, el último evento. Todos
	// en milisegundos Unix.
	StartedAt     int64 `json:"startedAt"`
	LastEventAt   int64 `json:"lastEventAt"`
	TurnStartedAt int64 `json:"turnStartedAt"`
	// Usage son los tokens del turno cuando se conocen: los CLIs y los
	// servidores de modelos los informan al final, así que durante el turno
	// suele estar vacío.
	Usage *Usage `json:"usage,omitempty"`
	// LastText son los últimos ~200 caracteres de lo que dijo el asistente.
	LastText string `json:"lastText"`
	// PendingApprovalID es la pregunta de permiso más vieja que sigue sin
	// contestar (vacío si no hay).
	PendingApprovalID string `json:"pendingApprovalId"`
	// Unread es true cuando un turno terminó (bien o mal) y ninguna interfaz lo
	// reconoció todavía (MarkRead). Cancelar a mano no lo deja sin leer: lo
	// hizo la persona.
	Unread bool `json:"unread"`
	// Error es el mensaje del fallo cuando Status es "error".
	Error string `json:"error,omitempty"`
	// Attached es true cuando alguna pestaña muestra la conversación ahora.
	Attached bool `json:"attached"`
	// Detached es true cuando se cerró la pestaña que la mostraba y la
	// conversación sigue abierta en segundo plano: se lista (aunque no esté
	// trabajando ni sin leer) hasta que se la cierre con CloseSession.
	Detached bool `json:"detached"`
}

// sessionEntry es el estado interno de una sesión.
type sessionEntry struct {
	info AgentSessionInfo
	// ctx es el contexto del turno vivo: se cancela con Cancel/Shutdown.
	ctx context.Context
	// cancelRequested distingue "lo cortó la persona" de un fallo, porque los
	// dos llegan como un KindError.
	cancelRequested bool
	// pending son las preguntas de permiso sin contestar, en orden de llegada.
	pending []string
	// buf es el búfer de reenganche del turno; bufBytes, su tamaño aproximado.
	buf      []Event
	bufBytes int
}

func (e *sessionEntry) active() bool {
	return e.info.Status == StatusRunning || e.info.Status == StatusAwaitingApproval
}

// listable dice si la sesión aparece en el listado.
func (e *sessionEntry) listable() bool { return e.active() || e.info.Unread || e.info.Detached }

// kept dice si la sesión no caduca: una pestaña la necesita o quedó abierta en
// segundo plano.
func (e *sessionEntry) kept() bool { return e.info.Attached || e.info.Detached }

type sessionCtxKey struct{}

// WithSessionID marca un contexto con la sesión a la que pertenece, para que
// quien pregunta un permiso desde adentro de un turno (App.askApprovalCtx)
// sepa de qué chat es sin que la herramienta tenga que conocerlo.
func WithSessionID(ctx context.Context, sessionID string) context.Context {
	return context.WithValue(ctx, sessionCtxKey{}, sessionID)
}

// SessionIDFromContext es la inversa de WithSessionID ("" si no está marcado).
func SessionIDFromContext(ctx context.Context) string {
	s, _ := ctx.Value(sessionCtxKey{}).(string)
	return s
}

func (m *Manager) clock() time.Time {
	if m.now != nil {
		return m.now()
	}
	return time.Now()
}

// registryLocked devuelve el mapa del registro, creándolo si hace falta (un
// Manager de valor cero también tiene que andar). Con m.mu tomado.
func (m *Manager) registryLocked() map[string]*sessionEntry {
	if m.reg == nil {
		m.reg = map[string]*sessionEntry{}
	}
	return m.reg
}

// emit es el único camino por el que un evento sale del Manager. Antes de
// entregarlo a la interfaz le asigna su Seq y lo anota en el registro (búfer
// de reenganche, vista previa, uso); el cambio de estado por un evento FINAL
// va después de entregarlo, porque App graba el turno dentro de la entrega y
// quien vea "idle" tiene que encontrar el historial ya escrito.
func (m *Manager) emit(sessionID string, ev Event) {
	m.observe(sessionID, &ev)
	if m.out != nil {
		m.out(sessionID, ev)
	}
	if ev.Kind == KindDone || ev.Kind == KindError {
		m.settle(sessionID, ev)
	}
	m.scheduleBroadcast()
}

// observe asigna el Seq y anota el evento en el registro.
func (m *Manager) observe(sessionID string, ev *Event) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.seq++
	ev.Seq = m.seq
	e := m.reg[sessionID]
	if e == nil {
		return
	}
	e.info.LastEventAt = m.clock().UnixMilli()
	switch ev.Kind {
	case KindStart:
		if ev.Model != "" {
			e.info.Model = ev.Model
		}
	case KindText:
		e.info.LastText = tailRunes(e.info.LastText+ev.Text, lastTextRunes)
	}
	if ev.Usage != nil {
		u := *ev.Usage
		e.info.Usage = &u
	}
	e.appendReplay(*ev)
}

// settle aplica el estado final de un turno.
func (m *Manager) settle(sessionID string, ev Event) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.reg[sessionID]
	if e == nil || !e.active() {
		return
	}
	e.pending, e.info.PendingApprovalID = nil, ""
	e.info.LastEventAt = m.clock().UnixMilli()
	switch {
	case ev.Kind == KindDone:
		e.info.Status, e.info.Unread = StatusIdle, true
	case e.cancelRequested:
		e.info.Status, e.info.Unread = StatusCancelled, false
	default:
		e.info.Status, e.info.Unread, e.info.Error = StatusError, true, ev.Error
	}
}

// beginTurn registra (o reabre) la sesión al arrancar un turno. Se llama justo
// antes de lanzar la goroutine, cuando ya no puede fallar el armado del turno.
func (m *Manager) beginTurn(ctx context.Context, t Turn) {
	m.mu.Lock()
	m.pruneLocked()
	reg := m.registryLocked()
	now := m.clock().UnixMilli()
	e := reg[t.SessionID]
	if e == nil {
		e = &sessionEntry{info: AgentSessionInfo{SessionID: t.SessionID, ChatID: t.SessionID, StartedAt: now}}
		reg[t.SessionID] = e
	}
	// Una pestaña que la mostraba antes de que existiera la entrada (el aviso
	// de AttachSession llegó primero) ya la tiene adjunta.
	if m.tabShown[t.SessionID] {
		e.info.Attached, e.info.Detached = true, false
	}
	e.info.AgentID = t.AgentID
	if t.AgentLabel != "" {
		e.info.AgentLabel = t.AgentLabel
	}
	e.info.Model = t.Model
	e.info.Mode = string(t.Mode)
	if t.Module != "" {
		e.info.Module, e.info.ContextID = t.Module, t.ContextID
	}
	if t.Title != "" {
		e.info.Title = t.Title
	}
	e.info.Status = StatusRunning
	e.info.TurnStartedAt, e.info.LastEventAt = now, now
	e.info.Usage = nil
	e.info.LastText = ""
	e.info.PendingApprovalID = ""
	e.info.Unread = false
	e.info.Error = ""
	e.ctx = ctx
	e.cancelRequested = false
	e.pending = nil
	e.buf, e.bufBytes = nil, 0
	m.mu.Unlock()
	m.scheduleBroadcast()
}

// sessionEnded es la red de finish: un turno que terminó sin emitir un evento
// final queda en idle (sin leer) en vez de "corriendo" para siempre.
func (m *Manager) sessionEnded(sessionID string) {
	m.mu.Lock()
	m.pruneLocked()
	e := m.reg[sessionID]
	changed := false
	if e != nil && e.active() {
		e.info.Status, e.info.Unread = StatusIdle, true
		e.pending, e.info.PendingApprovalID = nil, ""
		e.info.LastEventAt = m.clock().UnixMilli()
		changed = true
	}
	m.mu.Unlock()
	if changed {
		m.scheduleBroadcast()
	}
}

// markCancel anota que el corte lo pidió una persona.
func (m *Manager) markCancel(sessionID string) {
	m.mu.Lock()
	if e := m.reg[sessionID]; e != nil && e.active() {
		e.cancelRequested = true
	}
	m.mu.Unlock()
}

// AttachSession anota que una pestaña muestra la conversación. Se recuerda
// aunque todavía no haya entrada en el registro (un chat se adjunta al primer
// mensaje, y el aviso puede llegar antes que el turno).
func (m *Manager) AttachSession(sessionID string) {
	m.mu.Lock()
	if m.tabShown == nil {
		m.tabShown = map[string]bool{}
	}
	m.tabShown[sessionID] = true
	e := m.reg[sessionID]
	changed := e != nil && (!e.info.Attached || e.info.Detached)
	if changed {
		e.info.Attached, e.info.Detached = true, false
	}
	m.mu.Unlock()
	if changed {
		m.scheduleBroadcast()
	}
}

// DetachSession anota que ninguna pestaña muestra ya la conversación. Si el
// Manager la conoce, queda abierta en segundo plano (detached): sigue
// trabajando si estaba en un turno y se lista hasta que se la cierre con
// CloseSession. Una sesión desconocida no es un error: sin turnos no hay nada
// que mantener abierto.
func (m *Manager) DetachSession(sessionID string) {
	m.mu.Lock()
	delete(m.tabShown, sessionID)
	e := m.reg[sessionID]
	changed := e != nil && (e.info.Attached || !e.info.Detached)
	if changed {
		e.info.Attached, e.info.Detached = false, true
	}
	m.mu.Unlock()
	if changed {
		m.scheduleBroadcast()
	}
}

// CloseSession cierra el chat de verdad: corta el turno en curso (si lo hay),
// saca la sesión del registro y suelta la memoria del modelo. No toca el
// historial guardado: la conversación se puede volver a abrir y seguir.
func (m *Manager) CloseSession(sessionID string) {
	m.Cancel(sessionID)
	m.mu.Lock()
	delete(m.tabShown, sessionID)
	delete(m.llmHistory, sessionID)
	delete(m.llmHistoryAgent, sessionID)
	m.mu.Unlock()
	m.forget(sessionID)
}

// forget saca la sesión del registro (Reset: empezar de cero).
func (m *Manager) forget(sessionID string) {
	m.mu.Lock()
	e := m.reg[sessionID]
	notify := e != nil && e.listable()
	delete(m.reg, sessionID)
	m.mu.Unlock()
	if notify {
		m.scheduleBroadcast()
	}
}

// BeginApproval anota una pregunta de permiso sin contestar: la sesión pasa a
// awaiting_approval hasta que EndApproval las cierre todas.
func (m *Manager) BeginApproval(sessionID, approvalID string) {
	m.mu.Lock()
	e := m.reg[sessionID]
	ok := e != nil && e.active()
	if ok {
		e.pending = append(e.pending, approvalID)
		e.info.PendingApprovalID = e.pending[0]
		e.info.Status = StatusAwaitingApproval
		e.info.LastEventAt = m.clock().UnixMilli()
	}
	m.mu.Unlock()
	if ok {
		m.scheduleBroadcast()
	}
}

// EndApproval cierra una pregunta (contestada, vencida o cancelada). Sin más
// pendientes, la sesión vuelve a running.
func (m *Manager) EndApproval(sessionID, approvalID string) {
	m.mu.Lock()
	e := m.reg[sessionID]
	ok := e != nil
	if ok {
		for i, id := range e.pending {
			if id == approvalID {
				e.pending = append(e.pending[:i:i], e.pending[i+1:]...)
				break
			}
		}
		e.info.PendingApprovalID = ""
		if len(e.pending) > 0 {
			e.info.PendingApprovalID = e.pending[0]
		} else if e.info.Status == StatusAwaitingApproval {
			e.info.Status = StatusRunning
		}
		e.info.LastEventAt = m.clock().UnixMilli()
	}
	m.mu.Unlock()
	if ok {
		m.scheduleBroadcast()
	}
}

// TurnContext es el contexto del turno vivo de la sesión (se cancela con
// Cancel/Shutdown), o uno que nunca se cancela si no hay turno. Lo usa App para
// que una pregunta de permiso del CLI se descarte cuando cortan el turno.
func (m *Manager) TurnContext(sessionID string) context.Context {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e := m.reg[sessionID]; e != nil && e.active() && e.ctx != nil {
		return e.ctx
	}
	return context.Background()
}

// SessionMeta es lo que el diálogo de permisos muestra de la sesión: el título
// del chat y el nombre del agente.
func (m *Manager) SessionMeta(sessionID string) (title, agentLabel string, ok bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.reg[sessionID]
	if e == nil {
		return "", "", false
	}
	return e.info.Title, e.info.AgentLabel, true
}

// SetTitle actualiza el título (el chat se renombró con la sesión viva).
func (m *Manager) SetTitle(sessionID, title string) {
	m.mu.Lock()
	e := m.reg[sessionID]
	notify := false
	if e != nil {
		e.info.Title = title
		notify = e.listable()
	}
	m.mu.Unlock()
	if notify {
		m.scheduleBroadcast()
	}
}

// MarkRead reconoce el resultado de una sesión terminada. Una sesión que ya no
// está (se purgó) no es un error: no hay nada que reconocer.
func (m *Manager) MarkRead(sessionID string) {
	m.mu.Lock()
	e := m.reg[sessionID]
	changed := e != nil && e.info.Unread
	if changed {
		e.info.Unread = false
	}
	m.mu.Unlock()
	if changed {
		m.scheduleBroadcast()
	}
}

// Sessions es el listado para el sidebar: turnos vivos y terminados sin leer,
// en orden estable (por entrada al registro, la más vieja primero) para que la
// lista no salte mientras llegan eventos.
func (m *Manager) Sessions() []AgentSessionInfo {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneLocked()
	out := make([]AgentSessionInfo, 0, len(m.reg))
	for _, e := range m.reg {
		if e.listable() {
			out = append(out, e.info)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].StartedAt != out[j].StartedAt {
			return out[i].StartedAt < out[j].StartedAt
		}
		return out[i].SessionID < out[j].SessionID
	})
	return out
}

// Replay devuelve una copia de los eventos del turno actual o del último, para
// que una interfaz que se reengancha dibuje lo que ya pasó. Ver el protocolo
// arriba. Una sesión desconocida da una lista vacía.
func (m *Manager) Replay(sessionID string) []Event {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneLocked()
	e := m.reg[sessionID]
	if e == nil {
		return []Event{}
	}
	out := make([]Event, len(e.buf))
	copy(out, e.buf)
	return out
}

// pruneLocked descarta las sesiones sin turno vivo, ya leídas, que ninguna
// pestaña mira (ni quedaron abiertas en segundo plano) e inactivas más de
// sessionIdleTTL. Con m.mu tomado.
func (m *Manager) pruneLocked() {
	cutoff := m.clock().Add(-sessionIdleTTL).UnixMilli()
	for id, e := range m.reg {
		if !e.active() && !e.info.Unread && !e.kept() && e.info.LastEventAt < cutoff {
			delete(m.reg, id)
		}
	}
}

// appendReplay suma un evento al búfer de reenganche. Los deltas de texto (o de
// razonamiento) contiguos se funden en un solo evento, cuyo Seq es el del
// último: un turno hablador son miles de deltas de pocos bytes, y guardarlos
// uno por uno agotaría el tope de eventos con texto.
func (e *sessionEntry) appendReplay(ev Event) {
	if n := len(e.buf); n > 0 && (ev.Kind == KindText || ev.Kind == KindThinking) && e.buf[n-1].Kind == ev.Kind {
		last := &e.buf[n-1]
		last.Text += ev.Text
		last.Seq = ev.Seq
		e.bufBytes += len(ev.Text)
	} else {
		e.buf = append(e.buf, ev)
		e.bufBytes += eventSize(ev)
	}
	drop := 0
	for len(e.buf)-drop > 1 && (len(e.buf)-drop > replayMaxEvents || e.bufBytes > replayMaxBytes) {
		e.bufBytes -= eventSize(e.buf[drop])
		drop++
	}
	if drop > 0 {
		e.buf = e.buf[drop:]
	}
	// Un único evento más grande que el tope (texto fundido): se queda con el
	// final, que es lo último que se dijo.
	if len(e.buf) == 1 && e.bufBytes > replayMaxBytes {
		last := &e.buf[0]
		if cut := len(last.Text) - replayMaxBytes; cut > 0 {
			for cut < len(last.Text) && !utf8.RuneStart(last.Text[cut]) {
				cut++
			}
			last.Text = last.Text[cut:]
			e.bufBytes = eventSize(*last)
		}
	}
}

// eventSize aproxima los bytes que ocupa un evento retenido.
func eventSize(ev Event) int {
	n := 64 + len(ev.Text) + len(ev.Error) + len(ev.ConversationID) + len(ev.Model)
	if ev.Tool != nil {
		n += len(ev.Tool.Name) + len(ev.Tool.Input) + len(ev.Tool.Summary) + len(ev.Tool.Detail)
	}
	for _, s := range ev.Tools {
		n += len(s)
	}
	for _, s := range ev.MCPServers {
		n += len(s)
	}
	return n
}

// tailRunes deja los últimos n caracteres de s.
func tailRunes(s string, n int) string {
	// Mientras cabe (en bytes, n runas ocupan como mucho 4n) no hay que contar.
	if len(s) <= n {
		return s
	}
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[len(r)-n:])
}

// SetSessionsEmitter fija a dónde se difunde el listado cada vez que cambia
// (App lo cablea al evento "agent-sessions"). nil apaga la difusión.
func (m *Manager) SetSessionsEmitter(fn func([]AgentSessionInfo)) {
	m.bcMu.Lock()
	m.bcEmit = fn
	m.bcMu.Unlock()
}

// scheduleBroadcast difunde el listado como mucho una vez cada broadcastEvery.
// Lo que cambia mientras corre la espera se junta en una sola difusión
// posterior (extremo final): la última palabra siempre sale. Nunca se llama con
// m.mu tomado, porque el listado se arma bajo ese candado.
func (m *Manager) scheduleBroadcast() {
	m.bcMu.Lock()
	if m.bcEmit == nil || m.bcClosed || m.bcTimer != nil {
		m.bcMu.Unlock()
		return
	}
	every := m.bcEvery
	if every <= 0 {
		every = broadcastEvery
	}
	if wait := every - time.Since(m.bcLast); wait > 0 {
		m.bcTimer = time.AfterFunc(wait, m.flushBroadcast)
		m.bcMu.Unlock()
		return
	}
	m.bcMu.Unlock()
	m.flushBroadcast()
}

func (m *Manager) flushBroadcast() {
	// bcEmitMu serializa "armar el listado + entregarlo": sin él, dos
	// difusiones concurrentes podrían entregarse en orden inverso al de sus
	// listados y la interfaz se quedaría con el más viejo.
	m.bcEmitMu.Lock()
	defer m.bcEmitMu.Unlock()
	m.bcMu.Lock()
	m.bcTimer = nil
	m.bcLast = time.Now()
	emit, closed := m.bcEmit, m.bcClosed
	m.bcMu.Unlock()
	if emit == nil || closed {
		return
	}
	emit(m.Sessions())
}

// Shutdown corta todos los turnos vivos y espera (hasta wait) a que sus
// goroutines terminen. Lo llama App al cerrar, ANTES de cerrar el vault: cada
// turno cortado emite su error final y App lo graba en el historial.
// También apaga la difusión: la ventana ya se está yendo.
func (m *Manager) Shutdown(wait time.Duration) {
	m.bcMu.Lock()
	m.bcClosed = true
	if m.bcTimer != nil {
		m.bcTimer.Stop()
		m.bcTimer = nil
	}
	m.bcMu.Unlock()

	m.mu.Lock()
	for id, cancel := range m.cancels {
		if e := m.reg[id]; e != nil && e.active() {
			e.cancelRequested = true
		}
		cancel()
	}
	m.mu.Unlock()

	done := make(chan struct{})
	go func() {
		m.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(wait):
	}
}

// spawn lanza la goroutine de un turno contándola para Shutdown.
func (m *Manager) spawn(fn func()) {
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		fn()
	}()
}

// registryState reúne los campos del registro y de la difusión; vive aparte de
// Manager para que su declaración se lea de una vez.
type registryState struct {
	reg map[string]*sessionEntry
	// tabShown son las sesiones que alguna pestaña muestra, según el último
	// aviso de AttachSession/DetachSession. Va aparte del registro porque el
	// aviso puede llegar antes de que exista la entrada.
	tabShown map[string]bool
	seq      int64
	now      func() time.Time

	bcMu     sync.Mutex
	bcEmitMu sync.Mutex
	bcEmit   func([]AgentSessionInfo)
	bcLast   time.Time
	bcTimer  *time.Timer
	bcEvery  time.Duration
	bcClosed bool

	wg sync.WaitGroup
}
