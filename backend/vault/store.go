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

	// Best-effort: consolidate any WAL left over from a previous run that
	// didn't exit cleanly (see Close's doc comment for why that WAL could
	// otherwise be at risk) before anything else touches the file. A no-op
	// on a freshly created database.
	_, _ = db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`)

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

		-- Non-sensitive app preferences (unlike connections.encrypted_dsn,
		-- nothing here needs the master key) — readable/writable even while
		-- the vault is locked, so the theme applies on the unlock screen too.
		CREATE TABLE IF NOT EXISTS settings (
			id    INTEGER PRIMARY KEY CHECK (id = 1),
			theme TEXT NOT NULL DEFAULT 'dark'
		);
		INSERT OR IGNORE INTO settings (id, theme) VALUES (1, 'dark');

		-- Tracks which migrations (migrations.go) have been applied. Kept
		-- separate from vault_meta on purpose — vault_meta is the one thing
		-- a migration must never touch, see .claude/specs/vault-migrations.md.
		-- Today's schema (everything above) is permanently "version 1".
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version    INTEGER PRIMARY KEY,
			applied_at INTEGER NOT NULL
		);
		INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, strftime('%s','now'));
	`); err != nil {
		return nil, fmt.Errorf("vault: creating schema: %w", err)
	}

	if err := applyMigrations(db); err != nil {
		return nil, fmt.Errorf("vault: applying migrations: %w", err)
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

	passwordBytes := []byte(password)
	key := mtcrypto.DeriveKey(passwordBytes, salt)
	mtcrypto.Zero(passwordBytes)

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
// hands it to validateAndSetKey.
func (s *Store) Unlock(password string) error {
	salt, err := vaultgate.LoadOrCreateSalt()
	if err != nil {
		return err
	}

	passwordBytes := []byte(password)
	key := mtcrypto.DeriveKey(passwordBytes, salt)
	mtcrypto.Zero(passwordBytes)

	return s.validateAndSetKey(key)
}

// validateAndSetKey tries to decrypt the stored verifier with key — if GCM
// authentication passes, the key is correct and the gate unlocks with it.
// Shared by Unlock (which derives key from a password first) and
// TryAutoUnlock (backend/vault/remember.go — which already has a raw key
// from the OS keychain and skips password derivation entirely).
func (s *Store) validateAndSetKey(key []byte) error {
	var ciphertext, nonce []byte
	err := s.db.QueryRow(`SELECT verifier, verifier_nonce FROM vault_meta WHERE id = 1`).Scan(&ciphertext, &nonce)
	if errors.Is(err, sql.ErrNoRows) {
		return errors.New("vault: not initialized")
	}
	if err != nil {
		return fmt.Errorf("vault: reading verifier: %w", err)
	}

	if _, err := mtcrypto.Decrypt(key, ciphertext, nonce); err != nil {
		// Wrong key: this key is never handed to the gate, so nothing else
		// holds a reference to it — zero it before it's dropped rather than
		// leaving it to linger in memory until GC.
		mtcrypto.Zero(key)
		return ErrWrongPassword
	}

	s.gate.Set(key)
	return nil
}

// VerifyPassword checks password against the stored verifier without
// touching the gate — used to re-confirm identity before a sensitive action
// on an already-unlocked vault (e.g. generating a backup), where the point
// isn't to unlock anything (it already is) but to make sure whoever's
// sitting at the keyboard right now actually knows the master password.
func (s *Store) VerifyPassword(password string) error {
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

	passwordBytes := []byte(password)
	key := mtcrypto.DeriveKey(passwordBytes, salt)
	mtcrypto.Zero(passwordBytes)
	defer mtcrypto.Zero(key)

	if _, err := mtcrypto.Decrypt(key, ciphertext, nonce); err != nil {
		return ErrWrongPassword
	}
	return nil
}

// Close checkpoints the WAL into the main database file before closing the
// underlying connection. Real bug found live: App.shutdown() never called
// this — on every exit (including the OS-signal-triggered shutdown path
// Wails installs for SIGTERM/SIGINT, which fires on a plain `kill`, not
// just `kill -9`) the vault's SQLite handle was left open with an
// unchecked WAL. A subsequent process reopening the same file while the
// WAL/shm state from an abruptly-terminated process was still around could
// end up discarding it during recovery instead of replaying it — observed
// in practice as a vault that came back at the right schema_migrations
// version but with every connection/history row gone. Checkpointing here
// means every clean shutdown leaves all committed data in the main file
// itself, not stranded in a WAL a future process has to reconstruct.
func (s *Store) Close() error {
	// Best-effort — closing the connection still matters even if the
	// checkpoint itself fails for some reason (e.g. another connection
	// briefly holding a read lock).
	_, _ = s.db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`)
	return s.db.Close()
}
