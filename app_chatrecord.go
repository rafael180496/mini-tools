package main

import (
	"encoding/json"
	"log"
	"strings"
	"sync"

	"mini-tools/backend/agentchat"
	"mini-tools/backend/i18n"
	"mini-tools/backend/vault"
)

// Grabado del historial de los chats con agentes (migración 58).
//
// Vale para TODOS los proveedores —los CLIs y los servidores de modelos— y
// vive en App porque es el único que conoce a la vez el vault y el Manager:
// el Manager emite eventos y no sabe de persistencia.
//
// Qué se guarda, turno por turno:
//
//   - **Usuario**: lo que llegó a SendAgentChat ANTES de expandir las
//     referencias `@tipo:valor`. Lo expandido es el contenido de una nota, una
//     consulta o un servidor: guardarlo duplicaría en el historial justo lo
//     que el usuario eligió citar por referencia (y podría copiar secretos),
//     además de volverlo ilegible. Sí incluye los bloques de contexto que la
//     interfaz antepone al mensaje —el SQL del editor, la selección—, porque
//     a este lado no se pueden separar del texto escrito sin adivinar.
//   - **Herramientas**: una fila `tool` por llamada, con el nombre y, como
//     contenido, el resumen y el detalle.
//   - **Asistente**: el texto acumulado del turno (los `text` concatenados,
//     como los dibuja el chat) con los tokens en `usage`.
//   - **Error** (incluido un turno cancelado): una fila `assistant` cuyo
//     contenido empieza con agentchat.ErrorRowPrefix, precedida por lo que
//     alcanzó a decir. Se guarda para que el historial muestre el fallo donde
//     ocurrió; el contexto de un modelo lo descarta.
//
// Las filas de un turno se escriben juntas cuando el turno termina (done o
// error), y la del usuario en el mismo momento en que SendAgentChat confirma
// que el turno arrancó. Un turno interrumpido sin evento final (el proceso
// murió) se cierra como error en el siguiente mensaje de la sesión.

// Topes del contexto que se le reenvía a un servidor de modelos al retomar un
// chat guardado.
const (
	llmSeedRows     = 120   // filas leídas del vault (incluye herramientas)
	llmSeedMessages = 40    // mensajes usuario/asistente que se reenvían
	llmSeedChars    = 24000 // caracteres como máximo
)

// recordedTurn es un turno en curso.
type recordedTurn struct {
	rec         agentchat.TurnRecorder
	user        string
	agentID     string // proveedor del turno: va en el usage de sus filas
	attachments []agentchat.AttachmentMeta
	userWritten bool
}

// chatRecorder lleva los turnos en curso por sesión. El id de la sesión es el
// id del chat (el frontend usa el mismo para las dos cosas).
type chatRecorder struct {
	mu    sync.Mutex
	turns map[string]*recordedTurn
}

// begin abre el registro de un turno. Si la sesión tenía uno que nunca
// terminó, lo cierra antes como error: sus mensajes ya se habían dicho.
func (a *App) beginChatTurn(sessionID, typed string) *recordedTurn {
	r := &a.chatRec
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.turns == nil {
		r.turns = map[string]*recordedTurn{}
	}
	if old := r.turns[sessionID]; old != nil {
		msgs, _ := old.rec.Feed(agentchat.Event{Kind: agentchat.KindError, Error: i18n.T(msgTurnInterrupted)})
		a.persistTurnLocked(sessionID, old, msgs)
	}
	rt := &recordedTurn{user: typed}
	r.turns[sessionID] = rt
	return rt
}

var msgTurnInterrupted = i18n.Msg{ES: "el turno se interrumpió sin respuesta", EN: "the turn was interrupted without a reply"}

// dropChatTurn descarta el registro si sigue siendo ese (Send rechazó el turno).
func (a *App) dropChatTurn(sessionID string, rt *recordedTurn) {
	r := &a.chatRec
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.turns[sessionID] == rt {
		delete(r.turns, sessionID)
	}
}

// discardChatTurn olvida el turno en curso sin guardarlo: reiniciar o borrar
// un chat corta el turno, y el error de "cancelado" que llega después no debe
// resucitar mensajes en un chat que ya no los tiene.
func (a *App) discardChatTurn(sessionID string) {
	r := &a.chatRec
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.turns, sessionID)
}

