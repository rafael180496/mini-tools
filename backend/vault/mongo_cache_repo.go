package vault

import (
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// SaveMongoCollectionCache persists the collection list (already JSON-encoded
// []db.MongoCollectionInfo) for one connection+database. Listing a Mongo
// database's collections runs an EstimatedDocumentCount per collection, so a
// database with dozens of collections is a slow round-trip fan-out — the tree
// reads this cache instead of re-querying the server on every expansion. Keyed
// by (connection_id, database) since a connection browses many databases.
func (s *Store) SaveMongoCollectionCache(connID, database, collectionsJSON string) error {
	_, err := s.db.Exec(
		`INSERT INTO mongo_collection_cache (connection_id, database, collections_json, synced_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(connection_id, database) DO UPDATE SET collections_json = excluded.collections_json, synced_at = excluded.synced_at`,
		connID, database, collectionsJSON, time.Now().Unix(),
	)
	if err != nil {
		return fmt.Errorf("vault: guardando cache de colecciones Mongo: %w", err)
	}
	return nil
}

// GetMongoCollectionCache returns the cached collection JSON for one
// connection+database, if any — ok is false when never synced, not on error.
func (s *Store) GetMongoCollectionCache(connID, database string) (collectionsJSON string, ok bool, err error) {
	err = s.db.QueryRow(
		`SELECT collections_json FROM mongo_collection_cache WHERE connection_id = ? AND database = ?`,
		connID, database,
	).Scan(&collectionsJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("vault: leyendo cache de colecciones Mongo: %w", err)
	}
	return collectionsJSON, true, nil
}

// DeleteMongoCollectionCache drops every cached database for connID — called
// when the connection is deleted or its DSN changes (a different server/DSN can
// have entirely different databases and collections).
func (s *Store) DeleteMongoCollectionCache(connID string) error {
	if _, err := s.db.Exec(`DELETE FROM mongo_collection_cache WHERE connection_id = ?`, connID); err != nil {
		return fmt.Errorf("vault: borrando cache de colecciones Mongo: %w", err)
	}
	return nil
}
