package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"os"
	"runtime/debug"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/wailsapp/wails/v2/pkg/runtime"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"mini-tools/backend/agentapprove"
	"mini-tools/backend/agentchat"
	"mini-tools/backend/appdata"
	"mini-tools/backend/autobackup"
	"mini-tools/backend/claudemd"
	"mini-tools/backend/db"
	"mini-tools/backend/db/sqlcipher"
	"mini-tools/backend/explain"
	"mini-tools/backend/export"
	"mini-tools/backend/git"
	"mini-tools/backend/httpclient"
	"mini-tools/backend/localterm"
	"mini-tools/backend/mongoquery"
	"mini-tools/backend/query"
	"mini-tools/backend/redisquery"
	"mini-tools/backend/sftpx"
	"mini-tools/backend/sqlintel"
	"mini-tools/backend/sshconn"
	"mini-tools/backend/updatecheck"
	"mini-tools/backend/vault"
	"mini-tools/backend/vaultgate"
)

// App is the entire Go<->React binding surface (see
// .claude/specs/go-react-contract.md). Every method that touches vault or
// connection data must go through requireUnlocked first, which fails closed
// (vaultgate.ErrLocked) until the master password has been verified.
type App struct {
	ctx      context.Context
	gate     *vaultgate.Gate
	vault    *vault.Store
	pools    *db.PoolManager
	executor *query.Executor

	// redisPools/redisExecutor are Redis's native parallel path — it does
	// NOT go through PoolManager/query.Executor (both hard-typed to
	// *sql.DB/database/sql), a deliberate, documented exception to
	// .claude/rules/technical.md point 2. See
	// .claude/skills/mini-tools-patterns/SKILL.md's Redis section.
	redisPools    *db.RedisPoolManager
	redisExecutor *redisquery.Executor
	// redisStreams is Redis's live-monitor path (Pub/Sub subscriptions and
	// stream tails). Separate from redisExecutor on purpose: a subscription
	// has no result and no end, so it cannot share the command→result
	// contract. See backend/redisquery/stream.go.
	redisStreams *redisquery.StreamManager

	// mongoPools/mongoExecutor are MongoDB's native parallel path — same
	// deliberate, documented exception as Redis (.claude/rules/technical.md
	// point 2): MongoDB is document-oriented and the official driver doesn't
	// implement database/sql. See .claude/skills/mini-tools-patterns/SKILL.md's
	// MongoDB section.
	mongoPools    *db.MongoPoolManager
	mongoExecutor *mongoquery.Executor

	// sshSessions is SSH's own native parallel path — same exception as
	// redisPools/redisExecutor above, but with no separate "pool" step: an
	// interactive terminal session is opened, streamed, and closed as one
	// unit (see backend/sshconn's package doc).
	// sshPool is the ONE SSH connection per host, shared by the terminal,
	// the file panes and the transfers. Before it, a terminal plus an SFTP
	// pane against the same server meant two sockets and two
	// authentications for the same work; SSH multiplexes channels over one
	// connection by design. Refcounted, so closing either half never drops
	// the other. See backend/sshconn/pool.go.
	sshPool     *sshconn.ClientPool
	sshSessions *sshconn.SessionManager

	// sftpBrowse/sftpTransfers are the SFTP file-transfer parallel path,
	// dialing through sshconn.Dial and speaking SFTP (github.com/pkg/sftp) —
	// same native-path exception as sshSessions above. Browse sessions (one
	// per explorer pane) are kept separate from transfers (dedicated
	// connections) so a slow transfer never blocks the file listing and
	// closing a pane never kills an in-flight transfer. See backend/sftpx.
	sftpBrowse    *sftpx.BrowseManager
	sftpTransfers *sftpx.TransferManager

	// localTerms are interactive shells on THIS machine, over a real PTY —
	// the local counterpart of sshSessions above, and another native
	// parallel path (a shell process is not a database/sql connection).
	// Deliberately a separate manager and not a branch inside sshSessions:
	// a local session has no DSN, no host, no auth and no pool to share
	// with an SFTP pane, so merging them would make every sshconn method
	// start by asking "is this one local?". Bindings live in
	// app_localterm.go; see backend/localterm's package doc for why the
	// PTY dependency doesn't break the no-cgo rule.
	localTerms *localterm.SessionManager

	// agentChats corre los CLIs agénticos en modo HEADLESS, un camino aparte
	// del PTY de localTerms: aquel da la experiencia completa del CLI pero
	// entrega bytes con ANSI que se pueden mostrar y no entender; este entrega
	// eventos tipados con los que se puede dibujar un chat de verdad. Los dos
	// conviven a propósito — ver el doc de backend/agentchat.
	agentChats *agentchat.Manager
	// mcp es el servidor MCP. **Nace apagado y no ocupa nada mientras lo esté**:
	// el listener se abre recién cuando el usuario lo enciende en Configuración
	// → Acceso de la IA, y apagarlo lo cierra y borra el socket. Ver app_mcp.go.
	mcp mcpState

	// approve es el canal por el que un agente pide permiso acción por acción
	// (backend/agentapprove). nil cuando no se pudo abrir en esta máquina —
	// no es un error fatal: el chat sigue andando con la aprobación por modo,
	// y el modo de aprobación por acción simplemente no se ofrece.
	approve *agentapprove.Channel
	// approveSettings es la ruta del archivo que instala el hook.
	approveSettings string
	// approvePending son las preguntas esperando respuesta del usuario,
	// indexadas por el id que asigna el canal.
	approvePending map[string]chan agentapprove.Decision
	approveMu      sync.Mutex

	// gitRunner is the Git module's engine — the system `git` binary driven
	// through os/exec, another native parallel path like sshSessions/sftpx
	// above (a repository is not a database/sql connection). It holds no
	// per-repository state, so unlike the pool managers there is nothing to
	// tear down in shutdown. Bindings live in app_git.go; see backend/git's
	// package doc for why exec rather than go-git.
	gitRunner *git.Runner

	// httpRunner ejecuta las peticiones del módulo HTTP y lleva el registro de
	// las que están en vuelo, para poder cancelarlas. Ver backend/httpclient.
	httpRunner *httpclient.Runner

	// autoBackup ticks a periodic vault.Backup while the app is open,
	// gated by the settings.auto_backup_* columns — see
	// backend/autobackup's package doc.
	autoBackup *autobackup.Scheduler

	metadataMu    sync.Mutex
	metadataCache map[string]*db.SchemaMetadata

	// sqlIntel is the editor's IntelliSense engine: one compiled schema
	// index per connection plus this session's usage counters. It is fed
	// from the same metadata the sidebar uses (every path that produces a
	// *db.SchemaMetadata calls Set), and can also build its own index in
	// the background via PrimeSchemaIndex. See backend/sqlintel.
	sqlIntel *sqlintel.Manager
}

// FileContent is what OpenSQLFileDialog returns: the path (so Ctrl+S knows
// where to save back to) and its text.
type FileContent struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// ConnectionInput is what the frontend sends to test or save a connection.
// Params holds the engine-specific fields a db.Connector needs to build a
// DSN (for sqlite: {"path": "..."}) — it is never persisted as-is, only
// turned into a DSN and immediately encrypted.
type ConnectionInput struct {
	Name   string            `json:"name"`
	DBType string            `json:"dbType"`
	Params map[string]string `json:"params"`
	// Color is a user-chosen hex string for ConnectionTree.tsx — purely
	// visual, never interpreted server-side.
	Color string `json:"color"`
	// Environment is "prod", "staging", "dev" or "" — see
	// vault.ConnectionSummary.Environment. Unlike Color it is interpreted.
	Environment string `json:"environment"`
}

// NewApp creates a new App application struct
func NewApp() *App {
	sshPool := sshconn.NewClientPool()
	return &App{
		gate:       vaultgate.New(),
		sshPool:    sshPool,
		sftpBrowse: sftpx.NewBrowseManager(sshPool),
		pools:      db.NewPoolManager(),
		redisPools: db.NewRedisPoolManager(),
		mongoPools: db.NewMongoPoolManager(),

		gitRunner:     git.NewRunner(),
		httpRunner:    httpclient.NewRunner(),
		metadataCache: make(map[string]*db.SchemaMetadata),
		sqlIntel:      sqlintel.NewManager(),
	}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx

	store, err := vault.Open(a.gate)
	if err != nil {
		// The vault is required for the app to function at all — fail
		// loudly instead of starting into a broken, silently-degraded state.
		panic(fmt.Errorf("app: opening vault: %w", err))
	}
	a.vault = store

	a.autoBackup = autobackup.New(a.vault)
	if settings, err := a.vault.GetSettings(); err == nil {
		a.autoBackup.Reconfigure(settings.AutoBackupEnabled, settings.AutoBackupIntervalHours, settings.AutoBackupPath)
	}

	// Shared by both executors — query.EmitFunc y redisquery.EmitFunc son
	// tipos con nombre distinto pero de firma idéntica, así que el mismo
	// closure satisface los dos constructores sin duplicación (el nombre del
	// evento de Wails es el queryID en ambos casos).
	emit := func(event string, data interface{}) {
		runtime.EventsEmit(ctx, event, data)
	}
	// El HistorySink va en nil a propósito: ya no se guarda un historial de
	// consultas. La consola de ejecución es el log corrido de lo que se
	// ejecutó —texto completo, duración y error de cada statement— así que
	// persistir lo mismo en `query_history` era contar dos veces la misma
	// información, y además dejaba el SQL de toda la sesión escrito en disco
	// sin que nadie lo mirara. Los tres executores tratan el sink nil como
	// "no registrar" (ver recordHistory en cada uno).
	a.executor = query.NewExecutor(ctx, a.pools, emit, nil)
	// Restaura el tamaño de página elegido por el usuario (migración 22); si el
	// vault todavía no se puede leer, queda el default del executor.
	if settings, err := a.vault.GetSettings(); err == nil {
		a.executor.SetPageSize(settings.QueryPageSize)
	}
	a.redisExecutor = redisquery.NewExecutor(ctx, a.redisPools, emit, nil)
	a.redisStreams = redisquery.NewStreamManager(ctx, a.redisPools, emit)
	a.mongoExecutor = mongoquery.NewExecutor(ctx, a.mongoPools, emit, nil)
	a.sshSessions = sshconn.NewSessionManager(emit, a.sshPool)
	a.sftpTransfers = sftpx.NewTransferManager(emit, a.sshPool)
	// Mismo `emit` que el resto: localterm.EmitFunc es un tipo con nombre
	// propio pero de firma idéntica a sshconn.EmitFunc, así que el mismo
	// closure satisface los dos constructores (el nombre del evento es el
	// id de sesión en ambos casos).
	a.localTerms = localterm.NewSessionManager(emit)
	// El chat agéntico usa el mismo contrato de "un evento de Wails por
	// sesión", pero con un tipo propio en vez de interface{}: sus eventos son
	// una unión chica y cerrada (texto, herramienta, uso, error), y tiparlos
	// es lo que permite que el frontend los dibuje sin adivinar.
	a.agentChats = agentchat.NewManager(func(sessionID string, ev agentchat.Event) {
		emit(sessionID, ev)
	})

	// Canal de aprobación por acción. Que falle NO impide arrancar: en una
	// máquina sin AF_UNIX el chat sigue funcionando con la aprobación por
	// modo, y el modo por acción no aparece en la lista (ver
	// backend/agentapprove).
	a.approvePending = map[string]chan agentapprove.Decision{}
	if dir, err := appdata.Dir(); err == nil {
		ch, err := agentapprove.Start(dir, a.askApproval)
		if err == nil {
			a.approve = ch
			if self, err := os.Executable(); err == nil {
				if path, err := agentapprove.WriteSettings(dir, self); err == nil {
					a.approveSettings = path
				}
			}
		}
	}
}

// shutdown closes every open connection pool, checkpoints and closes the
// vault's own SQLite handle, and zeroes the in-memory vault key — otherwise
// it would sit in the process's memory unzeroed until the OS reclaims it on
// exit. This runs on every exit path, not just quitting the window normally
// — Wails installs its own SIGTERM/SIGINT handler that calls this same
// shutdown before the process actually exits, so a plain `kill <pid>` goes
// through here too, not just Cmd+Q.
//
// Real bug found live: a.vault.Close() used to be missing here entirely,
// leaving the vault's SQLite connection (WAL mode) open with no explicit
// checkpoint on every exit. A process reopening the same vault.db shortly
// after an abrupt termination could end up discarding the WAL during
// recovery instead of replaying it — the vault would come back at the
// right schema_migrations version but with every connection/history row
// gone. See Store.Close's doc comment for the checkpoint itself.
func (a *App) shutdown(ctx context.Context) {
	if a.autoBackup != nil {
		a.autoBackup.Stop()
	}
	a.executor.RollbackAll(ctx)
	a.pools.CloseAll()
	// Stop every live monitor BEFORE closing the pools: a subscription
	// holds its own dedicated connection, which CloseAll does not reach.
	if a.redisStreams != nil {
		a.redisStreams.StopAll()
	}
	// Same for a reserved transaction connection — it was checked OUT of
	// the pool, so closing the pool never reaches it and it would leak.
	if a.redisExecutor != nil {
		a.redisExecutor.Transactions().ReleaseAll(a.ctx)
	}
	a.redisPools.CloseAll()
	a.mongoPools.CloseAll()
	a.sshSessions.CloseAll()
	a.sftpTransfers.CancelAll()
	a.sftpBrowse.CloseAll()
	// Fuera del grupo SSH: no toma leases del pool compartido, lo que cierra
	// son procesos de esta máquina. Sin esto quedan shells huérfanas
	// corriendo después de cerrar la ventana.
	if a.approve != nil {
		_ = a.approve.Close()
	}
	if a.localTerms != nil {
		a.localTerms.CloseAll()
	}
	// LAST of the SSH group: the three above hold leases on the shared
	// connections, and the pool only drops a connection once its last
	// holder lets go. Closing it first would leave them releasing leases on
	// a pool that no longer has the entry.
	a.sshPool.CloseAll()
	// Los temporales con el cuerpo completo de las respuestas grandes: se
	// borran al salir, no antes. Mientras una pestaña muestra una respuesta
	// cortada, su botón «Guardar…» promete ese archivo.
	if a.httpRunner != nil {
		a.httpRunner.CleanSpills()
	}
	a.gate.Lock()
	if a.vault != nil {
		_ = a.vault.Close()
	}
}

// requireUnlocked is the gate check every method below the vault lifecycle
// must call first — enforced here in Go, not just in the UI, so there is no
// bypass. See .claude/rules/technical.md point 5.
func (a *App) requireUnlocked() error {
	if !a.gate.Unlocked() {
		return vaultgate.ErrLocked
	}
	return nil
}

// IsVaultInitialized reports whether a master password has already been set
// for this install.
func (a *App) IsVaultInitialized() (bool, error) {
	return a.vault.IsInitialized()
}

// InitializeVault sets the master password on first run and unlocks the
// vault in memory.
func (a *App) InitializeVault(password string) error {
	return a.vault.Initialize(password)
}

// UnlockVault verifies the master password against the stored verifier and
// unlocks the vault in memory on success.
func (a *App) UnlockVault(password string) error {
	return a.vault.Unlock(password)
}

