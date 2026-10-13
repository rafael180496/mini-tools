package main

import (
	"log"
	"sort"
	"time"

	"mini-tools/backend/agentapprove"
	"mini-tools/backend/agentchat"
	"mini-tools/backend/vault"
)

// Sesiones de chat múltiples y en segundo plano.
//
// Un turno de chat corre en una goroutine del Manager, no en la pestaña que lo
// pidió: cerrar la pestaña no cancela nada, el CLI sigue vivo y el historial se
// graba igual al terminar (recordChatEvent). Lo que estos bindings dan es la
// forma de VER esas sesiones desde otra parte de la interfaz: listarlas,
// reengancharse a una para ver el progreso, atender las aprobaciones que
// esperan y marcar lo terminado como visto. Detenerla es CancelAgentChat; dejarla
// terminar no requiere nada.
//
// Cerrar una pestaña NO es cerrar el chat. La interfaz avisa qué chats muestra
// alguna pestaña (AttachAgentSession) y cuáles dejó de mostrar (DetachAgentSession,
// al cerrarse su pestaña o su panel): un chat detached sigue abierto en segundo
// plano —trabajando si estaba en un turno, y listado en Utilidades → Chat de IA → Activas después de
// terminar— hasta que alguien lo cierre de verdad con CloseAgentSession. Los
// nombres de las acciones del usuario son dos: «Detener» corta el turno en curso
// y deja el chat abierto (CancelAgentChat); «Cerrar chat» lo corta y lo da por
// terminado (CloseAgentSession). La conversación guardada queda en el historial.
//
// Protocolo de reenganche (el orden importa, ver agentchat/registry.go):
//
//  1. suscribirse al evento de la sesión (nombre = sessionId) y encolar lo que
//     llegue;
//  2. AgentSessionReplay(sessionId) y dibujar esos eventos (`last` = el mayor
//     Seq que traiga);
//  3. aplicar lo encolado y lo que siga llegando, ignorando seq <= last.
//
// Eventos de Wails que emite esto:
//
//   - "agent-sessions": el listado completo (ListAgentSessions) cada vez que
//     cambia algo, a lo sumo ~4 veces por segundo.
//   - "agent-approval" / "agent-approval-dismiss": las preguntas de permiso,
//     ahora con sessionId, title y agentLabel (agentapprove.Request).

const (
	// agentSessionsEvent es el evento con el listado de sesiones.
	agentSessionsEvent = "agent-sessions"
	// agentShutdownGrace es cuánto espera shutdown a que los turnos cortados
	// escriban su error final en el historial.
	agentShutdownGrace = 3 * time.Second
)

// ListAgentSessions devuelve las sesiones de chat con un turno vivo
// (running / awaiting_approval), las terminadas que nadie reconoció todavía
// (unread) y las que quedaron abiertas en segundo plano al cerrarse su pestaña
// (detached, en cualquier estado). Orden estable: la que entró primero al
// registro, primero. Una sesión terminada, leída y sin pestaña ni marca de
// «abierta» deja de listarse; el registro la conserva 30 minutos por si se
// reabre su pestaña (AgentSessionReplay).
func (a *App) ListAgentSessions() ([]agentchat.AgentSessionInfo, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.agentChats.Sessions(), nil
}

// AgentSessionReplay devuelve los eventos del turno actual o del último de la
// sesión (acotado a 3000 eventos / 2 MB, con el texto contiguo fundido), cada
// uno con su Seq. Una sesión que no está en el registro da una lista vacía: el
// historial guardado (AgentChatMessages) es la fuente para ese caso.
func (a *App) AgentSessionReplay(sessionID string) ([]agentchat.Event, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.agentChats.Replay(sessionID), nil
}

// MarkAgentSessionRead reconoce el resultado de un turno terminado: la sesión
// deja de figurar como no leída. Una sesión que ya no está no es un error.
func (a *App) MarkAgentSessionRead(sessionID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	a.agentChats.MarkRead(sessionID)
	return nil
}

// AttachAgentSession anota que una pestaña muestra este chat (deja de estar
// «en segundo plano»). Idempotente.
func (a *App) AttachAgentSession(sessionID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	a.agentChats.AttachSession(sessionID)
	return nil
}

// DetachAgentSession anota que ninguna pestaña muestra ya este chat: queda
// abierto en segundo plano, sin cortar su turno, hasta que se lo cierre con
// CloseAgentSession. Es lo que se llama al cerrar una pestaña de Chat de IA
// (o su segundo panel). Una sesión desconocida no es un error.
func (a *App) DetachAgentSession(sessionID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	a.agentChats.DetachSession(sessionID)
	return nil
}

// CloseAgentSession cierra el chat de verdad: corta el turno si está
// corriendo, lo saca del registro, suelta la memoria del modelo y lo marca como
// cerrado en el vault (open = 0, deja de listarse en Chat de IA → Abiertas).
// La conversación guardada en el historial no se toca, así que se puede volver
// a abrir y seguir; la única excepción es un borrador al que nunca se le
// escribió nada ni se nombró, que se descarta (ver Store.SetAgentChatOpen).
// Es la única acción, junto con borrar, que termina un chat abierto; cerrar su
// pestaña —o la app— nunca lo hace.
func (a *App) CloseAgentSession(sessionID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	a.agentChats.CloseSession(sessionID)
	if _, err := a.vault.SetAgentChatOpen(sessionID, false); err != nil {
		return err
	}
	return nil
}

