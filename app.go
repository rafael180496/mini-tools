package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/wailsapp/wails/v2/pkg/runtime"

	"mini-tools/backend/claudemd"
	"mini-tools/backend/db"
	"mini-tools/backend/explain"
	"mini-tools/backend/export"
	"mini-tools/backend/query"
	"mini-tools/backend/redisquery"
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

	metadataMu    sync.Mutex
	metadataCache map[string]*db.SchemaMetadata
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
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{
		gate:          vaultgate.New(),
		pools:         db.NewPoolManager(),
		redisPools:    db.NewRedisPoolManager(),
		metadataCache: make(map[string]*db.SchemaMetadata),
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

	// Shared by both executors — query.EmitFunc/HistorySink and
	// redisquery.EmitFunc/HistorySink are distinct named types with
	// identical underlying signatures, so the same closures satisfy both
	// constructors without duplication (same Wails event name = queryID,
	// same query_history table for both SQL statements and Redis
	// commands).
	emit := func(event string, data interface{}) {
		runtime.EventsEmit(ctx, event, data)
	}
	history := func(connID, sqlText, status string, rowsAffected, durationMs int64, errMsg string) {
		// Best-effort: a failure to persist history shouldn't affect the
		// query result the user already saw.
		_ = a.vault.RecordQueryHistory(connID, sqlText, status, rowsAffected, durationMs, errMsg)
	}
	a.executor = query.NewExecutor(ctx, a.pools, emit, history)
	a.redisExecutor = redisquery.NewExecutor(ctx, a.redisPools, emit, history)
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
	a.executor.RollbackAll(ctx)
	a.pools.CloseAll()
	a.redisPools.CloseAll()
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

	return a.vault.SaveConnection(cfg.Name, dbType, dsn, cfg.Color)
}