// TryAutoUnlock attempts to unlock the vault using a key previously saved to
// the OS keychain (the "Recordar clave" toggle, see SetRememberMasterKey) —
// called once at startup, before UnlockScreen would otherwise be shown. No
// requireUnlocked guard: this runs precisely while still locked. Every
// failure mode degrades to (false, nil) rather than surfacing an error —
// see Store.TryAutoUnlock's doc comment.
func (a *App) TryAutoUnlock() (bool, error) {
	return a.vault.TryAutoUnlock()
}

// SetRememberMasterKey enables or disables auto-unlock via the OS keychain.
// Requires the vault to be unlocked when enabling (it saves the current
// session's key) — see Store.SetRememberMasterKey.
func (a *App) SetRememberMasterKey(enabled bool) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetRememberMasterKey(enabled)
}

// GetSettings and SetTheme intentionally skip requireUnlocked — the settings
// table holds no sensitive data (see the comment on it in
// backend/vault/store.go), and gating the theme behind the master password
// would force a jarring theme flash on the unlock screen for no security
// benefit. The gate exists to protect encrypted_dsn/query data, not cosmetic
// prefs.
func (a *App) GetSettings() (vault.Settings, error) {
	return a.vault.GetSettings()
}

// SetTheme persists the theme preference ("dark" or "light").
func (a *App) SetTheme(theme string) error {
	return a.vault.SetTheme(theme)
}

// AppVersion returns the app's semantic version, stamped at build time via
// -ldflags "-X main.appVersion=..." (see scripts/build.sh, VERSION is the
// source of truth). Returns "dev" for an unstamped build (e.g. `wails dev`).
// No requireUnlocked — it's not sensitive, and Configuración shows it.
func (a *App) AppVersion() string {
	return appVersion
}

// SetOpenTabs persists which editor tabs (path plus optional
// connection/language binding) are currently open, so Workspace.tsx can
// restore them on the next launch. Gated behind requireUnlocked — unlike
// GetSettings/SetTheme, this is only ever called during active use (after
// unlock), never from the lock screen.
func (a *App) SetOpenTabs(tabs []vault.OpenTabInfo) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetOpenTabs(tabs)
}

// SetSidebarCollapsed persists the connection tree's icon-only rail toggle.
// Gated behind requireUnlocked like SetOpenTabs — the sidebar it describes
// only exists in the post-unlock Workspace, never on the lock screen.
func (a *App) SetSidebarCollapsed(collapsed bool) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetSidebarCollapsed(collapsed)
}

// SetEditorHeight persists the SQL editor pane's height (px) after the user
// drags the resize handle between the editor and the results grid. Same
// requireUnlocked reasoning as SetSidebarCollapsed.
func (a *App) SetEditorHeight(height int) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetEditorHeight(height)
}

// SetEditorTheme persists the CodeMirror color theme id. Gated behind
// requireUnlocked like SetEditorHeight/SetSidebarCollapsed — unlike the
// app-wide dark/light Theme (see GetSettings/SetTheme's doc comment), this
// only ever affects the post-unlock Workspace's editor, never the lock
// screen, so there's no "flash of the wrong theme" reason to exempt it.
func (a *App) SetEditorTheme(theme string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetEditorTheme(theme)
}

// SetSshTerminalTheme persists the xterm.js color theme id. Gated behind
// requireUnlocked like SetEditorTheme — the SSH terminal only ever exists
// in the post-unlock Workspace, never the lock screen.
func (a *App) SetSshTerminalTheme(theme string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetSshTerminalTheme(theme)
}

// refreshAutoBackupScheduler re-reads settings and hands the current
// enabled/interval/folder to a.autoBackup — called after each
// SetAutoBackup*/PickAutoBackupFolder succeeds, instead of threading the one
// field that just changed by hand, so the scheduler is always driven by the
// same row it would read on the app's next startup anyway.
func (a *App) refreshAutoBackupScheduler() {
	settings, err := a.vault.GetSettings()
	if err != nil {
		return
	}
	a.autoBackup.Reconfigure(settings.AutoBackupEnabled, settings.AutoBackupIntervalHours, settings.AutoBackupPath)
}

// SetAutoBackupEnabled turns the vault's automatic backup scheduler
// (backend/autobackup) on or off. Gated behind requireUnlocked for flow
// consistency — same reasoning as SetRememberMasterKey: it's only ever
// invoked from inside SettingsDialog, already authenticated, not because
// the flag itself is sensitive. The scheduler's own tick does NOT re-check
// requireUnlocked (see backend/vault/backup.go: Backup only copies
// already-encrypted bytes, it doesn't decrypt anything).
func (a *App) SetAutoBackupEnabled(enabled bool) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if err := a.vault.SetAutoBackupEnabled(enabled); err != nil {
		return err
	}
	a.refreshAutoBackupScheduler()
	return nil
}

// SetAutoBackupIntervalHours persists how often the automatic backup runs
// (1-23, validated in vault.Store.SetAutoBackupIntervalHours) and
// reconfigures the live scheduler.
func (a *App) SetAutoBackupIntervalHours(hours int) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if err := a.vault.SetAutoBackupIntervalHours(hours); err != nil {
		return err
	}
	a.refreshAutoBackupScheduler()
	return nil
}

// SetAutoSaveEnabled persists the "Auto-guardar editores" toggle. No scheduler
// to reconfigure — the auto-save timer runs in the frontend (Workspace.tsx),
// this only records the preference.
func (a *App) SetAutoSaveEnabled(enabled bool) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetAutoSaveEnabled(enabled)
}

// SetAutoSaveIntervalSeconds persists the auto-save cadence (validated in
// vault.Store.SetAutoSaveIntervalSeconds).
func (a *App) SetAutoSaveIntervalSeconds(seconds int) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetAutoSaveIntervalSeconds(seconds)
}

// PickAutoBackupFolder opens a native folder picker for the automatic
// backup's destination; if the user confirms (doesn't cancel), persists the
// folder and reconfigures the scheduler. Returns "" without an error if the
// user cancels — same convention as PickVaultBackupFile.
func (a *App) PickAutoBackupFolder() (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}

	dir, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title:                "Elegir carpeta para el backup automático del vault",
		CanCreateDirectories: true,
	})
	if err != nil {
		return "", fmt.Errorf("app: abriendo diálogo de carpeta: %w", err)
	}
	if dir == "" {
		return "", nil
	}

	if err := a.vault.SetAutoBackupPath(dir); err != nil {
		return "", err
	}
	a.refreshAutoBackupScheduler()
	return dir, nil
}

// CheckForUpdate compares this build's version against the VERSION file
// published in the repo — see backend/updatecheck's package doc for the
// full read-only contract. Deliberately skips requireUnlocked and never
// touches a.vault: it has to work the same whether the vault is locked,
// unlocked, or (hypothetically) broken, since it's purely a network read
// against GitHub, unrelated to vault.db.
func (a *App) CheckForUpdate() updatecheck.Info {
	return updatecheck.Check(appVersion)
}

// PickSQLiteFile opens the native file picker for a SQLite/SQLCipher database
// and returns the chosen path (or "" if cancelled), so the connection dialog
// does not force the user to type the path by hand.
func (a *App) PickSQLiteFile() (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Elegir base SQLite",
		Filters: []runtime.FileFilter{
			{DisplayName: "SQLite / SQLCipher (*.db;*.sqlite;*.sqlite3;*.db3)", Pattern: "*.db;*.sqlite;*.sqlite3;*.db3"},
			{DisplayName: "Todos los archivos", Pattern: "*.*"},
		},
	})
}

// DetectSQLiteEncryption reports whether the file at path looks like a
// SQLCipher-encrypted database, so the dialog can pre-set the "Base cifrada"
// toggle when a file is picked or its path typed. It only reads the file's
// first 16 bytes and never touches the key — see sqlcipher.LooksEncrypted.
//
// A missing/unreadable path returns false with no error: the file may just not
// exist yet (a new SQLite DB is created on first connect), which is not a
// detection failure the UI should surface.
func (a *App) DetectSQLiteEncryption(path string) (bool, error) {
	if err := a.requireUnlocked(); err != nil {
		return false, err
	}
	if path == "" {
		return false, nil
	}
	enc, err := sqlcipher.LooksEncrypted(path)
	if err != nil {
		return false, nil
	}
	return enc, nil
}

// TestConnection builds a DSN from cfg and pings it, without saving
// anything. Used by the "Test Connection" button before a connection is
// persisted.
func (a *App) TestConnection(cfg ConnectionInput) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}

	dbType := db.DBType(cfg.DBType)
	connector, err := db.ConnectorFor(dbType)
	if err != nil {
		return err
	}

	dsn, err := connector.BuildDSN(cfg.Params)
	if err != nil {
		return err
	}

	return pingDSN(dbType, dsn)
}

// pingDSN dispatches to the right ping implementation for dbType — Redis is
// not a database/sql driver, so it needs its own short-lived-client path
// (db.PingRedisDSN) instead of db.Ping's sql.Open-based one.
func pingDSN(dbType db.DBType, dsn string) error {
	if dbType == db.DBTypeRedis {
		return db.PingRedisDSN(dsn)
	}
	if dbType == db.DBTypeMongo {
		return db.PingMongoDSN(dsn)
	}
	if dbType == db.DBTypeSSH {
		return sshconn.PingSSHDSN(dsn)
	}
	return db.Ping(dbType, dsn)
}

// ListSchemasForNewConnection builds a DSN from cfg (same as TestConnection)
// and lists its visible schemas without saving the connection or requiring
// a connID — lets ConnectionDialog.tsx offer the "which schemas should
// autocomplete scan" picker right after a successful Test Connection, at
// creation time, instead of only after the connection is already saved
// (see ListSchemas for that path). Postgres and Oracle, same as ListSchemas
// — nil for SQLite, which has nothing to restrict.
func (a *App) ListSchemasForNewConnection(cfg ConnectionInput) ([]string, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}

	dbType := db.DBType(cfg.DBType)
	connector, err := db.ConnectorFor(dbType)
	if err != nil {
		return nil, err
	}

	dsn, err := connector.BuildDSN(cfg.Params)
	if err != nil {
		return nil, err
	}

	return db.ListSchemasForDSN(a.ctx, dbType, dsn)
}

// SaveConnection builds a DSN from cfg, encrypts it, and persists it. Unless
// force is true, it first pings the DSN and fails without saving if the
// ping fails — matching the spec's "sin ping ok → warning, guarda igual si
// usuario fuerza".
func (a *App) SaveConnection(cfg ConnectionInput, force bool) (*vault.ConnectionSummary, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}

	dbType := db.DBType(cfg.DBType)
	connector, err := db.ConnectorFor(dbType)
	if err != nil {
		return nil, err
	}

	dsn, err := connector.BuildDSN(cfg.Params)
	if err != nil {
		return nil, err
	}

	if !force {
		if err := pingDSN(dbType, dsn); err != nil {
			return nil, fmt.Errorf("ping falló (guarda con force=true para omitir): %w", err)
		}
	}

	return a.vault.SaveConnection(cfg.Name, dbType, dsn, cfg.Color, cfg.Environment)
}

// ConnectionEditInfo pre-fills the "editar conexión" form. Params never
// includes "password" — see .claude/rules/technical.md point 9 — so the
// dialog shows it blank; leaving it blank on save means "keep the existing
// password" (see UpdateConnection), not "set an empty password".
type ConnectionEditInfo struct {
	Name        string            `json:"name"`
	DBType      string            `json:"dbType"`
	Params      map[string]string `json:"params"`
	Color       string            `json:"color"`
	Environment string            `json:"environment"`
}

// GetConnectionForEdit decrypts id's saved DSN and parses it back into the
// same params shape ConnectionDialog.tsx already builds for
// TestConnection/SaveConnection, minus the password.
func (a *App) GetConnectionForEdit(id string) (*ConnectionEditInfo, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}

	conns, err := a.vault.ListConnections()
	if err != nil {
		return nil, err
	}
	var name, color, environment string
	found := false
	for _, c := range conns {
		if c.ID == id {
			name = c.Name
			color = c.Color
			environment = c.Environment
			found = true
			break
		}
	}
	if !found {
		return nil, fmt.Errorf("app: conexión %q no encontrada", id)
	}

	dbType, dsn, err := a.vault.ConnectionDSN(id)
	if err != nil {
		return nil, err
	}
	connector, err := db.ConnectorFor(dbType)
	if err != nil {
		return nil, err
	}
	params, err := connector.ParseDSN(dsn)
	if err != nil {
		return nil, err
	}
	delete(params, "password")
	// SSH-specific credential material — same "never reaches the frontend"
	// treatment as password (.claude/rules/technical.md point 9). No-op for
	// every other engine, whose params never have these keys.
	delete(params, "privateKey")
	delete(params, "passphrase")
	// The SQLCipher key is a credential too; strip it like a password. The
	// dialog re-shows the "encrypted" toggle from the marker below and leaves
	// the key field blank — blank on save means "keep the existing key".
	if _, encrypted := params["sqlcipher_key"]; encrypted {
		delete(params, "sqlcipher_key")
		// A non-secret marker so the edit form knows to show the key field as
		// already-set, the same way a password field shows as "unchanged".
		params["sqlcipher_encrypted"] = "1"
	}

	return &ConnectionEditInfo{Name: name, DBType: string(dbType), Params: params, Color: color, Environment: environment}, nil
}

// UpdateConnection rebuilds id's DSN from cfg and overwrites the saved
// connection in place. A blank cfg.Params["password"] means "keep the
// existing password" — the frontend never had the real one to resubmit in
// the first place (see GetConnectionForEdit) — so it's filled in here from
// the connection's current DSN before rebuilding. Closes any open pool and
// drops cached metadata for id afterward, since the target this connID
// points at may have changed.
// RevealConnectionPassword devuelve en claro la contraseña guardada de una
// conexión, después de reconfirmar la clave maestra.
//
// Es una excepción deliberada y acotada a la regla de ConnectionDSN ("este
// valor nunca sale hacia el frontend"), y vale la pena decir por qué no la
// contradice:
//
//   - Devuelve SOLO el parámetro `password`, nunca el DSN armado. El resto de
//     lo que lleva el DSN (host, puerto, usuario, llave privada inline) no sale
//     por acá.
//   - Quien puede llamarla ya tiene el vault abierto, y con el vault abierto ya
//     podía conectarse a ese servidor. No abre una puerta que estuviera
//     cerrada: recupera un dato que es del usuario y que él mismo guardó.
//   - Aun así pide la clave maestra de nuevo (VerifyPassword, el mismo gesto
//     que exige el backup del vault), porque "la app quedó abierta" y "quiero
//     ver esta contraseña" no son la misma decisión.
//
// La llave privada de una conexión por key NO se expone por acá: un `.pem`
// entero es material de otra escala, y para eso está el gestor central de
// llaves.
func (a *App) RevealConnectionPassword(id string, masterPassword string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	if err := a.vault.VerifyPassword(masterPassword); err != nil {
		return "", err
	}

	dbType, dsn, err := a.vault.ConnectionDSN(id)
	if err != nil {
		return "", err
	}
	connector, err := db.ConnectorFor(dbType)
	if err != nil {
		return "", err
	}
	params, err := connector.ParseDSN(dsn)
	if err != nil {
		return "", err
	}
	return params["password"], nil
}

