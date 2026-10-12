package vault

import (
	"database/sql"
	"strings"
	"time"

	mtcrypto "mini-tools/backend/crypto"
	"mini-tools/backend/i18n"
)

// Mensajes de las conversaciones con agentes (migración 58).
//
// agent_chats guardaba solo el puntero a la conversación del CLI. Esto guarda
// lo que se dijo, para TODOS los proveedores: un servidor de modelos no tiene
// dónde guardar la charla, y buscar en el historial exige tenerlo junto. Los
// CLIs siguen retomando con su propio id; esto no lo reemplaza.
//
// El contenido va cifrado por columna, igual que el título del chat. El rol,
// el nombre de la herramienta, los tokens y las fechas van en claro: no son
// contenido.

// Roles de una fila.
const (
	ChatRoleUser      = "user"
	ChatRoleAssistant = "assistant"
	ChatRoleTool      = "tool"
)

// StoredChatMessage es una fila ya descifrada.
type StoredChatMessage struct {
	Seq      int
	Role     string
	Content  string
	ToolName string
	// Usage es el JSON de tokens de agentchat.Usage, o "" si no se conoce.
	Usage string
	// Meta es el JSON de la ficha de la fila (hoy: los adjuntos de un mensaje
	// del usuario, `{"attachments":[{"name","kind","size"}]}`), o "" si no tiene.
	// El vault no lo interpreta: es opaco para él, igual que Usage.
	Meta string
	// CreatedAt son segundos Unix, como el resto de agent_chats.
	CreatedAt int64
}

// NewChatMessage es lo que se agrega; el orden y la fecha los pone el repo.
type NewChatMessage struct {
	Role     string
	Content  string
	ToolName string
	Usage    string
	// Meta: ver StoredChatMessage.Meta. Se cifra como el contenido.
	Meta string
}

func (s *Store) encryptChatContent(v string) (enc, nonce []byte, err error) {
	if v == "" {
		return nil, nil, nil
	}
	key, err := s.gate.Key()
	if err != nil {
		return nil, nil, err
	}
	enc, nonce, err = mtcrypto.Encrypt(key, []byte(v))
	if err != nil {
		return nil, nil, i18n.Errorf(i18n.Msg{ES: "vault: cifrando el mensaje del chat: %w", EN: "vault: encrypting the chat message: %w"}, err)
	}
	return enc, nonce, nil
}

// AppendAgentChatMessages agrega mensajes al final del chat, en una sola
// transacción: un turno (herramientas + respuesta) entra entero o no entra.
// Marca además la actividad del chat (updated_at), que es lo que ordena el
// historial.
func (s *Store) AppendAgentChatMessages(chatID string, msgs []NewChatMessage) error {
	if len(msgs) == 0 {
		return nil
	}
	for _, m := range msgs {
		switch m.Role {
		case ChatRoleUser, ChatRoleAssistant, ChatRoleTool:
		default:
			return i18n.Errorf(i18n.Msg{ES: "vault: rol de mensaje desconocido %q", EN: "vault: unknown message role %q"}, m.Role)
		}
	}

	tx, err := s.db.Begin()
	if err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: guardando los mensajes del chat: %w", EN: "vault: saving the chat messages: %w"}, err)
	}
	defer tx.Rollback()

	now := time.Now().Unix()
	for _, m := range msgs {
		enc, nonce, err := s.encryptChatContent(m.Content)
		if err != nil {
			return err
		}
		menc, mnonce, err := s.encryptChatContent(m.Meta)
		if err != nil {
			return err
		}
		// El seq se calcula en la misma sentencia que inserta: leer el máximo
		// y después insertar dejaría una ventana para dos filas con el mismo
		// orden.
		if _, err := tx.Exec(
			`INSERT INTO agent_chat_messages (chat_id, seq, role, content, nonce, tool_name, usage, created_at, meta, meta_nonce)
			 VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM agent_chat_messages WHERE chat_id = ?), ?, ?, ?, ?, ?, ?, ?, ?)`,
			chatID, chatID, m.Role, enc, nonce, m.ToolName, m.Usage, now, menc, mnonce,
		); err != nil {
			return i18n.Errorf(i18n.Msg{ES: "vault: guardando los mensajes del chat: %w", EN: "vault: saving the chat messages: %w"}, err)
		}
	}
	if _, err := tx.Exec(`UPDATE agent_chats SET updated_at = ? WHERE id = ?`, now, chatID); err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: guardando los mensajes del chat: %w", EN: "vault: saving the chat messages: %w"}, err)
	}
	return tx.Commit()
}

// AppendAgentChatMessage agrega un solo mensaje.
func (s *Store) AppendAgentChatMessage(chatID, role, content, toolName, usage string) error {
	return s.AppendAgentChatMessages(chatID, []NewChatMessage{{Role: role, Content: content, ToolName: toolName, Usage: usage}})
}

// ListAgentChatMessages devuelve la conversación entera, del primer mensaje al
// último. Nunca nil: el frontend la recorre con .map.
func (s *Store) ListAgentChatMessages(chatID string) ([]StoredChatMessage, error) {
	rows, err := s.db.Query(
		`SELECT seq, role, content, nonce, tool_name, usage, created_at, meta, meta_nonce
		 FROM agent_chat_messages WHERE chat_id = ? ORDER BY seq`, chatID)
	if err != nil {
		return nil, i18n.Errorf(i18n.Msg{ES: "vault: leyendo los mensajes del chat: %w", EN: "vault: reading the chat messages: %w"}, err)
	}
	defer rows.Close()
	return s.scanChatMessages(rows)
}

