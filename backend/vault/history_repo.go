package vault

import (
	"database/sql"
	"fmt"
	"time"
)

// HistoryEntry is one row of query_history — never encrypted, unlike
// connections, per spec ("historial de queries... tabla separada, no
// encriptada").
type HistoryEntry struct {
	ID           string `json:"id"`
	ConnectionID string `json:"connectionId"`
	SQLText      string `json:"sqlText"`
	Status       string `json:"status"` // done | error | cancelled
	RowsAffected int64  `json:"rowsAffected"`
	DurationMs   int64  `json:"durationMs"`
	ErrorMessage string `json:"errorMessage,omitempty"`
	ExecutedAt   int64  `json:"executedAt"`
}

// RecordQueryHistory persists the terminal outcome of one statement
// execution. Called from the query executor's HistorySink callback (see
// app.go) — the query package itself never imports vault.
func (s *Store) RecordQueryHistory(connID, sqlText, status string, rowsAffected, durationMs int64, errMsg string) error {
	id, err := newID()
	if err != nil {
		return err
	}

	var errVal interface{}
	if errMsg != "" {
		errVal = errMsg
	}

	_, err = s.db.Exec(
		`INSERT INTO query_history (id, connection_id, sql_text, status, rows_affected, duration_ms, error_message, executed_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		id, connID, sqlText, status, rowsAffected, durationMs, errVal, time.Now().Unix(),
	)
	if err != nil {
		return fmt.Errorf("vault: guardando historial de query: %w", err)
	}
	return nil
}

// ListQueryHistory returns the most recent history entries for connID,
// newest first, capped at limit (default 100).
func (s *Store) ListQueryHistory(connID string, limit int) ([]HistoryEntry, error) {
	if limit <= 0 {
		limit = 100
	}

	rows, err := s.db.Query(
		`SELECT id, connection_id, sql_text, status, rows_affected, duration_ms, error_message, executed_at
		 FROM query_history WHERE connection_id = ? ORDER BY executed_at DESC LIMIT ?`,
		connID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("vault: listando historial de queries: %w", err)
	}
	defer rows.Close()

	out := []HistoryEntry{}
	for rows.Next() {
		var e HistoryEntry
		var errMsg sql.NullString
		if err := rows.Scan(&e.ID, &e.ConnectionID, &e.SQLText, &e.Status, &e.RowsAffected, &e.DurationMs, &errMsg, &e.ExecutedAt); err != nil {
			return nil, fmt.Errorf("vault: leyendo historial de query: %w", err)
		}
		e.ErrorMessage = errMsg.String
		out = append(out, e)
	}
	return out, rows.Err()
}

// ClearQueryHistory deletes every recorded history entry for connID — the
// "Limpiar historial" button in HistoryPanel.tsx. Scoped to one connection
// rather than wiping the whole table, matching how ListQueryHistory is
// already scoped.
func (s *Store) ClearQueryHistory(connID string) error {
	if _, err := s.db.Exec(`DELETE FROM query_history WHERE connection_id = ?`, connID); err != nil {
		return fmt.Errorf("vault: borrando historial de queries: %w", err)
	}
	return nil
}

// DeleteQueryHistoryEntry deletes a single history entry by id — the
// per-row delete button in HistoryPanel.tsx, scoped by primary key so it
// only ever removes the row the user actually clicked.
func (s *Store) DeleteQueryHistoryEntry(id string) error {
	if _, err := s.db.Exec(`DELETE FROM query_history WHERE id = ?`, id); err != nil {
		return fmt.Errorf("vault: borrando entrada de historial: %w", err)
	}
	return nil
}