func (a *App) UpdateConnection(id string, cfg ConnectionInput, force bool) (*vault.ConnectionSummary, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}

	dbType := db.DBType(cfg.DBType)
	connector, err := db.ConnectorFor(dbType)
	if err != nil {
		return nil, err
	}

	// A blank password (and, for SSH, privateKey/passphrase) means "keep the
	// existing one" — GetConnectionForEdit never returns credential
	// material to the frontend, so the form always submits it blank unless
	// the user typed a new value. For SSH only the fields the currently
	// selected auth method actually uses are merged — switching from
	// password to key auth (or back) shouldn't carry the other method's
	// now-irrelevant stale credential forward into the rebuilt DSN.
	sshKeyAuth := dbType == db.DBTypeSSH && cfg.Params["auth"] == db.SSHAuthKey
	needsPasswordMerge := !sshKeyAuth && cfg.Params["password"] == ""
	// A connection pointing at a stored key has no inline material to merge:
	// merging the previous DSN's privateKey back in would silently re-inline
	// the old key and defeat the whole point of the central store.
	usesStoredKey := sshKeyAuth && cfg.Params["keyId"] != ""
	needsKeyMerge := sshKeyAuth && !usesStoredKey && (cfg.Params["privateKey"] == "" || cfg.Params["passphrase"] == "")
	// An encrypted SQLite edited with a blank key field but the "encrypted"
	// toggle still on means "keep the existing SQLCipher key" — same rule as a
	// blank password. The marker distinguishes it from turning encryption off
	// (toggle off → no merge, the key is intentionally dropped).
	needsSqlcipherMerge := dbType == db.DBTypeSQLite && cfg.Params["sqlcipher_encrypted"] == "1" && cfg.Params["sqlcipher_key"] == ""
	if needsPasswordMerge || needsKeyMerge || needsSqlcipherMerge {
		if _, existingDSN, err := a.vault.ConnectionDSN(id); err == nil {
			if existingParams, err := connector.ParseDSN(existingDSN); err == nil {
				if needsPasswordMerge {
					cfg.Params["password"] = existingParams["password"]
				}
				if needsSqlcipherMerge {
					cfg.Params["sqlcipher_key"] = existingParams["sqlcipher_key"]
				}
				if needsKeyMerge {
					if cfg.Params["privateKey"] == "" {
						cfg.Params["privateKey"] = existingParams["privateKey"]
					}
					if cfg.Params["passphrase"] == "" {
						cfg.Params["passphrase"] = existingParams["passphrase"]
					}
				}
			}
		}
	}
	// The marker is a UI-only flag, never a DSN param — drop it before BuildDSN
	// so it does not leak into the stored DSN.
	delete(cfg.Params, "sqlcipher_encrypted")

	dsn, err := connector.BuildDSN(cfg.Params)
	if err != nil {
		return nil, err
	}

	if !force {
		if err := pingDSN(dbType, dsn); err != nil {
			return nil, fmt.Errorf("ping falló (guarda con force=true para omitir): %w", err)
		}
	}

	if err := a.vault.UpdateConnection(id, cfg.Name, dbType, dsn, cfg.Color, cfg.Environment); err != nil {
		return nil, err
	}

	a.rollbackIfOpen(id)
	if err := a.pools.Close(id); err != nil {
		return nil, err
	}
	// Harmless no-op on whichever pool/session manager doesn't actually own
	// id — closing all three unconditionally means callers never need to
	// know which engine id used to be before this update.
	// A reserved transaction connection and a live monitor's connection
	// were both checked OUT of the pool, so Close never reaches them.
	if a.redisExecutor != nil {
		a.redisExecutor.Transactions().Release(a.ctx, id)
	}
	if err := a.redisPools.Close(id); err != nil {
		return nil, err
	}
	if err := a.mongoPools.Close(id); err != nil {
		return nil, err
	}
	if err := a.sshSessions.Close(id); err != nil {
		return nil, err
	}
	a.dropCachedMetadata(id)
	// The DSN may now point at a different database entirely — both
	// persisted caches (tables and the schema name list) could reflect a
	// target that no longer exists behind this connID.
	if err := a.vault.DeleteSchemaMetadataCache(id); err != nil {
		return nil, err
	}
	if err := a.vault.DeleteSchemaListCache(id); err != nil {
		return nil, err
	}
	if err := a.vault.DeleteMongoCollectionCache(id); err != nil {
		return nil, err
	}

	conns, err := a.vault.ListConnections()
	if err != nil {
		return nil, err
	}
	for _, c := range conns {
		if c.ID == id {
			return &c, nil
		}
	}
	return nil, fmt.Errorf("app: conexión %q no encontrada después de actualizar", id)
}

// ListConnections returns every saved connection, without DSNs, for the
// sidebar tree.
func (a *App) ListConnections() ([]vault.ConnectionSummary, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.ListConnections()
}

// ListFolders returns every folder (flat) for the sidebar's connection
// tree — see vault.Folder and frontend/src/lib/folderTree.ts.
func (a *App) ListFolders() ([]vault.Folder, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.ListFolders()
}

// CreateFolder creates a new folder, optionally nested under parentID ("" =
// root), scoped to "db" or "ssh" (vault.Folder.Scope) — keeps SSH
// connections' folder tree entirely independent of DB connections'.
func (a *App) CreateFolder(name, parentID, scope string) (*vault.Folder, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.CreateFolder(name, parentID, scope)
}

// RenameFolder updates a folder's display name.
func (a *App) RenameFolder(id, name string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.RenameFolder(id, name)
}

// MoveFolder reparents a folder under newParentID ("" = root).
func (a *App) MoveFolder(id, newParentID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.MoveFolder(id, newParentID)
}

// ReorderFolder moves a folder one slot "up" or "down" among its siblings.
func (a *App) ReorderFolder(id, direction string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.ReorderFolder(id, direction)
}

// DeleteFolder removes a folder — its subfolders and connections are
// reparented to its own parent, never deleted (see vault.Store.DeleteFolder).
func (a *App) DeleteFolder(id string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.DeleteFolder(id)
}

// MoveConnectionToFolder re-organizes a saved connection under a different
// folder ("" = root).
func (a *App) MoveConnectionToFolder(connID, folderID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.MoveConnectionToFolder(connID, folderID)
}

// SetEditorAppearance persists how the editors render — font, size, line
// wrapping, gutter, tab width and whether the action row is shown. One call
// for the whole group: the settings dialog edits them together and every
// editor reads them together, so splitting it into six bindings would only
// mean six chances for them to get out of sync.
func (a *App) SetEditorAppearance(appearance vault.EditorAppearance) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetEditorAppearance(appearance)
}

// SetUIFontScale persiste el tamaño de letra de TODA la interfaz, en
// porcentaje (100 = el de siempre, 0 = sin elegir).
//
// Aparte de SetEditorAppearance a propósito: aquello es el cuerpo del EDITOR,
// que se elige para leer código y responde a otra cosa. Esto es la interfaz —
// listas, menús, diálogos, etiquetas—, y quien necesita agrandarla no
// necesariamente quiere tocar el editor.
//
// **Sin requireUnlocked, igual que SetTheme.** La pantalla de desbloqueo es
// interfaz: si el ajuste solo valiera con el vault abierto, quien no puede
// leer la app tampoco podría leer el formulario que le pide la clave para
// arreglarlo. Es una preferencia visual sin nada sensible adentro, y la tabla
// `settings` es legible y escribible con el vault cerrado por diseño (ver el
// comentario de la tabla en backend/vault/store.go).
func (a *App) SetUIFontScale(pct int) error {
	return a.vault.SetUIFontScale(pct)
}

// SetSidebarWidth persists the sidebar's dragged width. Called once on
// mouseup, not per pointer move — the vault write has no reason to keep up
// with the pointer, only to record where it stopped.
func (a *App) SetSidebarWidth(px int) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetSidebarWidth(px)
}

// SetSidebarModule persists which sidebar module the master menu has open,
// so the next launch reopens the one that was in use instead of always
// landing on the connection tree.
func (a *App) SetSidebarModule(id string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetSidebarModule(id)
}

// DeleteConnection closes any open pool for id and removes it from the
// vault.
func (a *App) DeleteConnection(id string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	a.rollbackIfOpen(id)
	if err := a.pools.Close(id); err != nil {
		return err
	}
	// A reserved transaction connection and a live monitor's connection
	// were both checked OUT of the pool, so Close never reaches them.
	if a.redisExecutor != nil {
		a.redisExecutor.Transactions().Release(a.ctx, id)
	}
	if err := a.redisPools.Close(id); err != nil {
		return err
	}
	if err := a.mongoPools.Close(id); err != nil {
		return err
	}
	if err := a.sshSessions.Close(id); err != nil {
		return err
	}
	if err := a.vault.DeleteSchemaMetadataCache(id); err != nil {
		return err
	}
	if err := a.vault.DeleteSchemaListCache(id); err != nil {
		return err
	}
	if err := a.vault.DeleteMongoCollectionCache(id); err != nil {
		return err
	}
	// The in-memory metadata and the compiled completion index were left
	// behind here before: harmless while nothing else read them, but an
	// editor tab still bound to the deleted connection would have kept
	// autocompleting against its schema for the rest of the session.
	a.dropCachedMetadata(id)
	return a.vault.DeleteConnection(id)
}

// DisconnectConnection closes id's open pool and drops its cached schema
// metadata, but — unlike DeleteConnection — keeps the saved connection in
// the vault. Safe to call on a connection that was never opened (Close is a
// no-op then). The next query/metadata fetch against id lazily reopens the
// pool via ensurePoolOpen, same as a fresh connect.
func (a *App) DisconnectConnection(id string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	a.rollbackIfOpen(id)
	if err := a.pools.Close(id); err != nil {
		return err
	}
	// A reserved transaction connection and a live monitor's connection
	// were both checked OUT of the pool, so Close never reaches them.
	if a.redisExecutor != nil {
		a.redisExecutor.Transactions().Release(a.ctx, id)
	}
	if err := a.redisPools.Close(id); err != nil {
		return err
	}
	if err := a.mongoPools.Close(id); err != nil {
		return err
	}
	if err := a.sshSessions.Close(id); err != nil {
		return err
	}
	a.dropCachedMetadata(id)
	return nil
}

// rollbackIfOpen releases id's reserved transaction connection, if any,
// before its pool gets closed — otherwise that connection would leak
// (sql.DB.Close doesn't reach into connections callers already checked out
// via pool.Conn and never returned). Best-effort: closing the connection
// underneath a pending transaction makes ROLLBACK academic anyway (nothing
// was going to get committed), so a failure here isn't worth surfacing —
// same "don't let cleanup hide the real result" precedent as
// fetchDBMSOutput's best-effort read.
func (a *App) rollbackIfOpen(connID string) {
	if a.executor.HasOpenTransaction(connID) {
		_ = a.executor.RollbackTransaction(a.ctx, connID)
	}
}

// ensurePoolOpen returns connID's pool, opening it from the vault's
// decrypted DSN first if it isn't already open. Shared by ExecuteQuery and
// GetSchemaMetadata so both lazily connect the same way.
func (a *App) ensurePoolOpen(connID string) error {
	if _, err := a.pools.Get(connID); err == nil {
		return nil
	}

	dbType, dsn, err := a.vault.ConnectionDSN(connID)
	if err != nil {
		return err
	}
	_, err = a.pools.Open(connID, dbType, dsn)
	return err
}

// ensureRedisPoolOpen is ensurePoolOpen's counterpart for Redis's
// RedisPoolManager — shared by ExecuteRedisCommand and every keyspace
// binding below so they all lazily connect the same way.
func (a *App) ensureRedisPoolOpen(connID string) error {
	if _, err := a.redisPools.Get(connID); err == nil {
		return nil
	}

	_, dsn, err := a.vault.ConnectionDSN(connID)
	if err != nil {
		return err
	}
	_, err = a.redisPools.Open(connID, dsn)
	return err
}

// ExecuteQuery opens (or reuses) the pool for connID and streams the result
// of sqlText back as events under queryID. The frontend must call
// EventsOn(queryID, ...) before invoking this — see
// .claude/skills/mini-tools-patterns/SKILL.md. captureDBMSOutput is the
// toolbar's "DBMS_OUTPUT" toggle — ignored outside Oracle PL/SQL blocks.
func (a *App) ExecuteQuery(connID, queryID, sqlText string, captureDBMSOutput bool, params []query.ParamValue) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if err := a.ensurePoolOpen(connID); err != nil {
		return err
	}

	a.executor.Execute(connID, queryID, sqlText, captureDBMSOutput, params)
	return nil
}

// DetectQueryParams lists the bind placeholders sqlText declares, so the
// frontend can ask for their values before running it. Which syntaxes count
// depends on the connection's engine, which is why this needs connID and
// cannot be answered in the frontend — see backend/query/params.go.
//
// An empty result means "run it as-is": the dialog is only shown when there
// is something to fill in.
func (a *App) DetectQueryParams(connID, sqlText string) ([]query.Param, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	dbType, err := a.vault.ConnectionDBType(connID)
	if err != nil {
		return nil, err
	}
	params := query.ExtractParams(sqlText, dbType)
	if params == nil {
		// Wails marshals a nil slice as null; the frontend wants a list it
		// can check the length of without a null guard at every call site.
		params = []query.Param{}
	}
	return params, nil
}

// CancelQuery cancels the in-flight query registered under queryID, if any.
func (a *App) CancelQuery(queryID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	a.executor.Cancel(queryID)
	return nil
}

// SetQueryPageSize cambia cuántas filas trae cada página de resultados y lo
// deja guardado como preferencia. 0 = "All" (sin paginar). Aplica desde la
// próxima página/consulta; los resultados ya en pantalla no se re-consultan.
func (a *App) SetQueryPageSize(n int) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if err := a.vault.SetQueryPageSize(n); err != nil {
		return err
	}
	a.executor.SetPageSize(n)
	return nil
}

// FetchMoreRows delivers the next page of a SELECT whose result set was paused
// after the first page (see backend/query/paging.go). Results arrive as the
// same streamed events the first page used, under the same queryID, so the
// frontend appends them to the tab that is already open.
func (a *App) FetchMoreRows(queryID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	a.executor.FetchMore(queryID)
	return nil
}

// ReleasePagedResult drops a paused result set the frontend no longer needs
// (tab closed, result discarded), returning the pooled connection its open
// cursor was holding.
func (a *App) ReleasePagedResult(queryID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	a.executor.CancelPaging(queryID)
	return nil
}

// ExecuteRedisCommand opens (or reuses) the Redis client for connID and
// streams the result of commandText back as events under queryID — same
// request/response-plus-streamed-events contract as ExecuteQuery, but for
// Redis's own one-command-per-line syntax instead of SQL (see
// backend/redisquery).
func (a *App) ExecuteRedisCommand(connID, queryID, commandText string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if err := a.ensureRedisPoolOpen(connID); err != nil {
		return err
	}

	a.redisExecutor.Execute(connID, queryID, commandText)
	return nil
}

