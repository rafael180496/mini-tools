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
	{
		version: 23,
		desc:    "agrega git_repos.pinned_branches — ramas ancladas por repositorio (JSON), para que las importantes queden arriba del panel",
		apply: func(tx *sql.Tx) error {
			// Columna en git_repos y no en settings porque anclar es por
			// repositorio: 'develop' importa en uno y no existe en otro.
			// DEFAULT '[]' = ningún repo existente cambia de comportamiento.
			// Solo nombres de rama, ninguna credencial — misma condición que
			// el resto de git_repos (migración 18).
			_, err := tx.Exec(`ALTER TABLE git_repos ADD COLUMN pinned_branches TEXT NOT NULL DEFAULT '[]'`)
			return err
		},
	},
	{
		version: 24,
		desc:    "agrega connections.environment — producción/staging/desarrollo, para teñir la conexión y activar la confirmación de comandos destructivos",
		apply: func(tx *sql.Tx) error {
			// DEFAULT '' = ninguna conexión existente queda marcada como
			// producción por accidente. Que una conexión de verdad crítica
			// aparezca sin marcar es un problema que el usuario ve y corrige;
			// lo contrario —marcar producción por defecto— entrenaría a
			// aceptar el diálogo sin leerlo, que es exactamente lo que esta
			// función existe para evitar.
			_, err := tx.Exec(`ALTER TABLE connections ADD COLUMN environment TEXT NOT NULL DEFAULT ''`)
			return err
		},
	},
	{
		version: 25,
		desc:    "crea ssh_keys — llaves privadas cifradas bajo la clave maestra, vinculables a varias conexiones sin duplicar el material",
		apply: func(tx *sql.Tx) error {
			// El material va cifrado con el mismo esquema que encrypted_dsn en
			// connections (AES-GCM bajo la clave del vault, nonce por columna):
			// una llave privada no merece menos protección que un DSN, y no
			// hay razón para inventar un segundo mecanismo.
			//
			// name es UNIQUE porque la llave se elige por nombre en el
			// formulario de conexión, y dos "id_rsa del server viejo" hacen
			// imposible saber cuál se está vinculando.
			//
			// fingerprint y key_type se derivan al guardar y se almacenan en
			// claro a propósito: son públicos por definición (un fingerprint
			// es lo que se publica para verificar una llave) y son lo único
			// que permite reconocer una llave en la lista sin descifrarla.
			_, err := tx.Exec(`CREATE TABLE ssh_keys (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL UNIQUE,
				key_type TEXT NOT NULL DEFAULT '',
				fingerprint TEXT NOT NULL DEFAULT '',
				encrypted_key BLOB NOT NULL,
				key_nonce BLOB NOT NULL,
				encrypted_passphrase BLOB,
				passphrase_nonce BLOB,
				created_at INTEGER NOT NULL
			)`)
			return err
		},
	},
	{
		version: 26,
		desc:    "agrega settings.local_shell — qué shell usa la terminal local integrada (zsh/bash/fish en Unix, PowerShell/cmd/Git Bash/WSL en Windows)",
		apply: func(tx *sql.Tx) error {
			// DEFAULT '' = "el que el sistema ya eligió" (localterm.
			// DefaultShellID: $SHELL en Unix, el PowerShell más moderno
			// instalado en Windows). Guardar '' y resolverlo en cada arranque,
			// en vez de materializar un id acá, es lo que hace que el mismo
			// vault restaurado en una máquina distinta —o en otro sistema
			// operativo— siga abriendo un shell que existe. Solo un
			// identificador de shell, nunca una ruta ni una credencial: no
			// necesita cifrado de columna.
			_, err := tx.Exec(`ALTER TABLE settings ADD COLUMN local_shell TEXT NOT NULL DEFAULT ''`)
			return err
		},
	},
	{
		version: 27,
		desc:    "agrega el layout del panel de la pestaña Git (dock de la terminal, tamaño, solapa abierta, paneles ocultos) y el tamaño de fuente de las terminales",
		apply: func(tx *sql.Tx) error {
			// Dónde va anclada la terminal del módulo Git: 'bottom' (el
			// default histórico), 'left' o 'right'. Los defaults reproducen
			// exactamente lo que veía una instalación existente antes de esta
			// migración, así que actualizar no mueve nada de lugar.
			if _, err := tx.Exec(`ALTER TABLE settings ADD COLUMN git_term_dock TEXT NOT NULL DEFAULT 'bottom'`); err != nil {
				return err
			}
			// Un solo número para las dos orientaciones: es el alto cuando
			// está abajo y el ancho cuando está a los costados. Guardar dos
			// columnas obligaría a decidir qué pasa al rotar el dock, y la
			// respuesta útil ("que quede parecido") sale sola con una sola.
			if _, err := tx.Exec(`ALTER TABLE settings ADD COLUMN git_term_size INTEGER NOT NULL DEFAULT 300`); err != nil {
				return err
			}
			// Qué solapa del panel quedó abierta: '' (cerrado), 'terminal' o
			// 'commands'. DEFAULT '' = una instalación que actualiza abre la
			// pestaña Git igual que siempre, sin un panel que no pidió — y sin
			// levantar un proceso de shell al arrancar.
			if _, err := tx.Exec(`ALTER TABLE settings ADD COLUMN git_panel_tab TEXT NOT NULL DEFAULT ''`); err != nil {
				return err
			}
			if _, err := tx.Exec(`ALTER TABLE settings ADD COLUMN git_side_hidden INTEGER NOT NULL DEFAULT 0`); err != nil {
				return err
			}
			if _, err := tx.Exec(`ALTER TABLE settings ADD COLUMN git_diff_hidden INTEGER NOT NULL DEFAULT 0`); err != nil {
				return err
			}
			// Tamaño de fuente compartido por TODAS las terminales (la local y
			// las sesiones SSH). 13 es el valor que ambas tenían hardcodeado,
			// así que nadie ve un cambio al migrar.
			_, err := tx.Exec(`ALTER TABLE settings ADD COLUMN terminal_font_size INTEGER NOT NULL DEFAULT 13`)
			return err
		},
	},
	{
		version: 28,
		desc:    "crea agent_configs (comando y API key opcional de cada CLI agéntico) y agrega settings.git_panel_sessions",
		apply: func(tx *sql.Tx) error {
			// Una fila por agente configurado, con el id del catálogo
			// (backend/agents) como clave: no hay id generado porque el
			// conjunto de agentes lo define la app, no el usuario, y un
			// agente que la app deje de conocer simplemente queda como una
			// fila huérfana inofensiva en vez de romper la lectura.
			//
			// La API key va cifrada con el MISMO esquema que encrypted_dsn y
			// que ssh_keys (AES-GCM bajo la clave maestra, nonce por
			// columna): es una credencial de pago y no merece menos
			// protección que un DSN. Es opcional a propósito — la vía normal
			// de estos CLIs es su propio login, y ahí no se guarda nada acá.
			if _, err := tx.Exec(`CREATE TABLE IF NOT EXISTS agent_configs (
				agent_id TEXT PRIMARY KEY,
				command TEXT NOT NULL DEFAULT '',
				encrypted_key BLOB,
				key_nonce BLOB,
				updated_at INTEGER NOT NULL
			)`); err != nil {
				return err
			}
			// Qué sesiones tenía abiertas el panel de la pestaña Git, en JSON
			// ([{kind, agentId, title}]). DEFAULT '[]' = una instalación que
			// actualiza abre el panel con una sola terminal, como hasta ahora.
			_, err := tx.Exec(`ALTER TABLE settings ADD COLUMN git_panel_sessions TEXT NOT NULL DEFAULT '[]'`)
			return err
		},
	},
	{
		version: 29,
		desc:    "crea ssh_command_history (comandos ejecutados en cada terminal SSH, cifrados) y agrega settings.ssh_history_enabled",
		apply: func(tx *sql.Tx) error {
			// Historial de comandos por conexión SSH.
			//
			// Cifrado con el MISMO esquema que encrypted_dsn, ssh_keys y las
			// API keys de agentes (AES-GCM bajo la clave maestra, nonce por
			// fila), y no por exceso de celo: hasta ahora este historial vivía
			// solo en memoria y se tiraba al cerrar la pestaña, precisamente
			// porque una línea de comando puede llevar un secreto adentro
			// (`mysql -pXXX`, `export TOKEN=…`). Persistirlo en claro sería
			// cambiar esa decisión sin decirlo. El repositorio además descarta
			// las líneas que parecen traer una credencial — ver
			// ssh_history_repo.go — así que el cifrado es la segunda línea de
			// defensa, no la única.
			//
			// ON DELETE CASCADE: borrar la conexión se lleva su historial. Un
			// historial huérfano no se puede ni mostrar ni limpiar desde la
			// interfaz, que es la definición de basura que se acumula.
			if _, err := tx.Exec(`CREATE TABLE IF NOT EXISTS ssh_command_history (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				conn_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
				encrypted_cmd BLOB NOT NULL,
				nonce BLOB NOT NULL,
				ran_at INTEGER NOT NULL
			)`); err != nil {
				return err
			}
			// El índice es por (conexión, fecha desc): toda lectura es "los
			// últimos N de esta conexión", y sin él una tabla que crece con
			// cada Enter obliga a un scan completo para responderla.
			if _, err := tx.Exec(`CREATE INDEX IF NOT EXISTS idx_ssh_history_conn ON ssh_command_history (conn_id, ran_at DESC)`); err != nil {
				return err
			}
			// Registrar el historial se puede apagar. Arranca en 1 porque es
			// una función que el usuario pidió, pero apagarlo tiene que estar
			// a un click y sin explicaciones: es su terminal.
			_, err := tx.Exec(`ALTER TABLE settings ADD COLUMN ssh_history_enabled INTEGER NOT NULL DEFAULT 1`)
			return err
		},
	},
	{
		version: 30,
		desc:    "agrega git_repos.open_files (pestañas del editor de archivos) y git_repos.default_agent",
		apply: func(tx *sql.Tx) error {
			// Qué archivos tenía abiertos el editor de la pestaña Git, en JSON
			// (["ruta/relativa.go", ...]). Por repositorio y no global: las
			// pestañas abiertas son del proyecto en el que estabas trabajando,
			// igual que pinned_branches.
			//
			// Se guardan las RUTAS, nunca el contenido. Guardar el contenido
			// convertiría al vault en una segunda copia del árbol de trabajo,
			// desincronizada con el disco desde el instante siguiente: al
			// reabrir hay que leer el archivo como está AHORA, que además es
			// lo único correcto si un agente lo tocó mientras tanto.
			//
			// DEFAULT '[]': una instalación que actualiza abre el editor
			// vacío, exactamente como venía.
			if _, err := tx.Exec(`ALTER TABLE git_repos ADD COLUMN open_files TEXT NOT NULL DEFAULT '[]'`); err != nil {
				return err
			}
			// Con qué agente se abre una sesión desde este repositorio cuando
			// no se elige uno. Vacío = preguntar, que es el comportamiento
			// actual y el default correcto: elegir por el usuario un asistente
			// que consume su cuota no es algo que nadie haya pedido.
			_, err := tx.Exec(`ALTER TABLE git_repos ADD COLUMN default_agent TEXT NOT NULL DEFAULT ''`)
			return err
		},
	},
	{
		version: 31,
		desc:    "crea agent_chats (historial de conversaciones con agentes por repositorio, con el título cifrado)",
		apply: func(tx *sql.Tx) error {
			// Historial de chats con agentes, por repositorio.
			//
			// Lo que se guarda es el PUNTERO a la conversación, no la
			// conversación: `conversation_id` es el id que devuelve el propio
			// CLI y con el que se la retoma (`--resume`, `--conversation`). El
			// historial de mensajes lo tiene el CLI; duplicarlo acá sería una
			// segunda memoria que se desincroniza con la real y que además
			// obligaría a guardar en el vault todo lo que se conversó.
			//
			// El TÍTULO sí va cifrado, con el mismo esquema que
			// ssh_command_history y por el mismo motivo: se deriva de lo
			// primero que se le escribió al agente, y eso puede ser cualquier
			// cosa —el nombre de un cliente, una ruta interna, un fragmento de
			// un error con datos adentro—. Los ids y las fechas van en claro:
			// son identificadores opacos, no contenido.
			//
			// ON DELETE CASCADE: sacar el repositorio de la app se lleva su
			// historial. Un chat huérfano no se puede ni mostrar ni borrar
			// desde la interfaz, que es la definición de basura que se acumula.
			if _, err := tx.Exec(`CREATE TABLE IF NOT EXISTS agent_chats (
				id TEXT PRIMARY KEY,
				repo_id TEXT NOT NULL REFERENCES git_repos(id) ON DELETE CASCADE,
				agent_id TEXT NOT NULL,
				encrypted_title BLOB,
				title_nonce BLOB,
				conversation_id TEXT NOT NULL DEFAULT '',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)`); err != nil {
				return err
			}
			// El índice es por (repositorio, fecha desc): toda lectura es "los
			// últimos chats de este repo", y sin él una tabla que crece con
			// cada conversación obliga a un scan completo para responderla.
			_, err := tx.Exec(`CREATE INDEX IF NOT EXISTS idx_agent_chats_repo ON agent_chats (repo_id, updated_at DESC)`)
			return err
		},
	},
	{
		version: 32,
		desc:    "agrega a agent_chats el modelo, el esfuerzo y el modo elegidos, para que un chat retomado siga como estaba",
		apply: func(tx *sql.Tx) error {
			// Ajustes del chat. Retomar una conversación con el modelo y el
			// esfuerzo en su default —cuando se había elegido otros— la
			// continúa de una forma distinta de como venía, y eso no se nota
			// hasta que la respuesta llega peor de lo esperado.
			//
			// El MODO también se guarda, pero se restaura acotado: los modos
			// permisivos vuelven a pedir aprobación aunque estuvieran
			// guardados (ver el frontend). Guardar "podía editar" y
			// reactivarlo solo porque se reabrió una pestaña sería conceder un
			// permiso que nadie volvió a dar.
			for _, col := range []string{"model", "effort", "mode"} {
				if _, err := tx.Exec(`ALTER TABLE agent_chats ADD COLUMN ` + col + ` TEXT NOT NULL DEFAULT ''`); err != nil {
					return err
				}
			}
			return nil
		},
	},
	{
		version: 33,
		desc:    "agente activo de nivel app y módulo de origen de cada chat (chat integral único)",
		apply: func(tx *sql.Tx) error {
			// El agente/modelo/esfuerzo activos dejan de ser del módulo Git y
			// pasan a ser de la aplicación: el chat es UNO SOLO y se abre desde
			// cualquier módulo, así que elegir agente en el editor SQL y
			// encontrar otro en la pestaña Git sería el mismo error que tener
			// dos chats.
			//
			// Vacío = preguntar, igual que `git_repos.default_agent` (migración
			// 30) y por el mismo motivo: elegir por el usuario un asistente que
			// consume su cuota no es algo que nadie haya pedido. El default por
			// repositorio se conserva y sigue ganando cuando existe — esto es el
			// piso para los módulos que no son un repositorio.
			for _, col := range []string{"active_agent", "active_model", "active_effort"} {
				if _, err := tx.Exec(`ALTER TABLE settings ADD COLUMN ` + col + ` TEXT NOT NULL DEFAULT ''`); err != nil {
					return err
				}
			}

			// Dónde va anclado el panel del chat y cuánto mide. Mismo criterio
			// que git_term_dock/git_term_size (migración 27): un solo número
			// para las dos orientaciones, porque el panel nunca está anclado
			// abajo y a un costado a la vez.
			//
			// El default es "right" y no "float": es donde el chat ya vivía en
			// la pestaña Git, y mover de lugar algo que el usuario ya tiene
			// aprendido no es una mejora.
			if _, err := tx.Exec(`ALTER TABLE settings ADD COLUMN agent_dock TEXT NOT NULL DEFAULT 'right'`); err != nil {
				return err
			}
			if _, err := tx.Exec(`ALTER TABLE settings ADD COLUMN agent_size INTEGER NOT NULL DEFAULT 380`); err != nil {
				return err
			}

			// De qué módulo salió cada conversación, para poder filtrar el
			// historial por origen ahora que ya no es todo del módulo Git.
			//
			// `module` es un identificador de la app ("git", "db", "ssh",
			// "note", "" = sin módulo) y `context_id` el id opaco del recurso
			// dentro de ese módulo (id de conexión, alias SSH, id de nota).
			// **Se guarda el id, nunca la etiqueta**: el nombre visible se
			// resuelve al leer, así que renombrar una conexión no deja el
			// historial mintiendo, y un recurso borrado se muestra como tal en
			// vez de dejar un texto que ya no corresponde a nada.
			//
			// `repo_id` queda como está y admite '' para los chats que no salen
			// de un repositorio. Su FK declarada no se aplica —este vault no
			// activa `PRAGMA foreign_keys` (hallazgo de la migración 31)—, así
			// que una fila con repo_id vacío no rompe nada; lo que sí hace falta
			// es que las lecturas por repositorio no se la lleven puesta, y por
			// eso ListAgentChats filtra por repo Y AgentChatsByModule por módulo.
			for _, col := range []string{"module", "context_id"} {
				if _, err := tx.Exec(`ALTER TABLE agent_chats ADD COLUMN ` + col + ` TEXT NOT NULL DEFAULT ''`); err != nil {
					return err
				}
			}
			// Mismo criterio que el índice por (repo, fecha) de la migración 31:
			// la lectura natural del historial unificado es "los últimos chats
			// de este módulo".
			_, err := tx.Exec(`CREATE INDEX IF NOT EXISTS idx_agent_chats_module ON agent_chats (module, updated_at DESC)`)
			return err
		},
	},
	{
		version: 34,
		desc:    "crea vault_notes (base de conocimiento cifrada, privada por defecto)",
		apply: func(tx *sql.Tx) error {
			// Notas de la base de conocimiento. Mismo esquema de cifrado por
			// COLUMNA que `connections.encrypted_dsn` y que el título de
			// `agent_chats`: la app no cifra el archivo entero porque eso
			// requeriría SQLCipher y cgo (.claude/rules/technical.md punto 3).
			//
			// Título, cuerpo y frontmatter van cifrados cada uno con su propio
			// nonce. Nonces separados y no uno compartido: reusar un nonce con
			// la misma clave en AES-GCM es la forma clásica de romper GCM, y
			// tres columnas que se escriben en la misma operación son
			// exactamente donde uno se tienta de compartirlo.
			//
			// **`is_private` nace en 0: una nota es VISIBLE para los agentes
			// salvo que se la marque.** Es una decisión explícita del usuario
			// del producto, y el intercambio es real: la base de conocimiento
			// sirve para que el agente la consulte, y una nota que nace
			// invisible no aparece hasta que alguien se acuerda de abrirla.
			// A cambio, esconder algo pasa a ser un acto deliberado — el
			// candado de la barra de la nota, que sigue existiendo y sigue
			// siendo absoluto (ver NoteForAI).
			//
			// El default vive igual en el ESQUEMA y no en el código que
			// inserta: así una nota creada por un camino nuevo hereda la misma
			// política, cualquiera sea.
			//
			// `title_hash` es SHA-256 del título normalizado. Es lo que permite
			// resolver `[[Nota]]` y dibujar el grafo **sin descifrar nada**: se
			// comparan hashes, no títulos. Va en claro porque un hash no revela
			// el título, y sin él cada enlace obligaría a descifrar todas las
			// notas para encontrar su destino.
			//
			// `checksum_hash` es SHA-256 del texto plano ANTES de cifrar. Sirve
			// para distinguir "esta nota está corrupta" de "esta nota dice
			// algo raro", que sin verificación se ven igual.
			if _, err := tx.Exec(`CREATE TABLE IF NOT EXISTS vault_notes (
				id TEXT PRIMARY KEY,
				encrypted_title BLOB,
				title_nonce BLOB,
				encrypted_content BLOB,
				content_nonce BLOB,
				encrypted_frontmatter BLOB,
				frontmatter_nonce BLOB,
				title_hash TEXT NOT NULL DEFAULT '',
				is_private INTEGER NOT NULL DEFAULT 0,
				checksum_hash TEXT NOT NULL DEFAULT '',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)`); err != nil {
				return err
			}
			// Índice para filtrar lo que la IA puede ver sin descifrar una sola
			// nota: la consulta del cortafuegos filtra por `is_private = 0` y
			// sigue siendo la única puerta, aunque el default se haya invertido.
			if _, err := tx.Exec(`CREATE INDEX IF NOT EXISTS idx_notes_ai_access ON vault_notes (id, is_private)`); err != nil {
				return err
			}
			// La lectura natural de la lista es "las últimas que toqué".
			if _, err := tx.Exec(`CREATE INDEX IF NOT EXISTS idx_notes_updated ON vault_notes (updated_at DESC)`); err != nil {
				return err
			}
			// Y la resolución de un `[[enlace]]` es una búsqueda por hash.
			_, err := tx.Exec(`CREATE INDEX IF NOT EXISTS idx_notes_title_hash ON vault_notes (title_hash)`)
			return err
		},
	},
	{
		version: 35,
		desc:    "crea vault_note_links (grafo de WikiLinks, por hash de título)",
		apply: func(tx *sql.Tx) error {
			// Aristas del grafo. El destino se guarda como HASH DEL TÍTULO y no
			// como id de nota, por dos motivos:
			//
			//  1. Un `[[enlace]]` puede apuntar a una nota que todavía no
			//     existe. Eso no es un error —es como se crean las notas en un
			//     grafo de conocimiento— y con una FK a `vault_notes(id)` no se
			//     podría representar.
			//  2. Renombrar una nota cambia su hash, y ahí los enlaces que le
			//     apuntaban quedan visiblemente rotos en vez de apuntar en
			//     silencio a otro contenido.
			//
			// No hay FK declarada a propósito: este vault no activa
			// `PRAGMA foreign_keys`, así que una FK sería decorativa (hallazgo
			// de la migración 31). El borrado de las aristas de una nota lo
			// hace explícitamente el repositorio.
			if _, err := tx.Exec(`CREATE TABLE IF NOT EXISTS vault_note_links (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				source_note_id TEXT NOT NULL,
				target_title_hash TEXT NOT NULL,
				created_at INTEGER NOT NULL
			)`); err != nil {
				return err
			}
			// Los dos sentidos se consultan igual de seguido: los enlaces
			// salientes de la nota abierta, y los entrantes (backlinks).
			if _, err := tx.Exec(`CREATE INDEX IF NOT EXISTS idx_note_links_source ON vault_note_links (source_note_id)`); err != nil {
				return err
			}
			_, err := tx.Exec(`CREATE INDEX IF NOT EXISTS idx_note_links_target ON vault_note_links (target_title_hash)`)
			return err
		},
	},
	{
		version: 36,
		desc:    "agrega a settings el estado del módulo de notas",
		apply: func(tx *sql.Tx) error {
			// Última nota abierta y ancho del panel lateral del módulo. Mismo
			// criterio que el resto del layout: la app abre como se dejó.
			if _, err := tx.Exec(`ALTER TABLE settings ADD COLUMN notes_last_open TEXT NOT NULL DEFAULT ''`); err != nil {
				return err
			}
			_, err := tx.Exec(`ALTER TABLE settings ADD COLUMN notes_side_width INTEGER NOT NULL DEFAULT 260`)
			return err
		},
	},
	{
		version: 37,
		desc:    "agrega settings.mcp_enabled — el servidor MCP nace APAGADO",
		apply: func(tx *sql.Tx) error {
			// **DEFAULT 0, y el default importa más que de costumbre.** Este
			// flag decide si hay un canal por el que un agente puede pedirle
			// datos a la aplicación. Nace apagado, y apagado significa que no
			// hay socket, ni goroutine, ni archivo — no es un permiso que se
			// evalúa en cada llamada, es un servidor que no existe.
			//
			// El flag es solo el RECUERDO de la preferencia: al abrir la app no
			// se enciende nada solo porque estuviera en 1. Encender es una
			// acción del usuario en esa sesión.
			_, err := tx.Exec(`ALTER TABLE settings ADD COLUMN mcp_enabled INTEGER NOT NULL DEFAULT 0`)
			return err
		},
	},
	{
		version: 38,
		desc:    "agrega vault_notes.folder_id — carpetas para organizar la base de conocimiento",
		apply: func(tx *sql.Tx) error {
			// Se reusa la tabla `folders` que ya existe, con `scope = 'note'`.
			// Esa columna se agregó en la migración 12 justamente para esto:
			// cada módulo organiza lo suyo en su propio árbol, sin mezclarse
			// con las carpetas de conexiones, SSH o repositorios. No hace falta
			// tabla nueva ni tocar `folders`.
			//
			// '' = en la raíz, que es donde nacen todas. Igual que
			// `connections.folder_id`, que es nulable por ser anterior a esta
			// convención — acá se usa cadena vacía porque es más simple de
			// consultar y no hay filas previas que preservar.
			_, err := tx.Exec(`ALTER TABLE vault_notes ADD COLUMN folder_id TEXT NOT NULL DEFAULT ''`)
			return err
		},
	},
	{
		version: 39,
		desc:    "crea vault_note_assets (imágenes de las notas, cifradas como el resto)",
		apply: func(tx *sql.Tx) error {
			// Imágenes pegadas en una nota.
			//
			// **Van cifradas y adentro del vault, no sueltas en el disco.** Es
			// la decisión importante de esta tabla: una captura de un tablero
			// de producción, de una consola con datos de un cliente o de un
			// error con un token a la vista es exactamente igual de sensible
			// que el texto de la nota que la acompaña. Guardar el texto cifrado
			// y la imagen en una carpeta al lado sería proteger la mitad —y la
			// mitad menos delatora, porque una captura se entiende de un
			// vistazo y un párrafo hay que leerlo.
			//
			// El costo es real y se asume: `vault.db` crece con cada imagen y
			// el backup del vault se lleva todo junto. A cambio, una sola cosa
			// que proteger y una sola clave.
			if _, err := tx.Exec(`CREATE TABLE IF NOT EXISTS vault_note_assets (
				id TEXT PRIMARY KEY,
				note_id TEXT NOT NULL,
				mime TEXT NOT NULL,
				encrypted_data BLOB,
				data_nonce BLOB,
				size_bytes INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL
			)`); err != nil {
				return err
			}
			// La lectura natural es "las imágenes de esta nota", para poder
			// borrarlas cuando la nota se borra.
			_, err := tx.Exec(`CREATE INDEX IF NOT EXISTS idx_note_assets_note ON vault_note_assets (note_id)`)
			return err
		},
	},
	{
		version: 40,
		desc:    "agrega settings.sidebar_module (qué módulo de la barra lateral está activo)",
		apply: func(tx *sql.Tx) error {
			// La barra lateral pasó de mostrar los cuatro módulos apilados a
			// mostrar UNO, elegido desde el menú de íconos de arriba. Lo que
			// hay que recordar entre sesiones cambió con eso: antes era "qué
			// módulos están plegados" (una lista), ahora es "cuál está
			// abierto" (uno solo), y no son la misma pregunta escrita
			// distinto — con un módulo a la vez no existe el concepto de
			// plegado.
			//
			// Por eso una columna nueva y no un reuso de
			// collapsed_sidebar_modules: esa columna queda huérfana (las
			// migraciones de este vault son solo aditivas, ver
			// .claude/rules/technical.md punto 13, así que no se borra), pero
			// guardar un id suelto donde antes iba un arreglo JSON dejaría el
			// dato ilegible para cualquiera que mire la tabla sin conocer
			// esta historia.
			_, err := tx.Exec(`ALTER TABLE settings ADD COLUMN sidebar_module TEXT NOT NULL DEFAULT ''`)
			return err
		},
	},
	{
		version: 41,
		desc:    "agrega settings.sidebar_width (ancho arrastrado de la barra lateral)",
		apply: func(tx *sql.Tx) error {
			// Mismo trato que git_side_width/editor_height: el tamaño que el
			// usuario arrastró se guarda para que la próxima sesión abra como
			// la dejó. 0 significa "todavía no lo tocó" y deja decidir el
			// ancho al frontend, en vez de congelar acá un número que después
			// hay que mantener sincronizado en dos lados.
			_, err := tx.Exec(`ALTER TABLE settings ADD COLUMN sidebar_width INTEGER NOT NULL DEFAULT 0`)
			return err
		},
	},
	{
		version: 42,
		desc:    "agrega la apariencia del editor (fuente, cuerpo, ajuste de línea, numeración, tabulación, barra de acciones)",
		apply: func(tx *sql.Tx) error {
			// Todo lo que hasta ahora estaba fijo en el código de cada
			// editor. Eran tres componentes distintos —el editor SQL, el de
			// archivos del módulo Git y el de notas— cada uno con su propio
			// `EditorView.theme` repitiendo el mismo 13px y la misma familia
			// tipográfica, así que cambiar de idea significaba editar tres
			// archivos y esperar no haberse olvidado de ninguno.
			//
			// Los valores por defecto son deliberadamente "vacíos" (cadena
			// vacía o cero) y no los valores reales: el default vive en el
			// frontend, en un solo lugar, y así una instalación que nunca
			// tocó estos ajustes sigue exactamente lo que decida el código
			// en vez de un número congelado en el schema el día que se
			// escribió esta migración.
			cols := []string{
				`ALTER TABLE settings ADD COLUMN editor_font_family TEXT NOT NULL DEFAULT ''`,
				`ALTER TABLE settings ADD COLUMN editor_font_size INTEGER NOT NULL DEFAULT 0`,
				`ALTER TABLE settings ADD COLUMN editor_line_wrap INTEGER NOT NULL DEFAULT 0`,
				`ALTER TABLE settings ADD COLUMN editor_line_numbers INTEGER NOT NULL DEFAULT 1`,
				`ALTER TABLE settings ADD COLUMN editor_tab_size INTEGER NOT NULL DEFAULT 0`,
				`ALTER TABLE settings ADD COLUMN editor_toolbar TEXT NOT NULL DEFAULT ''`,
			}
			for _, stmt := range cols {
				if _, err := tx.Exec(stmt); err != nil {
					return err
				}
			}
			return nil
		},
	},
	{
		version: 43,
		desc:    "crea local_command_history (comandos de las terminales locales del SO, cifrados)",
		apply: func(tx *sql.Tx) error {
			// Historial de las terminales LOCALES, con el mismo trato que el de
			// las SSH: cifrado bajo la clave maestra, con el filtro de líneas
			// que parecen traer un secreto y con el mismo interruptor para
			// apagarlo (settings.ssh_history_enabled — es "el historial de las
			// terminales", no dos ajustes que el usuario tendría que apagar por
			// separado).
			//
			// **Tabla aparte y no una fila más en ssh_command_history**, por dos
			// motivos que no se pueden esquivar: esa tabla tiene
			// `conn_id REFERENCES connections(id)` y una shell local no es una
			// conexión —no hay fila a la que apuntar—, y la clave por la que se
			// agrupa es distinta: el historial de una terminal local es del
			// INTÉRPRETE (zsh, PowerShell), no de un servidor.
			if _, err := tx.Exec(`CREATE TABLE IF NOT EXISTS local_command_history (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				shell_id TEXT NOT NULL,
				encrypted_cmd BLOB NOT NULL,
				nonce BLOB NOT NULL,
				ran_at INTEGER NOT NULL
			)`); err != nil {
				return err
			}
			// Mismo índice que el de SSH y por lo mismo: toda lectura es "los
			// últimos N de este intérprete".
			if _, err := tx.Exec(
				`CREATE INDEX IF NOT EXISTS idx_local_history_shell ON local_command_history (shell_id, ran_at DESC)`,
			); err != nil {
				return err
			}
			return nil
		},
	},
	{
		version: 44,
		desc:    "agrega settings.mcp_notes_write — el agente NO puede escribir notas hasta que se lo permitan",
		apply: func(tx *sql.Tx) error {
			// Permiso de ESCRITURA del servidor MCP sobre la base de
			// conocimiento. Nace en 0 y es un interruptor aparte del que
			// enciende el servidor, no una consecuencia suya.
			//
			// **Por qué su propio permiso.** Hasta acá todas las herramientas
			// MCP eran de lectura y esa era la promesa del módulo: el agente
			// mira lo que el usuario le comparte y no toca nada. Crear notas
			// rompe esa promesa, así que no puede llegar de arrastre al
			// encender el servidor — tiene que ser una decisión propia, visible
			// y revocable.
			_, err := tx.Exec(`ALTER TABLE settings ADD COLUMN mcp_notes_write INTEGER NOT NULL DEFAULT 0`)
			return err
		},
	},
	{
		version: 45,
		desc:    "módulo HTTP: colecciones, ítems (carpetas y requests) e historial",
		apply: func(tx *sql.Tx) error {
			// Fase 1 de .claude/specs/http-client.md. Se crean las tres
			// tablas del núcleo; entornos y cookies entran en sus propias
			// migraciones cuando lleguen sus fases, para que cada una sea
			// reversible por separado en el historial de git.
			//
			// Nada de esto es aditivo sobre tablas existentes: son tablas
			// nuevas, el caso más seguro de migración.
			if _, err := tx.Exec(`CREATE TABLE IF NOT EXISTS http_collections (
				id           TEXT PRIMARY KEY,
				name         TEXT NOT NULL,
				description  TEXT NOT NULL DEFAULT '',
				folder_id    TEXT,
				sort_order   INTEGER NOT NULL DEFAULT 0,
				variables    BLOB,
				variables_nonce BLOB,
				auth         BLOB,
				auth_nonce   BLOB,
				postman_raw  BLOB,
				postman_raw_nonce BLOB,
				created_at   INTEGER NOT NULL,
				updated_at   INTEGER NOT NULL
			)`); err != nil {
				return err
			}

			// Un solo árbol con parent_id + kind, sin tabla de carpetas
			// aparte: es la forma que ya tiene el formato de Postman, así
			// que el import (F6) no necesita traducir la estructura.
			//
			// Las columnas cifradas son las que pueden llevar secretos: el
			// cuerpo (un token en un JSON de login), la auth, la
			// documentación (que la gente usa para pegar ejemplos reales) y
			// el crudo de Postman preservado. url/params/headers quedan en
			// claro porque son lo que se busca y se ordena en el árbol, y
			// cifrarlos obligaría a descifrar la colección entera para
			// listarla.
			if _, err := tx.Exec(`CREATE TABLE IF NOT EXISTS http_items (
				id            TEXT PRIMARY KEY,
				collection_id TEXT NOT NULL,
				parent_id     TEXT,
				kind          TEXT NOT NULL,
				name          TEXT NOT NULL,
				sort_order    INTEGER NOT NULL DEFAULT 0,
				method        TEXT NOT NULL DEFAULT '',
				url           TEXT NOT NULL DEFAULT '',
				params        TEXT NOT NULL DEFAULT '',
				path_vars     TEXT NOT NULL DEFAULT '',
				headers       TEXT NOT NULL DEFAULT '',
				settings      TEXT NOT NULL DEFAULT '',
				body          BLOB,
				body_nonce    BLOB,
				auth          BLOB,
				auth_nonce    BLOB,
				docs          BLOB,
				docs_nonce    BLOB,
				postman_raw   BLOB,
				postman_raw_nonce BLOB,
				created_at    INTEGER NOT NULL,
				updated_at    INTEGER NOT NULL
			)`); err != nil {
				return err
			}
			// El árbol se lee siempre por colección y en orden; el índice es
			// exactamente esa consulta.
			if _, err := tx.Exec(
				`CREATE INDEX IF NOT EXISTS idx_http_items_tree ON http_items (collection_id, parent_id, sort_order)`,
			); err != nil {
				return err
			}

			// La URL del historial se guarda YA RESUELTA pero sin secretos:
			// sirve para reconocer qué se corrió sin volverse un archivo de
			// tokens. Los headers de la petición no se guardan por lo mismo
			// — mismo criterio que el historial de SSH.
			if _, err := tx.Exec(`CREATE TABLE IF NOT EXISTS http_history (
				id            TEXT PRIMARY KEY,
				item_id       TEXT,
				method        TEXT NOT NULL,
				url           TEXT NOT NULL,
				status        INTEGER NOT NULL DEFAULT 0,
				duration_ms   INTEGER NOT NULL DEFAULT 0,
				size_bytes    INTEGER NOT NULL DEFAULT 0,
				error         TEXT NOT NULL DEFAULT '',
				executed_at   INTEGER NOT NULL
			)`); err != nil {
				return err
			}
			if _, err := tx.Exec(
				`CREATE INDEX IF NOT EXISTS idx_http_history_item ON http_history (item_id, executed_at DESC)`,
			); err != nil {
				return err
			}
			return nil
		},
	},
	{
		version: 46,
		desc:    "módulo HTTP: entornos y entorno activo",
		apply: func(tx *sql.Tx) error {
			// Fase 2 de .claude/specs/http-client.md. Tabla propia y no una
			// columna más en http_collections porque un entorno es
			// TRANSVERSAL: el mismo "prod" se usa desde varias colecciones,
			// que es exactamente lo que lo distingue de las variables de
			// colección.
			//
			// Las variables van cifradas enteras y no fila por fila: adentro
			// de esa lista viajan las marcadas como secretas (tokens,
			// claves), y separarlas en columnas distintas obligaría a
			// decidir el nivel de protección al escribir en vez de al leer.
			if _, err := tx.Exec(`CREATE TABLE IF NOT EXISTS http_environments (
				id                   TEXT PRIMARY KEY,
				name                 TEXT NOT NULL,
				variables            BLOB,
				variables_nonce      BLOB,
				pinned_collection_id TEXT,
				sort_order           INTEGER NOT NULL DEFAULT 0,
				created_at           INTEGER NOT NULL,
				updated_at           INTEGER NOT NULL
			)`); err != nil {
				return err
			}
			// Qué entorno está activo es una preferencia de sesión, del
			// mismo tipo que el tema o la última nota abierta, así que vive
			// en settings y no en una tabla propia.
			_, err := tx.Exec(`ALTER TABLE settings ADD COLUMN http_active_env TEXT NOT NULL DEFAULT ''`)
			return err
		},
	},
	{
		version: 47,
		desc:    "módulo HTTP: scripts de pre-request y de test",
		apply: func(tx *sql.Tx) error {
			// Fase 5 de .claude/specs/http-client.md, primera mitad: GUARDAR
			// los scripts. Ejecutarlos depende de una decisión de tamaño de
			// binario que está pendiente, pero persistirlos no puede
			// esperar: el import de Postman (F6) tiene que poder traerlos y
			// devolverlos intactos, y una colección importada sin sus
			// scripts es una colección perdida, no una a medias.
			//
			// Cifrados porque un script de firma lleva la clave adentro, o
			// referencia variables secretas — es exactamente la clase de
			// texto que no puede quedar en claro en el archivo del vault.
			for _, table := range []string{"http_items", "http_collections"} {
				for _, col := range []string{"pre_request", "pre_request_nonce", "test_script", "test_script_nonce"} {
					if _, err := tx.Exec("ALTER TABLE " + table + " ADD COLUMN " + col + " BLOB"); err != nil {
						return err
					}
				}
			}
			return nil
		},
	},
	{
		version: 48,
		desc:    "módulo HTTP: variables calculadas (firma declarativa)",
		apply: func(tx *sql.Tx) error {
			// Segunda mitad de la fase 5, después de la decisión del usuario
			// de NO incorporar un motor JavaScript (+19,8 MB de goja contra
			// un techo de 80 que Windows ya roza con 55,66).
			//
			// Cifradas: adentro va la clave de una firma, que es el secreto
			// más sensible que puede guardar una colección.
			for _, table := range []string{"http_collections", "http_items"} {
				for _, col := range []string{"computed", "computed_nonce"} {
					if _, err := tx.Exec("ALTER TABLE " + table + " ADD COLUMN " + col + " BLOB"); err != nil {
						return err
					}
				}
			}
			return nil
		},
	},
	{
		version: 49,
		desc:    "módulo HTTP: nota de documentación por colección",
		apply: func(tx *sql.Tx) error {
			// Fase 7: la documentación de una colección se publica como una
			// nota del vault, y hay que poder volver a encontrarla para
			// regenerarla. Guardar el id de la nota en la colección —y no
			// buscarla por título— es lo que permite que el usuario le
			// cambie el nombre a la nota sin que la próxima regeneración
			// cree una segunda.
			//
			// En claro: es un identificador, no contenido. El mismo criterio
			// que el resto de los `id` de la base.
			_, err := tx.Exec(`ALTER TABLE http_collections ADD COLUMN docs_note_id TEXT NOT NULL DEFAULT ''`)
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
