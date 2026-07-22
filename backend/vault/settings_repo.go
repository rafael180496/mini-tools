package vault

import (
	"database/sql"
	"encoding/json"
	"fmt"
)

// OpenTabInfo is one restorable editor tab: its file path, plus which
// connection/language it was bound to (both optional — a tab can be
// unbound). See SetOpenTabs.
type OpenTabInfo struct {
	Path string `json:"path"`
	// ConnID is empty when the tab has no connection bound — never
	// resolved/validated here, the frontend drops the binding on restore if
	// the connection no longer exists (same "no code needed, the pool
	// simply never opens" story DeleteConnection cleanup already relies on).
	ConnID string `json:"connId,omitempty"`
	// Language is only meaningful while ConnID is empty (an unbound tab's
	// manually-picked editor language) — once a connection is bound, the
	// frontend derives the language from that connection's dbType instead
	// of trusting whatever was last persisted here.
	Language string `json:"language,omitempty"`
	// Kind distinguishes a plain CodeMirror editor tab ("", the zero value
	// — read as "editor") from a Redis Browser tab ("redis-browser"),
	// which has no file content to restore, only a ConnID to reopen
	// against.
	Kind string `json:"kind,omitempty"`
}

// Settings holds non-sensitive app preferences. Unlike connections'
// encrypted_dsn, nothing here is encrypted — see the settings table comment
// in store.go for why it's readable/writable even while the vault is
// locked.
type Settings struct {
	Theme string `json:"theme"`
	// OpenTabs is the last known set of open editor tabs (path + optional
	// connection/language binding), in tab order, so the workspace can
	// restore them on the next launch — see SetOpenTabs.
	OpenTabs []OpenTabInfo `json:"openTabs"`
	// SidebarCollapsed persists the connection tree's icon-only rail mode
	// (toggled in the sidebar header) — see SetSidebarCollapsed.
	SidebarCollapsed bool `json:"sidebarCollapsed"`
	// EditorHeight is the SQL editor pane's height in pixels, dragged via
	// the resize handle between the editor and the results grid — see
	// SetEditorHeight. Defaults to 256 (the old fixed h-64 Tailwind class).
	EditorHeight int `json:"editorHeight"`
	// RememberMasterKey reflects the "Recordar clave" toggle — whether
	// TryAutoUnlock should try the OS keychain at startup. The flag itself
	// is harmless to read while locked (it's just an on/off preference);
	// the actual secret it gates lives only in the OS keychain, never here
	// — see backend/vault/remember.go.
	RememberMasterKey bool `json:"rememberMasterKey"`
	// EditorTheme is the CodeMirror color theme id (one of
	// frontend/src/codemirror/themes.ts's registry, e.g. "auto",
	// "githubDark", "dracula") — "auto" (the default) follows the app's own
	// dark/light Theme above instead of naming a fixed CodeMirror theme.
	EditorTheme string `json:"editorTheme"`
	// CollapsedSidebarModules is which sidebar module ids (e.g.
	// "connections") the user has collapsed to an accordion header —
	// unrelated to SidebarCollapsed above, which is the whole-sidebar
	// icon-only rail toggle. A JSON array (not a single bool) because more
	// modules besides "connections" are expected later. See
	// SetCollapsedSidebarModules.
	CollapsedSidebarModules []string `json:"collapsedSidebarModules"`
	// SshTerminalTheme is the xterm.js color theme id (one of
	// frontend/src/xterm/terminalThemes.ts's registry, e.g. "auto",
	// "dracula", "nord") — same "auto follows the app's own dark/light
	// Theme" convention as EditorTheme above, just for the SSH terminal
	// instead of the SQL editor. One global setting, not per-connection —
	// same reasoning as EditorTheme.
	SshTerminalTheme string `json:"sshTerminalTheme"`
	// AutoBackupEnabled reflects the "Backup automático" toggle — whether
	// backend/autobackup.Scheduler should be ticking for this install. See
	// SetAutoBackupEnabled.
	AutoBackupEnabled bool `json:"autoBackupEnabled"`
	// AutoBackupIntervalHours is how often the automatic backup runs, in
	// hours (see MinAutoBackupIntervalHours/MaxAutoBackupIntervalHours).
	// Validated in SetAutoBackupIntervalHours, not here.
	AutoBackupIntervalHours int `json:"autoBackupIntervalHours"`
	// AutoBackupPath is the destination folder for the automatic backup —
	// the scheduler always writes the same fixed filename there, replacing
	// the previous run (unlike the timestamped manual backup from
	// BackupVault). Empty until the user picks a folder via
	// PickAutoBackupFolder; the scheduler treats an empty path as "not
	// configured yet" and stays stopped even if AutoBackupEnabled is true.
	AutoBackupPath string `json:"autoBackupPath"`
	// AutoSaveEnabled reflects the "Auto-guardar editores" toggle — whether
	// the frontend should periodically write dirty tabs that have a file path
	// back to disk. Unlike auto-backup there's no Go-side scheduler; the timer
	// lives in the frontend (Workspace.tsx), this is just the persisted
	// preference. See SetAutoSaveEnabled.
	AutoSaveEnabled bool `json:"autoSaveEnabled"`
	// AutoSaveIntervalSeconds is how often the frontend's auto-save timer
	// fires, in seconds (validated in SetAutoSaveIntervalSeconds against the
	// Min/Max bounds below).
	AutoSaveIntervalSeconds int `json:"autoSaveIntervalSeconds"`
}