// CancelRedisCommand cancels the in-flight Redis command script registered
// under queryID, if any.
func (a *App) CancelRedisCommand(queryID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	a.redisExecutor.Cancel(queryID)
	return nil
}

// ensureMongoPoolOpen is ensurePoolOpen's counterpart for MongoDB's
// MongoPoolManager — shared by every Mongo binding so they all lazily connect
// the same way.
func (a *App) ensureMongoPoolOpen(connID string) error {
	if _, err := a.mongoPools.Get(connID); err == nil {
		return nil
	}
	_, dsn, err := a.vault.ConnectionDSN(connID)
	if err != nil {
		return err
	}
	_, err = a.mongoPools.Open(connID, dsn)
	return err
}

// mongoClientFor unlocks the vault, ensures connID's Mongo client is open, and
// returns it — shared by every metadata/document binding below.
func (a *App) mongoClientFor(connID string) (*mongo.Client, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	if err := a.ensureMongoPoolOpen(connID); err != nil {
		return nil, err
	}
	return a.mongoPools.Get(connID)
}

// mongoOpCtx derives a bounded context for a one-shot metadata/document
// operation (not the streaming executor, which uses its own cancelable ctx).
func (a *App) mongoOpCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(a.ctx, 30*time.Second)
}

// ExecuteMongoQuery opens (or reuses) the Mongo client for connID and streams
// the result of commandText (mongosh-style db.<coll>.<method>(...) commands)
// back as events under queryID. database is the "current db" the `db` prefix
// refers to — MongoDB browses many, so the frontend passes the active one.
func (a *App) ExecuteMongoQuery(connID, queryID, database, commandText string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if err := a.ensureMongoPoolOpen(connID); err != nil {
		return err
	}
	a.mongoExecutor.Execute(connID, queryID, database, commandText)
	return nil
}

// CancelMongoQuery cancels the in-flight Mongo command script under queryID.
func (a *App) CancelMongoQuery(queryID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	a.mongoExecutor.Cancel(queryID)
	return nil
}

// GetMongoDefaultDatabase returns the database named in connID's DSN (if any),
// so the editor/sidebar can pick a sensible initial "current database" before
// the user browses others.
func (a *App) GetMongoDefaultDatabase(connID string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	_, dsn, err := a.vault.ConnectionDSN(connID)
	if err != nil {
		return "", err
	}
	connector, err := db.ConnectorFor(db.DBTypeMongo)
	if err != nil {
		return "", err
	}
	params, err := connector.ParseDSN(dsn)
	if err != nil {
		return "", err
	}
	return params["database"], nil
}

// ListMongoDatabases lists every database on connID's server (sidebar top level).
func (a *App) ListMongoDatabases(connID string) ([]db.MongoDatabaseInfo, error) {
	client, err := a.mongoClientFor(connID)
	if err != nil {
		return nil, err
	}
	ctx, cancel := a.mongoOpCtx()
	defer cancel()
	return db.ListMongoDatabases(ctx, client)
}

// ListMongoCollections lists the collections/views of one database. Unless
// forceRefresh is set, it returns the SQLite-cached list (mongo_collection_cache)
// when present — listing collections fans out an EstimatedDocumentCount per
// collection, slow on a database with many. forceRefresh (the tree's sync
// button) bypasses the cache, re-queries the server, and re-caches. A cache hit
// never opens the Mongo pool, so re-expanding a database is instant.
func (a *App) ListMongoCollections(connID, database string, forceRefresh bool) ([]db.MongoCollectionInfo, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	if !forceRefresh {
		if cached, ok, _ := a.vault.GetMongoCollectionCache(connID, database); ok {
			var cols []db.MongoCollectionInfo
			if err := json.Unmarshal([]byte(cached), &cols); err == nil {
				return cols, nil
			}
		}
	}

	if err := a.ensureMongoPoolOpen(connID); err != nil {
		return nil, err
	}
	client, err := a.mongoPools.Get(connID)
	if err != nil {
		return nil, err
	}
	ctx, cancel := a.mongoOpCtx()
	defer cancel()
	cols, err := db.ListMongoCollections(ctx, client, database)
	if err != nil {
		return nil, err
	}
	if data, err := json.Marshal(cols); err == nil {
		_ = a.vault.SaveMongoCollectionCache(connID, database, string(data))
	}
	return cols, nil
}

// GetMongoIndexes lists the indexes of one collection.
func (a *App) GetMongoIndexes(connID, database, collection string) ([]db.MongoIndex, error) {
	client, err := a.mongoClientFor(connID)
	if err != nil {
		return nil, err
	}
	ctx, cancel := a.mongoOpCtx()
	defer cancel()
	return db.GetMongoIndexes(ctx, client, database, collection)
}

// SampleMongoFields discovers a collection's field paths by reading a sample
// of its documents, so the query wizard can autocomplete real field names
// (nested ones included) instead of asking the user to remember them.
//
// MongoDB has no catalog to ask, which is why this samples documents rather
// than reading metadata like the SQL engines do. The result carries how
// often each path appeared and which BSON types were seen there — both
// matter to the user: a field in 3% of documents is worth offering but not
// worth ranking first, and a path holding both string and int is a trap
// worth seeing BEFORE writing a filter against it.
func (a *App) SampleMongoFields(connID, database, collection string) ([]db.MongoFieldInfo, error) {
	client, err := a.mongoClientFor(connID)
	if err != nil {
		return nil, err
	}
	ctx, cancel := a.mongoOpCtx()
	defer cancel()
	return db.SampleMongoFields(ctx, client, database, collection, 0)
}

// ListMongoDocuments returns a page of a collection's documents (Extended JSON),
// optionally filtered — feeds the browser panel.
func (a *App) ListMongoDocuments(connID, database, collection, filterJSON string, skip, limit int64) ([]string, error) {
	client, err := a.mongoClientFor(connID)
	if err != nil {
		return nil, err
	}
	ctx, cancel := a.mongoOpCtx()
	defer cancel()
	return db.ListMongoDocuments(ctx, client, database, collection, filterJSON, skip, limit)
}

// CountMongoDocuments returns the exact count matching filterJSON.
func (a *App) CountMongoDocuments(connID, database, collection, filterJSON string) (int64, error) {
	client, err := a.mongoClientFor(connID)
	if err != nil {
		return 0, err
	}
	ctx, cancel := a.mongoOpCtx()
	defer cancel()
	return db.CountMongoDocuments(ctx, client, database, collection, filterJSON)
}

// ReplaceMongoDocument replaces a whole document (identified by its own _id).
func (a *App) ReplaceMongoDocument(connID, database, collection, docJSON string) error {
	client, err := a.mongoClientFor(connID)
	if err != nil {
		return err
	}
	ctx, cancel := a.mongoOpCtx()
	defer cancel()
	return db.ReplaceMongoDocument(ctx, client, database, collection, docJSON)
}

// DeleteMongoDocument deletes the document whose _id is inside docJSON.
func (a *App) DeleteMongoDocument(connID, database, collection, docJSON string) error {
	client, err := a.mongoClientFor(connID)
	if err != nil {
		return err
	}
	ctx, cancel := a.mongoOpCtx()
	defer cancel()
	return db.DeleteMongoDocument(ctx, client, database, collection, docJSON)
}

// OpenSSHTerminal decrypts connID's saved DSN and opens an interactive
// PTY-backed shell against it, sized to cols x rows. The frontend must call
// EventsOn(connID, ...) BEFORE this — connID doubles as the Wails event
// name streaming Event{Type:"data"} chunks back (see sshconn.Event), same
// race-avoidance pattern as ExecuteQuery/ExecuteRedisCommand's queryID.
func (a *App) OpenSSHTerminal(connID string, cols, rows int) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	dsn, err := a.sshDSN(connID)
	if err != nil {
		return err
	}
	return a.sshSessions.Open(connID, dsn, cols, rows)
}

// WriteSSHTerminal forwards data (keystrokes/paste from xterm.js) to
// connID's open shell stdin.
func (a *App) WriteSSHTerminal(connID, data string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.sshSessions.Write(connID, data)
}

// ResizeSSHTerminal reflows connID's PTY after the frontend's terminal
// container is resized.
func (a *App) ResizeSSHTerminal(connID string, cols, rows int) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.sshSessions.Resize(connID, cols, rows)
}

// CloseSSHTerminal tears down connID's live shell session, if any is open —
// called when its terminal tab is closed. Unlike a Redis pool (cheap to
// leave open), a live shell is a real remote process, so this is not
// optional cleanup the way DisconnectConnection's pool close is.
func (a *App) CloseSSHTerminal(connID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.sshSessions.Close(connID)
}

// ListSshSnippets returns every saved SSH snippet — global, reusable across
// any open terminal session (see vault.SshSnippet's doc comment).
func (a *App) ListSshSnippets() ([]vault.SshSnippet, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.ListSshSnippets()
}

// --- Historial de comandos SSH ---------------------------------------------
//
// Ver backend/vault/ssh_history_repo.go para el porqué del cifrado y del
// filtro de secretos. Acá solo va el guardado de siempre: requireUnlocked y
// delegar.

// AppendSshHistory registra un comando ejecutado en una terminal SSH. Devuelve
// si se guardó: `false` sin error significa que la línea se descartó por
// parecer traer una credencial, o que el registro está apagado.
func (a *App) AppendSshHistory(connID, command string) (bool, error) {
	if err := a.requireUnlocked(); err != nil {
		return false, err
	}
	// El interruptor se consulta acá y no en el frontend para que apagarlo
	// valga aunque una pestaña vieja siga mandando: el registro se corta en el
	// único lugar por el que pasa todo.
	enabled, err := a.vault.SshHistoryEnabled()
	if err != nil {
		return false, err
	}
	if !enabled {
		return false, nil
	}
	return a.vault.AppendSshHistory(connID, command)
}

func (a *App) ListSshHistory(connID string, limit int) ([]vault.SshHistoryEntry, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.ListSshHistory(connID, limit)
}

// ClearSshHistory borra el historial de una conexión y devuelve cuántos
// comandos se borraron.
func (a *App) ClearSshHistory(connID string) (int64, error) {
	if err := a.requireUnlocked(); err != nil {
		return 0, err
	}
	return a.vault.ClearSshHistory(connID)
}

func (a *App) ClearAllSshHistory() (int64, error) {
	if err := a.requireUnlocked(); err != nil {
		return 0, err
	}
	return a.vault.ClearAllSshHistory()
}

func (a *App) SshHistoryEnabled() (bool, error) {
	if err := a.requireUnlocked(); err != nil {
		return false, err
	}
	return a.vault.SshHistoryEnabled()
}

func (a *App) SetSshHistoryEnabled(enabled bool) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetSshHistoryEnabled(enabled)
}

// CreateSshSnippet saves a new reusable command/script.
func (a *App) CreateSshSnippet(name, script string) (*vault.SshSnippet, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.CreateSshSnippet(name, script)
}

// UpdateSshSnippet overwrites an existing snippet's name/script in place.
func (a *App) UpdateSshSnippet(id, name, script string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.UpdateSshSnippet(id, name, script)
}

// DeleteSshSnippet removes a snippet permanently.
func (a *App) DeleteSshSnippet(id string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.DeleteSshSnippet(id)
}

// MoveSshSnippetToFolder reparents a snippet under folderID ("" = root).
func (a *App) MoveSshSnippetToFolder(id, folderID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.MoveSshSnippetToFolder(id, folderID)
}

// --- SFTP file transfer -----------------------------------------------------

// SftpEndpointInput is one side of a transfer as the frontend describes it:
// Local means the user's own machine; otherwise ConnID is an opaque SSH
// connection id whose DSN this layer resolves — the frontend never sees it.
type SftpEndpointInput struct {
	Local  bool   `json:"local"`
	ConnID string `json:"connId"`
}

// SftpTransferInput is the StartSftpTransfer request. TransferID is generated
// by the frontend, which must EventsOn(TransferID, ...) before calling this —
// same event/race contract as OpenSSHTerminal / ExecuteQuery.
type SftpTransferInput struct {
	TransferID string            `json:"transferId"`
	Src        SftpEndpointInput `json:"src"`
	Dst        SftpEndpointInput `json:"dst"`
	DstDir     string            `json:"dstDir"`
	Items      []sftpx.Item      `json:"items"`
	// OnConflict is the policy for destination names that already exist:
	// "overwrite", "newer", "skip" or "rename" (see backend/sftpx/conflict.go).
	// Empty means overwrite, which is what this call did before the policy
	// existed.
	OnConflict string `json:"onConflict"`
}

// OpenSftpBrowse opens a persistent SFTP browse session for a remote
// connection and returns its home directory. sessionID is a frontend-chosen
// pane id (never sftpx.LocalSession — the local pane needs no session). The
// DSN is decrypted here and never crosses back to the frontend.
func (a *App) OpenSftpBrowse(sessionID, connID string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	dsn, err := a.sshDSN(connID)
	if err != nil {
		return "", err
	}
	// connID (not sessionID) keys the shared connection: two panes and a
	// terminal on the same server all ride one SSH connection.
	return a.sftpBrowse.Open(sessionID, connID, dsn)
}

// ListSftpDir lists dir for a pane. sessionID == "local" (sftpx.LocalSession)
// lists the user's own machine; any other id must have been OpenSftpBrowse'd.
// An empty dir resolves to that pane's home directory.
func (a *App) ListSftpDir(sessionID, dir string) ([]sftpx.FileEntry, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.sftpBrowse.ListDir(sessionID, dir)
}

// SftpHomeDir returns a pane's home/start directory.
func (a *App) SftpHomeDir(sessionID string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	return a.sftpBrowse.Home(sessionID)
}

// MakeSftpDir creates a new directory (New Folder) on a pane.
func (a *App) MakeSftpDir(sessionID, dir string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.sftpBrowse.MkdirAll(sessionID, dir)
}

// DeleteSftpPath removes a file or directory (recursive) on a pane.
func (a *App) DeleteSftpPath(sessionID, path string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.sftpBrowse.Remove(sessionID, path)
}

// RenameSftpPath renames/moves within a pane.
func (a *App) RenameSftpPath(sessionID, oldPath, newPath string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.sftpBrowse.Rename(sessionID, oldPath, newPath)
}

// SftpPathPermissions returns a path's permission bits + ownership for the
// "Editar permisos" dialog.
func (a *App) SftpPathPermissions(sessionID, path string) (sftpx.PermInfo, error) {
	if err := a.requireUnlocked(); err != nil {
		return sftpx.PermInfo{}, err
	}
	return a.sftpBrowse.PermInfo(sessionID, path)
}

// ChmodSftpPath sets a path's permission bits — mode is the raw 0..0o777 value
// the frontend builds from the owner/group/other × rwx toggles.
func (a *App) ChmodSftpPath(sessionID, path string, mode int) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.sftpBrowse.Chmod(sessionID, path, mode)
}

// ReadSftpFileForEdit loads a remote file's contents for editing inside the
// app. Reports (rather than errors on) a binary or oversized file so the UI
// can explain why it will not open it.
//
// Nothing is written to the user's machine: the content goes straight into
// an editor buffer, which is why there is no temp directory to clean up.
func (a *App) ReadSftpFileForEdit(sessionID, path string) (sftpx.RemoteFile, error) {
	if err := a.requireUnlocked(); err != nil {
		return sftpx.RemoteFile{}, err
	}
	return a.sftpBrowse.ReadFileForEdit(sessionID, path)
}

