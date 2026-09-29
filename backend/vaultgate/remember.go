package vaultgate

import (
	"encoding/base64"
	"errors"

	"github.com/zalando/go-keyring"

	"mini-tools/backend/i18n"
)

// keyringService/keyringAccount identify this app's single entry in the OS
// credential store (macOS Keychain, Windows Credential Manager, Linux
// Secret Service via go-keyring) — the "recordar clave" opt-in feature.
// Deliberately not a file: unlike a file, an OS keychain entry is protected
// by the user's own OS session rather than by a secret that would otherwise
// have to live on the same disk right next to it.
const (
	keyringService = "mini-tools-vault"
	keyringAccount = "master-key"
)

// ErrNoRememberedKey means the keychain has nothing saved under this app's
// entry — a normal, expected state (never remembered, or already forgotten),
// not a failure.
var ErrNoRememberedKey = i18n.New(i18n.Msg{ES: "vaultgate: no hay ninguna clave recordada en el keychain del sistema", EN: "vaultgate: no remembered key in the OS keychain"})

// SaveRememberedKey stores key in the OS keychain, base64-encoded (keyring
// entries are strings, key is raw bytes).
func SaveRememberedKey(key []byte) error {
	if err := keyring.Set(keyringService, keyringAccount, base64.StdEncoding.EncodeToString(key)); err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vaultgate: guardando clave en el keychain: %w", EN: "vaultgate: saving key to the keychain: %w"}, err)
	}
	return nil
}

// LoadRememberedKey reads back whatever SaveRememberedKey stored, or
// ErrNoRememberedKey if there's nothing there.
func LoadRememberedKey() ([]byte, error) {
	encoded, err := keyring.Get(keyringService, keyringAccount)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil, ErrNoRememberedKey
	}
	if err != nil {
		return nil, i18n.Errorf(i18n.Msg{ES: "vaultgate: leyendo clave del keychain: %w", EN: "vaultgate: reading key from the keychain: %w"}, err)
	}

	key, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, i18n.Errorf(i18n.Msg{ES: "vaultgate: decodificando clave del keychain: %w", EN: "vaultgate: decoding key from the keychain: %w"}, err)
	}
	return key, nil
}

// ForgetRememberedKey deletes this app's keychain entry, if any. Not finding
// one is a no-op, not an error — the caller may be forgetting a key that was
// already forgotten (or never saved in the first place).
func ForgetRememberedKey() error {
	if err := keyring.Delete(keyringService, keyringAccount); err != nil && !errors.Is(err, keyring.ErrNotFound) {
		return i18n.Errorf(i18n.Msg{ES: "vaultgate: borrando clave del keychain: %w", EN: "vaultgate: deleting key from the keychain: %w"}, err)
	}
	return nil
}
