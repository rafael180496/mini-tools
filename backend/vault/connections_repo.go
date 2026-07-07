package vault

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
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
}

// SaveConnection encrypts dsn under the vault key and persists it alongside
// name/db_type. dsn must already be a fully-built DSN (see
// db.Connector.BuildDSN) — this method only ever sees it in memory, right
// before encrypting it.
func (s *Store) SaveConnection(name string, dbType db.DBType, dsn string) (*ConnectionSummary, error) {
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
		`INSERT INTO connections (id, name, db_type, encrypted_dsn, nonce, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		id, name, string(dbType), ciphertext, nonce, createdAt,
	); err != nil {
		return nil, fmt.Errorf("vault: saving connection: %w", err)
	}

	return &ConnectionSummary{ID: id, Name: name, DBType: string(dbType), CreatedAt: createdAt}, nil
}

// ListConnections returns every saved connection, without DSNs, ordered by
// name for the sidebar tree.
func (s *Store) ListConnections() ([]ConnectionSummary, error) {
	rows, err := s.db.Query(`SELECT id, name, db_type, created_at FROM connections ORDER BY name`)
	if err != nil {
		return nil, fmt.Errorf("vault: listing connections: %w", err)
	}
	defer rows.Close()

	out := []ConnectionSummary{}
	for rows.Next() {
		var c ConnectionSummary
		if err := rows.Scan(&c.ID, &c.Name, &c.DBType, &c.CreatedAt); err != nil {
			return nil, fmt.Errorf("vault: scanning connection: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
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
