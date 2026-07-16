package export

import (
	"fmt"
	"net/url"
)

// RedactDSN parses dsn — every engine builds a URL-shaped DSN (see
// backend/db/{sqlite,postgres,oracle,redis,ssh}.go) — and returns it with
// credential material removed, for "export de conexión sin password: para
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

	// SSH can't fit its credential material into the URL userinfo above —
	// a private key is multi-line PEM text — so it travels in the query
	// string instead (see backend/db/ssh.go's BuildDSN). Strip it here too,
	// unconditionally re-encoding is harmless for every other engine, whose
	// DSNs never have these keys in the first place.
	q := u.Query()
	q.Del("password")
	q.Del("privateKey")
	q.Del("passphrase")
	u.RawQuery = q.Encode()

	return u.String(), nil
}
