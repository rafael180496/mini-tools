package vault

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	mtcrypto "mini-tools/backend/crypto"
	"mini-tools/backend/db"
)

// ConnectionSummary is what the frontend sees for a saved connection — it
// never includes the DSN or any credential. See .claude/rules/technical.md
// point 9.
type ConnectionSummary struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	DBType    string `json:"dbType"`
	CreatedAt int64  `json:"createdAt"`
	// MetadataSchemas restricts which schemas GetSchemaMetadata scans for
	// this connection (Postgres only — see backend/db/metadata.go). Empty
	// means "scan every schema", the historical default before this field
	// existed (schema_migrations version 2).
	MetadataSchemas []string `json:"metadataSchemas"`
	// Color is a user-chosen hex string (e.g. "#60a5fa") purely for visual
	// identification in ConnectionTree.tsx — never interpreted server-side.
	// Empty means "no color set" (schema_migrations version 8).
	Color string `json:"color,omitempty"`
	// FolderID is which folders.id this connection is organized under —
	// empty means root (schema_migrations version 10). See folders_repo.go.
	FolderID string `json:"folderId,omitempty"`
}

func splitSchemas(raw sql.NullString) []string {
	if !raw.Valid || raw.String == "" {
		return nil
	}
	return strings.Split(raw.String, ",")
}

