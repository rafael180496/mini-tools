package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"mini-tools/backend/db"
	"mini-tools/backend/export"
	"mini-tools/backend/query"
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
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{
		gate:          vaultgate.New(),
		pools:         db.NewPoolManager(),
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
	a.executor = query.NewExecutor(
		ctx, a.pools,
		func(event string, data interface{}) {
			runtime.EventsEmit(ctx, event, data)
		},
		func(connID, sqlText, status string, rowsAffected, durationMs int64, errMsg string) {
			// Best-effort: a failure to persist history shouldn't affect the
			// query result the user already saw.
			_ = a.vault.RecordQueryHistory(connID, sqlText, status, rowsAffected, durationMs, errMsg)
		},
	)
}

// shutdown closes every open connection pool cleanly.
func (a *App) shutdown(ctx context.Context) {
	a.pools.CloseAll()
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

	return db.Ping(dbType, dsn)
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
		if err := db.Ping(dbType, dsn); err != nil {
			return nil, fmt.Errorf("ping falló (guarda con force=true para omitir): %w", err)
		}
	}

	return a.vault.SaveConnection(cfg.Name, dbType, dsn)
}

// ListConnections returns every saved connection, without DSNs, for the
// sidebar tree.
func (a *App) ListConnections() ([]vault.ConnectionSummary, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.ListConnections()
}

// DeleteConnection closes any open pool for id and removes it from the
// vault.
func (a *App) DeleteConnection(id string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if err := a.pools.Close(id); err != nil {
		return err
	}
	return a.vault.DeleteConnection(id)
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

// ExecuteQuery opens (or reuses) the pool for connID and streams the result
// of sqlText back as events under queryID. The frontend must call
// EventsOn(queryID, ...) before invoking this — see
// .claude/skills/mini-tools-patterns/SKILL.md.
func (a *App) ExecuteQuery(connID, queryID, sqlText string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}
	if err := a.ensurePoolOpen(connID); err != nil {
		return err
	}

	a.executor.Execute(connID, queryID, sqlText)
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

// ListQueryHistory returns the most recent statements run against connID,
// newest first.
func (a *App) ListQueryHistory(connID string, limit int) ([]vault.HistoryEntry, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}
	return a.vault.ListQueryHistory(connID, limit)
}

// BackupVault prompts for a destination and writes a full vault backup
// (encrypted connections + salt) there. Returns "" without an error if the
// user cancels the save dialog.
func (a *App) BackupVault() (string, error) {
	if err := a.requireUnlocked(); err != nil {
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
// Returns without an error if the user cancels the open dialog.
func (a *App) RestoreVaultBackup() error {
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

// GetSchemaMetadata returns connID's tables/columns/FKs, from an in-memory
// cache unless forceRefresh is set (spec: "cache de metadata por conexión,
// refresh manual (botón/F5)").
func (a *App) GetSchemaMetadata(connID string, forceRefresh bool) (*db.SchemaMetadata, error) {
	if err := a.requireUnlocked(); err != nil {
		return nil, err
	}

	if !forceRefresh {
		if cached, ok := a.cachedMetadata(connID); ok {
			return cached, nil
		}
	}

	pool, dbType, err := a.poolAndType(connID)
	if err != nil {
		return nil, err
	}

	meta, err := db.FetchSchemaMetadata(a.ctx, pool, dbType)
	if err != nil {
		return nil, err
	}

	a.setCachedMetadata(connID, meta)
	return meta, nil
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
