package vaultgate

import (
	"crypto/rand"
	"fmt"
	"os"

	"mini-tools/backend/appdata"
)

const saltSize = 16

// LoadOrCreateSalt returns this install's Argon2id salt, generating and
// persisting one on first run. The salt is not secret — it just needs to be
// stable per install so re-deriving the key from the same password works.
func LoadOrCreateSalt() ([]byte, error) {
	path, err := appdata.SaltPath()
	if err != nil {
		return nil, fmt.Errorf("vaultgate: resolving salt path: %w", err)
	}

	if data, err := os.ReadFile(path); err == nil {
		return data, nil
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("vaultgate: reading salt: %w", err)
	}

	salt := make([]byte, saltSize)
	if _, err := rand.Read(salt); err != nil {
		return nil, fmt.Errorf("vaultgate: generating salt: %w", err)
	}

	if err := os.WriteFile(path, salt, 0o600); err != nil {
		return nil, fmt.Errorf("vaultgate: writing salt: %w", err)
	}

	return salt, nil
}
