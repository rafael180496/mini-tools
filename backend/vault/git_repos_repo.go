package vault

import (
	"fmt"
	"time"
)

// GitRepo is a repository the user added to the Git module's sidebar.
//
// It stores nothing sensitive — path, display name, grouping, order. Auth for
// a remote is resolved at operation time by the OS credential helper or
// ssh-agent (backend/git/auth.go), so unlike `connections` there is no
// encrypted column here and nothing to decrypt on read. It is gated behind
// requireUnlocked in app.go anyway, same as recent_files and ssh_snippets: a
// list of a user's local project paths is not a credential, but it is still
// their data.
//
// FolderID reuses the shared `folders` table with scope 'git' — the same
// approach migrations 12 and 14 took for SSH connections and snippets, rather
// than a fourth parallel tree. "" means root, the same no-pointer-for-null
// convention used across this package.
type GitRepo struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Path      string `json:"path"`
	FolderID  string `json:"folderId,omitempty"`
	SortOrder int    `json:"sortOrder"`
	CreatedAt int64  `json:"createdAt"`
}

// AddGitRepo registers a repository at root. path is expected to be the
// canonical working-tree root already resolved by backend/git — this layer
// does not validate that it is a repository, it only persists it.
//
// The path column is UNIQUE, so adding the same repository twice is reported
// as a clear error instead of silently producing a duplicate sidebar entry.
func (s *Store) AddGitRepo(name, path string) (*GitRepo, error) {
	var existing string
	err := s.db.QueryRow(`SELECT name FROM git_repos WHERE path = ?`, path).Scan(&existing)
	if err == nil {
		return nil, fmt.Errorf("vault: el repositorio %q ya está agregado como %q", path, existing)
	}

	id, err := newID()
	if err != nil {
		return nil, err
	}
	createdAt := time.Now().Unix()

	var nextOrder int
	if err := s.db.QueryRow(`SELECT COALESCE(MAX(sort_order), -1) + 1 FROM git_repos`).Scan(&nextOrder); err != nil {
		return nil, fmt.Errorf("vault: calculando orden del repositorio: %w", err)
	}

	if _, err := s.db.Exec(
		`INSERT INTO git_repos (id, name, path, sort_order, created_at) VALUES (?, ?, ?, ?, ?)`,
		id, name, path, nextOrder, createdAt,
	); err != nil {
		return nil, fmt.Errorf("vault: agregando repositorio: %w", err)
	}

	return &GitRepo{ID: id, Name: name, Path: path, SortOrder: nextOrder, CreatedAt: createdAt}, nil
}

// ListGitRepos returns every registered repository, ordered for the sidebar.
// Rows come back flat; the tree is built client-side from folder_id, the same
// way ConnectionTree and the snippet tree already work.
func (s *Store) ListGitRepos() ([]GitRepo, error) {
	rows, err := s.db.Query(`
		SELECT id, name, path, COALESCE(folder_id, ''), sort_order, created_at
		FROM git_repos
		ORDER BY sort_order, name
	`)
	if err != nil {
		return nil, fmt.Errorf("vault: listando repositorios: %w", err)
	}
	defer rows.Close()

	repos := []GitRepo{}
	for rows.Next() {
		var r GitRepo
		if err := rows.Scan(&r.ID, &r.Name, &r.Path, &r.FolderID, &r.SortOrder, &r.CreatedAt); err != nil {
			return nil, fmt.Errorf("vault: leyendo repositorio: %w", err)
		}
		repos = append(repos, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("vault: listando repositorios: %w", err)
	}
	return repos, nil
}

// GetGitRepo resolves one repository by ID. The frontend addresses
// repositories by opaque ID and never sends a filesystem path back to Go, so
// this is what turns a click into a path for backend/git — the same shape as
// the connection-ID indirection used everywhere else.
func (s *Store) GetGitRepo(id string) (*GitRepo, error) {
	var r GitRepo
	err := s.db.QueryRow(`
		SELECT id, name, path, COALESCE(folder_id, ''), sort_order, created_at
		FROM git_repos WHERE id = ?
	`, id).Scan(&r.ID, &r.Name, &r.Path, &r.FolderID, &r.SortOrder, &r.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("vault: repositorio %q no encontrado: %w", id, err)
	}
	return &r, nil
}

// RenameGitRepo changes only the display name; the path on disk is untouched.
func (s *Store) RenameGitRepo(id, name string) error {
	res, err := s.db.Exec(`UPDATE git_repos SET name = ? WHERE id = ?`, name, id)
	if err != nil {
		return fmt.Errorf("vault: renombrando repositorio: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("vault: renombrando repositorio: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("vault: repositorio %q no encontrado", id)
	}
	return nil
}

// MoveGitRepoToFolder reparents a repository into a folder ("" = root).
func (s *Store) MoveGitRepoToFolder(id, folderID string) error {
	res, err := s.db.Exec(`UPDATE git_repos SET folder_id = ? WHERE id = ?`, nullableString(folderID), id)
	if err != nil {
		return fmt.Errorf("vault: moviendo repositorio: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("vault: moviendo repositorio: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("vault: repositorio %q no encontrado", id)
	}
	return nil
}

// RemoveGitRepo drops the repository from the sidebar. It deliberately does
// NOT touch the working tree on disk — removing a project from a list must
// never delete the user's code, the same principle as DeleteFolder never
// deleting what it contains.
func (s *Store) RemoveGitRepo(id string) error {
	res, err := s.db.Exec(`DELETE FROM git_repos WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("vault: quitando repositorio: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("vault: quitando repositorio: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("vault: repositorio %q no encontrado", id)
	}
	return nil
}
