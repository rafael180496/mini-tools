package db

import (
	"fmt"
	"path/filepath"

	_ "modernc.org/sqlite"
)

type sqliteConnector struct{}

func (sqliteConnector) Type() DBType { return DBTypeSQLite }

// BuildDSN expects params["path"], the .db/.sqlite file to open (created if
// it doesn't exist yet). WAL mode and a busy timeout are requested through
// the DSN itself (modernc.org/sqlite's `_pragma` query param) so every
// connection the pool opens gets them, not just the first — see spec's
// "SQLite modo WAL siempre activo".
func (sqliteConnector) BuildDSN(params map[string]string) (string, error) {
	path := params["path"]
	if path == "" {
		return "", fmt.Errorf("sqlite: falta el parámetro 'path'")
	}

	abs, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("sqlite: resolviendo path: %w", err)
	}

	return fmt.Sprintf("file://%s?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)", abs), nil
}