// RecentAgentChatMessages devuelve los últimos n mensajes, en orden
// cronológico (el más viejo de los n primero) — lo que hace falta para armar
// el contexto de un modelo.
func (s *Store) RecentAgentChatMessages(chatID string, n int) ([]StoredChatMessage, error) {
	if n <= 0 {
		return []StoredChatMessage{}, nil
	}
	rows, err := s.db.Query(
		`SELECT seq, role, content, nonce, tool_name, usage, created_at, meta, meta_nonce
		 FROM agent_chat_messages WHERE chat_id = ? ORDER BY seq DESC LIMIT ?`, chatID, n)
	if err != nil {
		return nil, i18n.Errorf(i18n.Msg{ES: "vault: leyendo los mensajes del chat: %w", EN: "vault: reading the chat messages: %w"}, err)
	}
	defer rows.Close()
	out, err := s.scanChatMessages(rows)
	if err != nil {
		return nil, err
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, nil
}

func (s *Store) scanChatMessages(rows *sql.Rows) ([]StoredChatMessage, error) {
	out := []StoredChatMessage{}
	for rows.Next() {
		var m StoredChatMessage
		var enc, nonce, menc, mnonce []byte
		if err := rows.Scan(&m.Seq, &m.Role, &enc, &nonce, &m.ToolName, &m.Usage, &m.CreatedAt, &menc, &mnonce); err != nil {
			return nil, err
		}
		m.Meta = s.decryptOptional(menc, mnonce)
		// Un mensaje que no se descifra no tira abajo la conversación: se
		// muestra vacío y el resto se lee igual.
		m.Content = s.decryptOptional(enc, nonce)
		out = append(out, m)
	}
	return out, rows.Err()
}

// DeleteAgentChatMessages borra los mensajes de un chat sin tocar el chat.
func (s *Store) DeleteAgentChatMessages(chatID string) error {
	if _, err := s.db.Exec(`DELETE FROM agent_chat_messages WHERE chat_id = ?`, chatID); err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: borrando los mensajes del chat: %w", EN: "vault: deleting the chat messages: %w"}, err)
	}
	return nil
}

// SearchAgentChats busca texto en los títulos y en los mensajes de TODOS los
// chats y devuelve los que aciertan, del más reciente al más viejo.
//
// **Descifra y filtra en Go**: el contenido cifrado no admite LIKE, y un
// índice de texto sobre contenido cifrado guardaría algo derivado del texto
// plano (ver notesearch.go). A escala de historial personal no se nota.
//
// Mismas reglas que el buscador de notas: sin distinguir mayúsculas ni
// acentos, varias palabras en cualquier orden —todas tienen que aparecer, en
// el título o en cualquier mensaje del chat— y las comillas piden una frase
// literal. Una consulta vacía no devuelve nada: listar es ListAllAgentChats.
// limit <= 0 no acota.
func (s *Store) SearchAgentChats(raw string, limit int) ([]AgentChat, error) {
	terms, phrases := chatSearchTerms(raw)
	out := []AgentChat{}
	if len(terms) == 0 && len(phrases) == 0 {
		return out, nil
	}

	chats, err := s.ListAllAgentChats() // ya viene por updated_at DESC
	if err != nil {
		return nil, err
	}

	// pending[id] es lo que a ese chat todavía le falta encontrar. Se va
	// vaciando con el título y con cada mensaje; un chat con la lista vacía
	// ya acertó y no se descifra nada más de él.
	type need struct{ terms, phrases []string }
	pending := make(map[string]*need, len(chats))
	for _, c := range chats {
		n := &need{terms: append([]string(nil), terms...), phrases: append([]string(nil), phrases...)}
		consumeFound(foldText(c.Title), &n.terms, &n.phrases)
		pending[c.ID] = n
	}
	done := func(n *need) bool { return len(n.terms) == 0 && len(n.phrases) == 0 }

	rows, err := s.db.Query(`SELECT chat_id, content, nonce FROM agent_chat_messages ORDER BY chat_id, seq`)
	if err != nil {
		return nil, i18n.Errorf(i18n.Msg{ES: "vault: buscando en los chats: %w", EN: "vault: searching the chats: %w"}, err)
	}
	defer rows.Close()
	for rows.Next() {
		var chatID string
		var enc, nonce []byte
		if err := rows.Scan(&chatID, &enc, &nonce); err != nil {
			return nil, err
		}
		n := pending[chatID]
		if n == nil || done(n) {
			continue
		}
		consumeFound(foldText(s.decryptOptional(enc, nonce)), &n.terms, &n.phrases)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	for _, c := range chats {
		if done(pending[c.ID]) {
			out = append(out, c)
			if limit > 0 && len(out) >= limit {
				break
			}
		}
	}
	return out, nil
}

// chatSearchTerms separa la consulta en palabras sueltas y frases entre
// comillas, ya normalizadas.
func chatSearchTerms(raw string) (terms, phrases []string) {
	for _, tok := range splitQuoted(raw) {
		if tok.quoted {
			if p := foldText(strings.TrimSpace(tok.text)); p != "" {
				phrases = append(phrases, p)
			}
			continue
		}
		for _, w := range strings.Fields(tok.text) {
			if f := foldText(w); f != "" {
				terms = append(terms, f)
			}
		}
	}
	return terms, phrases
}

// consumeFound saca de las listas lo que aparece en el texto (ya normalizado).
func consumeFound(folded string, terms, phrases *[]string) {
	keep := func(list []string) []string {
		out := list[:0]
		for _, t := range list {
			if !strings.Contains(folded, t) {
				out = append(out, t)
			}
		}
		return out
	}
	*terms = keep(*terms)
	*phrases = keep(*phrases)
}