// writeChatUser guarda el mensaje del usuario apenas se sabe que el turno
// arrancó, salvo que el cierre del turno ya lo haya escrito.
func (a *App) writeChatUser(sessionID string, rt *recordedTurn) {
	r := &a.chatRec
	r.mu.Lock()
	defer r.mu.Unlock()
	if rt.userWritten {
		return
	}
	a.persistTurnLocked(sessionID, rt, nil)
}

// recordChatEvent es el gancho del emit del Manager: acumula el turno y lo
// guarda al cerrarse. Corre ANTES de entregar el evento al frontend, así que
// cuando la interfaz ve el `done` las filas ya están.
func (a *App) recordChatEvent(sessionID string, ev agentchat.Event) {
	r := &a.chatRec
	r.mu.Lock()
	defer r.mu.Unlock()
	rt := r.turns[sessionID]
	if rt == nil {
		return
	}
	msgs, closed := rt.rec.Feed(ev)
	if !closed {
		return
	}
	delete(r.turns, sessionID)
	a.persistTurnLocked(sessionID, rt, msgs)
}

// persistTurnLocked escribe, en una transacción, el mensaje del usuario (si
// todavía no está) y las filas del turno. Con r.mu tomado.
func (a *App) persistTurnLocked(sessionID string, rt *recordedTurn, msgs []agentchat.RecordedMessage) {
	var rows []vault.NewChatMessage
	if !rt.userWritten {
		rows = append(rows, vault.NewChatMessage{Role: vault.ChatRoleUser, Content: rt.user, Meta: attachmentsMeta(rt.attachments)})
		rt.userWritten = true
	}
	for _, m := range msgs {
		rows = append(rows, vault.NewChatMessage{Role: m.Role, Content: m.Content, ToolName: m.ToolName, Usage: usageJSON(m.Usage, m.Model, rt.agentID)})
	}
	if len(rows) == 0 || a.vault == nil {
		return
	}
	if err := a.vault.AppendAgentChatMessages(sessionID, rows); err != nil {
		// El historial es una comodidad: un fallo acá (vault bloqueado, disco
		// lleno) no puede romper la conversación en curso.
		log.Printf("historial del chat %s: %v", sessionID, err)
	}
}

// usageJSON serializa el uso de un turno para agent_chat_messages.usage. Le
// agrega el modelo que contestó (si el evento start lo dijo): es lo que
// permite medir el consumo por modelo sin una migración — la columna ya era
// un JSON abierto y los lectores viejos ignoran claves que no conocen.
//
// También deja el proveedor (agentID) que atendió el turno: un chat puede
// cambiar de proveedor a mitad de camino y el consumo se atribuye por turno,
// no por el agente que tiene el chat ahora (ver ModelServerUsage).
func usageJSON(u *agentchat.Usage, model, agentID string) string {
	if u == nil {
		return ""
	}
	c := *u
	if c.Model == "" {
		c.Model = model
	}
	if c.AgentID == "" {
		c.AgentID = agentID
	}
	b, err := json.Marshal(c)
	if err != nil {
		return ""
	}
	return string(b)
}

// ensureChatRow garantiza que exista la fila de agent_chats antes de colgarle
// mensajes. Normalmente la crea el frontend al mandar el primer mensaje, pero
// las dos órdenes viajan sin orden garantizado y un chat abierto desde otro
// lado (Utilidades) puede no crearla: CreateAgentChat es idempotente, así que
// da igual quién llegue primero. Devuelve false si no hay fila, en cuyo caso
// no se graba nada (los mensajes quedarían huérfanos).
func (a *App) ensureChatRow(sessionID, module, contextID, agentID, typed string) bool {
	ok, err := a.vault.AgentChatExists(sessionID)
	if err != nil {
		log.Printf("historial del chat %s: %v", sessionID, err)
		return false
	}
	if ok {
		return true
	}
	// Mismo criterio que el frontend para el título: la primera línea del
	// primer mensaje, recortada. El repositorio solo existe en el módulo git;
	// en cualquier otro va vacío (ver CreateAgentChat).
	repoID := ""
	if module == "git" {
		repoID = contextID
	}
	if err := a.vault.CreateAgentChat(sessionID, repoID, agentID, chatTitleFrom(typed), module, contextID); err != nil {
		log.Printf("historial del chat %s: %v", sessionID, err)
		return false
	}
	return true
}

