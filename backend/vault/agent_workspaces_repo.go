package vault

import (
	"database/sql"
	"errors"
	"time"

	"mini-tools/backend/i18n"
)

// Carpetas de trabajo de los chats con un servidor de modelos (migración 61).
//
// Un repositorio de git ya se registra en git_repos; esto es para lo que NO es
// un repositorio — un proyecto sin git, una carpeta de documentos — y aun así
// se le quiere dar herramientas de archivos y comandos a un modelo. No guarda
// nada sensible: un nombre y una ruta. Va detrás de requireUnlocked igual que
// git_repos, porque la lista de carpetas de un usuario es dato suyo.

// AgentWorkspace es una carpeta registrada.
type AgentWorkspace struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Path      string `json:"path"`
	CreatedAt int64  `json:"createdAt"`
}

// AddAgentWorkspace registra una carpeta. La validación de QUÉ carpeta se
// acepta (existe, no es demasiado ancha) es de quien llama: esta capa solo
// persiste. path es UNIQUE, así que un duplicado exacto falla acá también.
func (s *Store) AddAgentWorkspace(name, path string) (*AgentWorkspace, error) {
	id, err := newID()
	if err != nil {
		return nil, err
	}
	now := time.Now().Unix()
	if _, err := s.db.Exec(
		`INSERT INTO agent_workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)`,
		id, name, path, now,
	); err != nil {
		return nil, i18n.Errorf(i18n.Msg{ES: "vault: agregando carpeta de trabajo: %w", EN: "vault: adding work folder: %w"}, err)
	}
	return &AgentWorkspace{ID: id, Name: name, Path: path, CreatedAt: now}, nil
}

// ListAgentWorkspaces devuelve las carpetas, las más recientes al final (el
// orden en que se fueron agregando).
func (s *Store) ListAgentWorkspaces() ([]AgentWorkspace, error) {
	rows, err := s.db.Query(`SELECT id, name, path, created_at FROM agent_workspaces ORDER BY created_at, name`)
	if err != nil {
		return nil, i18n.Errorf(i18n.Msg{ES: "vault: listando carpetas de trabajo: %w", EN: "vault: listing work folders: %w"}, err)
	}
	defer rows.Close()
	out := []AgentWorkspace{}
	for rows.Next() {
		var w AgentWorkspace
		if err := rows.Scan(&w.ID, &w.Name, &w.Path, &w.CreatedAt); err != nil {
			return nil, i18n.Errorf(i18n.Msg{ES: "vault: leyendo carpeta de trabajo: %w", EN: "vault: reading work folder: %w"}, err)
		}
		out = append(out, w)
	}
	if err := rows.Err(); err != nil {
		return nil, i18n.Errorf(i18n.Msg{ES: "vault: listando carpetas de trabajo: %w", EN: "vault: listing work folders: %w"}, err)
	}
	return out, nil
}

// GetAgentWorkspace resuelve una carpeta por id. El frontend la direcciona por
// id opaco y nunca manda una ruta de vuelta.
func (s *Store) GetAgentWorkspace(id string) (*AgentWorkspace, error) {
	var w AgentWorkspace
	err := s.db.QueryRow(`SELECT id, name, path, created_at FROM agent_workspaces WHERE id = ?`, id).
		Scan(&w.ID, &w.Name, &w.Path, &w.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, i18n.Errorf(i18n.Msg{ES: "vault: carpeta de trabajo %q no encontrada", EN: "vault: work folder %q not found"}, id)
	}
	if err != nil {
		return nil, i18n.Errorf(i18n.Msg{ES: "vault: leyendo carpeta de trabajo: %w", EN: "vault: reading work folder: %w"}, err)
	}
	return &w, nil
}

// RemoveAgentWorkspace quita la carpeta de la lista. NO toca la carpeta en el
// disco — sacar un proyecto de una lista nunca borra el código del usuario.
//
// Los chats que la tenían como contexto (`ws:<id>`) se borran con sus mensajes,
// igual que RemoveGitRepo: sin la carpeta esos chats conservarían un contexto
// que ya no resuelve a nada. Es explícito y no un ON DELETE CASCADE porque este
// vault no activa `PRAGMA foreign_keys` (ver RemoveGitRepo).
func (s *Store) RemoveAgentWorkspace(id string) error {
	ctxID := AgentWorkspaceContextPrefix + id
	if _, err := s.db.Exec(`DELETE FROM agent_chat_messages WHERE chat_id IN (SELECT id FROM agent_chats WHERE context_id = ?)`, ctxID); err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: quitando los mensajes de los chats de la carpeta: %w", EN: "vault: removing the messages of the folder's chats: %w"}, err)
	}
	if _, err := s.db.Exec(`DELETE FROM agent_chats WHERE context_id = ?`, ctxID); err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: quitando los chats de la carpeta: %w", EN: "vault: removing the folder's chats: %w"}, err)
	}
	res, err := s.db.Exec(`DELETE FROM agent_workspaces WHERE id = ?`, id)
	if err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: quitando carpeta de trabajo: %w", EN: "vault: removing work folder: %w"}, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: quitando carpeta de trabajo: %w", EN: "vault: removing work folder: %w"}, err)
	}
	if n == 0 {
		return i18n.Errorf(i18n.Msg{ES: "vault: carpeta de trabajo %q no encontrada", EN: "vault: work folder %q not found"}, id)
	}
	return nil
}

// AgentWorkspaceContextPrefix es el prefijo con que el contexto de un chat
// nombra una carpeta de trabajo: `ws:<id>`. Un id de repositorio git va sin
// prefijo.
const AgentWorkspaceContextPrefix = "ws:"