// WriteSftpFileFromEdit saves an edited file back, refusing when the remote
// copy changed since it was read.
//
// expectedModTimeUnix is the mtime the editor loaded; 0 means "overwrite
// anyway", which is what the conflict dialog sends after telling the user.
// Returns the new mtime so the next save compares against the right value
// instead of the stale one.
func (a *App) WriteSftpFileFromEdit(sessionID, path, content string, expectedModTimeUnix int64) (int64, error) {
	if err := a.requireUnlocked(); err != nil {
		return 0, err
	}
	return a.sftpBrowse.WriteFileFromEdit(sessionID, path, content, expectedModTimeUnix)
}

// CloseSftpBrowse tears down a pane's remote session (when it switches hosts
// or its SFTP tab closes). No-op for the local pane.
func (a *App) CloseSftpBrowse(sessionID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.sftpBrowse.Close(sessionID)
}

// StartSftpTransfer resolves each remote endpoint's DSN and launches the
// transfer in the background. Progress and the terminal result stream back as
// sftpx.ProgressEvent on the TransferID event. Returns quickly after
// enumeration; a setup failure is returned and also emitted as "error".
func (a *App) StartSftpTransfer(in SftpTransferInput) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	src, err := a.resolveSftpEndpoint(in.Src)
	if err != nil {
		return err
	}
	dst, err := a.resolveSftpEndpoint(in.Dst)
	if err != nil {
		return err
	}
	return a.sftpTransfers.Start(sftpx.Request{
		ID:         in.TransferID,
		Src:        src,
		Dst:        dst,
		DstDir:     in.DstDir,
		Items:      in.Items,
		OnConflict: in.OnConflict,
	})
}

// CheckSftpConflicts reports which of the items already exist under dstDir,
// with both sides' size and mtime, so the UI can ask ONCE up front instead of
// interrupting a running transfer file by file.
func (a *App) CheckSftpConflicts(in SftpTransferInput) ([]sftpx.Conflict, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	src, err := a.resolveSftpEndpoint(in.Src)
	if err != nil {
		return nil, err
	}
	dst, err := a.resolveSftpEndpoint(in.Dst)
	if err != nil {
		return nil, err
	}
	return a.sftpTransfers.CheckConflicts(src, dst, in.DstDir, in.Items)
}

// CancelSftpTransfer stops an in-flight transfer; its terminal event will be
// "cancelled".
func (a *App) CancelSftpTransfer(transferID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.sftpTransfers.Cancel(transferID)
}

// resolveSftpEndpoint turns a frontend endpoint (opaque connId or local flag)
// into an sftpx.Endpoint carrying the decrypted DSN — the DSN never leaves the
// backend.
func (a *App) resolveSftpEndpoint(e SftpEndpointInput) (sftpx.Endpoint, error) {
	if e.Local {
		return sftpx.Endpoint{Local: true}, nil
	}
	dsn, err := a.sshDSN(e.ConnID)
	if err != nil {
		return sftpx.Endpoint{}, err
	}
	// ConnID travels with the DSN so the transfer joins the host's existing
	// connection instead of opening one of its own.
	return sftpx.Endpoint{DSN: dsn, ConnID: e.ConnID}, nil
}

// sshDSN decrypts connID's DSN and, when it references a key from the central
// store instead of carrying one inline, substitutes the real material.
//
// This is the ONLY place the substitution happens, and it happens as late as
// possible: the resolved DSN exists in memory for the duration of a dial and
// is never persisted, so rotating a key in the store takes effect on the next
// connection of every connection that uses it, with nothing to re-save.
func (a *App) sshDSN(connID string) (string, error) {
	_, dsn, err := a.vault.ConnectionDSN(connID)
	if err != nil {
		return "", err
	}
	return a.resolveSSHKeyRef(dsn)
}

// resolveSSHKeyRef replaces a ?keyId= reference with the key it points at.
// A DSN without one is returned untouched, so every pre-existing connection
// takes exactly the same path it did before.
func (a *App) resolveSSHKeyRef(dsn string) (string, error) {
	u, err := url.Parse(dsn)
	if err != nil {
		return "", fmt.Errorf("app: parseando DSN ssh: %w", err)
	}
	q := u.Query()
	keyID := q.Get("keyId")
	if keyID == "" {
		return dsn, nil
	}

	privateKey, passphrase, err := a.vault.SSHKeyMaterial(keyID)
	if err != nil {
		return "", err
	}

	q.Del("keyId")
	q.Set("privateKey", privateKey)
	if passphrase != "" {
		q.Set("passphrase", passphrase)
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

// ListSSHKeys returns the stored keys' names, types and fingerprints. No key
// material is ever included — see vault.SSHKeySummary.
func (a *App) ListSSHKeys() ([]vault.SSHKeySummary, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.ListSSHKeys()
}

// SaveSSHKey validates and stores a private key encrypted under the vault's
// master key. privateKey is the file's full contents (never a path — a path
// would break the moment the file moves, and would leave the key unprotected
// on disk, which is what this store exists to avoid).
func (a *App) SaveSSHKey(name, privateKey, passphrase string) (*vault.SSHKeySummary, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.SaveSSHKey(name, privateKey, passphrase)
}

// RenameSSHKey relabels a stored key.
func (a *App) RenameSSHKey(id, name string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.RenameSSHKey(id, name)
}

// SSHKeyUsage lists the names of the connections that authenticate with id.
//
// Needed because the reference lives INSIDE each connection's encrypted DSN,
// so there is no foreign key to consult: answering "what breaks if I delete
// this" means decrypting every SSH connection. Called before deleting, since
// deleting a key in use leaves those servers unreachable with no undo.
func (a *App) SSHKeyUsage(id string) ([]string, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	conns, err := a.vault.ListConnections()
	if err != nil {
		return nil, err
	}
	connector, err := db.ConnectorFor(db.DBTypeSSH)
	if err != nil {
		return nil, err
	}

	var users []string
	for _, c := range conns {
		if c.DBType != string(db.DBTypeSSH) {
			continue
		}
		_, dsn, err := a.vault.ConnectionDSN(c.ID)
		if err != nil {
			continue
		}
		params, err := connector.ParseDSN(dsn)
		if err != nil {
			continue
		}
		if params["keyId"] == id {
			users = append(users, c.Name)
		}
	}
	return users, nil
}

// DeleteSSHKey removes a stored key. The caller is expected to have shown
// SSHKeyUsage first.
func (a *App) DeleteSSHKey(id string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.DeleteSSHKey(id)
}

// ActiveConnectionIds returns the connection ids that currently have an open
// pool or client — SQL, Redis and Mongo together.
//
// The sidebar uses it to show "desconectar" only where there IS something to
// disconnect. It reads the pool managers rather than tracking the state in the
// frontend because a pool is opened lazily by whatever needs it first (a
// query, a metadata scan, the key tree), not by an explicit connect action the
// UI could observe.
func (a *App) ActiveConnectionIds() ([]string, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	ids := a.pools.ActiveIDs()
	ids = append(ids, a.redisPools.ActiveIDs()...)
	ids = append(ids, a.mongoPools.ActiveIDs()...)
	return ids, nil
}

// ConnectionEnvironment returns connID's environment marking ("prod",
// "staging", "dev" or ""). The SSH terminal reads it to decide whether to
// confirm destructive commands.
func (a *App) ConnectionEnvironment(connID string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	return a.vault.ConnectionEnvironment(connID)
}

// ListRedisKeys pages through connID's keyspace via SCAN — never KEYS *,
// see .claude/rules/technical.md's performance rule. cursor is opaque: ""
// starts from the beginning, and a returned cursor of "" means there are no
// more pages. match is a SCAN glob ("*" for all keys).
func (a *App) ListRedisKeys(connID, cursor, match, keyType string, count int64) (db.RedisScanPage, error) {
	if err := a.requireUnlocked(); err != nil {
		return db.RedisScanPage{}, err
	}
	if err := a.ensureRedisPoolOpen(connID); err != nil {
		return db.RedisScanPage{}, err
	}
	client, err := a.redisPools.Get(connID)
	if err != nil {
		return db.RedisScanPage{}, err
	}
	return db.ScanKeys(a.ctx, client, cursor, match, keyType, count)
}

// GetRedisStats returns the sidebar header's summary (total keys + used
// memory) — see db.GetRedisStats for why UsedMemoryBytes is server-wide,
// not per logical database.
func (a *App) GetRedisStats(connID string) (db.RedisStats, error) {
	if err := a.requireUnlocked(); err != nil {
		return db.RedisStats{}, err
	}
	if err := a.ensureRedisPoolOpen(connID); err != nil {
		return db.RedisStats{}, err
	}
	client, err := a.redisPools.Get(connID)
	if err != nil {
		return db.RedisStats{}, err
	}
	return db.GetRedisStats(a.ctx, client)
}

// GetRedisKeyInfo returns key's type and TTL (see db.GetRedisKeyInfo for the
// -1/-2 TTL sentinel semantics) — the frontend always fetches this before
// GetRedisKeyValue, since the value fetch needs to know which type-specific
// path to take.
func (a *App) GetRedisKeyInfo(connID, key string) (db.RedisKeyInfo, error) {
	if err := a.requireUnlocked(); err != nil {
		return db.RedisKeyInfo{}, err
	}
	if err := a.ensureRedisPoolOpen(connID); err != nil {
		return db.RedisKeyInfo{}, err
	}
	client, err := a.redisPools.Get(connID)
	if err != nil {
		return db.RedisKeyInfo{}, err
	}
	return db.GetRedisKeyInfo(a.ctx, client, key)
}

// GetRedisKeyValue returns one paginated page of key's value, shaped by typ
// (as returned by GetRedisKeyInfo) — see db.GetRedisValue for the
// pagination semantics, which differ by type.
func (a *App) GetRedisKeyValue(connID, key, typ, cursor string, offset, count int64) (db.RedisValue, error) {
	if err := a.requireUnlocked(); err != nil {
		return db.RedisValue{}, err
	}
	if err := a.ensureRedisPoolOpen(connID); err != nil {
		return db.RedisValue{}, err
	}
	client, err := a.redisPools.Get(connID)
	if err != nil {
		return db.RedisValue{}, err
	}
	return db.GetRedisValue(a.ctx, client, key, typ, cursor, offset, count)
}

// DeleteRedisKey deletes key from connID — an explicit action the frontend
// confirms first (never inline/silent mutation), matching this project's
// existing philosophy for row data (see
// .claude/skills/mini-tools-patterns/SKILL.md).
func (a *App) DeleteRedisKey(connID, key string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if err := a.ensureRedisPoolOpen(connID); err != nil {
		return err
	}
	client, err := a.redisPools.Get(connID)
	if err != nil {
		return err
	}
	return db.DeleteRedisKey(a.ctx, client, key)
}

// redisClientFor unlocks the vault, ensures connID's Redis pool is open,
// and returns its client — the common prefix every write/export binding
// below shares (the read-only bindings above predate this feature and
// keep their own copy of the same 3 lines, left as-is to avoid an
// unrelated diff).
func (a *App) redisClientFor(connID string) (redis.UniversalClient, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	if err := a.ensureRedisPoolOpen(connID); err != nil {
		return nil, err
	}
	return a.redisPools.Get(connID)
}

// BeginRedisTransaction opens an interactive MULTI on connID, reserving a
// connection for it.
//
// While it is open, EVERY command run against this connection is queued on
// that same reserved connection — which is the whole point: MULTI opens a
// transaction ON A CONNECTION, and queueing on one while sending EXEC on
// another runs an empty transaction with no error and no way to notice.
// See backend/redisquery/tx.go.
func (a *App) BeginRedisTransaction(connID string) error {
	client, err := a.redisClientFor(connID)
	if err != nil {
		return err
	}
	return a.redisExecutor.Transactions().Begin(a.ctx, connID, client)
}

// ExecRedisTransaction sends EXEC and releases the reserved connection,
// returning the replies of the queued commands.
func (a *App) ExecRedisTransaction(connID string) (interface{}, error) {
	if _, err := a.redisClientFor(connID); err != nil {
		return nil, err
	}
	return a.redisExecutor.Transactions().Exec(a.ctx, connID)
}

// DiscardRedisTransaction sends DISCARD, throwing away every queued command.
func (a *App) DiscardRedisTransaction(connID string) error {
	if _, err := a.redisClientFor(connID); err != nil {
		return err
	}
	return a.redisExecutor.Transactions().Discard(a.ctx, connID)
}

// RedisTransactionStatus reports whether connID has a transaction open and
// how many commands are queued in it — the toolbar's indicator.
func (a *App) RedisTransactionStatus(connID string) (map[string]interface{}, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	open, queued := a.redisExecutor.Transactions().Open(connID)
	return map[string]interface{}{"open": open, "queued": queued}, nil
}

// CheckRedisLuaScript compiles a Lua script WITHOUT running it (SCRIPT
// LOAD), returning its SHA — the "validate before sending" step. Worth its
// own binding because a Redis script is atomic: while it runs it blocks
// every other client, so finding a syntax error before that is not a
// nicety.
func (a *App) CheckRedisLuaScript(connID, script string) (redisquery.LuaResult, error) {
	client, err := a.redisClientFor(connID)
	if err != nil {
		return redisquery.LuaResult{}, err
	}
	return redisquery.CheckLuaScript(a.ctx, client, script)
}

// RunRedisLuaScript validates and then runs a Lua script. keys and args map
// to Lua's KEYS[] and ARGV[]; the split is not cosmetic (Redis routes and
// validates a script by the KEYS it declares, so a key passed through ARGV
// breaks the day the deployment is sharded).
func (a *App) RunRedisLuaScript(connID, script string, keys, args []string) (redisquery.LuaResult, error) {
	client, err := a.redisClientFor(connID)
	if err != nil {
		return redisquery.LuaResult{}, err
	}
	// Dispatched through the transaction manager so a script runs INSIDE an
	// open MULTI when there is one, rather than silently beside it.
	runner := a.redisExecutor.Transactions().Runner(connID, client)
	return redisquery.RunLuaScript(a.ctx, runner, client, script, keys, args)
}

// SubscribeRedisChannels starts a live Pub/Sub monitor under monitorID.
// Messages arrive as Wails events named after monitorID, in batches — a
// busy channel can produce thousands per second and one event each would
// saturate the bridge (see backend/redisquery/stream.go's flushInterval).
//
// The frontend generates monitorID and subscribes to the event BEFORE
// calling this, same race-avoidance the query executor already relies on.
func (a *App) SubscribeRedisChannels(connID, monitorID string, channels, patterns []string) error {
	if _, err := a.redisClientFor(connID); err != nil {
		return err
	}
	return a.redisStreams.Subscribe(connID, monitorID, channels, patterns)
}

// ReadRedisStream tails a Redis stream under monitorID. fromID is "$" for
// only what arrives from now on, or "0" to replay from the beginning.
func (a *App) ReadRedisStream(connID, monitorID, key, fromID string) error {
	if _, err := a.redisClientFor(connID); err != nil {
		return err
	}
	return a.redisStreams.ReadStream(connID, monitorID, key, fromID)
}

// StopRedisMonitor ends a live monitor. Stopping one that is not running is
// deliberately not an error, so the UI can call it on unmount without
// tracking whether the start succeeded.
func (a *App) StopRedisMonitor(monitorID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	a.redisStreams.Stop(monitorID)
	return nil
}

// GetRedisServerInfo returns the health snapshot the metrics dashboard
// renders: memory against its limit, cache hit rate, connected clients,
// ops/sec and CPU, parsed out of INFO.
//
// Read-only and manual: nothing here polls on its own. The frontend decides
// when to refresh, because a dashboard that quietly issues a command per
// second against a production instance is exactly what this app avoids
// everywhere else.
func (a *App) GetRedisServerInfo(connID string) (db.RedisServerInfo, error) {
	client, err := a.redisClientFor(connID)
	if err != nil {
		return db.RedisServerInfo{}, err
	}
	return db.GetRedisServerInfo(a.ctx, client)
}

// AnalyzeRedisPrefixes groups a bounded SCAN sample into a namespace tree
// (session:*, cache:*, cart:*) with key counts and estimated memory.
//
// Bounded and sampled on purpose: this runs against production instances,
// and walking a whole keyspace is what SCAN exists to avoid. The report
// carries both the sample size and DBSIZE so the UI can present it as the
// estimate it is, never as a census.
func (a *App) AnalyzeRedisPrefixes(connID, separator string, sampleLimit int64, withMemory bool) (db.RedisPrefixReport, error) {
	client, err := a.redisClientFor(connID)
	if err != nil {
		return db.RedisPrefixReport{}, err
	}
	return db.AnalyzeRedisPrefixes(a.ctx, client, separator, sampleLimit, withMemory)
}

// DeleteRedisKeys removes several keys at once, returning how many actually
// existed. Chunked server-side; on a failure it reports how many were
// already deleted, since a partial destructive operation is unusable
// information otherwise.
func (a *App) DeleteRedisKeys(connID string, keys []string) (int64, error) {
	client, err := a.redisClientFor(connID)
	if err != nil {
		return 0, err
	}
	return db.DeleteRedisKeys(a.ctx, client, keys)
}

// SetRedisKeyTTL gives key an expiry of seconds from now (EXPIRE).
//
// A non-positive value is rejected rather than forwarded: Redis reads
// EXPIRE 0 as "delete this key now", which is not what someone typing a 0
// into a TTL box means. Removing an expiry is PersistRedisKey.
func (a *App) SetRedisKeyTTL(connID, key string, seconds int64) error {
	client, err := a.redisClientFor(connID)
	if err != nil {
		return err
	}
	return db.SetRedisKeyTTL(a.ctx, client, key, seconds)
}

// PersistRedisKey removes key's expiry (PERSIST), making it permanent.
// Succeeds silently when the key was already permanent — asking for a state
// something is already in is not an error.
func (a *App) PersistRedisKey(connID, key string) error {
	client, err := a.redisClientFor(connID)
	if err != nil {
		return err
	}
	return db.PersistRedisKey(a.ctx, client, key)
}

// SetRedisStringValue overwrites key's whole string value, preserving any
// existing TTL (see db.SetStringValue).
func (a *App) SetRedisStringValue(connID, key, value string) error {
	client, err := a.redisClientFor(connID)
	if err != nil {
		return err
	}
	return db.SetStringValue(a.ctx, client, key, value)
}

// SetRedisJSONValue overwrites key's whole RedisJSON document (see
// db.SetJSONValue). value must already be valid JSON — the frontend
// validates it before calling this, JSON.SET itself would otherwise
// return a cryptic parser error instead of a friendly one.
func (a *App) SetRedisJSONValue(connID, key, value string) error {
	client, err := a.redisClientFor(connID)
	if err != nil {
		return err
	}
	return db.SetJSONValue(a.ctx, client, key, value)
}

// SetRedisHashField creates or overwrites one field of a hash.
func (a *App) SetRedisHashField(connID, key, field, value string) error {
	client, err := a.redisClientFor(connID)
	if err != nil {
		return err
	}
	return db.SetHashField(a.ctx, client, key, field, value)
}

// DeleteRedisHashField removes one field from a hash.
func (a *App) DeleteRedisHashField(connID, key, field string) error {
	client, err := a.redisClientFor(connID)
	if err != nil {
		return err
	}
	return db.DeleteHashField(a.ctx, client, key, field)
}

// SetRedisListIndex overwrites the element at index.
func (a *App) SetRedisListIndex(connID, key string, index int64, value string) error {
	client, err := a.redisClientFor(connID)
	if err != nil {
		return err
	}
	return db.SetListIndex(a.ctx, client, key, index, value)
}

// PushRedisListValue appends value to the end of a list.
func (a *App) PushRedisListValue(connID, key, value string) error {
	client, err := a.redisClientFor(connID)
	if err != nil {
		return err
	}
	return db.PushListValue(a.ctx, client, key, value)
}

// RemoveRedisListIndex deletes the element at index (see
// db.RemoveListIndex for the LSET+LREM sentinel technique).
func (a *App) RemoveRedisListIndex(connID, key string, index int64) error {
	client, err := a.redisClientFor(connID)
	if err != nil {
		return err
	}
	return db.RemoveListIndex(a.ctx, client, key, index)
}

// AddRedisSetMember adds member to a set.
func (a *App) AddRedisSetMember(connID, key, member string) error {
	client, err := a.redisClientFor(connID)
	if err != nil {
		return err
	}
	return db.AddSetMember(a.ctx, client, key, member)
}

// RemoveRedisSetMember removes member from a set.
func (a *App) RemoveRedisSetMember(connID, key, member string) error {
	client, err := a.redisClientFor(connID)
	if err != nil {
		return err
	}
	return db.RemoveSetMember(a.ctx, client, key, member)
}

// AddRedisZSetMember adds (or updates the score of) member in a sorted set.
func (a *App) AddRedisZSetMember(connID, key, member string, score float64) error {
	client, err := a.redisClientFor(connID)
	if err != nil {
		return err
	}
	return db.AddZSetMember(a.ctx, client, key, member, score)
}

// RemoveRedisZSetMember removes member from a sorted set.
func (a *App) RemoveRedisZSetMember(connID, key, member string) error {
	client, err := a.redisClientFor(connID)
	if err != nil {
		return err
	}
	return db.RemoveZSetMember(a.ctx, client, key, member)
}

// ExportRedisKeys fetches type/TTL/full value for every key in keys — used
// by the Redis Browser tab's bulk "Exportar" action. Returns data, not a
// file (same pattern as GetObjectDDL): the frontend decides JSON vs CSV
// and calls SaveDDLToFile with the result.
func (a *App) ExportRedisKeys(connID string, keys []string) ([]db.RedisKeyExport, error) {
	client, err := a.redisClientFor(connID)
	if err != nil {
		return nil, err
	}
	return db.ExportRedisKeys(a.ctx, client, keys)
}

// BeginTransaction turns auto-commit off for connID: every statement
// ExecuteQuery runs against it afterward shares one reserved connection
// until CommitTransaction/RollbackTransaction ends it. Fails if a
// transaction is already open for connID.
func (a *App) BeginTransaction(connID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if err := a.ensurePoolOpen(connID); err != nil {
		return err
	}
	_, dbType, err := a.poolAndType(connID)
	if err != nil {
		return err
	}
	return a.executor.BeginTransaction(a.ctx, connID, dbType)
}

// CommitTransaction commits connID's open transaction and turns auto-commit
// back on for it.
func (a *App) CommitTransaction(connID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.executor.CommitTransaction(a.ctx, connID)
}

// RollbackTransaction rolls back connID's open transaction and turns
// auto-commit back on for it.
func (a *App) RollbackTransaction(connID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.executor.RollbackTransaction(a.ctx, connID)
}

// HasOpenTransaction reports whether connID currently has auto-commit off —
// lets the frontend re-sync its toggle/Commit-Rollback UI (e.g. right after
// selecting a connection) without assuming its own local state is current.
func (a *App) HasOpenTransaction(connID string) bool {
	return a.executor.HasOpenTransaction(connID)
}

// BackupVault prompts for a destination and writes a full vault backup
// (encrypted connections + salt) there. Requires re-entering the master
// password even though the vault is already unlocked — a backup file is
// meant to travel (another machine, a USB drive, cloud storage), so this is
// a deliberate re-confirmation step, not a redundant unlock check. Returns
// "" without an error if the user cancels the save dialog.
func (a *App) BackupVault(password string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	if err := a.vault.VerifyPassword(password); err != nil {
		return "", err
	}

	dest, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "Guardar backup del vault",
		DefaultFilename: fmt.Sprintf("mini-tools-vault-backup-%s.mtbackup", time.Now().Format("2006-01-02")),
		Filters: []runtime.FileFilter{
			{DisplayName: "mini-tools backup (*.mtbackup)", Pattern: "*.mtbackup"},
		},
	})
	if err != nil {
		return "", fmt.Errorf("app: abriendo diálogo de guardado: %w", err)
	}
	if dest == "" {
		return "", nil
	}

	if err := a.vault.Backup(dest); err != nil {
		return "", err
	}
	return dest, nil
}