// ConnectionEditInfo pre-fills the "editar conexión" form. Params never
// includes "password" — see .claude/rules/technical.md point 9 — so the
// dialog shows it blank; leaving it blank on save means "keep the existing
// password" (see UpdateConnection), not "set an empty password".
type ConnectionEditInfo struct {
	Name   string            `json:"name"`
	DBType string            `json:"dbType"`
	Params map[string]string `json:"params"`
	Color  string            `json:"color"`
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
	var name, color string
	found := false
	for _, c := range conns {
		if c.ID == id {
			name = c.Name
			color = c.Color
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

	return &ConnectionEditInfo{Name: name, DBType: string(dbType), Params: params, Color: color}, nil
}

// UpdateConnection rebuilds id's DSN from cfg and overwrites the saved
// connection in place. A blank cfg.Params["password"] means "keep the
// existing password" — the frontend never had the real one to resubmit in
// the first place (see GetConnectionForEdit) — so it's filled in here from
// the connection's current DSN before rebuilding. Closes any open pool and
// drops cached metadata for id afterward, since the target this connID
// points at may have changed.
func (a *App) UpdateConnection(id string, cfg ConnectionInput, force bool) (*vault.ConnectionSummary, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}

	dbType := db.DBType(cfg.DBType)
	connector, err := db.ConnectorFor(dbType)
	if err != nil {
		return nil, err
	}

	if cfg.Params["password"] == "" {
		if _, existingDSN, err := a.vault.ConnectionDSN(id); err == nil {
			if existingParams, err := connector.ParseDSN(existingDSN); err == nil {
				cfg.Params["password"] = existingParams["password"]
			}
		}
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

	if err := a.vault.UpdateConnection(id, cfg.Name, dbType, dsn, cfg.Color); err != nil {
		return nil, err
	}

	a.rollbackIfOpen(id)
	if err := a.pools.Close(id); err != nil {
		return nil, err
	}
	// Harmless no-op on whichever pool manager doesn't actually own id —
	// closing both unconditionally means callers never need to know which
	// engine id used to be before this update.
	if err := a.redisPools.Close(id); err != nil {
		return nil, err
	}
	a.metadataMu.Lock()
	delete(a.metadataCache, id)
	a.metadataMu.Unlock()
	// The DSN may now point at a different database entirely — both
	// persisted caches (tables and the schema name list) could reflect a
	// target that no longer exists behind this connID.
	if err := a.vault.DeleteSchemaMetadataCache(id); err != nil {
		return nil, err
	}
	if err := a.vault.DeleteSchemaListCache(id); err != nil {
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
// root).
func (a *App) CreateFolder(name, parentID string) (*vault.Folder, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.CreateFolder(name, parentID)
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

// SetCollapsedSidebarModules persists which sidebar module ids are
// collapsed to an accordion header.
func (a *App) SetCollapsedSidebarModules(ids []string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.SetCollapsedSidebarModules(ids)
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
	if err := a.redisPools.Close(id); err != nil {
		return err
	}
	if err := a.vault.DeleteSchemaMetadataCache(id); err != nil {
		return err
	}
	if err := a.vault.DeleteSchemaListCache(id); err != nil {
		return err
	}
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
	if err := a.redisPools.Close(id); err != nil {
		return err
	}
	a.metadataMu.Lock()
	delete(a.metadataCache, id)
	a.metadataMu.Unlock()
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
func (a *App) ExecuteQuery(connID, queryID, sqlText string, captureDBMSOutput bool) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if err := a.ensurePoolOpen(connID); err != nil {
		return err
	}

	a.executor.Execute(connID, queryID, sqlText, captureDBMSOutput)
	return nil
}

// CancelQuery cancels the in-flight query registered under queryID, if any.
func (a *App) CancelQuery(queryID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	a.executor.Cancel(queryID)
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

// ListQueryHistory returns the most recent statements run against connID,
// newest first.
func (a *App) ListQueryHistory(connID string, limit int) ([]vault.HistoryEntry, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.ListQueryHistory(connID, limit)
}

// ClearQueryHistory deletes connID's recorded execution history.
func (a *App) ClearQueryHistory(connID string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.ClearQueryHistory(connID)
}

// DeleteQueryHistoryEntry deletes a single history entry by id.
func (a *App) DeleteQueryHistoryEntry(id string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	return a.vault.DeleteQueryHistoryEntry(id)
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

// RestoreVaultBackup prompts for a backup file and restores it, replacing
// this install's vault.db/salt.bin. Only allowed when no vault has been
// initialized yet — restoring over an existing vault would silently
// discard its connections, so that has to be a deliberate separate step
// (delete/rename the vault first), not implicit in a restore click.
// password must match the master password the backup was made under —
// checked against the backup file itself (see vault.VerifyBackupPassword)
// before anything on disk is touched, so a wrong password fails cleanly
// instead of leaving an inaccessible vault behind. Returns without an
// error if the user cancels the open dialog.
func (a *App) RestoreVaultBackup(password string) error {
	initialized, err := a.vault.IsInitialized()
	if err != nil {
		return err
	}
	if initialized {
		return fmt.Errorf("app: ya existe un vault inicializado; no se puede restaurar encima (hacé backup o eliminá el vault actual primero)")
	}

	src, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Seleccionar backup del vault",
		Filters: []runtime.FileFilter{
			{DisplayName: "mini-tools backup (*.mtbackup)", Pattern: "*.mtbackup"},
		},
	})
	if err != nil {
		return fmt.Errorf("app: abriendo diálogo de selección: %w", err)
	}
	if src == "" {
		return nil
	}

	if err := vault.VerifyBackupPassword(src, password); err != nil {
		return err
	}

	if err := a.vault.Close(); err != nil {
		return fmt.Errorf("app: cerrando vault actual: %w", err)
	}

	if err := vault.RestoreBackup(src); err != nil {
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
	a.metadataMu.Lock()
	delete(a.metadataCache, connID)
	a.metadataMu.Unlock()
	return nil
}

func (a *App) cachedMetadata(connID string) (*db.SchemaMetadata, bool) {
	a.metadataMu.Lock()
	defer a.metadataMu.Unlock()
	meta, ok := a.metadataCache[connID]
	return meta, ok
}

func (a *App) setCachedMetadata(connID string, meta *db.SchemaMetadata) {
	a.metadataMu.Lock()
	defer a.metadataMu.Unlock()
	a.metadataCache[connID] = meta
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

// ExportTableDDL writes table's CREATE TABLE statement (schema is only
// meaningful for Postgres) to a user-chosen .sql file.
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
		ddl, err = export.OracleTableDDL(a.ctx, pool, table)
	default:
		return "", fmt.Errorf("app: export de DDL no soportado para %q", dbType)
	}
	if err != nil {
		return "", err
	}

	return a.saveSQLTextAs("Exportar DDL de tabla", table+".sql", ddl)
}

// ExportSchemaDDL writes every table's DDL (schema is only meaningful for
// Postgres) to a user-chosen .sql file.
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
		ddl, err = export.OracleSchemaDDL(a.ctx, pool)
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
		case "table":
			return export.OracleTableDDL(a.ctx, pool, name)
		case "procedure":
			return export.OracleProcedureDDL(a.ctx, pool, name)
		case "function":
			return export.OracleFunctionDDL(a.ctx, pool, name)
		case "trigger":
			return export.OracleTriggerDDL(a.ctx, pool, name)
		case "package":
			return export.OraclePackageDDL(a.ctx, pool, name)
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
