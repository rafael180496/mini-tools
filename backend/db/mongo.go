package db

import (
	"fmt"
	"net/url"
	"strings"
)

// MongoMode selects between a standard connection and a DNS-seedlist (SRV)
// one. Unlike Redis's mode (which travels in a "mode" query param), MongoDB
// consumes the DSN URI directly via the driver's ApplyURI, and that parser
// rejects unknown URI options — so the mode is NOT stored as a query param.
// It's inferred back from the URI scheme instead (mongodb:// vs
// mongodb+srv://), the same "infer from the URI shape" approach oracle.go
// uses. See .claude/skills/mini-tools-patterns/SKILL.md's MongoDB section.
type MongoMode string

const (
	MongoModeStandard MongoMode = "standard"
	MongoModeSRV      MongoMode = "srv"
)

type mongoConnector struct{}

func (mongoConnector) Type() DBType { return DBTypeMongo }

// BuildDSN builds a MongoDB connection URI the official driver can ApplyURI:
//
//   - "standard" (default): mongodb://[user:pass@]host:port[,host2:port2...]/[db]?opts
//     Needs "host" (+ optional "port", default "27017"); OR "hosts" (a
//     comma-separated host:port list, for a replica set / mongos set — put in
//     the URI authority, since the driver requires the hosts there and won't
//     read a custom query param the way go-redis does for Redis clusters).
//   - "srv" (Atlas-style): mongodb+srv://[user:pass@]host/[db]?opts — a single
//     DNS seedlist host, no port (the SRV record supplies the nodes).
//
// All modes accept optional "user"/"password", "database" (the default
// database; optional — the sidebar browses every database regardless),
// "authSource", "replicaSet", and "tls" ("true"). Only real MongoDB URI
// options are emitted into the query string, never a synthetic "mode".
func (mongoConnector) BuildDSN(params map[string]string) (string, error) {
	mode := MongoMode(params["mode"])
	if mode == "" {
		mode = MongoModeStandard
	}

	scheme := "mongodb"
	if mode == MongoModeSRV {
		scheme = "mongodb+srv"
	}

	var authority string
	switch mode {
	case MongoModeStandard:
		if hosts := strings.TrimSpace(params["hosts"]); hosts != "" {
			authority = normalizeHostList(hosts)
		} else {
			host := params["host"]
			if host == "" {
				return "", fmt.Errorf("mongodb: falta el parámetro 'host'")
			}
			port := params["port"]
			if port == "" {
				port = "27017"
			}
			authority = host + ":" + port
		}
	case MongoModeSRV:
		host := params["host"]
		if host == "" {
			return "", fmt.Errorf("mongodb: falta el parámetro 'host' para el modo srv")
		}
		// An SRV host must not carry a port — the DNS seedlist supplies it.
		authority = strings.SplitN(host, ":", 2)[0]
	default:
		return "", fmt.Errorf("mongodb: modo de conexión desconocido %q (usar standard o srv)", params["mode"])
	}

	u := url.URL{Scheme: scheme, Host: authority}
	if user := params["user"]; user != "" || params["password"] != "" {
		u.User = url.UserPassword(user, params["password"])
	}
	if db := params["database"]; db != "" {
		u.Path = "/" + db
	}

	q := url.Values{}
	if rs := params["replicaSet"]; rs != "" {
		q.Set("replicaSet", rs)
	}
	if as := params["authSource"]; as != "" {
		q.Set("authSource", as)
	}
	if params["tls"] == "true" {
		q.Set("tls", "true")
	}
	u.RawQuery = q.Encode()

	return u.String(), nil
}

// ParseDSN reverses BuildDSN. Includes password — see the Connector interface
// doc comment for why stripping it is the caller's responsibility. The host
// authority is read from u.Host directly (not u.Hostname()/u.Port(), which
// mis-split a multi-host "h1:27017,h2:27017" authority).
func (mongoConnector) ParseDSN(dsn string) (map[string]string, error) {
	u, err := url.Parse(dsn)
	if err != nil {
		return nil, fmt.Errorf("mongodb: parseando DSN: %w", err)
	}

	params := map[string]string{}
	if u.Scheme == "mongodb+srv" {
		params["mode"] = string(MongoModeSRV)
	} else {
		params["mode"] = string(MongoModeStandard)
	}

	if u.User != nil {
		params["user"] = u.User.Username()
		if pw, ok := u.User.Password(); ok {
			params["password"] = pw
		}
	}

	authority := u.Host
	switch {
	case params["mode"] == string(MongoModeSRV):
		params["host"] = authority
	case strings.Contains(authority, ","):
		params["hosts"] = authority
	default:
		host, port := splitHostPort(authority)
		params["host"] = host
		if port != "" {
			params["port"] = port
		}
	}

	if db := strings.TrimPrefix(u.Path, "/"); db != "" {
		params["database"] = db
	}

	q := u.Query()
	if rs := q.Get("replicaSet"); rs != "" {
		params["replicaSet"] = rs
	}
	if as := q.Get("authSource"); as != "" {
		params["authSource"] = as
	}
	if q.Get("tls") == "true" {
		params["tls"] = "true"
	}
	return params, nil
}

// normalizeHostList trims each entry of a comma-separated host[:port] list and
// rejoins it — the entries stay in the URI authority verbatim (MongoDB's URI
// format keeps every seed host there, unlike Redis which moves them to a query
// param).
func normalizeHostList(list string) string {
	parts := strings.Split(list, ",")
	out := parts[:0]
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, ",")
}

// splitHostPort splits a single "host:port" authority, returning an empty port
// when none is present. Not used for multi-host authorities (see ParseDSN).
func splitHostPort(authority string) (host, port string) {
	if i := strings.LastIndex(authority, ":"); i >= 0 {
		return authority[:i], authority[i+1:]
	}
	return authority, ""
}
