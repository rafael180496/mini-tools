package vault

import (
	"database/sql"
	"fmt"
	"time"
)

// SshSnippet is a reusable command/script the user can Run (execute
// immediately) or Paste (insert without executing) into ANY open SSH
// terminal session — global, never tied to one connection, matching
// Termius' own snippet library (see .claude/skills/mini-tools-patterns for
// the SSH module's other design decisions). Never column-level encrypted,
// same reasoning as recent_files/query_history: a script name/body isn't a
// credential, so gating it behind decryption would only add friction with
// no security benefit — it's still gated behind requireUnlocked in app.go
// like every other data-bearing method, just not encrypted at rest.
type SshSnippet struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Script string `json:"script"`
	// FolderID is which folders.id (scope 'ssh-snippet', schema_migrations
	// version 14) this snippet is organized under — "" means root, same
	// no-pointer-for-null convention as Folder.ParentID/ConnectionSummary.
	// FolderID. This tree is entirely independent of the 'db'/'ssh'
	// connection folder trees, even if a folder happens to share a name.
	FolderID  string `json:"folderId,omitempty"`
	CreatedAt int64  `json:"createdAt"`
}

// CreateSshSnippet appends a new snippet at the end of the list, at root
// (organizing into a folder is a separate step via MoveSshSnippetToFolder,
// same "create then organize" flow connections already use).
func (s *Store) CreateSshSnippet(name, script string) (*SshSnippet, error) {
	id, err := newID()
	if err != nil {
		return nil, err
	}
	createdAt := time.Now().Unix()

	var nextOrder int
	if err := s.db.QueryRow(`SELECT COALESCE(MAX(sort_order), -1) + 1 FROM ssh_snippets`).Scan(&nextOrder); err != nil {
		return nil, fmt.Errorf("vault: calculando orden del snippet: %w", err)
	}

	if _, err := s.db.Exec(
		`INSERT INTO ssh_snippets (id, name, script, sort_order, created_at) VALUES (?, ?, ?, ?, ?)`,
		id, name, script, nextOrder, createdAt,
	); err != nil {
		return nil, fmt.Errorf("vault: creando snippet: %w", err)
	}
	return &SshSnippet{ID: id, Name: name, Script: script, CreatedAt: createdAt}, nil
}

// UpdateSshSnippet overwrites an existing snippet's name/script in place.
func (s *Store) UpdateSshSnippet(id, name, script string) error {
	res, err := s.db.Exec(`UPDATE ssh_snippets SET name = ?, script = ? WHERE id = ?`, name, script, id)
	if err != nil {
		return fmt.Errorf("vault: actualizando snippet: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("vault: actualizando snippet: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("vault: snippet %q no encontrado", id)
	}
	return nil
}

// DeleteSshSnippet removes a snippet permanently.
func (s *Store) DeleteSshSnippet(id string) error {
	if _, err := s.db.Exec(`DELETE FROM ssh_snippets WHERE id = ?`, id); err != nil {
		return fmt.Errorf("vault: borrando snippet: %w", err)
	}
	return nil
}

// MoveSshSnippetToFolder reparents a snippet under folderID ("" = root) —
// same shape as MoveConnectionToFolder (connections_repo.go).
func (s *Store) MoveSshSnippetToFolder(id, folderID string) error {
	res, err := s.db.Exec(`UPDATE ssh_snippets SET folder_id = ? WHERE id = ?`, nullableString(folderID), id)
	if err != nil {
		return fmt.Errorf("vault: moviendo snippet de carpeta: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("vault: moviendo snippet de carpeta: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("vault: snippet %q no encontrado", id)
	}
	return nil
}

// ListSshSnippets returns every snippet, insertion order.
func (s *Store) ListSshSnippets() ([]SshSnippet, error) {
	rows, err := s.db.Query(`SELECT id, name, script, folder_id, created_at FROM ssh_snippets ORDER BY sort_order, created_at`)
	if err != nil {
		return nil, fmt.Errorf("vault: listando snippets: %w", err)
	}
	defer rows.Close()

	out := []SshSnippet{}
	for rows.Next() {
		var sn SshSnippet
		var folderID sql.NullString
		if err := rows.Scan(&sn.ID, &sn.Name, &sn.Script, &folderID, &sn.CreatedAt); err != nil {
			return nil, fmt.Errorf("vault: leyendo snippet: %w", err)
		}
		sn.FolderID = folderID.String
		out = append(out, sn)
	}
	return out, rows.Err()
}
