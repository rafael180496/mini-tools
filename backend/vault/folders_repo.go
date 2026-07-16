package vault

import (
	"database/sql"
	"fmt"
	"time"
)

// Folder is a node in the connection tree — a purely organizational
// container, never anything sensitive (no DSN/credential ever touches this
// table). ParentID/FolderID being "" means "root" throughout this file and
// connections_repo.go's MoveConnectionToFolder — same no-pointer-for-null
// convention as ConnectionSummary.Color (see connections_repo.go).
type Folder struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	ParentID  string `json:"parentId,omitempty"`
	SortOrder int    `json:"sortOrder"`
	CreatedAt int64  `json:"createdAt"`
	// Scope keeps SSH connections' folder tree entirely independent of DB
	// connections' — "db" or "ssh" (schema_migrations version 12). Two
	// folders with the same name/parent but different scope are unrelated;
	// each sidebar module (ConnectionTree.tsx/SshConnectionTree.tsx)
	// filters ListFolders' flat result to its own scope client-side, same
	// "flat rows in, tree built client-side" approach as ever.
	Scope string `json:"scope"`
}

// CreateFolder inserts a new folder, optionally nested under parentID ("" =
// root), scoped to "db" or "ssh" — see Folder.Scope.
func (s *Store) CreateFolder(name, parentID, scope string) (*Folder, error) {
	id, err := newID()
	if err != nil {
		return nil, err
	}
	createdAt := time.Now().Unix()

	if _, err := s.db.Exec(
		`INSERT INTO folders (id, name, parent_id, sort_order, created_at, scope) VALUES (?, ?, ?, 0, ?, ?)`,
		id, name, nullableString(parentID), createdAt, scope,
	); err != nil {
		return nil, fmt.Errorf("vault: creando carpeta: %w", err)
	}

	return &Folder{ID: id, Name: name, ParentID: parentID, CreatedAt: createdAt, Scope: scope}, nil
}

