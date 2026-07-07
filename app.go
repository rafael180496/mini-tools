package main

import (
	"context"
	"fmt"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"mini-tools/backend/db"
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
		gate:  vaultgate.New(),
		pools: db.NewPoolManager(),
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

// ExecuteQuery opens (or reuses) the pool for connID and streams the result
// of sqlText back as events under queryID. The frontend must call
// EventsOn(queryID, ...) before invoking this — see
// .claude/skills/mini-tools-patterns/SKILL.md.
func (a *App) ExecuteQuery(connID, queryID, sqlText string) error {
	if err := a.requireUnlocked(); err != nil {
		return err
	}

	if _, err := a.pools.Get(connID); err != nil {
		dbType, dsn, dsnErr := a.vault.ConnectionDSN(connID)
		if dsnErr != nil {
			return dsnErr
		}
		if _, openErr := a.pools.Open(connID, dbType, dsn); openErr != nil {
			return openErr
		}
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
