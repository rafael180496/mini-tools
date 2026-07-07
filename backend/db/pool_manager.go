package db

import (
	"context"
	"database/sql"
	"fmt"
	"sync"
	"time"
)

const (
	defaultMaxOpenConns    = 5
	defaultMaxIdleConns    = 2
	defaultConnMaxLifetime = 30 * time.Minute
	defaultPingTimeout     = 5 * time.Second
)

// PoolManager holds one *sql.DB per active connection ID. A pool is opened
// once and reused for every query against that connection — never reopened
// per query — and closed explicitly via Close when the connection changes
// or is deleted.
type PoolManager struct {
	mu    sync.Mutex
	pools map[string]*sql.DB
}

func NewPoolManager() *PoolManager {
	return &PoolManager{pools: make(map[string]*sql.DB)}
}

// Get returns the already-open pool for connID, or an error if Open hasn't
// been called for it yet.
func (m *PoolManager) Get(connID string) (*sql.DB, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	pool, ok := m.pools[connID]
	if !ok {
		return nil, fmt.Errorf("db: no hay un pool abierto para la conexión %q", connID)
	}
	return pool, nil
}

// Open opens (or returns the already-open) pool for connID against the
// given engine/DSN, pinging it once before caching it.
func (m *PoolManager) Open(connID string, dbType DBType, dsn string) (*sql.DB, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if pool, ok := m.pools[connID]; ok {
		return pool, nil
	}

	pool, err := sql.Open(dbType.DriverName(), dsn)
	if err != nil {
		return nil, fmt.Errorf("db: abriendo pool %s: %w", dbType, err)
	}

	pool.SetMaxOpenConns(defaultMaxOpenConns)
	pool.SetMaxIdleConns(defaultMaxIdleConns)
	pool.SetConnMaxLifetime(defaultConnMaxLifetime)

	ctx, cancel := context.WithTimeout(context.Background(), defaultPingTimeout)
	defer cancel()

	if err := pool.PingContext(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("db: haciendo ping al pool %s: %w", dbType, err)
	}

	m.pools[connID] = pool
	return pool, nil
}

// Close closes and forgets the pool for connID, if any is open. Safe to
// call on a connID with no open pool.
func (m *PoolManager) Close(connID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	pool, ok := m.pools[connID]
	if !ok {
		return nil
	}
	delete(m.pools, connID)
	return pool.Close()
}

// CloseAll closes every open pool — used on app shutdown.
func (m *PoolManager) CloseAll() {
	m.mu.Lock()
	defer m.mu.Unlock()

	for id, pool := range m.pools {
		pool.Close()
		delete(m.pools, id)
	}
}

// Ping opens a short-lived connection to verify dsn is reachable, without
// caching it in the pool manager. Used by "Test Connection" before a
// connection is saved.
func Ping(dbType DBType, dsn string) error {
	conn, err := sql.Open(dbType.DriverName(), dsn)
	if err != nil {
		return fmt.Errorf("db: abriendo para probar conexión: %w", err)
	}
	defer conn.Close()

	ctx, cancel := context.WithTimeout(context.Background(), defaultPingTimeout)
	defer cancel()

	if err := conn.PingContext(ctx); err != nil {
		return fmt.Errorf("db: ping falló: %w", err)
	}
	return nil
}
