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
	{
		version: 7,
		desc:    "agrega settings.remember_master_key para el toggle opt-in de auto-unlock via OS keychain",
		apply: func(tx *sql.Tx) error {
			_, err := tx.Exec(`ALTER TABLE settings ADD COLUMN remember_master_key INTEGER NOT NULL DEFAULT 0`)
			return err
		},
	},
	{
		version: 8,
		desc:    "agrega connections.color para personalizar la etiqueta de color de cada conexión",
		apply: func(tx *sql.Tx) error {
			_, err := tx.Exec(`ALTER TABLE connections ADD COLUMN color TEXT`)
			return err
		},
	},
	{
		version: 9,
		desc:    "agrega settings.editor_theme para el tema configurable del editor CodeMirror",
		apply: func(tx *sql.Tx) error {
			_, err := tx.Exec(`ALTER TABLE settings ADD COLUMN editor_theme TEXT NOT NULL DEFAULT 'auto'`)
			return err
		},
	},
	{
		version: 10,
		desc:    "agrega folders (árbol de carpetas para conexiones), connections.folder_id y settings.collapsed_sidebar_modules",
		apply: func(tx *sql.Tx) error {
			if _, err := tx.Exec(`
				CREATE TABLE IF NOT EXISTS folders (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					parent_id TEXT,
					sort_order INTEGER NOT NULL DEFAULT 0,
					created_at INTEGER NOT NULL
				)
			`); err != nil {
				return err
			}
			if _, err := tx.Exec(`ALTER TABLE connections ADD COLUMN folder_id TEXT`); err != nil {
				return err
			}
			_, err := tx.Exec(`ALTER TABLE settings ADD COLUMN collapsed_sidebar_modules TEXT`)
			return err
		},
	},
	{
		version: 11,
		desc:    "agrega schema_metadata_cache.scanner_version — invalida en frío el cache de metadata previo al scanner de procedures/functions/triggers/packages",
		apply: func(tx *sql.Tx) error {
			// DEFAULT 0 applies to every existing row too (same SQLite
			// behavior already relied on by sidebar_collapsed/editor_height
			// above) — every cache entry written before this column existed
			// reads back as version 0, which GetSchemaMetadataCache treats
			// as a miss (see schema_metadata_repo.go's currentScannerVersion),
			// forcing exactly one live re-fetch per connection instead of
			// silently serving stale metadata missing the new object types
			// forever. New rows are written with the current version.
			_, err := tx.Exec(`ALTER TABLE schema_metadata_cache ADD COLUMN scanner_version INTEGER NOT NULL DEFAULT 0`)
			return err
		},
	},
	{
		version: 12,
		desc:    "agrega folders.scope — separa el árbol de carpetas de conexiones SSH del de conexiones de base de datos, dos módulos de sidebar independientes en vez de uno compartido",
		apply: func(tx *sql.Tx) error {
			// DEFAULT 'db' applies to every folder that already existed —
			// every one of them was, until now, exclusively used to
			// organize DB connections (SSH didn't have its own module yet),
			// so this preserves their current place in "Conexiones" exactly
			// and leaves the new "SSH" module starting empty, same as a
			// fresh install.
			_, err := tx.Exec(`ALTER TABLE folders ADD COLUMN scope TEXT NOT NULL DEFAULT 'db'`)
			return err
		},
	},
	{
		version: 13,
		desc:    "agrega ssh_snippets (comandos/scripts reutilizables en cualquier sesión SSH) y settings.ssh_terminal_theme",
		apply: func(tx *sql.Tx) error {
			if _, err := tx.Exec(`
				CREATE TABLE IF NOT EXISTS ssh_snippets (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					script TEXT NOT NULL,
					sort_order INTEGER NOT NULL DEFAULT 0,
					created_at INTEGER NOT NULL
				)
			`); err != nil {
				return err
			}
			_, err := tx.Exec(`ALTER TABLE settings ADD COLUMN ssh_terminal_theme TEXT NOT NULL DEFAULT 'auto'`)
			return err
		},
	},
	{
		version: 14,
		desc:    "agrega ssh_snippets.folder_id para organizar snippets en carpetas — árbol independiente (scope 'ssh-snippet') del de conexiones DB/SSH, reusando folders.scope igual que la migración 12",
		apply: func(tx *sql.Tx) error {
			_, err := tx.Exec(`ALTER TABLE ssh_snippets ADD COLUMN folder_id TEXT`)
			return err
		},
	},
	{
		version: 15,
		desc:    "agrega settings.auto_backup_enabled/auto_backup_interval_hours/auto_backup_path para el backup automático periódico del vault",
		apply: func(tx *sql.Tx) error {
			if _, err := tx.Exec(`ALTER TABLE settings ADD COLUMN auto_backup_enabled INTEGER NOT NULL DEFAULT 0`); err != nil {
				return err
			}
			if _, err := tx.Exec(`ALTER TABLE settings ADD COLUMN auto_backup_interval_hours INTEGER NOT NULL DEFAULT 6`); err != nil {
				return err
			}
			_, err := tx.Exec(`ALTER TABLE settings ADD COLUMN auto_backup_path TEXT NOT NULL DEFAULT ''`)
			return err
		},
	},
	{
		version: 16,
		desc:    "agrega settings.auto_save_enabled/auto_save_interval_seconds para el auto-guardado periódico de los editores a su archivo",
		apply: func(tx *sql.Tx) error {
			if _, err := tx.Exec(`ALTER TABLE settings ADD COLUMN auto_save_enabled INTEGER NOT NULL DEFAULT 0`); err != nil {
				return err
			}
			_, err := tx.Exec(`ALTER TABLE settings ADD COLUMN auto_save_interval_seconds INTEGER NOT NULL DEFAULT 30`)
			return err
		},
	},
	{
		version: 17,
		desc:    "agrega mongo_collection_cache para cachear la lista de colecciones (con conteo) por conexión+base de MongoDB, evitando re-consultar el servidor en cada expansión del árbol",
		apply: func(tx *sql.Tx) error {
			_, err := tx.Exec(`CREATE TABLE IF NOT EXISTS mongo_collection_cache (
				connection_id TEXT NOT NULL,
				database TEXT NOT NULL,
				collections_json TEXT NOT NULL,
				synced_at INTEGER NOT NULL,
				PRIMARY KEY (connection_id, database)
			)`)
			return err
		},
	},
	{
		version: 18,
		desc:    "agrega git_repos (repositorios del módulo Git) — solo rutas y nombres, ninguna credencial",
		apply: func(tx *sql.Tx) error {
			// Deliberately holds no credential of any kind: auth for a git
			// remote is resolved by the OS credential helper / ssh-agent at
			// operation time (backend/git/auth.go), so there is nothing to
			// persist here and no encrypted column is needed. This table is
			// as organizational as `folders` — path, name, grouping, order.
			//
			// folder_id reuses the existing `folders` table with a new scope
			// ('git'), exactly like migration 12 did for SSH and 14 for
			// snippets, instead of introducing a parallel tree.
			_, err := tx.Exec(`
				CREATE TABLE IF NOT EXISTS git_repos (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					path TEXT NOT NULL UNIQUE,
					folder_id TEXT,
					sort_order INTEGER NOT NULL DEFAULT 0,
					created_at INTEGER NOT NULL
				)
			`)
			return err
		},
	},
	{
		version: 19,
		desc:    "agrega git_credentials — tokens (PAT) por host para el módulo Git, con el token cifrado a nivel de columna",
		apply: func(tx *sql.Tx) error {
			// Unlike git_repos (migration 18), this table DOES hold a secret,
			// so it follows the same column-level AES-256-GCM pattern as
			// connections.encrypted_dsn (.claude/rules/technical.md point 3):
			// encrypted_token + its own nonce, never a plaintext column.
			//
			// Keyed by host rather than by repository because that is how the
			// credential actually scopes — one github.com token serves every
			// repository cloned from github.com, and storing it per repository
			// would make the user paste the same PAT once per project and keep
			// N copies of it in sync.
			_, err := tx.Exec(`
				CREATE TABLE IF NOT EXISTS git_credentials (
					id TEXT PRIMARY KEY,
					host TEXT NOT NULL UNIQUE,
					username TEXT NOT NULL,
					encrypted_token BLOB NOT NULL,
					nonce BLOB NOT NULL,
					created_at INTEGER NOT NULL
				)
			`)
			return err
		},
	},
	{
		version: 20,
		desc:    "agrega settings.git_side_width/git_diff_width para persistir el ancho de los paneles de la pestaña Git",
		apply: func(tx *sql.Tx) error {
			// Same shape as editor_height (migration 4): a dragged pixel size
			// persisted so the layout survives a restart. DEFAULTs match the
			// hardcoded widths the panels shipped with, so an existing install
			// opens looking exactly as it did before the columns existed.
			if _, err := tx.Exec(`ALTER TABLE settings ADD COLUMN git_side_width INTEGER NOT NULL DEFAULT 224`); err != nil {
				return err
			}
			_, err := tx.Exec(`ALTER TABLE settings ADD COLUMN git_diff_width INTEGER NOT NULL DEFAULT 520`)
			return err
		},
	},
	{
		version: 21,
		desc:    "agrega settings.git_diff_context/git_diff_ignore_ws/git_diff_wrap — preferencias del visor de diff",
		apply: func(tx *sql.Tx) error {
			// DEFAULT 3 is git's own default context; the other two default off
			// so an existing install sees exactly the diff it saw before.
			if _, err := tx.Exec(`ALTER TABLE settings ADD COLUMN git_diff_context INTEGER NOT NULL DEFAULT 3`); err != nil {
				return err
			}
			if _, err := tx.Exec(`ALTER TABLE settings ADD COLUMN git_diff_ignore_ws INTEGER NOT NULL DEFAULT 0`); err != nil {
				return err
			}
			_, err := tx.Exec(`ALTER TABLE settings ADD COLUMN git_diff_wrap INTEGER NOT NULL DEFAULT 1`)
			return err
		},
	},
	{
		version: 22,
		desc:    "agrega settings.query_page_size — cuántas filas trae cada página de resultados (0 = todas)",
		apply: func(tx *sql.Tx) error {
			// DEFAULT 500 = el mismo valor que usaba la constante, así una
			// instalación existente no cambia de comportamiento al migrar.
			_, err := tx.Exec(`ALTER TABLE settings ADD COLUMN query_page_size INTEGER NOT NULL DEFAULT 500`)
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
