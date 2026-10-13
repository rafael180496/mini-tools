package vault

import (
	"time"

	"mini-tools/backend/i18n"
)

// Conversaciones de IA persistentes (migración 65).
//
// El historial de agent_chats siempre fue «lo que se habló»; esto le suma «lo
// que sigue abierto». Una conversación abierta (open = 1) figura en Utilidades
// → Chat de IA → Abiertas hasta que alguien la CIERRE o la BORRE, no hasta que
// se cierre su pestaña ni hasta que se cierre la app:
//
//	cerrar la pestaña   no toca nada: la conversación sigue abierta
//	cerrar la app       tampoco; lo que corría queda marcado «interrumpido»
//	Cerrar chat         open = 0 (sale de Abiertas, queda en el historial)
//	Eliminar            borra la fila y sus mensajes
//
// Las filas de antes nacen con open = 0 (ver la migración): el historial viejo
// no se vuelca de golpe en la barra lateral.

// agentChatHasNoMessages es la condición SQL de «nunca se le escribió nada».
const agentChatHasNoMessages = `NOT EXISTS (SELECT 1 FROM agent_chat_messages m WHERE m.chat_id = agent_chats.id)`

// CreateOpenAgentChat registra una conversación NUEVA ya abierta, sin título:
// el borrador de un chat al que todavía no se le escribió. Existe desde que se
// crea la pestaña, así que cerrarla (o la app) no la pierde, y recuerda el
// proveedor, el modelo y el proyecto elegidos. El título se queda vacío hasta
// que el usuario la nombre o llegue el primer mensaje (App.nameUntitledChat).
//
// Idempotente, igual que CreateAgentChat: un id que ya existe no se toca.
func (s *Store) CreateOpenAgentChat(id, agentID, model, module, contextID string) error {
	now := time.Now().Unix()
	_, err := s.db.Exec(
		`INSERT INTO agent_chats (id, repo_id, agent_id, encrypted_title, title_nonce, conversation_id, created_at, updated_at, model, module, context_id, open, opened_at)
		 VALUES (?, ?, ?, NULL, NULL, '', ?, ?, ?, ?, ?, 1, ?)
		 ON CONFLICT(id) DO NOTHING`,
		id, repoOfContext(module, contextID), agentID, now, now, model, module, contextID, now,
	)
	if err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: creando el chat: %w", EN: "vault: creating the chat: %w"}, err)
	}
	return nil
}

// repoOfContext es el repo_id que corresponde a un contexto: solo el módulo git
// tiene repositorio (ver CreateAgentChat).
func repoOfContext(module, contextID string) string {
	if module == "git" {
		return contextID
	}
	return ""
}

// ListOpenAgentChats devuelve las conversaciones abiertas: las fijadas primero
// y, dentro de cada grupo, la de actividad más reciente arriba.
func (s *Store) ListOpenAgentChats() ([]AgentChat, error) {
	return s.queryAgentChats(
		`SELECT ` + agentChatColumns + ` FROM agent_chats WHERE open = 1
		 ORDER BY pinned DESC, updated_at DESC, opened_at DESC, id`)
}