// AutoBackupIntervalHours must fall within these bounds — the scheduler
// (backend/autobackup) ticks on an interval that has to be a positive,
// bounded number of hours to make sense as a "every X hours" <select>
// (1..23, not 24 — "every 24h" and "every 0h/disabled" would be
// redundant/ambiguous).
const (
	MinAutoBackupIntervalHours = 1
	MaxAutoBackupIntervalHours = 23
)

// AutoSaveIntervalSeconds bounds — a positive, sane range for a "save every X
// seconds" timer (5s..600s = 10min); anything faster thrashes the disk, slower
// than 10min defeats the purpose.
const (
	MinAutoSaveIntervalSeconds = 5
	MaxAutoSaveIntervalSeconds = 600
)

// GetSettings returns the single settings row, seeded with defaults by Open.
func (s *Store) GetSettings() (Settings, error) {
	var theme string
	var openTabsJSON sql.NullString
	var sidebarCollapsed bool
	var editorHeight int
	var rememberMasterKey bool
	var editorTheme string
	var collapsedModulesJSON sql.NullString
	var sshTerminalTheme string
	var autoBackupEnabled bool
	var autoBackupIntervalHours int
	var autoBackupPath string
	var autoSaveEnabled bool
	var autoSaveIntervalSeconds int
	if err := s.db.QueryRow(
		`SELECT theme, open_tabs, sidebar_collapsed, editor_height, remember_master_key, editor_theme, collapsed_sidebar_modules, ssh_terminal_theme, auto_backup_enabled, auto_backup_interval_hours, auto_backup_path, auto_save_enabled, auto_save_interval_seconds FROM settings WHERE id = 1`,
	).Scan(
		&theme, &openTabsJSON, &sidebarCollapsed, &editorHeight, &rememberMasterKey, &editorTheme, &collapsedModulesJSON, &sshTerminalTheme, &autoBackupEnabled, &autoBackupIntervalHours, &autoBackupPath, &autoSaveEnabled, &autoSaveIntervalSeconds,
	); err != nil {
		return Settings{}, fmt.Errorf("vault: leyendo settings: %w", err)
	}

	var openTabs []OpenTabInfo
	if openTabsJSON.Valid && openTabsJSON.String != "" {
		if err := json.Unmarshal([]byte(openTabsJSON.String), &openTabs); err != nil {
			// Backward compatibility: vault.db installs already in the wild
			// (see .claude/rules/technical.md point 13) have open_tabs
			// persisted as a plain []string from before tabs could bind a
			// connection/language. Fall back to that shape instead of
			// erroring out and losing the user's restored tabs on upgrade.
			var legacy []string
			if err2 := json.Unmarshal([]byte(openTabsJSON.String), &legacy); err2 != nil {
				return Settings{}, fmt.Errorf("vault: parseando open_tabs: %w", err)
			}
			openTabs = make([]OpenTabInfo, len(legacy))
			for i, p := range legacy {
				openTabs[i] = OpenTabInfo{Path: p}
			}
		}
	}

	var collapsedModules []string
	if collapsedModulesJSON.Valid && collapsedModulesJSON.String != "" {
		if err := json.Unmarshal([]byte(collapsedModulesJSON.String), &collapsedModules); err != nil {
			return Settings{}, fmt.Errorf("vault: parseando collapsed_sidebar_modules: %w", err)
		}
	}

	return Settings{
		Theme: theme, OpenTabs: openTabs, SidebarCollapsed: sidebarCollapsed,
		EditorHeight: editorHeight, RememberMasterKey: rememberMasterKey,
		EditorTheme: editorTheme, CollapsedSidebarModules: collapsedModules,
		SshTerminalTheme: sshTerminalTheme,
		AutoBackupEnabled: autoBackupEnabled, AutoBackupIntervalHours: autoBackupIntervalHours,
		AutoBackupPath:          autoBackupPath,
		AutoSaveEnabled:         autoSaveEnabled,
		AutoSaveIntervalSeconds: autoSaveIntervalSeconds,
	}, nil
}

