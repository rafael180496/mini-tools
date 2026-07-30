package sshconn

import (
	"fmt"
	"sync"

	"golang.org/x/crypto/ssh"
)

// One SSH connection per host, shared by everything that talks to it.
//
// Before this, opening a terminal and an SFTP pane against the same server
// meant TWO SSH connections: two TCP sockets, two authentications, two
// entries in the server's session log — and on a host with MaxSessions or
// per-user connection limits, twice the budget for the same work. SSH is
// designed for the opposite: one connection carrying many channels (a
// session channel for the PTY, an sftp subsystem channel for files).
//
// The pool is refcounted rather than owned by whoever opened it first. That
// is what makes the two halves independent in both directions: closing the
// terminal must not kill an SFTP pane that is still listing files, and an
// SFTP pane closing must not drop the interactive shell. The connection
// lives exactly as long as someone holds a lease.

// ClientLease is a borrowed reference to a shared client. The holder MUST
// call Close exactly once; the underlying connection is dropped when the
// last lease goes.
//
// A lease rather than a bare *ssh.Client so releasing is explicit and
// double-release is harmless — refcounting where callers can accidentally
// decrement twice is worse than no refcounting at all.
type ClientLease struct {
	Client *ssh.Client

	once   sync.Once
	pool   *ClientPool
	connID string
}

// Close releases the lease. Safe to call more than once.
func (l *ClientLease) Close() {
	if l == nil {
		return
	}
	l.once.Do(func() {
		l.pool.release(l.connID)
	})
}

type pooledClient struct {
	client *ssh.Client
	refs   int
	// dsn is kept so a connection whose credentials or host changed is
	// re-dialled instead of silently reused — editing a connection and
	// reopening it must not land on the old host.
	dsn string
}

// ClientPool holds at most one live SSH client per connection id.
type ClientPool struct {
	mu      sync.Mutex
	clients map[string]*pooledClient
}

func NewClientPool() *ClientPool {
	return &ClientPool{clients: make(map[string]*pooledClient)}
}

// Acquire returns a lease on connID's client, dialling it if there is none.
//
// A reused client is checked for liveness first. An SSH client whose TCP
// connection died does not report it until the next channel open fails, and
// handing out a dead one means the user sees "connection lost" on an action
// they just started rather than on the one that actually dropped. The check
// is a keepalive global request — the same probe OpenSSH itself uses, and a
// round trip on an already-open connection.
func (p *ClientPool) Acquire(connID, dsn string) (*ClientLease, error) {
	p.mu.Lock()

	if existing, ok := p.clients[connID]; ok {
		if existing.dsn == dsn && alive(existing.client) {
			existing.refs++
			p.mu.Unlock()
			return &ClientLease{Client: existing.client, pool: p, connID: connID}, nil
		}
		// Stale or pointing somewhere else: drop it. Anyone still holding a
		// lease keeps their own reference to the old client and will fail on
		// their next operation, which is the truthful outcome — the
		// connection really is gone.
		delete(p.clients, connID)
		go existing.client.Close()
	}

	p.mu.Unlock()

	// Dial OUTSIDE the lock: a handshake against an unreachable host takes
	// as long as the TCP timeout, and holding the mutex through it would
	// freeze every other connection's operations too.
	client, err := Dial(dsn)
	if err != nil {
		return nil, err
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	// Another goroutine may have dialled the same connID meanwhile. Keep
	// theirs and discard ours rather than replacing a client someone
	// already holds a lease on.
	if existing, ok := p.clients[connID]; ok && existing.dsn == dsn {
		existing.refs++
		go client.Close()
		return &ClientLease{Client: existing.client, pool: p, connID: connID}, nil
	}

	p.clients[connID] = &pooledClient{client: client, refs: 1, dsn: dsn}
	return &ClientLease{Client: client, pool: p, connID: connID}, nil
}

func (p *ClientPool) release(connID string) {
	p.mu.Lock()
	entry, ok := p.clients[connID]
	if !ok {
		p.mu.Unlock()
		return
	}
	entry.refs--
	if entry.refs > 0 {
		p.mu.Unlock()
		return
	}
	delete(p.clients, connID)
	p.mu.Unlock()

	// Closed outside the lock for the same reason dialling is: a close on a
	// half-dead socket can block.
	go entry.client.Close()
}

// Active reports how many leases connID currently has — what the UI uses to
// say "terminal and files are sharing one connection".
func (p *ClientPool) Active(connID string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	if entry, ok := p.clients[connID]; ok {
		return entry.refs
	}
	return 0
}

// CloseAll drops every connection — shutdown.
func (p *ClientPool) CloseAll() {
	p.mu.Lock()
	clients := make([]*ssh.Client, 0, len(p.clients))
	for id, entry := range p.clients {
		clients = append(clients, entry.client)
		delete(p.clients, id)
	}
	p.mu.Unlock()

	for _, c := range clients {
		_ = c.Close()
	}
}

// alive probes a client with the keepalive request OpenSSH uses. A server
// that does not implement it answers with a failure rather than dropping
// the connection, and that failure still proves the transport is up — which
// is why only a transport-level error counts as dead.
func alive(client *ssh.Client) bool {
	_, _, err := client.SendRequest("keepalive@openssh.com", true, nil)
	if err == nil {
		return true
	}
	// A "request failed" reply comes back as an error too, so distinguish it
	// from a broken pipe by asking for the connection's own error state.
	return !isTransportError(err)
}

func isTransportError(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	// golang.org/x/crypto/ssh reports an unsupported global request as
	// "ssh: request failed"; anything else at this layer means the
	// transport itself is gone.
	return msg != "ssh: request failed" && msg != "request failed"
}

// ErrNoSession is returned by callers that expect a live connection.
var ErrNoSession = fmt.Errorf("sshconn: no hay una conexión abierta")
