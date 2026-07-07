package db

import (
	"fmt"
	"strconv"

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
