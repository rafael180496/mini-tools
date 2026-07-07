package vault

import (
	"database/sql"
	"encoding/json"
	"fmt"
)

// Settings holds non-sensitive app preferences. Unlike connections'
// encrypted_dsn, nothing here is encrypted — see the settings table comment
// in store.go for why it's readable/writable even while the vault is
// locked.
type Settings struct {
	Theme string `json:"theme"`
	// OpenTabs is the last known set of open editor tab file paths, in tab
	// order, so the workspace can restore them on the next launch — see
	// SetOpenTabs.
	OpenTabs []string `json:"openTabs"`
}

// GetSettings returns the single settings row, seeded with defaults by Open.
func (s *Store) GetSettings() (Settings, error) {
	var theme string
	var openTabsJSON sql.NullString
	if err := s.db.QueryRow(`SELECT theme, open_tabs FROM settings WHERE id = 1`).Scan(&theme, &openTabsJSON); err != nil {
		return Settings{}, fmt.Errorf("vault: leyendo settings: %w", err)
	}

	var openTabs []string
	if openTabsJSON.Valid && openTabsJSON.String != "" {
		if err := json.Unmarshal([]byte(openTabsJSON.String), &openTabs); err != nil {
			return Settings{}, fmt.Errorf("vault: parseando open_tabs: %w", err)
		}
	}

	return Settings{Theme: theme, OpenTabs: openTabs}, nil
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

// SetOpenTabs persists the current set of open editor tabs (by file path,
// in tab order) so Workspace.tsx can restore them the next time the app
// starts. Paths only, never tab content — an unsaved scratch tab has
// nothing on disk to reopen, so it's simply not included.
func (s *Store) SetOpenTabs(paths []string) error {
	encoded, err := json.Marshal(paths)
	if err != nil {
		return fmt.Errorf("vault: serializando open_tabs: %w", err)
	}
	if _, err := s.db.Exec(`UPDATE settings SET open_tabs = ? WHERE id = 1`, string(encoded)); err != nil {
		return fmt.Errorf("vault: guardando open_tabs: %w", err)
	}
	return nil
}
