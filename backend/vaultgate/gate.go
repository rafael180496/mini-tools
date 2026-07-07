package vaultgate

import (
	"errors"
	"sync"

	mtcrypto "mini-tools/backend/crypto"
)

// ErrLocked is returned by any bound method that requires an unlocked vault
// while the app has not been unlocked yet.
var ErrLocked = errors.New("vault: locked")

// Gate holds the derived vault key in memory while the app is unlocked.
// There is no bypass: any code path that needs the key must go through Key,
// and it fails closed (ErrLocked) until Set has been called successfully.
type Gate struct {
	mu  sync.Mutex
	key []byte
}

func New() *Gate {
	return &Gate{}
}

// Set stores the derived key, unlocking the gate.
func (g *Gate) Set(key []byte) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.key = key
}

// Key returns the derived key, or ErrLocked if the vault has not been
// unlocked yet.
func (g *Gate) Key() ([]byte, error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	if g.key == nil {
		return nil, ErrLocked
	}

	return g.key, nil
}

// Unlocked reports whether the gate currently holds a key.
func (g *Gate) Unlocked() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.key != nil
}

// Lock zeroes the in-memory key and re-locks the gate.
func (g *Gate) Lock() {
	g.mu.Lock()
	defer g.mu.Unlock()
	mtcrypto.Zero(g.key)
	g.key = nil
}
