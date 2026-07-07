package vault

import (
	"database/sql"
	"fmt"
)

// migration is one schema change above the baseline (schema_migrations
// version 1, created directly by Open()'s CREATE TABLE IF NOT EXISTS block).
//
// Hard rules for every entry added here — see .claude/specs/vault-migrations.md
// and .claude/rules/technical.md:
//   - Additive only: CREATE TABLE IF NOT EXISTS, or ALTER TABLE ... ADD COLUMN
//     ... DEFAULT .... Never DELETE/DROP/rewrite existing rows.
//   - Never touch vault_meta.verifier or vault_meta.verifier_nonce.
//   - apply must be idempotent-safe within its own transaction — it only
//     ever runs once per version per database (guarded by applyMigrations),
//     but a migration that fails mid-way must not corrupt state on retry.
type migration struct {
	version int
	desc    string
	apply   func(tx *sql.Tx) error
}

// migrations is empty today — version 1 is the baseline created directly in
// store.go's CREATE TABLE IF NOT EXISTS block. The first real entry here
// will be {version: 2, ...}.
var migrations = []migration{}

// applyMigrations runs every migration whose version is newer than the
// database's current schema_migrations version, in order, each in its own
// transaction (so a failure partway through a batch leaves already-applied
// migrations durably recorded — the next call only retries what's left).
// Called once from Open(), after the baseline schema exists. A fully
// migrated database (the common case, every startup after the first) does
// zero work here.
func applyMigrations(db *sql.DB) error {
	var current int
	if err := db.QueryRow(`SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&current); err != nil {
		return fmt.Errorf("vault: leyendo versión de schema: %w", err)
	}

	for _, m := range migrations {
		if m.version <= current {
			continue
		}

		tx, err := db.Begin()
		if err != nil {
			return fmt.Errorf("vault: migración %d (%s): begin: %w", m.version, m.desc, err)
		}

		if err := m.apply(tx); err != nil {
			tx.Rollback()
			return fmt.Errorf("vault: migración %d (%s): %w", m.version, m.desc, err)
		}

		if _, err := tx.Exec(
			`INSERT INTO schema_migrations (version, applied_at) VALUES (?, strftime('%s','now'))`,
			m.version,
		); err != nil {
			tx.Rollback()
			return fmt.Errorf("vault: migración %d (%s): guardando versión: %w", m.version, m.desc, err)
		}

		if err := tx.Commit(); err != nil {
			return fmt.Errorf("vault: migración %d (%s): commit: %w", m.version, m.desc, err)
		}
	}

	return nil
}
