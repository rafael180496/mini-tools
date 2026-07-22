package db

import (
	"fmt"
	"net/url"
	"strings"

	_ "github.com/microsoft/go-mssqldb"
)

type sqlserverConnector struct{}

func (sqlserverConnector) Type() DBType { return DBTypeSQLServer }

// BuildDSN builds a go-mssqldb URL DSN (sqlserver://user:pass@host:port/instance?database=...).
//
// Expects params: host, user (required), dbname (required — INFORMATION_SCHEMA
// is per-database, so metadata needs a concrete database in context, same as
// Postgres). Optional: password; port (default "1433", ignored when instance
// is set — a named instance is resolved by SQL Server Browser, not a fixed
// port); instance (named instance, goes in the URL path); encrypt
// (disable/false/true/strict — default "disable", matching the project's
// permissive internal-network posture, same as Oracle's InsecureIgnoreHostKey
// and the permissive CORS; harden per-connection when reaching a host outside
// that network); trustServerCertificate (true/false); appName.
//
// Azure AD / Windows integrated auth are deliberately out of scope for now —
// they need the go-mssqldb azuread/sspi sub-packages (extra deps + binary
// size). Only SQL Server authentication (user/password) is supported here.
func (sqlserverConnector) BuildDSN(params map[string]string) (string, error) {
	host := params["host"]
	if host == "" {
		return "", fmt.Errorf("sqlserver: falta el parámetro 'host'")
	}
	user := params["user"]
	if user == "" {
		return "", fmt.Errorf("sqlserver: falta el parámetro 'user'")
	}
	dbname := params["dbname"]
	if dbname == "" {
		return "", fmt.Errorf("sqlserver: falta el parámetro 'dbname'")
	}

	instance := params["instance"]
	hostPart := host
	// A named instance is resolved via the SQL Server Browser service, not a
	// fixed TCP port — setting a port alongside it would override that
	// resolution, so port only applies when no instance is given.
	if instance == "" {
		port := params["port"]
		if port == "" {
			port = "1433"
		}
		hostPart = fmt.Sprintf("%s:%s", host, port)
	}

	encrypt := params["encrypt"]
	if encrypt == "" {
		encrypt = "disable"
	}

	u := url.URL{
		Scheme: "sqlserver",
		User:   url.UserPassword(user, params["password"]),
		Host:   hostPart,
	}
	if instance != "" {
		u.Path = "/" + instance
	}

	q := url.Values{}
	q.Set("database", dbname)
	q.Set("encrypt", encrypt)
	if tsc := params["trustServerCertificate"]; tsc != "" {
		q.Set("TrustServerCertificate", tsc)
	}
	if appName := params["appName"]; appName != "" {
		q.Set("app name", appName)
	}
	u.RawQuery = q.Encode()

	return u.String(), nil
}

// ParseDSN reverses BuildDSN. Includes password — see the Connector interface
// doc comment for why stripping it is the caller's responsibility, not this
// function's.
func (sqlserverConnector) ParseDSN(dsn string) (map[string]string, error) {
	u, err := url.Parse(dsn)
	if err != nil {
		return nil, fmt.Errorf("sqlserver: parseando DSN: %w", err)
	}

	params := map[string]string{
		"host": u.Hostname(),
		"port": u.Port(),
	}
	if instance := strings.TrimPrefix(u.Path, "/"); instance != "" {
		params["instance"] = instance
	}
	if u.User != nil {
		params["user"] = u.User.Username()
		if pw, ok := u.User.Password(); ok {
			params["password"] = pw
		}
	}

	q := u.Query()
	if dbname := q.Get("database"); dbname != "" {
		params["dbname"] = dbname
	}
	if encrypt := q.Get("encrypt"); encrypt != "" {
		params["encrypt"] = encrypt
	}
	if tsc := q.Get("TrustServerCertificate"); tsc != "" {
		params["trustServerCertificate"] = tsc
	}
	if appName := q.Get("app name"); appName != "" {
		params["appName"] = appName
	}
	return params, nil
}
