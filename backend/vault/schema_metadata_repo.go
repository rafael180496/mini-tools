package vault

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"mini-tools/backend/db"
)

// SaveSchemaMetadataCache persists connID's table/column/FK metadata so the
// next GetSchemaMetadata (see app.go) can skip the live fetch entirely —
// what makes reopening an already-synced connection instant instead of
// re-scanning the whole catalog every time.
func (s *Store) SaveSchemaMetadataCache(connID string, meta *db.SchemaMetadata) error {
	tablesJSON, err := json.Marshal(meta)
	if err != nil {
		return fmt.Errorf("vault: serializando metadata de esquema: %w", err)
	}

	_, err = s.db.Exec(
		`INSERT INTO schema_metadata_cache (connection_id, tables_json, synced_at) VALUES (?, ?, ?)
		 ON CONFLICT(connection_id) DO UPDATE SET tables_json = excluded.tables_json, synced_at = excluded.synced_at`,
		connID, string(tablesJSON), time.Now().Unix(),
	)
	if err != nil {
		return fmt.Errorf("vault: guardando cache de metadata: %w", err)
	}
	return nil
}

// GetSchemaMetadataCache returns connID's persisted metadata, if any — ok is
// false when the connection has never been synced (no live fetch has
// completed yet), not on error.
func (s *Store) GetSchemaMetadataCache(connID string) (meta *db.SchemaMetadata, ok bool, err error) {
	var tablesJSON string
	err = s.db.QueryRow(`SELECT tables_json FROM schema_metadata_cache WHERE connection_id = ?`, connID).Scan(&tablesJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("vault: leyendo cache de metadata: %w", err)
	}

	var out db.SchemaMetadata
	if err := json.Unmarshal([]byte(tablesJSON), &out); err != nil {
		return nil, false, fmt.Errorf("vault: parseando cache de metadata: %w", err)
	}
	return &out, true, nil
}

// DeleteSchemaMetadataCache drops connID's persisted metadata — called when
// its schema selection changes (the cache may reference schemas no longer
// scanned, or miss ones newly added) or when the connection itself is
// deleted. A no-op, not an error, if there was nothing cached.
func (s *Store) DeleteSchemaMetadataCache(connID string) error {
	if _, err := s.db.Exec(`DELETE FROM schema_metadata_cache WHERE connection_id = ?`, connID); err != nil {
		return fmt.Errorf("vault: borrando cache de metadata: %w", err)
	}
	return nil
}
