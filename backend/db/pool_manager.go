package db

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"sync"
	"time"

	"mini-tools/backend/db/sqlcipher"
)

const (
	defaultMaxOpenConns    = 5
	defaultMaxIdleConns    = 2
	defaultConnMaxLifetime = 30 * time.Minute
	defaultPingTimeout     = 5 * time.Second
)

type pooledConn struct {
	db     *sql.DB
	dbType DBType
	// tempPath is the decrypted plaintext copy of a SQLCipher database, if
	// this connection is an encrypted SQLite one. It is deleted when the pool
	// closes so the decrypted data does not outlive the connection. Empty for
	// every other connection.
	tempPath string
}

// materializeDSN turns a stored DSN into one sql.Open can use, handling the
// one engine that needs pre-processing: an encrypted SQLite connection is
// decrypted to a temporary plaintext copy here, and the returned DSN points at
// that copy instead of the original. tempPath is the copy's path (to be
// deleted on close) or "" when nothing was materialized.
//
// The decrypted copy is opened read-only: writing to it would not reach the
// real encrypted file (re-encryption is out of scope, see package sqlcipher),
// so read-only makes the contract honest rather than silently dropping edits.
func materializeDSN(dbType DBType, dsn string) (finalDSN, tempPath string, err error) {
	if dbType != DBTypeSQLite {
		return dsn, "", nil
	}
	srcPath, key, ok := sqliteEncryptedSource(dsn)
	if !ok {
		return dsn, "", nil
	}

	tmp, err := os.CreateTemp("", "mini-tools-sqlcipher-*.db")
	if err != nil {
		return "", "", fmt.Errorf("db: creando copia temporal descifrada: %w", err)
	}
	tmp.Close()
	if _, err := sqlcipher.DecryptToFile(srcPath, key, tmp.Name()); err != nil {
		os.Remove(tmp.Name())
		return "", "", err
	}
	// mode=ro: the copy is a throwaway read view of the encrypted original.
	return fmt.Sprintf("file://%s?_pragma=busy_timeout(5000)&mode=ro", tmp.Name()), tmp.Name(), nil
}

// PoolManager holds one *sql.DB (plus its engine type) per active
// connection ID. A pool is opened once and reused for every query against
// that connection — never reopened per query — and closed explicitly via
// Close when the connection changes or is deleted.
type PoolManager struct {
	mu    sync.Mutex
	pools map[string]pooledConn
}

func NewPoolManager() *PoolManager {
	return &PoolManager{pools: make(map[string]pooledConn)}
}

// Get returns the already-open pool for connID, or an error if Open hasn't
// been called for it yet.
func (m *PoolManager) Get(connID string) (*sql.DB, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	pc, ok := m.pools[connID]
	if !ok {
		return nil, fmt.Errorf("db: no hay un pool abierto para la conexión %q", connID)
	}
	return pc.db, nil
}

// Type returns the engine type for connID's open pool, if any.
func (m *PoolManager) Type(connID string) (DBType, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	pc, ok := m.pools[connID]
	if !ok {
		return "", false
	}
	return pc.dbType, true
}

// Open opens (or returns the already-open) pool for connID against the
// given engine/DSN, pinging it once before caching it.
func (m *PoolManager) Open(connID string, dbType DBType, dsn string) (*sql.DB, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if pc, ok := m.pools[connID]; ok {
		return pc.db, nil
	}

	// Decrypt-to-temp for an encrypted SQLite connection; a no-op for the rest.
	finalDSN, tempPath, err := materializeDSN(dbType, dsn)
	if err != nil {
		return nil, err
	}

	pool, err := sql.Open(dbType.DriverName(), finalDSN)
	if err != nil {
		if tempPath != "" {
			os.Remove(tempPath)
		}
		return nil, fmt.Errorf("db: abriendo pool %s: %w", dbType, err)
	}

	pool.SetMaxOpenConns(defaultMaxOpenConns)
	pool.SetMaxIdleConns(defaultMaxIdleConns)
	pool.SetConnMaxLifetime(defaultConnMaxLifetime)

	ctx, cancel := context.WithTimeout(context.Background(), defaultPingTimeout)
	defer cancel()

	if err := pool.PingContext(ctx); err != nil {
		pool.Close()
		if tempPath != "" {
			os.Remove(tempPath)
		}
		return nil, fmt.Errorf("db: haciendo ping al pool %s: %w", dbType, err)
	}

	m.pools[connID] = pooledConn{db: pool, dbType: dbType, tempPath: tempPath}
	return pool, nil
}

// Close closes and forgets the pool for connID, if any is open. Safe to
// call on a connID with no open pool.
func (m *PoolManager) Close(connID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	pc, ok := m.pools[connID]
	if !ok {
		return nil
	}
	delete(m.pools, connID)
	err := pc.db.Close()
	if pc.tempPath != "" {
		os.Remove(pc.tempPath)
	}
	return err
}

// CloseAll closes every open pool — used on app shutdown.
func (m *PoolManager) CloseAll() {
	m.mu.Lock()
	defer m.mu.Unlock()

	for id, pc := range m.pools {
		pc.db.Close()
		if pc.tempPath != "" {
			os.Remove(pc.tempPath)
		}
		delete(m.pools, id)
	}
}

// Ping opens a short-lived connection to verify dsn is reachable, without
// caching it in the pool manager. Used by "Test Connection" before a
// connection is saved.
func Ping(dbType DBType, dsn string) error {
	// "Test Connection" on an encrypted SQLite verifies the passphrase too:
	// materializeDSN decrypts to a temp copy, which fails here if the key is
	// wrong — exactly the check the user wants before saving.
	finalDSN, tempPath, err := materializeDSN(dbType, dsn)
	if err != nil {
		return err
	}
	if tempPath != "" {
		defer os.Remove(tempPath)
	}

	conn, err := sql.Open(dbType.DriverName(), finalDSN)
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
