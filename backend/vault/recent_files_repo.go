package vault

import (
	"time"

	"mini-tools/backend/i18n"
)

// RecentFile is one entry of the recent-files list — never encrypted, like
// query_history, per spec ("persiste en vault, config local, no encriptado").
type RecentFile struct {
	Path     string `json:"path"`
	OpenedAt int64  `json:"openedAt"`
}

// RecordRecentFile upserts path with the current time, so it moves to the
// top of the recent list whether it's newly opened or re-opened.
func (s *Store) RecordRecentFile(path string) error {
	_, err := s.db.Exec(
		`INSERT INTO recent_files (path, opened_at) VALUES (?, ?)
		 ON CONFLICT(path) DO UPDATE SET opened_at = excluded.opened_at`,
		path, time.Now().Unix(),
	)
	if err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: guardando recent file: %w", EN: "vault: saving recent file: %w"}, err)
	}
	return nil
}

// ListRecentFiles returns the most recently opened files, newest first.
func (s *Store) ListRecentFiles(limit int) ([]RecentFile, error) {
	if limit <= 0 {
		limit = 20
	}

	rows, err := s.db.Query(`SELECT path, opened_at FROM recent_files ORDER BY opened_at DESC LIMIT ?`, limit)
	if err != nil {
		return nil, i18n.Errorf(i18n.Msg{ES: "vault: listando recent files: %w", EN: "vault: listing recent files: %w"}, err)
	}
	defer rows.Close()

	out := []RecentFile{}
	for rows.Next() {
		var f RecentFile
		if err := rows.Scan(&f.Path, &f.OpenedAt); err != nil {
			return nil, i18n.Errorf(i18n.Msg{ES: "vault: leyendo recent file: %w", EN: "vault: reading recent file: %w"}, err)
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// ClearRecentFiles removes every entry — the spec's manual "limpiar
// historial" button.
func (s *Store) ClearRecentFiles() error {
	if _, err := s.db.Exec(`DELETE FROM recent_files`); err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: limpiando recent files: %w", EN: "vault: clearing recent files: %w"}, err)
	}
	return nil
}
