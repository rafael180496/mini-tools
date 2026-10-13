package main

import (
	"sort"
	"time"

	"mini-tools/backend/agentapprove"
	"mini-tools/backend/agentchat"
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
// plano —trabajando si estaba en un turno, y listado en IA → Activas después de
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
// corriendo, lo saca del registro (deja de listarse en IA → Activas) y suelta
// la memoria del modelo. La conversación guardada en el historial no se toca,
// así que se puede volver a abrir y seguir. Es la única acción que termina un
// chat abierto en segundo plano; cerrar su pestaña nunca lo hace.
func (a *App) CloseAgentSession(sessionID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	a.agentChats.CloseSession(sessionID)
	return nil
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
