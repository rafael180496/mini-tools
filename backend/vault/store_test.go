package vault

import (
	"os"
	"strings"
	"testing"

	"mini-tools/backend/appdata"
	"mini-tools/backend/vaultgate"
)

// openTestStore abre un vault limpio en un directorio TEMPORAL propio de
// cada test.
//
// Antes corría contra el directorio de datos real del usuario —no había
// forma de inyectar otra ruta— y borraba vault.db y salt.bin para empezar de
// cero. Correr `go test ./backend/...` en una máquina con la aplicación
// instalada destruía el vault: pasó de verdad, ver appdata.OverrideEnv.
//
// Ahora se sandboxea con esa variable, así que el borrado de abajo solo
// puede tocar el temporal del test. t.Setenv además restaura el valor
// anterior al terminar y hace que el test falle si alguien lo pone en
// paralelo, que es justo lo que no se quiere acá.
func openTestStore(t *testing.T) (*Store, *vaultgate.Gate) {
	t.Helper()

	t.Setenv(appdata.OverrideEnv, t.TempDir())

	dir, err := appdata.Dir()
	if err != nil {
		t.Fatalf("appdata.Dir: %v", err)
	}
	// Guarda de seguridad: si por lo que sea la ruta NO quedó dentro de un
	// temporal, se aborta antes de borrar nada. Un test no tiene por qué
	// poder tocar datos de una persona.
	if !strings.HasPrefix(dir, os.TempDir()) {
		t.Fatalf("el sandbox no se aplicó: %q está fuera del temporal, no se borra nada", dir)
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
