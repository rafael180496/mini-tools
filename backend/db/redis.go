package db

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// RedisMode selects which of the 3 topologies a Redis connection targets.
// Always written explicitly into the DSN's "mode" query param — unlike
// Oracle's connector (backend/db/oracle.go), which infers its mode back
// from which query param is present, Redis's 3 modes don't have as clean a
// signal to infer from, so ParseDSN just reads "mode" back verbatim.
type RedisMode string

const (
	RedisModeStandalone RedisMode = "standalone"
	RedisModeCluster    RedisMode = "cluster"
	RedisModeSentinel   RedisMode = "sentinel"
)

type redisConnector struct{}

func (redisConnector) Type() DBType { return DBTypeRedis }

// BuildDSN supports the 3 topologies via params["mode"] (see RedisMode) —
// same params["mode"] discriminator pattern as oracle.go's 4 connect
// modes, see .claude/skills/mini-tools-patterns/SKILL.md.
//
//   - "standalone" (default): needs "host" (+ optional "port", default
//     "6379"); "db" (0-15, default "0") selects the logical database.
//   - "cluster": needs "nodes" (comma-separated host:port list, at least
//     one entry). No db index — Redis Cluster doesn't support SELECT.
//   - "sentinel": needs "sentinels" (comma-separated host:port list of the
//     sentinel processes, NOT the data node) and "master" (the sentinel
//     master name); "db" selects the logical database on the resolved
//     master, same as standalone.
//
// All modes accept optional "user" (ACL username), "password", and "tls"
// ("true" to use the rediss:// scheme). Sentinel auth reuses the same
// user/password for the sentinel processes themselves (go-redis supports a
// distinct SentinelUsername/SentinelPassword, but that would need its own
// query param and an export.RedactDSN extension — deliberately out of
// scope for v1, documented in the SKILL rather than silently unsupported).
func (redisConnector) BuildDSN(params map[string]string) (string, error) {
	mode := RedisMode(params["mode"])
	if mode == "" {
		mode = RedisModeStandalone
	}

	scheme := "redis"
	if params["tls"] == "true" {
		scheme = "rediss"
	}

	u := url.URL{Scheme: scheme}
	if user := params["user"]; user != "" || params["password"] != "" {
		u.User = url.UserPassword(user, params["password"])
	}

	q := url.Values{}
	q.Set("mode", string(mode))

	switch mode {
	case RedisModeStandalone:
		host := params["host"]
		if host == "" {
			return "", fmt.Errorf("redis: falta el parámetro 'host' para el modo standalone")
		}
		port := params["port"]
		if port == "" {
			port = "6379"
		}
		dbIndex, err := normalizeDBIndex(params["db"])
		if err != nil {
			return "", err
		}
		u.Host = host + ":" + port
		u.Path = "/" + dbIndex

	case RedisModeCluster:
		nodes := params["nodes"]
		if nodes == "" {
			return "", fmt.Errorf("redis: falta el parámetro 'nodes' para el modo cluster")
		}
		first, err := firstNode(nodes)
		if err != nil {
			return "", err
		}
		u.Host = first
		q.Set("nodes", nodes)

	case RedisModeSentinel:
		sentinels := params["sentinels"]
		if sentinels == "" {
			return "", fmt.Errorf("redis: falta el parámetro 'sentinels' para el modo sentinel")
		}
		master := params["master"]
		if master == "" {
			return "", fmt.Errorf("redis: falta el parámetro 'master' para el modo sentinel")
		}
		first, err := firstNode(sentinels)
		if err != nil {
			return "", err
		}
		dbIndex, err := normalizeDBIndex(params["db"])
		if err != nil {
			return "", err
		}
		u.Host = first
		u.Path = "/" + dbIndex
		q.Set("sentinels", sentinels)
		q.Set("master", master)

	default:
		return "", fmt.Errorf("redis: modo de conexión desconocido %q (usar standalone, cluster o sentinel)", params["mode"])
	}

	u.RawQuery = q.Encode()
	return u.String(), nil
}

// ParseDSN reverses BuildDSN. Includes password — see the Connector
// interface doc comment for why that's the caller's responsibility to
// strip, not this function's.
func (redisConnector) ParseDSN(dsn string) (map[string]string, error) {
	u, err := url.Parse(dsn)
	if err != nil {
		return nil, fmt.Errorf("redis: parseando DSN: %w", err)
	}

	params := map[string]string{}
	if u.Scheme == "rediss" {
		params["tls"] = "true"
	}
	if u.User != nil {
		params["user"] = u.User.Username()
		if pw, ok := u.User.Password(); ok {
			params["password"] = pw
		}
	}

	q := u.Query()
	mode := RedisMode(q.Get("mode"))
	if mode == "" {
		mode = RedisModeStandalone
	}
	params["mode"] = string(mode)

	switch mode {
	case RedisModeCluster:
		params["nodes"] = q.Get("nodes")
	case RedisModeSentinel:
		params["sentinels"] = q.Get("sentinels")
		params["master"] = q.Get("master")
		params["db"] = strings.TrimPrefix(u.Path, "/")
	default: // standalone
		params["host"] = u.Hostname()
		params["port"] = u.Port()
		params["db"] = strings.TrimPrefix(u.Path, "/")
	}
	return params, nil
}

// normalizeDBIndex validates the "db" param is a plain 0-15 index (Redis's
// default 16-logical-database convention), defaulting to "0" when absent.
func normalizeDBIndex(raw string) (string, error) {
	if raw == "" {
		return "0", nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 || n > 15 {
		return "", fmt.Errorf("redis: 'db' inválido (debe ser 0-15): %q", raw)
	}
	return strconv.Itoa(n), nil
}

// firstNode returns the first non-empty, trimmed entry of a comma-separated
// host:port list — used as the URL authority so the DSN still "looks like"
// a normal URL, while the full list travels in a query param (see BuildDSN).
func firstNode(list string) (string, error) {
	for _, p := range strings.Split(list, ",") {
		if p = strings.TrimSpace(p); p != "" {
			return p, nil
		}
	}
	return "", fmt.Errorf("redis: la lista de nodos está vacía")
}
