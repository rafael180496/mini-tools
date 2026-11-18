package vault

import (
	"bytes"

	"mini-tools/backend/vaultgate"
)

// SetRememberMasterKey enables or disables auto-unlock via the OS keychain
// (the "Recordar clave" toggle). Enabling saves the current session's
// already-unlocked key (fails with vaultgate.ErrLocked if called while
// locked); disabling forgets whatever's in the keychain regardless of lock
// state, best-effort. The actual secret never touches vault.db/salt.bin —
// see backend/vault/backup.go, which is untouched by this feature on
// purpose.
func (s *Store) SetRememberMasterKey(enabled bool) error {
	if !enabled {
		_ = vaultgate.ForgetRememberedKey()
		_, err := s.db.Exec(`UPDATE settings SET remember_master_key = 0 WHERE id = 1`)
		return err
	}

	key, err := s.gate.Key()
	if err != nil {
		return err
	}
	if err := vaultgate.SaveRememberedKey(key); err != nil {
		return err
	}

	_, err = s.db.Exec(`UPDATE settings SET remember_master_key = 1 WHERE id = 1`)
	return err
}

// TryAutoUnlock attempts to unlock the vault using a key previously saved to
// the OS keychain — called once at startup, before showing the password
// prompt. Every failure mode (nothing remembered, keychain unavailable, or a
// key that no longer validates — e.g. after restoring a backup from a
// different vault) degrades silently to (false, nil) rather than blocking
// startup; a key that fails to validate is forgotten so it isn't retried on
// every future launch.
//
// A missing or unreadable keychain entry does NOT turn the toggle off: the
// next password unlock repairs it (see syncRememberedKey).
func (s *Store) TryAutoUnlock() (bool, error) {
	if !s.rememberEnabled() {
		return false, nil
	}

	key, err := vaultgate.LoadRememberedKey()
	if err != nil {
		return false, nil
	}

	if err := s.validateAndSetKey(key); err != nil {
		_ = vaultgate.ForgetRememberedKey()
		_, _ = s.db.Exec(`UPDATE settings SET remember_master_key = 0 WHERE id = 1`)
		return false, nil
	}

	return true, nil
}

func (s *Store) rememberEnabled() bool {
	var remembered int
	if err := s.db.QueryRow(`SELECT remember_master_key FROM settings WHERE id = 1`).Scan(&remembered); err != nil {
		return false
	}
	return remembered != 0
}

// syncRememberedKey runs after every successful password unlock. With the
// toggle on, it makes sure the OS keychain holds THIS vault's key.
//
// # Why it exists
//
// The toggle lives in vault.db (settings.remember_master_key) but the key
// lives in the OS keychain of the machine that saved it. A .mtbackup carries
// vault.db whole, so restoring a backup made with the toggle on — on another
// machine, or after the keychain entry was lost (Windows profile reset,
// Credential Manager cleanup) — left the toggle showing ON while there was
// nothing to auto-unlock with: TryAutoUnlock found no key, the password was
// asked on every launch, and since the toggle already read ON, nothing ever
// saved the key again. Reported on Windows 11.
//
// If the keychain can't be written, the toggle is switched off so the
// settings stop claiming something that isn't happening.
func (s *Store) syncRememberedKey() {
	if !s.rememberEnabled() {
		return
	}
	key, err := s.gate.Key()
	if err != nil {
		return
	}
	if stored, err := vaultgate.LoadRememberedKey(); err == nil && bytes.Equal(stored, key) {
		return
	}
	if err := vaultgate.SaveRememberedKey(key); err != nil {
		_, _ = s.db.Exec(`UPDATE settings SET remember_master_key = 0 WHERE id = 1`)
	}
}
