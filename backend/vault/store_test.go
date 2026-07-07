package vault

import (
	"os"
	"testing"

	"mini-tools/backend/appdata"
	"mini-tools/backend/vaultgate"
)

// openTestStore opens a fresh vault against this install's real appdata
// path (there's no injectable path today), scrubbing any leftover
// vault.db/salt.bin first and after so runs don't interfere with each other
// or with a real running instance of the app.
func openTestStore(t *testing.T) (*Store, *vaultgate.Gate) {
	t.Helper()

	dir, err := appdata.Dir()
	if err != nil {
		t.Fatalf("appdata.Dir: %v", err)
	}

	cleanup := func() {
		os.Remove(dir + "/vault.db")
		os.Remove(dir + "/salt.bin")
	}
	cleanup()
	t.Cleanup(cleanup)

	gate := vaultgate.New()
	store, err := Open(gate)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { store.Close() })

	return store, gate
}

func TestVaultInitializeThenUnlockWithCorrectPassword(t *testing.T) {
	store, gate := openTestStore(t)

	if init, err := store.IsInitialized(); err != nil || init {
		t.Fatalf("expected not initialized before Initialize, got init=%v err=%v", init, err)
	}

	if err := store.Initialize("correct-horse"); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	if !gate.Unlocked() {
		t.Fatal("expected gate unlocked immediately after Initialize")
	}

	gate.Lock()
	if gate.Unlocked() {
		t.Fatal("expected gate locked after Lock")
	}

	if err := store.Unlock("correct-horse"); err != nil {
		t.Fatalf("Unlock with correct password: %v", err)
	}
	if !gate.Unlocked() {
		t.Fatal("expected gate unlocked after correct Unlock")
	}
}

func TestVaultUnlockWithWrongPasswordStaysLocked(t *testing.T) {
	store, gate := openTestStore(t)

	if err := store.Initialize("correct-horse"); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	gate.Lock()

	if err := store.Unlock("wrong-password"); err == nil {
		t.Fatal("expected an error unlocking with the wrong password")
	}
	if gate.Unlocked() {
		t.Fatal("gate must stay locked after a wrong password")
	}
}

func TestVaultInitializeTwiceFails(t *testing.T) {
	store, _ := openTestStore(t)

	if err := store.Initialize("correct-horse"); err != nil {
		t.Fatalf("Initialize: %v", err)
	}

	if err := store.Initialize("another-password"); err == nil {
		t.Fatal("expected re-initializing an already-initialized vault to fail")
	}
}