// RenameFolder updates a folder's display name in place.
func (s *Store) RenameFolder(id, name string) error {
	res, err := s.db.Exec(`UPDATE folders SET name = ? WHERE id = ?`, name, id)
	if err != nil {
		return fmt.Errorf("vault: renombrando carpeta: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("vault: renombrando carpeta: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("vault: carpeta %q no encontrada", id)
	}
	return nil
}

// MoveFolder reparents a folder under newParentID ("" = root).
func (s *Store) MoveFolder(id, newParentID string) error {
	res, err := s.db.Exec(`UPDATE folders SET parent_id = ? WHERE id = ?`, nullableString(newParentID), id)
	if err != nil {
		return fmt.Errorf("vault: moviendo carpeta: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("vault: moviendo carpeta: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("vault: carpeta %q no encontrada", id)
	}
	return nil
}

// DeleteFolder removes a folder WITHOUT ever deleting what's inside it —
// its subfolders and connections are reparented to id's own parent (or to
// root, if id was already a root folder) before the row itself is deleted.
// Same "organizational delete never touches real data" principle as
// unbinding an editor tab's connection without touching the file on disk
// (see EditorTabs.tsx).
func (s *Store) DeleteFolder(id string) error {
	var parentID sql.NullString
	if err := s.db.QueryRow(`SELECT parent_id FROM folders WHERE id = ?`, id).Scan(&parentID); err != nil {
		if err == sql.ErrNoRows {
			return fmt.Errorf("vault: carpeta %q no encontrada", id)
		}
		return fmt.Errorf("vault: leyendo carpeta: %w", err)
	}

	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("vault: borrando carpeta: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`UPDATE folders SET parent_id = ? WHERE parent_id = ?`, parentID, id); err != nil {
		return fmt.Errorf("vault: reparentando subcarpetas: %w", err)
	}
	if _, err := tx.Exec(`UPDATE connections SET folder_id = ? WHERE folder_id = ?`, parentID, id); err != nil {
		return fmt.Errorf("vault: reparentando conexiones: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM folders WHERE id = ?`, id); err != nil {
		return fmt.Errorf("vault: borrando carpeta: %w", err)
	}

	return tx.Commit()
}

// ReorderFolder moves a folder one slot "up" or "down" among its siblings
// (same parent). Re-indexes every sibling to dense 0..n-1 sort_order values
// from their CURRENT effective order first, then swaps id with its
// neighbor — a plain value swap wouldn't visibly move anything for
// siblings that still share sort_order 0 (every folder's default at
// creation, see CreateFolder). A no-op (not an error) if id is already at
// that edge of its sibling list.
func (s *Store) ReorderFolder(id, direction string) error {
	if direction != "up" && direction != "down" {
		return fmt.Errorf("vault: dirección de reorden inválida %q", direction)
	}

	var parentID sql.NullString
	var scope string
	if err := s.db.QueryRow(`SELECT parent_id, scope FROM folders WHERE id = ?`, id).Scan(&parentID, &scope); err != nil {
		if err == sql.ErrNoRows {
			return fmt.Errorf("vault: carpeta %q no encontrada", id)
		}
		return fmt.Errorf("vault: leyendo carpeta: %w", err)
	}

	// Siblings means same parent AND same scope — otherwise reordering an
	// SSH root folder could silently swap sort_order with an unrelated DB
	// root folder that happens to interleave with it in the global
	// sort_order/name ordering, moving nothing visible in either module's
	// own (scope-filtered) tree.
	rows, err := s.db.Query(
		`SELECT id FROM folders WHERE parent_id IS ? AND scope = ? ORDER BY sort_order, name`,
		nullableString(parentID.String), scope,
	)
	if err != nil {
		return fmt.Errorf("vault: listando carpetas hermanas: %w", err)
	}
	var siblingIDs []string
	for rows.Next() {
		var sid string
		if err := rows.Scan(&sid); err != nil {
			rows.Close()
			return fmt.Errorf("vault: leyendo carpeta hermana: %w", err)
		}
		siblingIDs = append(siblingIDs, sid)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("vault: listando carpetas hermanas: %w", err)
	}

	idx := -1
	for i, sid := range siblingIDs {
		if sid == id {
			idx = i
			break
		}
	}
	if idx == -1 {
		return fmt.Errorf("vault: carpeta %q no encontrada", id)
	}

	swapWith := idx - 1
	if direction == "down" {
		swapWith = idx + 1
	}
	if swapWith < 0 || swapWith >= len(siblingIDs) {
		return nil
	}
	siblingIDs[idx], siblingIDs[swapWith] = siblingIDs[swapWith], siblingIDs[idx]

	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("vault: reordenando carpetas: %w", err)
	}
	defer tx.Rollback()
	for i, sid := range siblingIDs {
		if _, err := tx.Exec(`UPDATE folders SET sort_order = ? WHERE id = ?`, i, sid); err != nil {
			return fmt.Errorf("vault: reordenando carpetas: %w", err)
		}
	}
	return tx.Commit()
}

// ListFolders returns every folder, flat — the frontend builds the tree
// from parentId (see frontend/src/lib/folderTree.ts), same "flat rows in,
// tree built client-side" approach ConnectionTree.tsx already uses for
// connections→schemas.
func (s *Store) ListFolders() ([]Folder, error) {
	rows, err := s.db.Query(`SELECT id, name, parent_id, sort_order, created_at, scope FROM folders ORDER BY sort_order, name`)
	if err != nil {
		return nil, fmt.Errorf("vault: listando carpetas: %w", err)
	}
	defer rows.Close()

	out := []Folder{}
	for rows.Next() {
		var f Folder
		var parentID sql.NullString
		if err := rows.Scan(&f.ID, &f.Name, &parentID, &f.SortOrder, &f.CreatedAt, &f.Scope); err != nil {
			return nil, fmt.Errorf("vault: leyendo carpeta: %w", err)
		}
		f.ParentID = parentID.String
		out = append(out, f)
	}
	return out, rows.Err()
}
