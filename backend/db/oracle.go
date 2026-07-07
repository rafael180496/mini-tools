package db

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"

	go_ora "github.com/sijms/go-ora/v2"
)

type oracleConnector struct{}

func (oracleConnector) Type() DBType { return DBTypeOracle }

// BuildDSN supports the 4 connect modes from the spec via params["mode"]:
//
//   - "service_name" / "easy_connect": functionally identical here — Oracle's
//     Easy Connect syntax IS host:port/service_name. Needs "service".
//   - "sid": needs "sid" instead of "service".
//   - "tns": a full connect descriptor pasted from tnsnames.ora, e.g.
//     "(DESCRIPTION=(ADDRESS=(HOST=...)(PORT=...))(CONNECT_DATA=(SERVICE_NAME=...)))",
//     needs "connectDescriptor". host/port are still required to form a
//     well-formed DSN URL, but the descriptor is what actually drives routing.
//
// All modes need host, user, password; port defaults to 1521.
func (oracleConnector) BuildDSN(params map[string]string) (string, error) {
	host := params["host"]
	if host == "" {
		return "", fmt.Errorf("oracle: falta el parámetro 'host'")
	}
	user := params["user"]
	if user == "" {
		return "", fmt.Errorf("oracle: falta el parámetro 'user'")
	}

	portStr := params["port"]
	if portStr == "" {
		portStr = "1521"
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		return "", fmt.Errorf("oracle: 'port' inválido: %w", err)
	}

	password := params["password"]

	switch params["mode"] {
	case "", "service_name", "easy_connect":
		service := params["service"]
		if service == "" {
			return "", fmt.Errorf("oracle: falta el parámetro 'service' para el modo service_name/easy_connect")
		}
		return go_ora.BuildUrl(host, port, service, user, password, nil), nil

	case "sid":
		sid := params["sid"]
		if sid == "" {
			return "", fmt.Errorf("oracle: falta el parámetro 'sid' para el modo sid")
		}
		return go_ora.BuildUrl(host, port, "", user, password, map[string]string{"SID": sid}), nil

	case "tns":
		descriptor := params["connectDescriptor"]
		if descriptor == "" {
			return "", fmt.Errorf("oracle: falta el parámetro 'connectDescriptor' para el modo tns")
		}
		return go_ora.BuildUrl(host, port, "", user, password, map[string]string{"connStr": descriptor}), nil

	default:
		return "", fmt.Errorf("oracle: modo de conexión desconocido %q (usar service_name, easy_connect, sid o tns)", params["mode"])
	}
}

// ParseDSN reverses BuildDSN. go_ora.BuildUrl always produces a standard
// oracle://user:pass@host:port/service?KEY=val URL (see connection_string.go
// in the go-ora module), so net/url.Parse handles it directly — mode isn't
// stored anywhere explicit, it's inferred back from which query param is
// present (SID vs connStr vs neither). Includes password — see the
// Connector interface doc comment for why that's the caller's
// responsibility to strip, not this function's. Not verified against a
// real Oracle instance — see .claude/skills/mini-tools-patterns/SKILL.md.
func (oracleConnector) ParseDSN(dsn string) (map[string]string, error) {
	u, err := url.Parse(dsn)
	if err != nil {
		return nil, fmt.Errorf("oracle: parseando DSN: %w", err)
	}

	params := map[string]string{
		"host": u.Hostname(),
		"port": u.Port(),
	}
	if u.User != nil {
		params["user"] = u.User.Username()
		if pw, ok := u.User.Password(); ok {
			params["password"] = pw
		}
	}

	q := u.Query()
	switch {
	case q.Get("SID") != "":
		params["mode"] = "sid"
		params["sid"] = q.Get("SID")
	case q.Get("connStr") != "":
		params["mode"] = "tns"
		params["connectDescriptor"] = q.Get("connStr")
	default:
		params["mode"] = "service_name"
		params["service"] = strings.TrimPrefix(u.Path, "/")
	}
	return params, nil
}
