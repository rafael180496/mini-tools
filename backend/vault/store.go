package vault

import (
	"database/sql"
	"errors"
	"fmt"

	_ "modernc.org/sqlite"

	"mini-tools/backend/appdata"
	mtcrypto "mini-tools/backend/crypto"
	"mini-tools/backend/vaultgate"
)

// ErrWrongPassword is returned by Unlock when the derived key fails to open
// the stored verifier — i.e. the master password was wrong.
var ErrWrongPassword = errors.New("vault: wrong master password")

// ErrAlreadyInitialized is returned by Initialize once a master password has
// already been set for this vault.
var ErrAlreadyInitialized = errors.New("vault: already initialized")

// verifierPlaintext has no meaning beyond being a known value we can
// encrypt at init time and try to decrypt at unlock time: if decryption
// succeeds (GCM authentication passes), the password was correct.
const verifierPlaintext = "mini-tools-vault-v1"

// Store owns the vault's SQLite connection and the in-memory unlock gate.
// Column-level encryption only (the DSN blob), never a fully encrypted
// database file — see .claude/rules/technical.md.
type Store struct {
	db   *sql.DB
	gate *vaultgate.Gate
}

// Open opens (creating if needed) the vault database and ensures its schema
// exists. It does not unlock anything — the vault starts locked until
// Initialize or Unlock succeeds.
func Open(gate *vaultgate.Gate) (*Store, error) {
	path, err := appdata.VaultPath()
	if err != nil {
		return nil, fmt.Errorf("vault: resolving path: %w", err)
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("vault: opening db: %w", err)
	}

	if _, err := db.Exec(`PRAGMA journal_mode=WAL;`); err != nil {
		return nil, fmt.Errorf("vault: enabling WAL: %w", err)
	}

	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS vault_meta (
			id             INTEGER PRIMARY KEY CHECK (id = 1),
			verifier       BLOB NOT NULL,
			verifier_nonce BLOB NOT NULL,
			created_at     INTEGER NOT NULL
		);

		CREATE TABLE IF NOT EXISTS connections (
			id            TEXT PRIMARY KEY,
			name          TEXT NOT NULL,
			db_type       TEXT NOT NULL, -- oracle | postgres | sqlite
			encrypted_dsn BLOB NOT NULL,
			nonce         BLOB NOT NULL,
			created_at    INTEGER
		);

		CREATE TABLE IF NOT EXISTS query_history (
			id            TEXT PRIMARY KEY,
			connection_id TEXT NOT NULL,
			sql_text      TEXT NOT NULL,
			status        TEXT NOT NULL, -- done | error | cancelled
			rows_affected INTEGER NOT NULL DEFAULT 0,
			duration_ms   INTEGER NOT NULL DEFAULT 0,
			error_message TEXT,
			executed_at   INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_query_history_connection
			ON query_history (connection_id, executed_at DESC);

		CREATE TABLE IF NOT EXISTS recent_files (
			path      TEXT PRIMARY KEY,
			opened_at INTEGER NOT NULL
		);

		CREATE TABLE IF NOT EXISTS explain_history (
			id            TEXT PRIMARY KEY,
			connection_id TEXT NOT NULL,
			sql_text      TEXT NOT NULL,
			analyze       INTEGER NOT NULL DEFAULT 0,
			plan_json     TEXT NOT NULL,
			created_at    INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_explain_history_connection
			ON explain_history (connection_id, created_at DESC);
	`); err != nil {
		return nil, fmt.Errorf("vault: creating schema: %w", err)
	}

	return &Store{db: db, gate: gate}, nil
}

// IsInitialized reports whether a master password has already been set for
// this vault.
func (s *Store) IsInitialized() (bool, error) {
	var count int
	if err := s.db.QueryRow(`SELECT COUNT(1) FROM vault_meta WHERE id = 1`).Scan(&count); err != nil {
		return false, fmt.Errorf("vault: checking init state: %w", err)
	}

	return count > 0, nil
}

// Initialize sets the master password on first run: derives a key, encrypts
// the verifier under it, persists both, and unlocks the gate in memory.
func (s *Store) Initialize(password string) error {
	initialized, err := s.IsInitialized()
	if err != nil {
		return err
	}
	if initialized {
		return ErrAlreadyInitialized
	}

	salt, err := vaultgate.LoadOrCreateSalt()
	if err != nil {
		return err
	}

	key := mtcrypto.DeriveKey([]byte(password), salt)

	ciphertext, nonce, err := mtcrypto.Encrypt(key, []byte(verifierPlaintext))
	if err != nil {
		return fmt.Errorf("vault: encrypting verifier: %w", err)
	}

	if _, err := s.db.Exec(
		`INSERT INTO vault_meta (id, verifier, verifier_nonce, created_at) VALUES (1, ?, ?, strftime('%s','now'))`,
		ciphertext, nonce,
	); err != nil {
		return fmt.Errorf("vault: storing verifier: %w", err)
	}

	s.gate.Set(key)
	return nil
}

// Unlock derives a key from the given password and the stored salt, then
// tries to decrypt the verifier with it. A wrong password fails GCM
// authentication and the gate stays locked — there is no other check and no
// bypass.
func (s *Store) Unlock(password string) error {
	salt, err := vaultgate.LoadOrCreateSalt()
	if err != nil {
		return err
	}

	var ciphertext, nonce []byte
	err = s.db.QueryRow(`SELECT verifier, verifier_nonce FROM vault_meta WHERE id = 1`).Scan(&ciphertext, &nonce)
	if errors.Is(err, sql.ErrNoRows) {
		return errors.New("vault: not initialized")
	}
	if err != nil {
		return fmt.Errorf("vault: reading verifier: %w", err)
	}

	key := mtcrypto.DeriveKey([]byte(password), salt)

	if _, err := mtcrypto.Decrypt(key, ciphertext, nonce); err != nil {
		return ErrWrongPassword
	}

	s.gate.Set(key)
	return nil
}

// Close closes the underlying database connection.
func (s *Store) Close() error {
	return s.db.Close()
}
