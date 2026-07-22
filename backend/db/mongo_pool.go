package db

import (
	"context"
	"fmt"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"go.mongodb.org/mongo-driver/v2/mongo/readpref"
)

const defaultMongoPingTimeout = 5 * time.Second

// MongoPoolManager holds one *mongo.Client per active connection ID — the
// MongoDB counterpart to PoolManager (SQL) and RedisPoolManager (Redis). A
// *mongo.Client is itself a connection pool, opened once per connID and reused
// for every operation, closed explicitly when the connection changes or is
// deleted. See .claude/skills/mini-tools-patterns/SKILL.md's MongoDB section.
type MongoPoolManager struct {
	mu      sync.Mutex
	clients map[string]*mongo.Client
}

func NewMongoPoolManager() *MongoPoolManager {
	return &MongoPoolManager{clients: make(map[string]*mongo.Client)}
}

// Get returns the already-open client for connID, or an error if Open hasn't
// been called for it yet.
func (m *MongoPoolManager) Get(connID string) (*mongo.Client, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	client, ok := m.clients[connID]
	if !ok {
		return nil, fmt.Errorf("db: no hay un cliente Mongo abierto para la conexión %q", connID)
	}
	return client, nil
}

// Open opens (or returns the already-open) client for connID from dsn, pinging
// it once before caching. Unlike PoolManager.Open it takes no dbType — it's
// always MongoDB, same as RedisPoolManager.Open.
func (m *MongoPoolManager) Open(connID, dsn string) (*mongo.Client, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if client, ok := m.clients[connID]; ok {
		return client, nil
	}

	client, err := mongo.Connect(options.Client().ApplyURI(dsn))
	if err != nil {
		return nil, fmt.Errorf("db: abriendo cliente Mongo: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), defaultMongoPingTimeout)
	defer cancel()

	if err := client.Ping(ctx, readpref.Primary()); err != nil {
		_ = client.Disconnect(context.Background())
		return nil, fmt.Errorf("db: haciendo ping al cliente Mongo: %w", err)
	}

	m.clients[connID] = client
	return client, nil
}

// Close disconnects and forgets the client for connID, if any is open. Safe to
// call on a connID with no open client (callers close every pool manager
// unconditionally on disconnect/delete).
func (m *MongoPoolManager) Close(connID string) error {
	m.mu.Lock()
	client, ok := m.clients[connID]
	if ok {
		delete(m.clients, connID)
	}
	m.mu.Unlock()

	if !ok {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), defaultMongoPingTimeout)
	defer cancel()
	return client.Disconnect(ctx)
}

// CloseAll disconnects every open client — used on app shutdown.
func (m *MongoPoolManager) CloseAll() {
	m.mu.Lock()
	clients := make([]*mongo.Client, 0, len(m.clients))
	for id, client := range m.clients {
		clients = append(clients, client)
		delete(m.clients, id)
	}
	m.mu.Unlock()

	for _, client := range clients {
		ctx, cancel := context.WithTimeout(context.Background(), defaultMongoPingTimeout)
		_ = client.Disconnect(ctx)
		cancel()
	}
}

// PingMongoDSN opens a short-lived client to verify dsn is reachable, without
// caching it — the MongoDB counterpart to db.Ping / PingRedisDSN, used by
// "Test Connection" before a connection is saved.
func PingMongoDSN(dsn string) error {
	client, err := mongo.Connect(options.Client().ApplyURI(dsn))
	if err != nil {
		return fmt.Errorf("db: abriendo para probar conexión Mongo: %w", err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), defaultMongoPingTimeout)
		defer cancel()
		_ = client.Disconnect(ctx)
	}()

	ctx, cancel := context.WithTimeout(context.Background(), defaultMongoPingTimeout)
	defer cancel()

	if err := client.Ping(ctx, readpref.Primary()); err != nil {
		return fmt.Errorf("db: ping Mongo falló: %w", err)
	}
	return nil
}
