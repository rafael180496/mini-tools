package db

import (
	"fmt"
	"net"
	"net/url"
)

// SSH auth methods — see sshConnector.BuildDSN. Agent Forwarding is a
// separate, orthogonal flag (params["agentForwarding"]), not a third auth
// method: it controls whether the local SSH agent socket is forwarded to
// the remote host for onward jumps, independent of how the initial login to
// that host itself is authenticated.
const (
	SSHAuthPassword = "password"
	SSHAuthKey      = "key"
)

type sshConnector struct{}

func (sshConnector) Type() DBType { return DBTypeSSH }

// BuildDSN encodes host/port/user/auth method/credentials into a
// ssh://user@host:port?... URL, same net/url.URL+url.Values pattern as
// redisConnector.BuildDSN (backend/db/redis.go) — url.Values.Encode()
// percent-encodes arbitrary bytes safely, so a multi-line PEM private key
// in "privateKey" round-trips without a separate base64 step.
func (sshConnector) BuildDSN(params map[string]string) (string, error) {
	host := params["host"]
	if host == "" {
		return "", fmt.Errorf("ssh: falta el parámetro 'host'")
	}
	port := params["port"]
	if port == "" {
		port = "22"
	}
	user := params["user"]
	if user == "" {
		return "", fmt.Errorf("ssh: falta el parámetro 'user'")
	}
	auth := params["auth"]
	if auth == "" {
		auth = SSHAuthPassword
	}

	u := url.URL{Scheme: "ssh", Host: net.JoinHostPort(host, port), User: url.User(user)}

	q := url.Values{}
	q.Set("auth", auth)
	switch auth {
	case SSHAuthPassword:
		q.Set("password", params["password"])
	case SSHAuthKey:
		if params["privateKey"] == "" {
			return "", fmt.Errorf("ssh: falta el parámetro 'privateKey' para auth=key")
		}
		q.Set("privateKey", params["privateKey"])
		if passphrase := params["passphrase"]; passphrase != "" {
			q.Set("passphrase", passphrase)
		}
	default:
		return "", fmt.Errorf("ssh: método de autenticación desconocido %q (usar 'password' o 'key')", auth)
	}
	if params["agentForwarding"] == "1" {
		q.Set("agentForwarding", "1")
	}

	u.RawQuery = q.Encode()
	return u.String(), nil
}

// ParseDSN reverses BuildDSN. Includes password/privateKey/passphrase — see
// the Connector interface doc comment for why that's the caller's
// responsibility to strip, not this function's.
func (sshConnector) ParseDSN(dsn string) (map[string]string, error) {
	u, err := url.Parse(dsn)
	if err != nil {
		return nil, fmt.Errorf("ssh: parseando DSN: %w", err)
	}
	host, port, err := net.SplitHostPort(u.Host)
	if err != nil {
		return nil, fmt.Errorf("ssh: parseando host:port del DSN: %w", err)
	}

	q := u.Query()
	params := map[string]string{
		"host": host,
		"port": port,
		"user": u.User.Username(),
		"auth": q.Get("auth"),
	}
	if v := q.Get("password"); v != "" {
		params["password"] = v
	}
	if v := q.Get("privateKey"); v != "" {
		params["privateKey"] = v
	}
	if v := q.Get("passphrase"); v != "" {
		params["passphrase"] = v
	}
	if q.Get("agentForwarding") == "1" {
		params["agentForwarding"] = "1"
	}
	return params, nil
}