// PickVaultBackupFileFirstRun is step 1 of restoring a backup on FIRST RUN —
// the "Crear clave maestra" lock screen, when no vault exists yet. Unlike
// PickVaultBackupFile (restoring OVER an existing vault) there is no current
// master password to confirm: nothing is being replaced or authorized, so the
// button opens the file picker straight away and the backup's own password is
// asked for afterward, tied to the chosen file (see
// RestoreVaultBackupFirstRun). Only allowed while uninitialized — restoring
// over an existing vault must go through the current-password-gated
// Configuración flow instead. Returns "" without an error if the user cancels
// the picker.
func (a *App) PickVaultBackupFileFirstRun() (string, error) {
	initialized, err := a.vault.IsInitialized()
	if err != nil {
		return "", err
	}
	if initialized {
		return "", fmt.Errorf("app: ya existe un vault inicializado; restaurá desde Configuración, no desde la pantalla de creación")
	}

	src, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Seleccionar backup del vault",
		Filters: []runtime.FileFilter{
			{DisplayName: "mini-tools backup (*.mtbackup)", Pattern: "*.mtbackup"},
		},
	})
	if err != nil {
		return "", fmt.Errorf("app: abriendo diálogo de selección: %w", err)
	}
	return src, nil
}

// RestoreVaultBackupFirstRun is step 2 of the first-run restore: path was
// already chosen via PickVaultBackupFileFirstRun, so this only needs the
// backup's own master password — verified against the file itself
// (vault.VerifyBackupPassword) before anything on disk is touched, so a wrong
// password fails cleanly instead of leaving an inaccessible vault behind. Only
// allowed while uninitialized. After it succeeds the vault IS initialized
// (encrypted with the backup's password), so the frontend flips the lock
// screen to "Desbloquear" and the user unlocks with that same password — the
// gate is never left unlocked here.
func (a *App) RestoreVaultBackupFirstRun(path, backupPassword string) error {
	initialized, err := a.vault.IsInitialized()
	if err != nil {
		return err
	}
	if initialized {
		return fmt.Errorf("app: ya existe un vault inicializado; no se puede restaurar encima")
	}
	if err := vault.VerifyBackupPassword(path, backupPassword); err != nil {
		return err
	}

	if err := a.vault.Close(); err != nil {
		return fmt.Errorf("app: cerrando vault actual: %w", err)
	}

	if err := vault.RestoreBackup(path); err != nil {
		// Reopen whatever was there before so the app isn't left with a.vault nil.
		if store, openErr := vault.Open(a.gate); openErr == nil {
			a.vault = store
		}
		return err
	}

	store, err := vault.Open(a.gate)
	if err != nil {
		return fmt.Errorf("app: reabriendo vault restaurado: %w", err)
	}
	a.vault = store
	return nil
}

// PickVaultBackupFile is step 1 of restoring a backup OVER an already-
// initialized, unlocked vault (Configuración → "Restaurar backup", not the
// first-run lock screen — see RestoreVaultBackupFromFile for step 2 and the
// full reasoning). Verifies currentPassword — proves the caller is the
// legitimate current vault owner before anything gets destroyed, same
// VerifyPassword re-confirmation BackupVault already does before writing a
// file out — then opens the file picker and returns the chosen path.
//
// Deliberately split from step 2 instead of taking the backup's own
// password here too: at this point the user hasn't chosen a file yet, so
// asking for "the backup's password" before they even know which backup
// it's for is backwards — the password prompt belongs AFTER the file is
// picked, tied to that specific file's name/date, and a wrong guess there
// can retry against the same already-chosen path without reopening the
// picker or re-entering currentPassword. Returns "" without an error if the
// user cancels the picker.
func (a *App) PickVaultBackupFile(currentPassword string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	if err := a.vault.VerifyPassword(currentPassword); err != nil {
		return "", err
	}

	src, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Seleccionar backup del vault",
		Filters: []runtime.FileFilter{
			{DisplayName: "mini-tools backup (*.mtbackup)", Pattern: "*.mtbackup"},
		},
	})
	if err != nil {
		return "", fmt.Errorf("app: abriendo diálogo de selección: %w", err)
	}
	return src, nil
}

// RestoreVaultBackupFromFile is step 2: path was already chosen via
// PickVaultBackupFile (and currentPassword already verified there), so this
// only needs backupPassword — the master password that was active when
// THAT specific backup was made, almost certainly different from
// currentPassword. VerifyBackupPassword confirms it can actually be
// decrypted before anything gets destroyed.
//
// On success every live SSH session and DB/Redis pool is torn down first
// (their connections are about to disappear along with the old vault), then
// the old vault.db/salt.bin are replaced and the gate is locked — the
// frontend must send the user back through the unlock screen afterward (see
// App.tsx's onLocked), since the restored vault's password is whatever the
// backup was encrypted with, not currentPassword.
func (a *App) RestoreVaultBackupFromFile(path, backupPassword string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if err := vault.VerifyBackupPassword(path, backupPassword); err != nil {
		return err
	}

	a.sshSessions.CloseAll()
	a.pools.CloseAll()
	a.redisPools.CloseAll()
	a.mongoPools.CloseAll()

	if err := a.vault.Close(); err != nil {
		return fmt.Errorf("app: cerrando vault actual: %w", err)
	}

	if err := vault.RestoreBackup(path); err != nil {
		if store, openErr := vault.Open(a.gate); openErr == nil {
			a.vault = store
		}
		return err
	}

	store, err := vault.Open(a.gate)
	if err != nil {
		return fmt.Errorf("app: reabriendo vault restaurado: %w", err)
	}
	a.vault = store
	a.gate.Lock()
	return nil
}

