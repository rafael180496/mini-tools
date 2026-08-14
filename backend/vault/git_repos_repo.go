package vault

import (
	"encoding/json"
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
	// PinnedBranches are the branches the user keeps at the top of the
	// sidebar. Per repository, not global: "develop" is the trunk in one
	// project and does not exist in another.
	PinnedBranches []string `json:"pinnedBranches"`
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
		SELECT id, name, path, COALESCE(folder_id, ''), sort_order, created_at, COALESCE(pinned_branches, '[]')
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
		var pinned string
		if err := rows.Scan(&r.ID, &r.Name, &r.Path, &r.FolderID, &r.SortOrder, &r.CreatedAt, &pinned); err != nil {
			return nil, fmt.Errorf("vault: leyendo repositorio: %w", err)
		}
		r.PinnedBranches = decodePinned(pinned)
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

// GitRepoWorkspace es el estado por repositorio del banco de trabajo: qué
// archivos tenía abiertos el editor y con qué agente se abre una sesión.
//
// Va aparte de GitRepo y no como campos suyos porque GitRepo lo lee la barra
// lateral en cada refresco para dibujar la lista, y esto solo lo necesita la
// pestaña abierta.
type GitRepoWorkspace struct {
	OpenFiles []string `json:"openFiles"`
	// DefaultAgent vacío significa "preguntar", que es el default correcto:
	// elegir por el usuario un asistente que consume su cuota no es algo que
	// nadie haya pedido.
	DefaultAgent string `json:"defaultAgent"`
}

// GitRepoWorkspaceFor lee ese estado. Un valor ilegible degrada a vacío en vez
// de fallar, mismo criterio que decodePinned: perder las pestañas abiertas es
// molesto, no poder abrir el repositorio es otra cosa.
func (s *Store) GitRepoWorkspaceFor(id string) (GitRepoWorkspace, error) {
	var rawFiles, agent string
	err := s.db.QueryRow(
		`SELECT COALESCE(open_files, '[]'), COALESCE(default_agent, '') FROM git_repos WHERE id = ?`, id,
	).Scan(&rawFiles, &agent)
	if err != nil {
		return GitRepoWorkspace{}, fmt.Errorf("vault: repositorio %q no encontrado: %w", id, err)
	}

	ws := GitRepoWorkspace{OpenFiles: []string{}, DefaultAgent: agent}
	if rawFiles != "" {
		var files []string
		if err := json.Unmarshal([]byte(rawFiles), &files); err == nil && files != nil {
			ws.OpenFiles = files
		}
	}
	return ws, nil
}

// SetGitRepoOpenFiles guarda las RUTAS de los archivos abiertos, nunca su
// contenido: al reabrir hay que leer el archivo como está ahora, que es lo
// único correcto si un agente lo tocó mientras tanto.
func (s *Store) SetGitRepoOpenFiles(id string, files []string) error {
	if files == nil {
		files = []string{}
	}
	encoded, err := json.Marshal(files)
	if err != nil {
		return fmt.Errorf("vault: serializando archivos abiertos: %w", err)
	}
	if _, err := s.db.Exec(`UPDATE git_repos SET open_files = ? WHERE id = ?`, string(encoded), id); err != nil {
		return fmt.Errorf("vault: guardando archivos abiertos: %w", err)
	}
	return nil
}

// SetGitRepoDefaultAgent fija con qué agente se abre una sesión desde este
// repositorio. Vacío vuelve a "preguntar".
func (s *Store) SetGitRepoDefaultAgent(id, agentID string) error {
	if _, err := s.db.Exec(`UPDATE git_repos SET default_agent = ? WHERE id = ?`, agentID, id); err != nil {
		return fmt.Errorf("vault: guardando el agente por defecto: %w", err)
	}
	return nil
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
	// Los chats del repositorio se borran EXPLÍCITAMENTE, aunque agent_chats
	// declare ON DELETE CASCADE.
	//
	// Ese CASCADE no se dispara: SQLite no aplica claves foráneas salvo que se
	// active `PRAGMA foreign_keys = ON`, y este vault no lo hace. Se comprobó
	// con un script sandboxeado — el chat sobrevivía al borrado del
	// repositorio. Se resuelve acá y no activando el pragma porque ese cambio
	// es global: alteraría el comportamiento de toda tabla con FK declarada,
	// incluidas las que hoy funcionan sin él, y eso merece su propia
	// verificación en vez de entrar de costado con esta feature.
	if _, err := s.db.Exec(`DELETE FROM agent_chats WHERE repo_id = ?`, id); err != nil {
		return fmt.Errorf("vault: quitando los chats del repositorio: %w", err)
	}

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

// SetGitRepoPinnedBranches replaces a repository's pinned branch list.
//
// Stored as JSON in one column rather than as a child table: it is a short
// ordered list read and written whole, never queried across repositories,
// and the same shape settings.open_tabs already uses.
func (s *Store) SetGitRepoPinnedBranches(id string, branches []string) error {
	if branches == nil {
		branches = []string{}
	}
	encoded, err := json.Marshal(branches)
	if err != nil {
		return fmt.Errorf("vault: serializando ramas ancladas: %w", err)
	}
	if _, err := s.db.Exec(`UPDATE git_repos SET pinned_branches = ? WHERE id = ?`, string(encoded), id); err != nil {
		return fmt.Errorf("vault: guardando ramas ancladas: %w", err)
	}
	return nil
}

// decodePinned reads the JSON column, degrading to an empty list rather than
// failing: a malformed value costs the user their pinned list, which they can
// redo in two clicks, while an error would make the whole repository list
// unreadable.
func decodePinned(raw string) []string {
	if raw == "" {
		return []string{}
	}
	var out []string
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return []string{}
	}
	return out
}