// ListOpenAgentChats devuelve las conversaciones abiertas —las que figuran en
// Chat de IA → Abiertas hasta que se las cierre o borre—, fijadas primero y
// luego por actividad reciente. Es la parte PERSISTENTE de la lista: la
// interfaz le superpone el estado en vivo de ListAgentSessions.
func (a *App) ListOpenAgentChats() ([]vault.AgentChat, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.ListOpenAgentChats()
}

// SetAgentChatOpen abre o cierra una conversación en la lista de Abiertas. Abrir
// una del historial la suma a la lista; cerrarla es lo mismo que
// CloseAgentSession (corta lo que corra y la saca). Cerrar la pestaña que la
// muestra no pasa por acá.
func (a *App) SetAgentChatOpen(chatID string, open bool) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if !open {
		return a.CloseAgentSession(chatID)
	}
	_, err := a.vault.SetAgentChatOpen(chatID, true)
	return err
}

// SetAgentChatPinned fija o desfija una conversación abierta arriba de la lista.
func (a *App) SetAgentChatPinned(chatID string, pinned bool) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetAgentChatPinned(chatID, pinned)
}

// CreateAgentChatDraft crea la conversación de una pestaña nueva, ya abierta y
// sin título, con el proveedor, el modelo y el proyecto elegidos. Existe desde
// ese instante —no desde el primer mensaje—, así que cerrar la pestaña o la app
// no la pierde. Idempotente.
func (a *App) CreateAgentChatDraft(id, agentID, model, module, contextID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.CreateOpenAgentChat(id, agentID, model, module, contextID)
}

// SetAgentChatDraftAgent cambia el proveedor de un borrador (sin mensajes). A
// diferencia de SetAgentChatAgent no se limita a servidores de modelos: un
// borrador no tiene historia que arrastrar.
func (a *App) SetAgentChatDraftAgent(chatID, agentID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetAgentChatDraftAgent(chatID, agentID)
}

// wireChatStatus cablea el Manager al vault para que agent_chats.last_status
// refleje cómo terminó cada turno. Mientras un turno corre se guarda
// «interrumpido»: si el proceso muere sin pasar por el cierre ordenado, eso es
// lo que le pasó, y el estado verdadero lo pisa al terminar.
func (a *App) wireChatStatus() {
	a.agentChats.SetStatusHook(a.persistChatStatus)
}

func (a *App) persistChatStatus(sessionID, status string) {
	if a.vault == nil {
		return
	}
	last := ""
	switch status {
	case agentchat.StatusRunning:
		last = vault.ChatStatusInterrupted
	case agentchat.StatusIdle:
		last = vault.ChatStatusIdle
	case agentchat.StatusError:
		last = vault.ChatStatusError
	case agentchat.StatusCancelled:
		last = vault.ChatStatusCancelled
	default:
		return
	}
	if err := a.vault.SetAgentChatLastStatus(sessionID, last); err != nil {
		log.Printf("estado del chat %s: %v", sessionID, err)
	}
}

// stopChatsForShutdown corta los turnos vivos al cerrar la app y deja anotado
// que fue la app la que los cortó: las conversaciones siguen abiertas (open no
// se toca) y figuran «interrumpidas», para retomarlas al volver. Se toma la
// lista ANTES de apagar el Manager —cortar un turno lo pasa a «cancelled»— y el
// marcado va DESPUÉS, para pisar ese estado. Con el vault todavía abierto.
func (a *App) stopChatsForShutdown(grace time.Duration) {
	if a.agentChats == nil {
		return
	}
	running := a.agentChats.ActiveSessionIDs()
	a.agentChats.Shutdown(grace)
	if a.vault == nil || len(running) == 0 {
		return
	}
	if err := a.vault.MarkAgentChatsInterrupted(running); err != nil {
		log.Printf("marcando los chats interrumpidos: %v", err)
	}
}

// ListPendingApprovals devuelve las preguntas de permiso que siguen esperando
// respuesta, de la más vieja a la más nueva. Es lo que necesita un diálogo que
// se monta DESPUÉS de que la pregunta se hizo (el chat estaba en segundo plano
// o la ventana recién se abrió): el evento "agent-approval" ya pasó.
//
// El plazo de 5 minutos no cambia: vencido, la pregunta se deniega y deja de
// figurar acá (y se emite "agent-approval-dismiss").
func (a *App) ListPendingApprovals() ([]agentapprove.Request, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	a.approveMu.Lock()
	out := make([]agentapprove.Request, 0, len(a.approveReqs))
	for _, r := range a.approveReqs {
		out = append(out, r)
	}
	a.approveMu.Unlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt != out[j].CreatedAt {
			return out[i].CreatedAt < out[j].CreatedAt
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}
