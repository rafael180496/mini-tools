package vault

import (
	"fmt"
	"time"

	mtcrypto "mini-tools/backend/crypto"
)

// Historial de conversaciones con agentes, por repositorio (migración 31).
//
// Lo que se guarda es el PUNTERO a la conversación —el id que devuelve el
// propio CLI y con el que se la retoma— y no los mensajes. El historial lo
// tiene el CLI: duplicarlo acá sería una segunda memoria que se desincroniza
// con la real, y obligaría a meter en el vault todo lo que se conversó.
//
// El título va cifrado con el mismo esquema que ssh_command_history: se deriva
// de lo primero que se le escribió al agente, y eso puede traer cualquier cosa
// adentro. Los ids y las fechas van en claro — son identificadores opacos.

// AgentChat es una conversación guardada.
type AgentChat struct {
	ID      string `json:"id"`
	RepoID  string `json:"repoId"`
	AgentID string `json:"agentId"`
	Title   string `json:"title"`
	// ConversationID es el id del CLI. Vacío mientras la conversación no
	// arrancó — un chat recién creado al que todavía no se le mandó nada.
	ConversationID string `json:"conversationId"`
	CreatedAt      int64  `json:"createdAt"`
	UpdatedAt      int64  `json:"updatedAt"`
	// Ajustes con los que se venía trabajando (migración 32). Retomar un chat
	// con el modelo en su default —cuando se había elegido otro— lo continúa
	// de una forma distinta de como venía.
	Model  string `json:"model"`
	Effort string `json:"effort"`
	Mode   string `json:"mode"`
}

// CreateAgentChat registra una conversación nueva.
func (s *Store) CreateAgentChat(id, repoID, agentID, title string) error {
	enc, nonce, err := s.encryptOptional(title)
	if err != nil {
		return err
	}
	now := time.Now().Unix()
	_, err = s.db.Exec(
		`INSERT INTO agent_chats (id, repo_id, agent_id, encrypted_title, title_nonce, conversation_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, '', ?, ?)`,
		id, repoID, agentID, enc, nonce, now, now,
	)
	if err != nil {
		return fmt.Errorf("vault: creando el chat: %w", err)
	}
	return nil
}

// ListAgentChats devuelve los chats de un repositorio, del más reciente al más
// viejo — que es el orden en el que se los busca.
func (s *Store) ListAgentChats(repoID string) ([]AgentChat, error) {
	rows, err := s.db.Query(
		`SELECT id, repo_id, agent_id, encrypted_title, title_nonce, conversation_id, created_at, updated_at,
		        COALESCE(model, ''), COALESCE(effort, ''), COALESCE(mode, '')
		 FROM agent_chats WHERE repo_id = ? ORDER BY updated_at DESC`, repoID,
	)
	if err != nil {
		return nil, fmt.Errorf("vault: leyendo los chats: %w", err)
	}
	defer rows.Close()

	out := []AgentChat{}
	for rows.Next() {
		var c AgentChat
		var enc, nonce []byte
		if err := rows.Scan(&c.ID, &c.RepoID, &c.AgentID, &enc, &nonce, &c.ConversationID, &c.CreatedAt, &c.UpdatedAt,
			&c.Model, &c.Effort, &c.Mode); err != nil {
			return nil, err
		}
		// Un título que no se puede descifrar NO tira abajo la lista: se
		// muestra sin nombre y el chat se puede seguir retomando o borrar.
		// Perder el listado entero por una fila sería mucho peor.
		c.Title = s.decryptOptional(enc, nonce)
		out = append(out, c)
	}
	return out, rows.Err()
}

// RenameAgentChat cambia el nombre visible.
func (s *Store) RenameAgentChat(id, title string) error {
	enc, nonce, err := s.encryptOptional(title)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(
		`UPDATE agent_chats SET encrypted_title = ?, title_nonce = ?, updated_at = ? WHERE id = ?`,
		enc, nonce, time.Now().Unix(), id,
	)
	if err != nil {
		return fmt.Errorf("vault: renombrando el chat: %w", err)
	}
	return nil
}

// TouchAgentChat guarda el id de conversación del CLI y marca actividad.
//
// Se llama cuando el agente contesta por primera vez: hasta entonces no hay
// nada que retomar. Un id vacío no se escribe encima del que ya había — un
// turno que falló antes de arrancar no debe borrar la continuidad de los
// anteriores.
func (s *Store) TouchAgentChat(id, conversationID string) error {
	now := time.Now().Unix()
	var err error
	if conversationID == "" {
		_, err = s.db.Exec(`UPDATE agent_chats SET updated_at = ? WHERE id = ?`, now, id)
	} else {
		_, err = s.db.Exec(
			`UPDATE agent_chats SET conversation_id = ?, updated_at = ? WHERE id = ?`, conversationID, now, id)
	}
	if err != nil {
		return fmt.Errorf("vault: actualizando el chat: %w", err)
	}
	return nil
}

// SetAgentChatSettings guarda con qué modelo, esfuerzo y modo se estaba
// trabajando, para que retomar el chat lo continúe como venía.
func (s *Store) SetAgentChatSettings(id, model, effort, mode string) error {
	_, err := s.db.Exec(
		`UPDATE agent_chats SET model = ?, effort = ?, mode = ?, updated_at = ? WHERE id = ?`,
		model, effort, mode, time.Now().Unix(), id,
	)
	if err != nil {
		return fmt.Errorf("vault: guardando los ajustes del chat: %w", err)
	}
	return nil
}

// DeleteAgentChat borra la entrada. **No borra la conversación del CLI**: esa
// vive en su propio almacenamiento y esta app no la administra. Lo que se
// pierde es el atajo para retomarla desde acá.
func (s *Store) DeleteAgentChat(id string) error {
	if _, err := s.db.Exec(`DELETE FROM agent_chats WHERE id = ?`, id); err != nil {
		return fmt.Errorf("vault: borrando el chat: %w", err)
	}
	return nil
}

// encryptOptional cifra un texto que puede estar vacío. Vacío se guarda como
// NULL en vez de como un cifrado de la cadena vacía: distinguirlos permite que
// "sin título" no cueste una operación de cripto ni ocupe lugar.
func (s *Store) encryptOptional(v string) (enc, nonce []byte, err error) {
	if v == "" {
		return nil, nil, nil
	}
	key, err := s.gate.Key()
	if err != nil {
		return nil, nil, err
	}
	enc, nonce, err = mtcrypto.Encrypt(key, []byte(v))
	if err != nil {
		return nil, nil, fmt.Errorf("vault: cifrando el título del chat: %w", err)
	}
	return enc, nonce, nil
}

func (s *Store) decryptOptional(enc, nonce []byte) string {
	if len(enc) == 0 || len(nonce) == 0 {
		return ""
	}
	key, err := s.gate.Key()
	if err != nil {
		return ""
	}
	plain, err := mtcrypto.Decrypt(key, enc, nonce)
	if err != nil {
		return ""
	}
	return string(plain)
}