// SaveConnection encrypts dsn under the vault key and persists it alongside
// name/db_type. dsn must already be a fully-built DSN (see
// db.Connector.BuildDSN) — this method only ever sees it in memory, right
// before encrypting it.
func (s *Store) SaveConnection(name string, dbType db.DBType, dsn string, color string) (*ConnectionSummary, error) {
	key, err := s.gate.Key()
	if err != nil {
		return nil, err
	}

	ciphertext, nonce, err := mtcrypto.Encrypt(key, []byte(dsn))
	if err != nil {
		return nil, fmt.Errorf("vault: encrypting dsn: %w", err)
	}

	id, err := newID()
	if err != nil {
		return nil, err
	}
	createdAt := time.Now().Unix()

	if _, err := s.db.Exec(
		`INSERT INTO connections (id, name, db_type, encrypted_dsn, nonce, created_at, color) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, name, string(dbType), ciphertext, nonce, createdAt, nullableString(color),
	); err != nil {
		return nil, fmt.Errorf("vault: saving connection: %w", err)
	}

	return &ConnectionSummary{ID: id, Name: name, DBType: string(dbType), CreatedAt: createdAt, Color: color}, nil
}

// nullableString turns an empty string into SQL NULL — "no color set"
// should read back as "" (zero value), not a stored empty string.
func nullableString(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}

// UpdateConnection re-encrypts dsn under the vault key and overwrites id's
// name/db_type/encrypted_dsn in place — same "dsn must already be built"
// contract as SaveConnection. Does NOT touch metadata_schemas (that's
// SetConnectionSchemas' job) or created_at. Fails if id doesn't exist.
func (s *Store) UpdateConnection(id, name string, dbType db.DBType, dsn string, color string) error {
	key, err := s.gate.Key()
	if err != nil {
		return err
	}

	ciphertext, nonce, err := mtcrypto.Encrypt(key, []byte(dsn))
	if err != nil {
		return fmt.Errorf("vault: encrypting dsn: %w", err)
	}

	res, err := s.db.Exec(
		`UPDATE connections SET name = ?, db_type = ?, encrypted_dsn = ?, nonce = ?, color = ? WHERE id = ?`,
		name, string(dbType), ciphertext, nonce, nullableString(color), id,
	)
	if err != nil {
		return fmt.Errorf("vault: updating connection: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("vault: updating connection: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("vault: conexión %q no encontrada", id)
	}
	return nil
}

// ListConnections returns every saved connection, without DSNs, ordered by
// name for the sidebar tree.
func (s *Store) ListConnections() ([]ConnectionSummary, error) {
	rows, err := s.db.Query(`SELECT id, name, db_type, created_at, metadata_schemas, color, folder_id FROM connections ORDER BY name`)
	if err != nil {
		return nil, fmt.Errorf("vault: listing connections: %w", err)
	}
	defer rows.Close()

	out := []ConnectionSummary{}
	for rows.Next() {
		var c ConnectionSummary
		var schemas, color, folderID sql.NullString
		if err := rows.Scan(&c.ID, &c.Name, &c.DBType, &c.CreatedAt, &schemas, &color, &folderID); err != nil {
			return nil, fmt.Errorf("vault: scanning connection: %w", err)
		}
		c.MetadataSchemas = splitSchemas(schemas)
		c.Color = color.String
		c.FolderID = folderID.String
		out = append(out, c)
	}
	return out, rows.Err()
}

// MoveConnectionToFolder re-organizes a connection under a different folder
// ("" = root) — purely organizational, never touches encrypted_dsn. Same
// pattern as SetConnectionSchemas.
func (s *Store) MoveConnectionToFolder(id, folderID string) error {
	res, err := s.db.Exec(`UPDATE connections SET folder_id = ? WHERE id = ?`, nullableString(folderID), id)
	if err != nil {
		return fmt.Errorf("vault: moviendo conexión de carpeta: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("vault: moviendo conexión de carpeta: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("vault: conexión %q no encontrada", id)
	}
	return nil
}

// SetConnectionSchemas persists which schemas GetSchemaMetadata should scan
// for id — an empty slice clears the restriction back to "scan every
// schema". Postgres-only in practice (see backend/db/metadata.go), but not
// enforced here — an Oracle/SQLite connection would just store a value
// nothing ever reads.
func (s *Store) SetConnectionSchemas(id string, schemas []string) error {
	var value interface{}
	if len(schemas) > 0 {
		value = strings.Join(schemas, ",")
	} // else leave value nil (SQL NULL) — an empty string would make the
	// "IN (...)" filter downstream reject every schema instead of meaning
	// "no restriction".

	res, err := s.db.Exec(`UPDATE connections SET metadata_schemas = ? WHERE id = ?`, value, id)
	if err != nil {
		return fmt.Errorf("vault: guardando esquemas de conexión: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("vault: guardando esquemas de conexión: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("vault: conexión %q no encontrada", id)
	}
	return nil
}

// ConnectionMetadataSchemas returns id's configured schema restriction (nil
// = scan everything).
func (s *Store) ConnectionMetadataSchemas(id string) ([]string, error) {
	var schemas sql.NullString
	err := s.db.QueryRow(`SELECT metadata_schemas FROM connections WHERE id = ?`, id).Scan(&schemas)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("vault: conexión %q no encontrada", id)
	}
	if err != nil {
		return nil, fmt.Errorf("vault: leyendo esquemas de conexión: %w", err)
	}
	return splitSchemas(schemas), nil
}

// DeleteConnection removes a saved connection. The caller is responsible for
// closing any open pool for id first (see db.PoolManager.Close).
func (s *Store) DeleteConnection(id string) error {
	if _, err := s.db.Exec(`DELETE FROM connections WHERE id = ?`, id); err != nil {
		return fmt.Errorf("vault: deleting connection: %w", err)
	}
	return nil
}

// ConnectionDSN decrypts and returns the DSN for id. Internal use only (the
// pool manager) — this value must never be returned from a bound App
// method to the frontend.
func (s *Store) ConnectionDSN(id string) (db.DBType, string, error) {
	key, err := s.gate.Key()
	if err != nil {
		return "", "", err
	}

	var dbType string
	var ciphertext, nonce []byte
	err = s.db.QueryRow(`SELECT db_type, encrypted_dsn, nonce FROM connections WHERE id = ?`, id).
		Scan(&dbType, &ciphertext, &nonce)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", fmt.Errorf("vault: conexión %q no encontrada", id)
	}
	if err != nil {
		return "", "", fmt.Errorf("vault: reading connection: %w", err)
	}

	plaintext, err := mtcrypto.Decrypt(key, ciphertext, nonce)
	if err != nil {
		return "", "", fmt.Errorf("vault: decrypting dsn: %w", err)
	}

	return db.DBType(dbType), string(plaintext), nil
}

func newID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("vault: generating id: %w", err)
	}
	return hex.EncodeToString(b), nil
}