// SetTheme persists the theme preference ("dark" or "light").
func (s *Store) SetTheme(theme string) error {
	if theme != "dark" && theme != "light" {
		return fmt.Errorf("vault: tema inválido %q", theme)
	}
	if _, err := s.db.Exec(`UPDATE settings SET theme = ? WHERE id = 1`, theme); err != nil {
		return fmt.Errorf("vault: guardando tema: %w", err)
	}
	return nil
}

// SetOpenTabs persists the current set of open editor tabs (path plus
// optional connection/language binding, in tab order) so Workspace.tsx can
// restore them the next time the app starts. Only tabs with a path are
// ever included — an unsaved scratch tab has nothing on disk to reopen, so
// its binding is session-only by the same logic.
func (s *Store) SetOpenTabs(tabs []OpenTabInfo) error {
	encoded, err := json.Marshal(tabs)
	if err != nil {
		return fmt.Errorf("vault: serializando open_tabs: %w", err)
	}
	if _, err := s.db.Exec(`UPDATE settings SET open_tabs = ? WHERE id = 1`, string(encoded)); err != nil {
		return fmt.Errorf("vault: guardando open_tabs: %w", err)
	}
	return nil
}

// SetSidebarCollapsed persists whether the connection tree is showing as a
// full sidebar or an icon-only rail.
func (s *Store) SetSidebarCollapsed(collapsed bool) error {
	if _, err := s.db.Exec(`UPDATE settings SET sidebar_collapsed = ? WHERE id = 1`, collapsed); err != nil {
		return fmt.Errorf("vault: guardando sidebar_collapsed: %w", err)
	}
	return nil
}

// SetEditorHeight persists the SQL editor pane's height in pixels. The
// frontend clamps the value while dragging (see Workspace.tsx) — this is
// just storage, no range validation here.
func (s *Store) SetEditorHeight(height int) error {
	if _, err := s.db.Exec(`UPDATE settings SET editor_height = ? WHERE id = 1`, height); err != nil {
		return fmt.Errorf("vault: guardando editor_height: %w", err)
	}
	return nil
}

// SetEditorTheme persists the CodeMirror theme id. No validation against a
// fixed list here — the registry of valid ids lives in
// frontend/src/codemirror/themes.ts, and an unrecognized id just falls back
// to "auto" there, same "storage only" reasoning as SetEditorHeight.
func (s *Store) SetEditorTheme(theme string) error {
	if _, err := s.db.Exec(`UPDATE settings SET editor_theme = ? WHERE id = 1`, theme); err != nil {
		return fmt.Errorf("vault: guardando editor_theme: %w", err)
	}
	return nil
}

// SetSshTerminalTheme persists the xterm.js theme id. No validation against
// a fixed list here, same "storage only" reasoning as SetEditorTheme — the
// registry of valid ids lives in frontend/src/xterm/terminalThemes.ts, and
// an unrecognized id just falls back to "auto" there.
func (s *Store) SetSshTerminalTheme(theme string) error {
	if _, err := s.db.Exec(`UPDATE settings SET ssh_terminal_theme = ? WHERE id = 1`, theme); err != nil {
		return fmt.Errorf("vault: guardando ssh_terminal_theme: %w", err)
	}
	return nil
}

