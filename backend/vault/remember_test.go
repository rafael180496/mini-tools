package vault

import (
	"testing"

	"github.com/zalando/go-keyring"
)

// Caso reportado en Windows 11: el toggle quedó en 1 (vino en un backup o el
// Credential Manager perdió la entrada) pero el keychain está vacío. El
// arranque no puede desbloquear solo; el siguiente desbloqueo con clave tiene
// que reponer la entrada para que el próximo arranque sí lo haga.
func TestUnlockRepairsMissingRememberedKey(t *testing.T) {
	keyring.MockInit()
	store, gate := openTestStore(t)

	if err := store.Initialize("clave-maestra"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetRememberMasterKey(true); err != nil {
		t.Fatal(err)
	}
	// El keychain pierde la entrada; el flag sigue en 1.
	if err := keyring.Delete(keyringServiceForTest, keyringAccountForTest); err != nil {
		t.Fatal(err)
	}
	gate.Lock()

	if ok, _ := store.TryAutoUnlock(); ok {
		t.Fatal("sin entrada en el keychain no debería desbloquear solo")
	}
	if !store.rememberEnabled() {
		t.Fatal("una entrada faltante no debe apagar el toggle")
	}
	if err := store.Unlock("clave-maestra"); err != nil {
		t.Fatal(err)
	}
	gate.Lock()

	if ok, _ := store.TryAutoUnlock(); !ok {
		t.Fatal("tras desbloquear con la clave, el arranque siguiente debe desbloquear solo")
	}
}

// Con el toggle apagado, desbloquear no escribe nada en el keychain.
func TestUnlockDoesNotRememberWhenDisabled(t *testing.T) {
	keyring.MockInit()
	store, gate := openTestStore(t)

	if err := store.Initialize("clave-maestra"); err != nil {
		t.Fatal(err)
	}
	gate.Lock()
	if err := store.Unlock("clave-maestra"); err != nil {
		t.Fatal(err)
	}
	if _, err := keyring.Get(keyringServiceForTest, keyringAccountForTest); err == nil {
		t.Fatal("con el toggle apagado no debería guardarse la clave")
	}
}

const (
	keyringServiceForTest = "mini-tools-vault"
	keyringAccountForTest = "master-key"
)
