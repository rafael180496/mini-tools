package db

import (
	"context"
	"crypto/tls"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const defaultRedisPingTimeout = 5 * time.Second

// RedisPoolManager holds one redis.UniversalClient per active Redis
// connection ID, mirroring PoolManager's shape (Open/Get/Close/CloseAll)
// but for go-redis's own client instead of *sql.DB. This is the native
// parallel path for Redis — it does NOT go through database/sql, an
// explicit, documented exception to .claude/rules/technical.md point 2 (see
// that file and .claude/skills/mini-tools-patterns/SKILL.md's Redis
// section for why: go-redis's client doesn't implement database/sql
// interfaces, and Redis isn't relational).
type RedisPoolManager struct {
	mu      sync.Mutex
	clients map[string]redis.UniversalClient
}

func NewRedisPoolManager() *RedisPoolManager {
	return &RedisPoolManager{clients: make(map[string]redis.UniversalClient)}
}

// Get returns the already-open client for connID, or an error if Open
// hasn't been called for it yet.
func (m *RedisPoolManager) Get(connID string) (redis.UniversalClient, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	c, ok := m.clients[connID]
	if !ok {
		return nil, fmt.Errorf("db: no hay un cliente Redis abierto para la conexión %q", connID)
	}
	return c, nil
}

// Open opens (or returns the already-open) client for connID against the
// given DSN, pinging it once before caching it. redis.NewUniversalClient
// picks the concrete client type (single-node/Cluster/Sentinel-backed
// failover) from the parsed options — see redisUniversalOptionsFromDSN.
func (m *RedisPoolManager) Open(connID, dsn string) (redis.UniversalClient, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if c, ok := m.clients[connID]; ok {
		return c, nil
	}

	opts, err := redisUniversalOptionsFromDSN(dsn)
	if err != nil {
		return nil, err
	}

	client := redis.NewUniversalClient(opts)

	ctx, cancel := context.WithTimeout(context.Background(), defaultRedisPingTimeout)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		client.Close()
		return nil, fmt.Errorf("db: haciendo ping al cliente Redis: %w", err)
	}

	m.clients[connID] = client
	return client, nil
}

// Close closes and forgets the client for connID, if any is open. Safe to
// call on a connID with no open client (e.g. a non-Redis connection, or one
// never opened this session) — used by callers that close both pool
// managers unconditionally on delete/disconnect/update.
func (m *RedisPoolManager) Close(connID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	c, ok := m.clients[connID]
	if !ok {
		return nil
	}
	delete(m.clients, connID)
	return c.Close()
}

// CloseAll closes every open client — used on app shutdown.
func (m *RedisPoolManager) CloseAll() {
	m.mu.Lock()
	defer m.mu.Unlock()

	for id, c := range m.clients {
		c.Close()
		delete(m.clients, id)
	}
}

// PingRedisDSN opens a short-lived client to verify dsn is reachable,
// without caching it in the pool manager — mirrors the free function Ping
// in pool_manager.go, used by "Test Connection" before a connection is
// saved.
func PingRedisDSN(dsn string) error {
	opts, err := redisUniversalOptionsFromDSN(dsn)
	if err != nil {
		return err
	}
	client := redis.NewUniversalClient(opts)
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), defaultRedisPingTimeout)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("db: ping a Redis falló: %w", err)
	}
	return nil
}

// redisUniversalOptionsFromDSN parses a DSN built by redisConnector.BuildDSN
// into go-redis's UniversalOptions. Protocol is pinned to RESP2 for
// predictable, redis-cli-familiar reply shapes — RESP3 collapses some
// replies into maps/booleans that would need extra normalization branches
// in redisquery for no real benefit here.
func redisUniversalOptionsFromDSN(dsn string) (*redis.UniversalOptions, error) {
	u, err := url.Parse(dsn)
	if err != nil {
		return nil, fmt.Errorf("db: parseando DSN de Redis: %w", err)
	}

	q := u.Query()
	mode := RedisMode(q.Get("mode"))
	if mode == "" {
		mode = RedisModeStandalone
	}

	opts := &redis.UniversalOptions{Protocol: 2}
	if u.User != nil {
		opts.Username = u.User.Username()
		if pw, ok := u.User.Password(); ok {
			opts.Password = pw
		}
	}
	if u.Scheme == "rediss" {
		opts.TLSConfig = &tls.Config{}
	}

	switch mode {
	case RedisModeCluster:
		nodes := q.Get("nodes")
		if nodes == "" {
			return nil, fmt.Errorf("db: DSN de Redis en modo cluster sin 'nodes'")
		}
		opts.Addrs = splitNodes(nodes)
		// IsClusterMode is set explicitly rather than relying on
		// NewUniversalClient's "2+ Addrs = Cluster" inference, so a
		// (rare) single-node cluster during setup/testing still routes
		// correctly instead of silently falling through to a plain
		// single-node Client.
		opts.IsClusterMode = true

	case RedisModeSentinel:
		sentinels := q.Get("sentinels")
		if sentinels == "" {
			return nil, fmt.Errorf("db: DSN de Redis en modo sentinel sin 'sentinels'")
		}
		opts.Addrs = splitNodes(sentinels)
		opts.MasterName = q.Get("master")
		// v1 scope: sentinel auth reuses the data-node credentials — see
		// the doc comment on redisConnector.BuildDSN.
		opts.SentinelUsername = opts.Username
		opts.SentinelPassword = opts.Password
		opts.DB = dbIndexFromPath(u.Path)

	default: // standalone
		opts.Addrs = []string{u.Host}
		opts.DB = dbIndexFromPath(u.Path)
	}

	return opts, nil
}

func splitNodes(list string) []string {
	parts := strings.Split(list, ",")
	nodes := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			nodes = append(nodes, p)
		}
	}
	return nodes
}

func dbIndexFromPath(path string) int {
	n, err := strconv.Atoi(strings.TrimPrefix(path, "/"))
	if err != nil {
		return 0
	}
	return n
}