// GetSchemaMetadata returns connID's tables/columns/FKs. Resolution order
// when !forceRefresh: in-memory cache (this session already opened it),
// then the vault-persisted cache (a previous session synced it — this is
// what makes reopening an already-synced connection instant, without
// touching the real database at all), and only falls back to a live fetch
// if neither has anything yet (this connection has never been synced) or
// forceRefresh is set (spec: "cache de metadata por conexión, refresh
// manual (botón/F5)").
func (a *App) GetSchemaMetadata(connID string, forceRefresh bool) (*db.SchemaMetadata, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}

	if !forceRefresh {
		if cached, ok := a.cachedMetadata(connID); ok {
			return cached, nil
		}
		if cached, ok, err := a.vault.GetSchemaMetadataCache(connID); err != nil {
			return nil, err
		} else if ok {
			a.setCachedMetadata(connID, cached)
			return cached, nil
		}
	}

	pool, dbType, err := a.poolAndType(connID)
	if err != nil {
		return nil, err
	}

	schemas, err := a.vault.ConnectionMetadataSchemas(connID)
	if err != nil {
		return nil, err
	}

	meta, err := db.FetchSchemaMetadata(a.ctx, pool, dbType, schemas)
	if err != nil {
		return nil, err
	}

	a.setCachedMetadata(connID, meta)
	if err := a.vault.SaveSchemaMetadataCache(connID, meta); err != nil {
		return nil, err
	}
	return meta, nil
}

// SyncSchemaMetadata refreshes just one schema's tables (the per-schema
// sync button in the sidebar tree) instead of the whole connection, so
// picking up a new/changed table in one schema doesn't force re-scanning
// every other already-cached schema. schema == "" means the connection has
// no schema restriction configured (SQLite, or Postgres/Oracle scanned
// unqualified) — there's only one implicit "schema" in that case, so it's
// equivalent to a full forceRefresh.
func (a *App) SyncSchemaMetadata(connID, schema string) (*db.SchemaMetadata, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}

	if schema == "" {
		return a.GetSchemaMetadata(connID, true)
	}

	pool, dbType, err := a.poolAndType(connID)
	if err != nil {
		return nil, err
	}

	fresh, err := db.FetchSchemaMetadata(a.ctx, pool, dbType, []string{schema})
	if err != nil {
		return nil, err
	}

	merged := &db.SchemaMetadata{}
	if cached, ok := a.cachedMetadata(connID); ok {
		*merged = *cached
	} else if cached, ok, err := a.vault.GetSchemaMetadataCache(connID); err != nil {
		return nil, err
	} else if ok {
		*merged = *cached
	}

	// Bug fixed here: this used to only ever carry Tables through the
	// merge (`merged.Tables = cached.Tables` + a manual filter/append),
	// silently dropping Procedures/Functions/Triggers/Packages back to
	// empty on every sync even when fresh had them — added when
	// SchemaMetadata grew those fields (scanner DDL spec) without
	// updating this merge. replaceSchemaObjects now does the same
	// "drop this schema's old entries, append the fresh ones" swap for
	// all five object types.
	merged.Tables = replaceSchemaObjects(merged.Tables, schema, fresh.Tables, func(t db.Table) string { return t.Schema })
	merged.Procedures = replaceSchemaObjects(merged.Procedures, schema, fresh.Procedures, func(p db.Procedure) string { return p.Schema })
	merged.Functions = replaceSchemaObjects(merged.Functions, schema, fresh.Functions, func(f db.Function) string { return f.Schema })
	merged.Triggers = replaceSchemaObjects(merged.Triggers, schema, fresh.Triggers, func(t db.Trigger) string { return t.Schema })
	merged.Packages = replaceSchemaObjects(merged.Packages, schema, fresh.Packages, func(p db.Package) string { return p.Schema })

	a.setCachedMetadata(connID, merged)
	if err := a.vault.SaveSchemaMetadataCache(connID, merged); err != nil {
		return nil, err
	}
	return merged, nil
}

// replaceSchemaObjects drops every item in cached whose schema matches
// schema, then appends fresh's items — the shared "refresh exactly one
// schema's slice, leave every other already-cached schema's objects
// alone" primitive SyncSchemaMetadata uses for tables/procedures/
// functions/triggers/packages alike.
func replaceSchemaObjects[T any](cached []T, schema string, fresh []T, schemaOf func(T) string) []T {
	kept := cached[:0]
	for _, item := range cached {
		if schemaOf(item) != schema {
			kept = append(kept, item)
		}
	}
	return append(kept, fresh...)
}

// ListSchemas returns connID's visible schema names (Postgres and Oracle —
// nil for SQLite, see db.ListSchemas) so the frontend can offer a
// "which schemas should autocomplete scan" picker without paying for a
// full GetSchemaMetadata fetch first. Same persisted-cache-first resolution
// as GetSchemaMetadata: unless forceRefresh, a previously synced list is
// read from the vault instead of listing schemas live again — on a catalog
// with 100+ schemas that live listing alone can be slow, and this cache is
// what lets the picker open instantly on every subsequent visit. Pass
// forceRefresh to discover a schema created since the last sync (the "sync"
// button next to the search box in SchemaPickerDialog.tsx).
func (a *App) ListSchemas(connID string, forceRefresh bool) ([]string, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}

	if !forceRefresh {
		if cached, ok, err := a.vault.GetSchemaListCache(connID); err != nil {
			return nil, err
		} else if ok {
			return cached, nil
		}
	}

	pool, dbType, err := a.poolAndType(connID)
	if err != nil {
		return nil, err
	}
	schemas, err := db.ListSchemas(a.ctx, pool, dbType)
	if err != nil {
		return nil, err
	}

	if err := a.vault.SaveSchemaListCache(connID, schemas); err != nil {
		return nil, err
	}
	return schemas, nil
}

// SetConnectionSchemas persists which schemas connID's metadata fetch
// should scan (empty = every schema) and drops any cached metadata for it
// — both in-memory and vault-persisted — since the old cache may reflect a
// different scan scope (a schema just unchecked, or one just added that
// was never fetched).
func (a *App) SetConnectionSchemas(connID string, schemas []string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if err := a.vault.SetConnectionSchemas(connID, schemas); err != nil {
		return err
	}
	if err := a.vault.DeleteSchemaMetadataCache(connID); err != nil {
		return err
	}
	a.dropCachedMetadata(connID)
	return nil
}

func (a *App) cachedMetadata(connID string) (*db.SchemaMetadata, bool) {
	a.metadataMu.Lock()
	defer a.metadataMu.Unlock()
	meta, ok := a.metadataCache[connID]
	return meta, ok
}

// setCachedMetadata is the single choke point where fresh metadata becomes
// visible to the rest of the app, so it is also where the editor's schema
// index is rebuilt. Compiling the index here rather than lazily on the
// first completion means the sidebar and the autocomplete can never
// disagree about what the schema holds, and a per-schema sync updates both
// in one step.
func (a *App) setCachedMetadata(connID string, meta *db.SchemaMetadata) {
	a.metadataMu.Lock()
	a.metadataCache[connID] = meta
	a.metadataMu.Unlock()
	a.sqlIntel.Set(connID, meta)
}

// dropCachedMetadata forgets everything derived from a connection's schema:
// the in-memory metadata and the compiled completion index. Both have to go
// together — an index outliving its metadata would keep suggesting tables
// from a database this connection no longer points at.
func (a *App) dropCachedMetadata(connID string) {
	a.metadataMu.Lock()
	delete(a.metadataCache, connID)
	a.metadataMu.Unlock()
	a.sqlIntel.Drop(connID)
}

// --- Editor IntelliSense (backend/sqlintel) -------------------------------

// sqlIntelIndexEvent is the Wails event the frontend listens on to know a
// background schema extraction finished, so a completion that arrived while
// the index was still building can be retried.
const sqlIntelIndexEvent = "sqlintel:index"

// PrimeSchemaIndex makes sure connID's completion index exists, building it
// in the background if it does not, and reports the state right now.
//
// Asynchronous by design: extraction is a catalog query against a possibly
// remote database, and it must never block the UI or a query the user is
// running. The call returns immediately with "loading"; the frontend gets
// the final state through the sqlintel:index event and re-requests
// completions then. Completion works throughout — until the index lands it
// simply degrades to keywords, functions and snippets.
//
// Called when an editor tab binds to a connection, so the schema is usually
// indexed before the first character is typed.
func (a *App) PrimeSchemaIndex(connID string) (*sqlintel.Status, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}

	status := a.sqlIntel.Prime(connID,
		func() (*db.SchemaMetadata, error) {
			// Reuses the normal resolution order (memory → vault cache →
			// live fetch), so priming an already-synced connection costs a
			// cache read rather than another catalog scan. GetSchemaMetadata
			// feeds the index itself via setCachedMetadata; returning the
			// metadata here is what makes Prime's own state machine settle.
			return a.GetSchemaMetadata(connID, false)
		},
		func(st sqlintel.Status) {
			runtime.EventsEmit(a.ctx, sqlIntelIndexEvent, st)
		})

	return &status, nil
}

// GetSchemaIndexStatus reports whether connID's completion index is ready,
// for the editor's status indicator.
func (a *App) GetSchemaIndexStatus(connID string) (*sqlintel.Status, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	status := a.sqlIntel.Status(connID)
	return &status, nil
}

// CompleteSQL answers "what can go at this cursor position?" — the single
// entry point behind the editor's completion popup. Everything the answer
// depends on (statement parsing, scope resolution, dialect catalog,
// ranking) lives in backend/sqlintel; the frontend only renders what comes
// back.
//
// It never fails on malformed SQL: half-typed input is the normal case, and
// the engine is written to degrade to a shorter list rather than error.
//
// El `recover` de abajo NO es decorativo. Ver recoverEditorCall: un pánico
// acá no se manifiesta como un error, sino como un autocompletado que deja
// de funcionar hasta reabrir la pestaña.
func (a *App) CompleteSQL(req sqlintel.Request) (resp *sqlintel.Response, err error) {
	defer recoverEditorCall("CompleteSQL", func() {
		resp, err = &sqlintel.Response{}, nil
	})
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	out := sqlintel.Complete(a.sqlIntel.Index(req.ConnID), req, a.sqlIntel.UsageFor(req.ConnID))
	return &out, nil
}

// recoverEditorCall convierte un pánico de una llamada del editor en una
// respuesta vacía.
//
// **Por qué no basta con "no entrar en pánico".** Wails recupera el pánico
// por su cuenta (internal/frontend/dispatcher.ProcessMessage) y responde con
// `Callback("")`, una cadena vacía que el runtime de JavaScript no puede
// parsear — así que la promesa de esa llamada **no se resuelve ni se rechaza
// nunca**. Y una promesa colgada de CompleteSQL deja la consulta de
// CodeMirror para siempre en su lista de pendientes, que es lo que hace que
// el autocompletado no vuelva ni con Ctrl+Espacio hasta cerrar y abrir la
// pestaña. Comprobado en un banco de pruebas con CodeMirror real: una sola
// llamada que no vuelve y no se recupera ni escribiendo sesenta caracteres.
//
// Recuperar acá cierra ese agujero para toda esta familia de llamadas: en el
// peor caso el usuario ve una lista vacía una vez, no un editor que hay que
// reabrir. El pánico se registra, porque sigue siendo un error que hay que
// arreglar; simplemente deja de ser mortal.
func recoverEditorCall(name string, fallback func()) {
	if r := recover(); r != nil {
		log.Printf("pánico recuperado en %s: %v\n%s", name, r, debug.Stack())
		fallback()
	}
}

// SignatureSQL answers "which argument am I on?" for the call under the
// cursor — the parameter-info tooltip. Separate from CompleteSQL because it
// is asked at a different moment: completion stops being useful the instant
// the opening parenthesis is typed, which is exactly when this starts.
//
// Like CompleteSQL it never fails on malformed SQL; an unresolvable cursor
// yields an empty response, which the editor renders as no tooltip.
func (a *App) SignatureSQL(req sqlintel.SignatureRequest) (resp *sqlintel.SignatureResponse, err error) {
	defer recoverEditorCall("SignatureSQL", func() {
		resp, err = &sqlintel.SignatureResponse{}, nil
	})
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	out := sqlintel.Signature(a.sqlIntel.Index(req.ConnID), req)
	return &out, nil
}

// SuggestInlineSQL returns just the ghost-text continuation for the cursor.
// Separate from CompleteSQL because the ghost text updates on every cursor
// move, not only while the popup is open: answering it with a bare string
// keeps that frequent call's payload at a few bytes instead of the full
// item list.
func (a *App) SuggestInlineSQL(req sqlintel.Request) (out string, err error) {
	defer recoverEditorCall("SuggestInlineSQL", func() { out, err = "", nil })
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	return sqlintel.InlineOnly(a.sqlIntel.Index(req.ConnID), req), nil
}

// RecordCompletionUse counts an accepted suggestion so the ranking learns
// what this session actually uses. Session-only and never persisted — it is
// a ranking hint, not user data.
func (a *App) RecordCompletionUse(connID, kind, name string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	a.sqlIntel.RecordUse(connID, kind, name)
	return nil
}

// ResolveJoinCondition answers "how do these two tables join?" from the
// declared foreign keys, without needing a cursor or a half-written query —
// what the sidebar's "join with…" action uses. Aliases are optional and
// default to the table names. An empty result means the schema declares no
// foreign key between them, not that the join is impossible.
func (a *App) ResolveJoinCondition(connID, leftTable, leftAlias, rightTable, rightAlias string) ([]sqlintel.JoinCondition, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	idx := a.sqlIntel.Index(connID)
	return sqlintel.ResolveJoinBetween(idx, leftTable, leftAlias, rightTable, rightAlias), nil
}

// OpenSQLFileDialog prompts for a .sql file, reads it, and records it in
// Recent Files. Returns nil (no error) if the user cancels the dialog.
func (a *App) OpenSQLFileDialog() (*FileContent, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}

	path, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:   "Abrir archivo SQL",
		Filters: []runtime.FileFilter{{DisplayName: "SQL (*.sql)", Pattern: "*.sql"}},
	})
	if err != nil {
		return nil, fmt.Errorf("app: abriendo diálogo de selección: %w", err)
	}
	if path == "" {
		return nil, nil
	}

	content, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("app: leyendo archivo: %w", err)
	}

	if err := a.vault.RecordRecentFile(path); err != nil {
		return nil, err
	}
	return &FileContent{Path: path, Content: string(content)}, nil
}

// OpenSQLFilePath reads path directly, no dialog — used when the user
// clicks an entry in Recent Files, which should reopen it as a tab
// immediately (spec: "click en recent → reabre tab directo").
func (a *App) OpenSQLFilePath(path string) (*FileContent, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}

	content, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("app: leyendo archivo: %w", err)
	}

	if err := a.vault.RecordRecentFile(path); err != nil {
		return nil, err
	}
	return &FileContent{Path: path, Content: string(content)}, nil
}

// SaveSQLFile writes content to an already-known path (Ctrl+S on an open
// file/tab) and records it in Recent Files.
func (a *App) SaveSQLFile(path, content string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return fmt.Errorf("app: guardando archivo: %w", err)
	}
	return a.vault.RecordRecentFile(path)
}

// SaveSQLFileAs prompts for a destination, writes content there, and
// records it in Recent Files. Returns "" (no error) if the user cancels.
func (a *App) SaveSQLFileAs(suggestedName, content string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}

	dest, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "Guardar archivo SQL",
		DefaultFilename: suggestedName,
		Filters:         []runtime.FileFilter{{DisplayName: "SQL (*.sql)", Pattern: "*.sql"}},
	})
	if err != nil {
		return "", fmt.Errorf("app: abriendo diálogo de guardado: %w", err)
	}
	if dest == "" {
		return "", nil
	}

	if err := a.SaveSQLFile(dest, content); err != nil {
		return "", err
	}
	return dest, nil
}

