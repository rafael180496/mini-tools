package vault

import (
	"encoding/json"
	"fmt"
	"time"

	"mini-tools/backend/explain"
)

// ExplainHistoryEntry is one row of explain_history — never encrypted, like
// query_history and recent_files.
type ExplainHistoryEntry struct {
	ID           string       `json:"id"`
	ConnectionID string       `json:"connectionId"`
	SQLText      string       `json:"sqlText"`
	Analyze      bool         `json:"analyze"`
	Plan         explain.Plan `json:"plan"`
	CreatedAt    int64        `json:"createdAt"`
}

// RecordExplainPlan persists one EXPLAIN result.
func (s *Store) RecordExplainPlan(connID, sqlText string, analyze bool, plan *explain.Plan) error {
	id, err := newID()
	if err != nil {
		return err
	}

	planJSON, err := json.Marshal(plan)
	if err != nil {
		return fmt.Errorf("vault: serializando plan: %w", err)
	}

	_, err = s.db.Exec(
		`INSERT INTO explain_history (id, connection_id, sql_text, analyze, plan_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		id, connID, sqlText, analyze, string(planJSON), time.Now().Unix(),
	)
	if err != nil {
		return fmt.Errorf("vault: guardando historial de explain: %w", err)
	}
	return nil
}

// ListExplainHistory returns the most recent EXPLAIN results for connID,
// newest first.
func (s *Store) ListExplainHistory(connID string, limit int) ([]ExplainHistoryEntry, error) {
	if limit <= 0 {
		limit = 50
	}

	rows, err := s.db.Query(
		`SELECT id, connection_id, sql_text, analyze, plan_json, created_at
		 FROM explain_history WHERE connection_id = ? ORDER BY created_at DESC LIMIT ?`,
		connID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("vault: listando historial de explain: %w", err)
	}
	defer rows.Close()

	out := []ExplainHistoryEntry{}
	for rows.Next() {
		var e ExplainHistoryEntry
		var analyzeInt int
		var planJSON string
		if err := rows.Scan(&e.ID, &e.ConnectionID, &e.SQLText, &analyzeInt, &planJSON, &e.CreatedAt); err != nil {
			return nil, fmt.Errorf("vault: leyendo historial de explain: %w", err)
		}
		e.Analyze = analyzeInt != 0
		if err := json.Unmarshal([]byte(planJSON), &e.Plan); err != nil {
			return nil, fmt.Errorf("vault: parseando plan guardado: %w", err)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
