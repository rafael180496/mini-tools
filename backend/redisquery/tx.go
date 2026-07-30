package redisquery

import (
	"context"
	"fmt"
	"sync"

	"github.com/redis/go-redis/v9"
)

// Interactive MULTI/EXEC.
//
// This was out of scope, and the reason was specific: Executor dispatches
// every command with client.Do() against whatever connection the pool hands
// out. MULTI opens a transaction ON A CONNECTION — queue the commands on
// one connection and send EXEC on another, and the transaction silently
// runs empty while the queued commands were never in it. Wrong results, no
// error, no way for the user to tell. Not offering it beat offering it
// broken.
//
// What changes now is not the risk assessment but the mechanism: a
// transaction reserves a single *redis.Conn for its whole life, and while
// one is reserved EVERY command for that connection routes to it. That is
// the same shape backend/query/executor.go already uses for SQL
// transactions, for the same reason, and it is what makes the guarantee
// real rather than hoped for.

// commandRunner is what a command is dispatched against: the pooled client
// normally, the reserved connection while a transaction is open. Both
// satisfy it, which is what keeps the dispatch site free of branching.
type commandRunner interface {
	Do(ctx context.Context, args ...interface{}) *redis.Cmd
}

// txState is one open transaction.
type txState struct {
	conn *redis.Conn
	// queued counts the commands sent since MULTI, so the UI can show what
	// EXEC is about to apply.
	queued int
}

// TxManager owns the reserved connections, one per connID at most.
type TxManager struct {
	mu  sync.Mutex
	txs map[string]*txState
}

func NewTxManager() *TxManager {
	return &TxManager{txs: map[string]*txState{}}
}

// Begin reserves a connection for connID and sends MULTI on it.
//
// Rejects clusters outright: a Redis Cluster transaction can only span keys
// in one hash slot, and nothing here can know in advance which slots the
// user is about to touch. Offering a button that works until the day two
// keys land on different shards is worse than saying no.
func (t *TxManager) Begin(ctx context.Context, connID string, client redis.UniversalClient) error {
	if _, isCluster := client.(*redis.ClusterClient); isCluster {
		return fmt.Errorf("redisquery: en Redis Cluster una transacción solo puede tocar claves del mismo hash slot, así que no se ofrece desde acá")
	}

	base, ok := client.(*redis.Client)
	if !ok {
		return fmt.Errorf("redisquery: este tipo de conexión no soporta transacciones interactivas")
	}

	t.mu.Lock()
	if _, exists := t.txs[connID]; exists {
		t.mu.Unlock()
		return fmt.Errorf("redisquery: ya hay una transacción abierta en esta conexión")
	}
	// Reserve before releasing the lock so two concurrent Begins cannot
	// both think they won.
	t.txs[connID] = nil
	t.mu.Unlock()

	conn := base.Conn()
	if err := conn.Do(ctx, "MULTI").Err(); err != nil {
		_ = conn.Close()
		t.mu.Lock()
		delete(t.txs, connID)
		t.mu.Unlock()
		return fmt.Errorf("redisquery: abriendo la transacción: %w", err)
	}

	t.mu.Lock()
	t.txs[connID] = &txState{conn: conn}
	t.mu.Unlock()
	return nil
}

// Exec sends EXEC and releases the connection, returning the replies of the
// queued commands.
func (t *TxManager) Exec(ctx context.Context, connID string) (interface{}, error) {
	state, err := t.take(connID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = state.conn.Close() }()

	res, err := state.conn.Do(ctx, "EXEC").Result()
	if err != nil {
		if err == redis.Nil {
			// EXEC returns a nil reply when a WATCHed key changed: the
			// transaction was aborted and NOTHING ran. Saying so is the
			// whole point — an empty result read as "it worked" is how
			// data silently goes missing.
			return nil, fmt.Errorf("redisquery: la transacción se abortó porque cambió una clave vigilada con WATCH; no se aplicó ningún comando")
		}
		return nil, fmt.Errorf("redisquery: aplicando la transacción: %w", err)
	}
	return res, nil
}

// Discard sends DISCARD and releases the connection, throwing away every
// queued command.
func (t *TxManager) Discard(ctx context.Context, connID string) error {
	state, err := t.take(connID)
	if err != nil {
		return err
	}
	defer func() { _ = state.conn.Close() }()

	if err := state.conn.Do(ctx, "DISCARD").Err(); err != nil {
		return fmt.Errorf("redisquery: descartando la transacción: %w", err)
	}
	return nil
}

// Runner returns what a command for connID must be dispatched against: the
// reserved connection when a transaction is open, otherwise the pooled
// client.
//
// Every path that runs a command has to go through this. A caller that
// reaches for the pool directly would silently run OUTSIDE the user's open
// transaction — the exact failure this whole file exists to prevent, and
// the same warning backend/query already carries for its own txConn.
func (t *TxManager) Runner(connID string, client redis.UniversalClient) commandRunner {
	t.mu.Lock()
	defer t.mu.Unlock()
	if state, ok := t.txs[connID]; ok && state != nil {
		return state.conn
	}
	return client
}

// NoteQueued records that a command was queued inside the open transaction,
// if there is one.
func (t *TxManager) NoteQueued(connID string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if state, ok := t.txs[connID]; ok && state != nil {
		state.queued++
	}
}

// Open reports whether connID has a transaction open, and how many commands
// are queued in it.
func (t *TxManager) Open(connID string) (bool, int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	state, ok := t.txs[connID]
	if !ok || state == nil {
		return false, 0
	}
	return true, state.queued
}

// Release discards connID's transaction if one is open, best-effort. Called
// before a pool is closed (disconnect, delete, shutdown): a reserved
// connection is one the caller checked OUT of the pool, so sql-style
// Close() on the pool never reaches it and it would simply leak.
func (t *TxManager) Release(ctx context.Context, connID string) {
	state, err := t.take(connID)
	if err != nil {
		return
	}
	_ = state.conn.Do(ctx, "DISCARD").Err()
	_ = state.conn.Close()
}

// ReleaseAll discards every open transaction — shutdown.
func (t *TxManager) ReleaseAll(ctx context.Context) {
	t.mu.Lock()
	ids := make([]string, 0, len(t.txs))
	for id := range t.txs {
		ids = append(ids, id)
	}
	t.mu.Unlock()

	for _, id := range ids {
		t.Release(ctx, id)
	}
}

// take removes and returns connID's transaction, erroring when there is
// none.
func (t *TxManager) take(connID string) (*txState, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	state, ok := t.txs[connID]
	if !ok || state == nil {
		return nil, fmt.Errorf("redisquery: no hay ninguna transacción abierta en esta conexión")
	}
	delete(t.txs, connID)
	return state, nil
}