// SetAgentChatOpen abre o cierra la conversación. Abrir no toca updated_at
// (abrir no es actividad) pero sí le da un estado a una conversación vieja con
// mensajes que nunca lo tuvo: sin eso un chat del historial recién abierto se
// vería como «borrador». Cerrar la saca también de las fijadas.
//
// Cerrar una conversación que NUNCA se usó (sin mensajes ni nombre) la borra:
// un borrador vacío cerrado a propósito no tiene nada que conservar, y dejarlo
// en el historial lo llenaría de filas «Nueva conversación». Devuelve si la
// borró. Una conversación inexistente es ErrAgentChatNotFound al abrirla y no
// es error al cerrarla (cerrar es idempotente).
func (s *Store) SetAgentChatOpen(id string, open bool) (deleted bool, err error) {
	if open {
		res, err := s.db.Exec(
			`UPDATE agent_chats SET open = 1, opened_at = ?,
			   last_status = CASE WHEN last_status = '' AND NOT `+agentChatHasNoMessages+` THEN 'idle' ELSE last_status END
			 WHERE id = ?`, time.Now().Unix(), id)
		if err != nil {
			return false, i18n.Errorf(i18n.Msg{ES: "vault: abriendo el chat: %w", EN: "vault: opening the chat: %w"}, err)
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return false, ErrAgentChatNotFound
		}
		return false, nil
	}
	res, err := s.db.Exec(
		`DELETE FROM agent_chats WHERE id = ? AND encrypted_title IS NULL AND last_status = '' AND conversation_id = '' AND `+agentChatHasNoMessages, id)
	if err != nil {
		return false, i18n.Errorf(i18n.Msg{ES: "vault: cerrando el chat: %w", EN: "vault: closing the chat: %w"}, err)
	}
	if n, _ := res.RowsAffected(); n > 0 {
		return true, nil
	}
	if _, err := s.db.Exec(`UPDATE agent_chats SET open = 0, pinned = 0 WHERE id = ?`, id); err != nil {
		return false, i18n.Errorf(i18n.Msg{ES: "vault: cerrando el chat: %w", EN: "vault: closing the chat: %w"}, err)
	}
	return false, nil
}

// SetAgentChatPinned fija o desfija la conversación. Fijar solo tiene sentido
// en una abierta: el listado de las fijadas es el de Abiertas.
func (s *Store) SetAgentChatPinned(id string, pinned bool) error {
	v := 0
	if pinned {
		v = 1
	}
	res, err := s.db.Exec(`UPDATE agent_chats SET pinned = ? WHERE id = ?`, v, id)
	if err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: fijando el chat: %w", EN: "vault: pinning the chat: %w"}, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrAgentChatNotFound
	}
	return nil
}

// SetAgentChatLastStatus anota cómo va lo último que hizo la conversación y
// cuenta como actividad (sube en el orden). Un id sin fila no es un error: la
// sesión puede ser de un módulo que no guarda historial, o haberse borrado.
func (s *Store) SetAgentChatLastStatus(id, status string) error {
	if _, err := s.db.Exec(`UPDATE agent_chats SET last_status = ?, updated_at = ? WHERE id = ?`, status, time.Now().Unix(), id); err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: guardando el estado del chat: %w", EN: "vault: saving the chat status: %w"}, err)
	}
	return nil
}

// MarkAgentChatsInterrupted marca como interrumpidas las conversaciones que
// estaban trabajando cuando se cerró la app. No toca updated_at: no fue
// actividad, y mover «lo último que hizo» al instante del cierre desordenaría
// la lista.
func (s *Store) MarkAgentChatsInterrupted(ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: guardando el estado del chat: %w", EN: "vault: saving the chat status: %w"}, err)
	}
	defer tx.Rollback()
	for _, id := range ids {
		if _, err := tx.Exec(`UPDATE agent_chats SET last_status = ? WHERE id = ?`, ChatStatusInterrupted, id); err != nil {
			return i18n.Errorf(i18n.Msg{ES: "vault: guardando el estado del chat: %w", EN: "vault: saving the chat status: %w"}, err)
		}
	}
	return tx.Commit()
}

// SetAgentChatDraftAgent cambia el proveedor de un borrador (sin mensajes ni
// conversación del CLI): ahí cualquier proveedor sirve, no solo entre servidores
// de modelos, porque no hay historia que arrastrar. Vacía el modelo, que era
// del proveedor anterior.
func (s *Store) SetAgentChatDraftAgent(id, agentID string) error {
	res, err := s.db.Exec(
		`UPDATE agent_chats SET agent_id = ?, model = '', updated_at = ?
		 WHERE id = ? AND last_status = '' AND conversation_id = '' AND `+agentChatHasNoMessages,
		agentID, time.Now().Unix(), id)
	if err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: cambiando el proveedor del chat: %w", EN: "vault: switching the chat provider: %w"}, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return i18n.Errorf(i18n.Msg{ES: "vault: solo se cambia de proveedor en un chat sin mensajes", EN: "vault: the provider can only be changed in a chat without messages"})
	}
	return nil
}
