package sqlintel

import (
	"strings"
	"sync"

	"mini-tools/backend/db"
)

// IndexState is what a connection's schema index is currently doing.
type IndexState string

const (
	// StateAbsent means nothing has been asked for this connection yet.
	StateAbsent IndexState = "absent"
	// StateLoading means a background extraction is in flight.
	StateLoading IndexState = "loading"
	// StateReady means the index is built and completion is fully armed.
	StateReady IndexState = "ready"
	// StateError means the extraction failed; the connection still gets
	// keyword/function/snippet completion, just nothing schema-aware.
	StateError IndexState = "error"
)

// Status is the index state as reported to the frontend, both as the return
// value of a prime call and as the payload of the "sqlintel:index" event.
type Status struct {
	ConnID string     `json:"connId"`
	State  IndexState `json:"state"`
	Tables int        `json:"tables"`
	Error  string     `json:"error,omitempty"`
}

// Manager owns one SchemaIndex per connection plus this session's usage
// counters. It is the only mutable state in the package: the indexes it
// hands out are immutable snapshots, swapped wholesale on refresh, so a
// completion request in flight can never observe a half-rebuilt index.
//
// Extraction is asynchronous by construction — Prime returns immediately
// and the work happens on a goroutine — because it is a catalog query
// against a possibly-remote database, and the UI must never wait on it.
type Manager struct {
	mu      sync.RWMutex
	indexes map[string]*SchemaIndex
	states  map[string]IndexState
	errs    map[string]string
	// inflight guards against two tabs priming the same connection at once
	// and firing two catalog scans.
	inflight map[string]bool
	// usage counts accepted completions per connection, keyed
	// "kind\x00lowercased-name". Session-only and never persisted: it is a
	// ranking hint, not user data worth keeping, and persisting it would
	// mean a vault migration for something that costs nothing to relearn.
	usage map[string]map[string]int
}

// NewManager builds an empty manager.
func NewManager() *Manager {
	return &Manager{
		indexes:  map[string]*SchemaIndex{},
		states:   map[string]IndexState{},
		errs:     map[string]string{},
		inflight: map[string]bool{},
		usage:    map[string]map[string]int{},
	}
}

// Index returns the connection's index, or nil when there is none yet.
// Callers pass the nil straight into Complete, which degrades to
// keyword/function/snippet suggestions.
func (m *Manager) Index(connID string) *SchemaIndex {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.indexes[connID]
}

// Set installs freshly fetched metadata as the connection's index. Called
// on every path that already has metadata in hand — the on-demand fetch,
// the persisted-cache hit, the per-schema sync — so the index tracks the
// sidebar without a second round trip to the database.
func (m *Manager) Set(connID string, meta *db.SchemaMetadata) {
	idx := BuildIndex(meta)
	m.mu.Lock()
	defer m.mu.Unlock()
	m.indexes[connID] = idx
	m.states[connID] = StateReady
	delete(m.errs, connID)
}

// Status reports the connection's current index state.
func (m *Manager) Status(connID string) Status {
	m.mu.RLock()
	defer m.mu.RUnlock()
	state, ok := m.states[connID]
	if !ok {
		state = StateAbsent
	}
	return Status{
		ConnID: connID,
		State:  state,
		Tables: m.indexes[connID].TableCount(),
		Error:  m.errs[connID],
	}
}

// Prime starts a background extraction unless the index is already ready or
// a scan is already running, and reports the state at the moment of the
// call. fetch does the actual metadata read; notify (optional) is invoked
// with the final status once the scan settles, which is what lets the
// frontend re-run a completion that arrived too early.
//
// Both callbacks run on the spawned goroutine, so neither may touch state
// the caller holds a lock on.
func (m *Manager) Prime(connID string, fetch func() (*db.SchemaMetadata, error), notify func(Status)) Status {
	m.mu.Lock()
	if m.states[connID] == StateReady {
		st := Status{ConnID: connID, State: StateReady, Tables: m.indexes[connID].TableCount()}
		m.mu.Unlock()
		return st
	}
	if m.inflight[connID] {
		m.mu.Unlock()
		return Status{ConnID: connID, State: StateLoading}
	}
	m.inflight[connID] = true
	m.states[connID] = StateLoading
	m.mu.Unlock()

	go func() {
		meta, err := fetch()

		m.mu.Lock()
		delete(m.inflight, connID)
		var st Status
		if err != nil {
			m.states[connID] = StateError
			// The error text reaches the UI, so it must never carry a DSN.
			// Everything upstream of here already redacts (the fetch closure
			// only ever returns catalog errors), but the connection id is
			// the only identifier this package is willing to echo back.
			m.errs[connID] = err.Error()
			st = Status{ConnID: connID, State: StateError, Error: err.Error()}
		} else {
			idx := BuildIndex(meta)
			m.indexes[connID] = idx
			m.states[connID] = StateReady
			delete(m.errs, connID)
			st = Status{ConnID: connID, State: StateReady, Tables: idx.TableCount()}
		}
		m.mu.Unlock()

		if notify != nil {
			notify(st)
		}
	}()

	return Status{ConnID: connID, State: StateLoading}
}

// Drop forgets everything about a connection — its index, its state and its
// usage counters. Called wherever the pool is closed (disconnect, delete,
// credentials updated, schema scope changed): an index outliving its
// connection would keep suggesting tables the user can no longer query.
func (m *Manager) Drop(connID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.indexes, connID)
	delete(m.states, connID)
	delete(m.errs, connID)
	delete(m.usage, connID)
}

// RecordUse counts an accepted completion, feeding the frequency component
// of the ranking.
func (m *Manager) RecordUse(connID, kind, name string) {
	if name == "" {
		return
	}
	key := kind + "\x00" + strings.ToLower(name)
	m.mu.Lock()
	defer m.mu.Unlock()
	counts, ok := m.usage[connID]
	if !ok {
		counts = map[string]int{}
		m.usage[connID] = counts
	}
	counts[key]++
}

// UsageFor returns the lookup Complete needs for one connection. The
// returned closure takes the manager's read lock per call, which is
// uncontended in practice (completions are serialised by the single editor)
// and keeps the counters correct if that ever stops being true.
func (m *Manager) UsageFor(connID string) UsageFunc {
	return func(kind, name string) int {
		key := kind + "\x00" + strings.ToLower(name)
		m.mu.RLock()
		defer m.mu.RUnlock()
		return m.usage[connID][key]
	}
}