// SetAutoBackupEnabled persists the "Backup automático" toggle. Storage
// only — App.SetAutoBackupEnabled is responsible for telling
// backend/autobackup.Scheduler to start/stop after this succeeds.
func (s *Store) SetAutoBackupEnabled(enabled bool) error {
	if _, err := s.db.Exec(`UPDATE settings SET auto_backup_enabled = ? WHERE id = 1`, enabled); err != nil {
		return fmt.Errorf("vault: guardando auto_backup_enabled: %w", err)
	}
	return nil
}

// SetAutoBackupIntervalHours persists how often the automatic backup runs.
// Unlike SetEditorHeight/SetEditorTheme (storage only), this DOES validate
// the range: an out-of-range value would feed
// autobackup.Scheduler.Reconfigure a nonsensical duration — 0 or negative
// hours panics time.NewTicker.
func (s *Store) SetAutoBackupIntervalHours(hours int) error {
	if hours < MinAutoBackupIntervalHours || hours > MaxAutoBackupIntervalHours {
		return fmt.Errorf("vault: intervalo de backup automático inválido: %d (debe ser entre %d y %d horas)", hours, MinAutoBackupIntervalHours, MaxAutoBackupIntervalHours)
	}
	if _, err := s.db.Exec(`UPDATE settings SET auto_backup_interval_hours = ? WHERE id = 1`, hours); err != nil {
		return fmt.Errorf("vault: guardando auto_backup_interval_hours: %w", err)
	}
	return nil
}

// SetAutoBackupPath persists the automatic backup's destination folder. No
// existence check here — App.PickAutoBackupFolder only ever passes a path
// the OS's native picker just returned, which by construction exists and is
// a directory.
func (s *Store) SetAutoBackupPath(path string) error {
	if _, err := s.db.Exec(`UPDATE settings SET auto_backup_path = ? WHERE id = 1`, path); err != nil {
		return fmt.Errorf("vault: guardando auto_backup_path: %w", err)
	}
	return nil
}

// SetAutoSaveEnabled persists the "Auto-guardar editores" toggle. Storage only
// — the timer that acts on it lives entirely in the frontend (Workspace.tsx),
// so there's nothing server-side to reconfigure.
func (s *Store) SetAutoSaveEnabled(enabled bool) error {
	if _, err := s.db.Exec(`UPDATE settings SET auto_save_enabled = ? WHERE id = 1`, enabled); err != nil {
		return fmt.Errorf("vault: guardando auto_save_enabled: %w", err)
	}
	return nil
}

// SetAutoSaveIntervalSeconds persists the auto-save cadence, validating the
// range (a 0/negative interval would make setInterval useless / thrash).
func (s *Store) SetAutoSaveIntervalSeconds(seconds int) error {
	if seconds < MinAutoSaveIntervalSeconds || seconds > MaxAutoSaveIntervalSeconds {
		return fmt.Errorf("vault: intervalo de auto-guardado inválido: %d (debe ser entre %d y %d segundos)", seconds, MinAutoSaveIntervalSeconds, MaxAutoSaveIntervalSeconds)
	}
	if _, err := s.db.Exec(`UPDATE settings SET auto_save_interval_seconds = ? WHERE id = 1`, seconds); err != nil {
		return fmt.Errorf("vault: guardando auto_save_interval_seconds: %w", err)
	}
	return nil
}

// SetCollapsedSidebarModules persists which sidebar module ids are
// collapsed to an accordion header.
func (s *Store) SetCollapsedSidebarModules(ids []string) error {
	encoded, err := json.Marshal(ids)
	if err != nil {
		return fmt.Errorf("vault: serializando collapsed_sidebar_modules: %w", err)
	}
	if _, err := s.db.Exec(`UPDATE settings SET collapsed_sidebar_modules = ? WHERE id = 1`, string(encoded)); err != nil {
		return fmt.Errorf("vault: guardando collapsed_sidebar_modules: %w", err)
	}
	return nil
}
