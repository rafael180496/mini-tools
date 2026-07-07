package db

import (
	"fmt"
	"net/url"
	"strings"

	_ "github.com/jackc/pgx/v5/stdlib"
)

type postgresConnector struct{}

func (postgresConnector) Type() DBType { return DBTypePostgres }

// BuildDSN expects params: host, user, dbname (required), port (default
// "5432"), password, sslmode (default "prefer" — any value pgx/libpq
// accepts: disable, allow, prefer, require, verify-ca, verify-full — see
// spec's "Postgres soporta el set completo de SSL modes").
func (postgresConnector) BuildDSN(params map[string]string) (string, error) {
	host := params["host"]
	if host == "" {
		return "", fmt.Errorf("postgres: falta el parámetro 'host'")
	}
	user := params["user"]
	if user == "" {
		return "", fmt.Errorf("postgres: falta el parámetro 'user'")
	}
	dbname := params["dbname"]
	if dbname == "" {
		return "", fmt.Errorf("postgres: falta el parámetro 'dbname'")
	}

	port := params["port"]
	if port == "" {
		port = "5432"
	}
	sslmode := params["sslmode"]
	if sslmode == "" {
		sslmode = "prefer"
	}

	u := url.URL{
		Scheme: "postgres",
		User:   url.UserPassword(user, params["password"]),
		Host:   fmt.Sprintf("%s:%s", host, port),
		Path:   "/" + dbname,
	}
	q := url.Values{}
	q.Set("sslmode", sslmode)
	u.RawQuery = q.Encode()

	return u.String(), nil
}

// ParseDSN reverses BuildDSN. Includes password — see the Connector
// interface doc comment for why that's the caller's responsibility to
// strip, not this function's.
func (postgresConnector) ParseDSN(dsn string) (map[string]string, error) {
	u, err := url.Parse(dsn)
	if err != nil {
		return nil, fmt.Errorf("postgres: parseando DSN: %w", err)
	}

	params := map[string]string{
		"host":   u.Hostname(),
		"port":   u.Port(),
		"dbname": strings.TrimPrefix(u.Path, "/"),
	}
	if u.User != nil {
		params["user"] = u.User.Username()
		if pw, ok := u.User.Password(); ok {
			params["password"] = pw
		}
	}
	if sslmode := u.Query().Get("sslmode"); sslmode != "" {
		params["sslmode"] = sslmode
	}
	return params, nil
}
