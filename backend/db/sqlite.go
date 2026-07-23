package db

import (
	"fmt"
	"net/url"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

type sqliteConnector struct{}

func (sqliteConnector) Type() DBType { return DBTypeSQLite }

// BuildDSN expects params["path"], the .db/.sqlite file to open (created if
// it doesn't exist yet). WAL mode and a busy timeout are requested through
// the DSN itself (modernc.org/sqlite's `_pragma` query param) so every
// connection the pool opens gets them, not just the first — see spec's
// "SQLite modo WAL siempre activo".
//
// An optional params["sqlcipher_key"] marks the file as SQLCipher-encrypted
// and carries the passphrase (or raw key). It is folded into the DSN — which
// is encrypted at rest in the vault, so the key never lives in plaintext and
// never reaches the frontend (rule #9). The pool decrypts to a temporary
// plaintext copy at connect time (see materializeDSN); modernc.org/sqlite
// itself has no idea about encryption.
func (sqliteConnector) BuildDSN(params map[string]string) (string, error) {
	path := params["path"]
	if path == "" {
		return "", fmt.Errorf("sqlite: falta el parámetro 'path'")
	}

	abs, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("sqlite: resolviendo path: %w", err)
	}

	dsn := fmt.Sprintf("file://%s?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)", abs)
	if key := params["sqlcipher_key"]; key != "" {
		// url.QueryEscape keeps a key with special characters intact through
		// the round-trip. sqlcipher_key is a marker AND the secret; its mere
		// presence is what routes the connection through decryption.
		dsn += "&sqlcipher_key=" + url.QueryEscape(key)
	}
	return dsn, nil
}

// ParseDSN reverses BuildDSN. It returns sqlcipher_key when present so the
// "edit connection" form can tell the DB is encrypted — the App boundary
// strips it before anything reaches the frontend, exactly like a password
// (see app.go's GetConnectionForEdit).
func (sqliteConnector) ParseDSN(dsn string) (map[string]string, error) {
	trimmed := strings.TrimPrefix(dsn, "file://")
	path := trimmed
	var key string
	if idx := strings.IndexByte(trimmed, '?'); idx != -1 {
		path = trimmed[:idx]
		if q, err := url.ParseQuery(trimmed[idx+1:]); err == nil {
			key = q.Get("sqlcipher_key")
		}
	}
	if path == "" {
		return nil, fmt.Errorf("sqlite: no se pudo interpretar el DSN")
	}
	out := map[string]string{"path": path}
	if key != "" {
		out["sqlcipher_key"] = key
	}
	return out, nil
}

// sqliteEncryptedSource returns the source path and key if dsn is an encrypted
// SQLite DSN, or ok=false for a plain one. Kept next to the connector so the
// DSN format has a single owner.
func sqliteEncryptedSource(dsn string) (path, key string, ok bool) {
	idx := strings.IndexByte(dsn, '?')
	if idx == -1 {
		return "", "", false
	}
	q, err := url.ParseQuery(dsn[idx+1:])
	if err != nil {
		return "", "", false
	}
	key = q.Get("sqlcipher_key")
	if key == "" {
		return "", "", false
	}
	path = strings.TrimPrefix(dsn[:idx], "file://")
	return path, key, true
}