// chatTitleFrom saca el título de un chat del primer mensaje.
func chatTitleFrom(typed string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(typed), "\n")
	line = strings.TrimSpace(line)
	if r := []rune(line); len(r) > 80 {
		line = string(r[:80])
	}
	if line == "" {
		return i18n.T(i18n.Msg{ES: "Conversación", EN: "Conversation"})
	}
	return line
}

// chatTitleFor es el título con el que se rotula la sesión: el guardado del
// chat (puede haber sido renombrado) o, si todavía no hay fila, el que saldría
// del primer mensaje.
func (a *App) chatTitleFor(sessionID, typed string) string {
	if a.vault != nil {
		if t := strings.TrimSpace(a.vault.AgentChatTitle(sessionID)); t != "" {
			return t
		}
	}
	return chatTitleFrom(typed)
}

// sendRecorded manda el turno al Manager grabándolo en el historial.
func (a *App) sendRecorded(module, contextID, typed string, t agentchat.Turn) error {
	// El título sale del primer mensaje; si fue solo adjuntos, del primer archivo.
	title := typed
	if strings.TrimSpace(title) == "" && len(t.Attachments) > 0 {
		title = t.Attachments[0].Name
	}
	// Rótulos de la sesión para el registro (sidebar y diálogo de permisos).
	t.Module, t.ContextID = module, contextID
	if t.Title == "" {
		t.Title = a.chatTitleFor(t.SessionID, title)
	}
	// Sesión ocupada: Send va a rechazarlo, y abrir un registro nuevo pisaría
	// el del turno que sí está corriendo.
	if a.agentChats.Busy(t.SessionID) || !a.ensureChatRow(t.SessionID, module, contextID, t.AgentID, title) {
		return a.agentChats.Send(t)
	}
	rt := a.beginChatTurn(t.SessionID, typed)
	// Solo la ficha de los adjuntos —nombre, tipo, tamaño—, nunca su contenido.
	rt.attachments = agentchat.Metas(t.Attachments)
	rt.agentID = t.AgentID
	if err := a.agentChats.Send(t); err != nil {
		a.dropChatTurn(t.SessionID, rt)
		return err
	}
	a.writeChatUser(t.SessionID, rt)
	return nil
}

// llmSeedHistory arma el contexto de un servidor de modelos desde el historial
// guardado del chat. Se llama ANTES de registrar el mensaje nuevo, para que no
// quede duplicado en el contexto.
func (a *App) llmSeedHistory(chatID string) []agentchat.HistoryMessage {
	rows, err := a.vault.RecentAgentChatMessages(chatID, llmSeedRows)
	if err != nil {
		log.Printf("historial del chat %s: %v", chatID, err)
		return nil
	}
	return storedToHistory(rows)
}

func storedToHistory(rows []vault.StoredChatMessage) []agentchat.HistoryMessage {
	out := make([]agentchat.HistoryMessage, 0, len(rows))
	for _, m := range rows {
		out = append(out, agentchat.HistoryMessage{Role: m.Role, Content: m.Content, ToolName: m.ToolName, Attachments: attachmentsFromMeta(m.Meta)})
	}
	return out
}

// attachmentsMeta serializa la ficha de los adjuntos para
// agent_chat_messages.meta ("" si no hay). El objeto externo deja lugar a otras
// claves sin otra migración.
func attachmentsMeta(atts []agentchat.AttachmentMeta) string {
	if len(atts) == 0 {
		return ""
	}
	b, err := json.Marshal(struct {
		Attachments []agentchat.AttachmentMeta `json:"attachments"`
	}{atts})
	if err != nil {
		return ""
	}
	return string(b)
}

// attachmentsFromMeta es la inversa; una ficha ilegible o vacía es «sin
// adjuntos» (nunca nil: el frontend la recorre con .map).
func attachmentsFromMeta(meta string) []agentchat.AttachmentMeta {
	out := []agentchat.AttachmentMeta{}
	if meta == "" {
		return out
	}
	var m struct {
		Attachments []agentchat.AttachmentMeta `json:"attachments"`
	}
	if json.Unmarshal([]byte(meta), &m) == nil && m.Attachments != nil {
		out = m.Attachments
	}
	return out
}
