package appdata

import (
	"os"
	"path/filepath"
)

const dirName = "mini-tools"

// Dir returns the per-user application data directory, creating it if needed.
func Dir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}

	dir := filepath.Join(base, dirName)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}

	return dir, nil
}

// VaultPath returns the path to the local vault SQLite database.
func VaultPath() (string, error) {
	dir, err := Dir()
	if err != nil {
		return "", err
	}

	return filepath.Join(dir, "vault.db"), nil
}

// SaltPath returns the path to the per-install Argon2id salt file.
func SaltPath() (string, error) {
	dir, err := Dir()
	if err != nil {
		return "", err
	}

	return filepath.Join(dir, "salt.bin"), nil
}