// ListRecentFiles returns the most recently opened/saved .sql files.
func (a *App) ListRecentFiles() ([]vault.RecentFile, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.ListRecentFiles(20)
}

// ClearRecentFiles removes every Recent Files entry.
func (a *App) ClearRecentFiles() error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.ClearRecentFiles()
}

// ExportResult prompts for a destination (extension implied by format:
// "csv" | "json" | "xlsx") and writes columns/rows there. The frontend
// passes rows it already streamed and holds in memory — the backend
// doesn't retain query results after emitting them, so there's no queryID
// to look up here. Returns "" without an error if the user cancels.
func (a *App) ExportResult(columns []string, rows [][]interface{}, format string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}

	var display, pattern, ext string
	switch format {
	case "csv":
		display, pattern, ext = "CSV (*.csv)", "*.csv", ".csv"
	case "json":
		display, pattern, ext = "JSON (*.json)", "*.json", ".json"
	case "xlsx":
		display, pattern, ext = "Excel (*.xlsx)", "*.xlsx", ".xlsx"
	default:
		return "", fmt.Errorf("app: formato de export desconocido %q", format)
	}

	dest, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "Exportar resultados",
		DefaultFilename: "resultado" + ext,
		Filters:         []runtime.FileFilter{{DisplayName: display, Pattern: pattern}},
	})
	if err != nil {
		return "", fmt.Errorf("app: abriendo diálogo de guardado: %w", err)
	}
	if dest == "" {
		return "", nil
	}

	switch format {
	case "csv":
		err = export.WriteCSV(dest, columns, rows)
	case "json":
		err = export.WriteJSON(dest, columns, rows)
	case "xlsx":
		err = export.WriteXLSX(dest, columns, rows)
	}
	if err != nil {
		return "", err
	}
	return dest, nil
}

// ExportTableDDL writes table's CREATE TABLE statement to a user-chosen .sql
// file. schema matters everywhere except SQLite (que no tiene esquemas): en
// Oracle es el dueño del objeto, y omitirlo hacía fallar cualquier tabla que no
// fuera del usuario conectado.
func (a *App) ExportTableDDL(connID, schema, table string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	pool, dbType, err := a.poolAndType(connID)
	if err != nil {
		return "", err
	}

	var ddl string
	switch dbType {
	case db.DBTypeSQLite:
		ddl, err = export.SQLiteTableDDL(a.ctx, pool, table)
	case db.DBTypePostgres:
		ddl, err = export.PostgresTableDDL(a.ctx, pool, schema, table)
	case db.DBTypeOracle:
		ddl, err = export.OracleTableDDL(a.ctx, pool, schema, table)
	case db.DBTypeSQLServer:
		ddl, err = export.SQLServerTableDDL(a.ctx, pool, schema, table)
	default:
		return "", fmt.Errorf("app: export de DDL no soportado para %q", dbType)
	}
	if err != nil {
		return "", err
	}

	return a.saveSQLTextAs("Exportar DDL de tabla", table+".sql", ddl)
}

// ExportSchemaDDL writes every table's DDL of `schema` to a user-chosen .sql
// file — en Oracle, las tablas de ESE dueño y no las del usuario conectado.
func (a *App) ExportSchemaDDL(connID, schema string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	pool, dbType, err := a.poolAndType(connID)
	if err != nil {
		return "", err
	}

	var ddl string
	switch dbType {
	case db.DBTypeSQLite:
		ddl, err = export.SQLiteSchemaDDL(a.ctx, pool)
	case db.DBTypePostgres:
		ddl, err = export.PostgresSchemaDDL(a.ctx, pool, schema)
	case db.DBTypeOracle:
		ddl, err = export.OracleSchemaDDL(a.ctx, pool, schema)
	case db.DBTypeSQLServer:
		ddl, err = export.SQLServerSchemaDDL(a.ctx, pool, schema)
	default:
		return "", fmt.Errorf("app: export de DDL no soportado para %q", dbType)
	}
	if err != nil {
		return "", err
	}

	return a.saveSQLTextAs("Exportar DDL del schema", "schema.sql", ddl)
}

// GetObjectDDL fetches the current DDL for any scanned schema object, for
// the in-app DDL viewer modal (unlike ExportTableDDL/ExportSchemaDDL above,
// this returns the text directly instead of writing it to a file — the
// modal shows it, SaveDDLToFile below is the separate opt-in "export what
// I'm already looking at" action). objectType is one of "table",
// "procedure", "function", "trigger", "package"; schema/oid are only
// meaningful for the object types/engines that need them (schema: Postgres
// tables; oid: Postgres functions/procedures/triggers, to disambiguate
// overloads — see db.Function's doc comment).
func (a *App) GetObjectDDL(connID, objectType, schema, name string, oid int64) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	pool, dbType, err := a.poolAndType(connID)
	if err != nil {
		return "", err
	}

	switch dbType {
	case db.DBTypeSQLite:
		switch objectType {
		case "table":
			return export.SQLiteTableDDL(a.ctx, pool, name)
		case "trigger":
			return export.SQLiteTriggerDDL(a.ctx, pool, name)
		}
	case db.DBTypePostgres:
		switch objectType {
		case "table":
			return export.PostgresTableDDL(a.ctx, pool, schema, name)
		case "function", "procedure":
			return export.PostgresFunctionDDL(a.ctx, pool, oid)
		case "trigger":
			return export.PostgresTriggerDDL(a.ctx, pool, oid)
		}
	case db.DBTypeOracle:
		switch objectType {
		// El esquema se pasa SIEMPRE que el árbol lo conozca: sin él,
		// DBMS_METADATA busca en el esquema de la sesión y un objeto de otro
		// dueño falla con "no existe" aunque se lo esté viendo en pantalla.
		case "table":
			return export.OracleTableDDL(a.ctx, pool, schema, name)
		case "procedure":
			return export.OracleProcedureDDL(a.ctx, pool, schema, name)
		case "function":
			return export.OracleFunctionDDL(a.ctx, pool, schema, name)
		case "trigger":
			return export.OracleTriggerDDL(a.ctx, pool, schema, name)
		case "package":
			return export.OraclePackageDDL(a.ctx, pool, schema, name)
		}
	case db.DBTypeSQLServer:
		switch objectType {
		case "table":
			return export.SQLServerTableDDL(a.ctx, pool, schema, name)
		case "procedure", "function", "trigger":
			return export.SQLServerObjectDDL(a.ctx, pool, schema, name)
		}
	}
	return "", fmt.Errorf("app: GetObjectDDL no soportado para %q/%q", dbType, objectType)
}

// SaveDDLToFile prompts for a .sql destination and writes ddl there — the
// DDL viewer modal's "Exportar a archivo" button calls this with whatever
// text GetObjectDDL already returned, no re-fetch needed.
func (a *App) SaveDDLToFile(defaultFilename, ddl string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}
	return a.saveSQLTextAs("Exportar DDL", defaultFilename, ddl)
}

// ExportConnectionConfig writes connID's config (name, engine, DSN with the
// password stripped — see export.RedactDSN) to a user-chosen .json file.
// Spec: "export de conexión (sin password): para compartir config".
func (a *App) ExportConnectionConfig(connID string) (string, error) {
	if err := a.requireUnlocked(); err != nil {
		return "", err
	}

	dbType, dsn, err := a.vault.ConnectionDSN(connID)
	if err != nil {
		return "", err
	}
	redacted, err := export.RedactDSN(dsn)
	if err != nil {
		return "", err
	}

	conns, err := a.vault.ListConnections()
	if err != nil {
		return "", err
	}
	name := connID
	for _, c := range conns {
		if c.ID == connID {
			name = c.Name
		}
	}

	payload := struct {
		Name   string `json:"name"`
		DBType string `json:"dbType"`
		DSN    string `json:"dsn"`
	}{Name: name, DBType: string(dbType), DSN: redacted}

	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return "", fmt.Errorf("app: serializando config de conexión: %w", err)
	}

	dest, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "Exportar configuración de conexión",
		DefaultFilename: name + ".json",
		Filters:         []runtime.FileFilter{{DisplayName: "JSON (*.json)", Pattern: "*.json"}},
	})
	if err != nil {
		return "", fmt.Errorf("app: abriendo diálogo de guardado: %w", err)
	}
	if dest == "" {
		return "", nil
	}
	if err := os.WriteFile(dest, data, 0o644); err != nil {
		return "", fmt.Errorf("app: escribiendo config de conexión: %w", err)
	}
	return dest, nil
}

// poolAndType is ensurePoolOpen plus fetching the pool/dbType, the common
// prefix for every export method that needs to query a live connection.
func (a *App) poolAndType(connID string) (*sql.DB, db.DBType, error) {
	if err := a.ensurePoolOpen(connID); err != nil {
		return nil, "", err
	}
	pool, err := a.pools.Get(connID)
	if err != nil {
		return nil, "", err
	}
	dbType, _ := a.pools.Type(connID)
	return pool, dbType, nil
}

// saveSQLTextAs prompts for a .sql destination and writes text there.
// Returns "" without an error if the user cancels.
func (a *App) saveSQLTextAs(title, defaultFilename, text string) (string, error) {
	dest, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           title,
		DefaultFilename: defaultFilename,
		Filters:         []runtime.FileFilter{{DisplayName: "SQL (*.sql)", Pattern: "*.sql"}},
	})
	if err != nil {
		return "", fmt.Errorf("app: abriendo diálogo de guardado: %w", err)
	}
	if dest == "" {
		return "", nil
	}
	if err := os.WriteFile(dest, []byte(text), 0o644); err != nil {
		return "", fmt.Errorf("app: escribiendo archivo: %w", err)
	}
	return dest, nil
}

// ExplainQuery runs EXPLAIN (Postgres: with ANALYZE if requested; SQLite
// has no ANALYZE equivalent, analyze is ignored for it) against connID and
// records the result in explain_history.
func (a *App) ExplainQuery(connID, sqlText string, analyze bool) (*explain.Plan, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	pool, dbType, err := a.poolAndType(connID)
	if err != nil {
		return nil, err
	}

	var plan *explain.Plan
	switch dbType {
	case db.DBTypeSQLite:
		plan, err = explain.SQLitePlan(a.ctx, pool, sqlText)
	case db.DBTypePostgres:
		plan, err = explain.PostgresPlan(a.ctx, pool, sqlText, analyze)
	case db.DBTypeOracle:
		plan, err = explain.OraclePlan(a.ctx, pool, sqlText)
	case db.DBTypeSQLServer:
		plan, err = explain.SQLServerPlan(a.ctx, pool, sqlText, analyze)
	default:
		return nil, fmt.Errorf("app: EXPLAIN no soportado para %q", dbType)
	}
	if err != nil {
		return nil, err
	}

	// Best-effort: a failure to persist history shouldn't hide a plan the
	// user already has.
	_ = a.vault.RecordExplainPlan(connID, sqlText, analyze, plan)
	return plan, nil
}

// CheckSQLMutation reports whether sqlText writes anything (data or
// schema), so the frontend can confirm before running Explain Analyze —
// which, unlike Explain, really executes the statement.
//
// Answered in Go rather than with a regex in the frontend because the
// splitter here is quote- and comment-aware: "-- delete this later" and
// "SELECT 'DELETE'" are not deletes, and a "WITH t AS (…) DELETE FROM …"
// is one despite starting with WITH. A frontend regex gets all three wrong.
//
// The confirmation is a UX courtesy, not the safety mechanism: the actual
// guarantee is that PostgresPlan wraps a mutating analyzed run in a
// transaction it always rolls back.
func (a *App) CheckSQLMutation(sqlText string) (bool, error) {
	if err := a.requireUnlocked(); err != nil {
		return false, err
	}
	return query.ContainsMutation(sqlText), nil
}

// ListExplainHistory returns the most recent EXPLAIN results for connID.
func (a *App) ListExplainHistory(connID string, limit int) ([]vault.ExplainHistoryEntry, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.ListExplainHistory(connID, limit)
}

// GenerateProjectDocs writes CLAUDE.md + .claude/{specs,rules,skills}
// describing connID's schema into projectRootPath, unless a CLAUDE.md
// already exists there. Returns wrote=false (no error) when it skipped
// because one already exists — that is not a failure, it is the documented
// "don't clobber an existing CLAUDE.md" behavior.
//
// This deviates from the plan's single-arg signature
// (GenerateProjectDocs(projectRootPath)): App has no server-side notion of
// "the current connection" — that is frontend-only state in Workspace.tsx —
// so the frontend must pass connID explicitly.
// GenerateProjectDocs writes CLAUDE.md + .claude/{specs,rules,skills} into
// projectRootPath unless one already exists there. schema optionally scopes
// the documented tables to just that schema (matches whatever's selected in
// the toolbar's schema dropdown) — empty string means "use the connection's
// full configured metadata", same as before this param existed.
func (a *App) GenerateProjectDocs(projectRootPath, connID, schema string) (bool, error) {
	if err := a.requireUnlocked(); err != nil {
		return false, err
	}
	info, err := a.buildClaudeMDInfo(connID, schema)
	if err != nil {
		return false, err
	}
	return claudemd.Generate(projectRootPath, info)
}

// RegenerateProjectDocs always overwrites CLAUDE.md + .claude/{specs,rules,
// skills} in projectRootPath with connID's current schema — the explicit
// "Regenerar" action. See GenerateProjectDocs for what schema does.
func (a *App) RegenerateProjectDocs(projectRootPath, connID, schema string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	info, err := a.buildClaudeMDInfo(connID, schema)
	if err != nil {
		return err
	}
	return claudemd.Regenerate(projectRootPath, info)
}

// buildClaudeMDInfo looks up connID's display name and current schema
// metadata for the claudemd templates. Never touches the DSN. When schema
// is non-empty, only that schema's tables are included — the generated
// docs end up describing exactly what the user was looking at, not every
// schema the connection happens to have access to.
func (a *App) buildClaudeMDInfo(connID, schema string) (claudemd.ProjectInfo, error) {
	conns, err := a.vault.ListConnections()
	if err != nil {
		return claudemd.ProjectInfo{}, err
	}
	var name string
	var dbType db.DBType
	found := false
	for _, c := range conns {
		if c.ID == connID {
			name = c.Name
			dbType = db.DBType(c.DBType)
			found = true
			break
		}
	}
	if !found {
		return claudemd.ProjectInfo{}, fmt.Errorf("app: conexión %q no encontrada", connID)
	}

	meta, err := a.GetSchemaMetadata(connID, false)
	if err != nil {
		return claudemd.ProjectInfo{}, err
	}

	if schema != "" && meta != nil {
		filtered := make([]db.Table, 0, len(meta.Tables))
		for _, t := range meta.Tables {
			if t.Schema == schema {
				filtered = append(filtered, t)
			}
		}
		meta = &db.SchemaMetadata{Tables: filtered}
	}

	return claudemd.ProjectInfo{
		ConnectionName: name,
		DBType:         dbType,
		Schema:         schema,
		Metadata:       meta,
	}, nil
}
