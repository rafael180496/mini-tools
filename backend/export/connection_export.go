package export

import (
	"fmt"
	"net/url"
)

// RedactDSN parses dsn — all 3 engines build URL-shaped DSNs (see
// backend/db/{sqlite,postgres,oracle}.go) — and returns it with the
// password component removed, for "export de conexión sin password: para
// compartir config". SQLite DSNs never carry a password so this is a
// no-op for them beyond round-tripping through url.Parse/String.
func RedactDSN(dsn string) (string, error) {
	u, err := url.Parse(dsn)
	if err != nil {
		return "", fmt.Errorf("export: parseando dsn: %w", err)
	}

	if u.User != nil {
		if username := u.User.Username(); username != "" {
			u.User = url.User(username)
		} else {
			u.User = nil
		}
	}

	return u.String(), nil
}
