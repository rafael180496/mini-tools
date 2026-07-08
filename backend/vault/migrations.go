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
var migrations = []migration{
	{
		version: 2,
		desc:    "agrega connections.metadata_schemas para limitar qué esquemas escanea el autocomplete",
		apply: func(tx *sql.Tx) error {
			_, err := tx.Exec(`ALTER TABLE connections ADD COLUMN metadata_schemas TEXT`)
			return err
		},
	},
	{
		version: 3,
		desc:    "agrega settings.open_tabs para restaurar las pestañas abiertas al reiniciar la app",
		apply: func(tx *sql.Tx) error {
			_, err := tx.Exec(`ALTER TABLE settings ADD COLUMN open_tabs TEXT`)
			return err
		},
	},
	{
		version: 4,
		desc:    "agrega settings.sidebar_collapsed y settings.editor_height para persistir el layout del workspace",
		apply: func(tx *sql.Tx) error {
			if _, err := tx.Exec(`ALTER TABLE settings ADD COLUMN sidebar_collapsed INTEGER NOT NULL DEFAULT 0`); err != nil {
				return err
			}
			_, err := tx.Exec(`ALTER TABLE settings ADD COLUMN editor_height INTEGER NOT NULL DEFAULT 256`)
			return err
		},
	},
	{
		version: 5,
		desc:    "agrega schema_metadata_cache para persistir la metadata de tablas/columnas entre reinicios",
		apply: func(tx *sql.Tx) error {
			_, err := tx.Exec(`
				CREATE TABLE IF NOT EXISTS schema_metadata_cache (
					connection_id TEXT PRIMARY KEY,
					tables_json TEXT NOT NULL,
					synced_at INTEGER NOT NULL
				)
			`)
			return err
		},
	},
	{
		version: 6,
		desc:    "agrega schema_list_cache para persistir la lista de esquemas/owners visibles entre reinicios",
		apply: func(tx *sql.Tx) error {
			_, err := tx.Exec(`
				CREATE TABLE IF NOT EXISTS schema_list_cache (
					connection_id TEXT PRIMARY KEY,
					schemas_json TEXT NOT NULL,
					synced_at INTEGER NOT NULL
				)
			`)
			return err
		},
	},
}

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
