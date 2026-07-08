package vault

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// SaveSchemaListCache persists connID's list of visible schema/owner names
// (db.ListSchemas' result) — separate from schema_metadata_cache, which
// caches each schema's tables/columns. Listing every schema name on a
// catalog with many schemas can itself be slow, so SchemaPickerDialog reads
// this instead of calling db.ListSchemas live every time it opens.
func (s *Store) SaveSchemaListCache(connID string, schemas []string) error {
	schemasJSON, err := json.Marshal(schemas)
	if err != nil {
		return fmt.Errorf("vault: serializando lista de esquemas: %w", err)
	}

	_, err = s.db.Exec(
		`INSERT INTO schema_list_cache (connection_id, schemas_json, synced_at) VALUES (?, ?, ?)
		 ON CONFLICT(connection_id) DO UPDATE SET schemas_json = excluded.schemas_json, synced_at = excluded.synced_at`,
		connID, string(schemasJSON), time.Now().Unix(),
	)
	if err != nil {
		return fmt.Errorf("vault: guardando cache de lista de esquemas: %w", err)
	}
	return nil
}

// GetSchemaListCache returns connID's persisted schema list, if any — ok is
// false when never synced, not on error.
func (s *Store) GetSchemaListCache(connID string) (schemas []string, ok bool, err error) {
	var schemasJSON string
	err = s.db.QueryRow(`SELECT schemas_json FROM schema_list_cache WHERE connection_id = ?`, connID).Scan(&schemasJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("vault: leyendo cache de lista de esquemas: %w", err)
	}

	if err := json.Unmarshal([]byte(schemasJSON), &schemas); err != nil {
		return nil, false, fmt.Errorf("vault: parseando cache de lista de esquemas: %w", err)
	}
	return schemas, true, nil
}

// DeleteSchemaListCache drops connID's persisted schema list — called when
// the connection is deleted or its DSN changes (UpdateConnection), since a
// different target database can have an entirely different set of schemas.
func (s *Store) DeleteSchemaListCache(connID string) error {
	if _, err := s.db.Exec(`DELETE FROM schema_list_cache WHERE connection_id = ?`, connID); err != nil {
		return fmt.Errorf("vault: borrando cache de lista de esquemas: %w", err)
	}
	return nil
}
