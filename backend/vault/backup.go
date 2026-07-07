package vault

import (
	"archive/zip"
	"database/sql"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"mini-tools/backend/appdata"
	mtcrypto "mini-tools/backend/crypto"
)

// Backup creates a self-contained, restorable snapshot of the vault at
// destPath: a zip containing a consistent copy of vault.db (via SQLite's
// VACUUM INTO, safe to run against the live WAL-mode connection) plus the
// per-install salt.bin. Both are required to unlock the restored vault with
// the same master password — a backup missing the salt is useless even with
// the correct password, since the derived key would differ.
func (s *Store) Backup(destPath string) error {
	tmpDir, err := os.MkdirTemp("", "mini-tools-backup-*")
	if err != nil {
		return fmt.Errorf("vault: creando directorio temporal: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	tmpDBPath := filepath.Join(tmpDir, "vault.db")
	if _, err := s.db.Exec(`VACUUM INTO ?`, tmpDBPath); err != nil {
		return fmt.Errorf("vault: generando snapshot de la base: %w", err)
	}

	saltPath, err := appdata.SaltPath()
	if err != nil {
		return err
	}

	out, err := os.Create(destPath)
	if err != nil {
		return fmt.Errorf("vault: creando archivo de backup: %w", err)
	}
	defer out.Close()

	zw := zip.NewWriter(out)
	if err := addFileToZip(zw, "vault.db", tmpDBPath); err != nil {
		zw.Close()
		return err
	}
	if err := addFileToZip(zw, "salt.bin", saltPath); err != nil {
		zw.Close()
		return err
	}
	if err := zw.Close(); err != nil {
		return fmt.Errorf("vault: finalizando archivo de backup: %w", err)
	}

	return nil
}

func addFileToZip(zw *zip.Writer, name, srcPath string) error {
	src, err := os.Open(srcPath)
	if err != nil {
		return fmt.Errorf("vault: abriendo %s para el backup: %w", name, err)
	}
	defer src.Close()

	w, err := zw.Create(name)
	if err != nil {
		return fmt.Errorf("vault: agregando %s al backup: %w", name, err)
	}
	if _, err := io.Copy(w, src); err != nil {
		return fmt.Errorf("vault: escribiendo %s en el backup: %w", name, err)
	}
	return nil
}

// VerifyBackupPassword checks password against backupPath's own embedded
// vault_meta.verifier — the same master password that was unlocked when the
// backup was made, not necessarily this machine's current one (a backup can
// travel to a different install). Extracts vault.db/salt.bin to a scratch
// temp dir to check, never touches this install's real vault.db/salt.bin —
// RestoreBackup only runs after this succeeds, so a wrong password (or a
// backup made under a different master password) fails loudly here instead
// of leaving the caller with a restored-but-inaccessible vault, and instead
// of silently exposing whatever the backup's DSNs decrypt to under the
// wrong assumption that "restored = same password as before".
func VerifyBackupPassword(backupPath, password string) error {
	r, err := zip.OpenReader(backupPath)
	if err != nil {
		return fmt.Errorf("vault: abriendo archivo de backup: %w", err)
	}
	defer r.Close()

	var dbFile, saltFile *zip.File
	for _, f := range r.File {
		switch f.Name {
		case "vault.db":
			dbFile = f
		case "salt.bin":
			saltFile = f
		}
	}
	if dbFile == nil || saltFile == nil {
		return fmt.Errorf("vault: backup inválido (falta vault.db o salt.bin)")
	}

	tmpDir, err := os.MkdirTemp("", "mini-tools-restore-check-*")
	if err != nil {
		return fmt.Errorf("vault: creando directorio temporal: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	tmpDBPath := filepath.Join(tmpDir, "vault.db")
	tmpSaltPath := filepath.Join(tmpDir, "salt.bin")
	if err := extractZipFile(dbFile, tmpDBPath); err != nil {
		return err
	}
	if err := extractZipFile(saltFile, tmpSaltPath); err != nil {
		return err
	}

	salt, err := os.ReadFile(tmpSaltPath)
	if err != nil {
		return fmt.Errorf("vault: leyendo salt del backup: %w", err)
	}

	db, err := sql.Open("sqlite", tmpDBPath)
	if err != nil {
		return fmt.Errorf("vault: abriendo backup para verificar: %w", err)
	}
	defer db.Close()

	var ciphertext, nonce []byte
	if err := db.QueryRow(`SELECT verifier, verifier_nonce FROM vault_meta WHERE id = 1`).Scan(&ciphertext, &nonce); err != nil {
		return fmt.Errorf("vault: el backup no tiene un verificador válido: %w", err)
	}

	passwordBytes := []byte(password)
	key := mtcrypto.DeriveKey(passwordBytes, salt)
	mtcrypto.Zero(passwordBytes)
	defer mtcrypto.Zero(key)

	if _, err := mtcrypto.Decrypt(key, ciphertext, nonce); err != nil {
		return ErrWrongPassword
	}
	return nil
}

// RestoreBackup extracts a backup created by Backup, overwriting this
// install's vault.db and salt.bin. The caller must Close any Store that has
// vault.db open before calling this, and is responsible for deciding whether
// it's safe to restore over an existing vault (this function doesn't check
// that — see App.RestoreVaultBackup for that guard). Callers should run
// VerifyBackupPassword first — this function trusts the caller already
// confirmed the password, it doesn't check again.
func RestoreBackup(backupPath string) error {
	r, err := zip.OpenReader(backupPath)
	if err != nil {
		return fmt.Errorf("vault: abriendo archivo de backup: %w", err)
	}
	defer r.Close()

	var dbFile, saltFile *zip.File
	for _, f := range r.File {
		switch f.Name {
		case "vault.db":
			dbFile = f
		case "salt.bin":
			saltFile = f
		}
	}
	if dbFile == nil || saltFile == nil {
		return fmt.Errorf("vault: backup inválido (falta vault.db o salt.bin)")
	}

	dbPath, err := appdata.VaultPath()
	if err != nil {
		return err
	}
	saltPath, err := appdata.SaltPath()
	if err != nil {
		return err
	}

	if err := extractZipFile(dbFile, dbPath); err != nil {
		return err
	}
	if err := extractZipFile(saltFile, saltPath); err != nil {
		return err
	}

	// Stale WAL/SHM sidecar files from whatever vault.db was there before
	// would otherwise shadow the freshly restored file's data.
	os.Remove(dbPath + "-wal")
	os.Remove(dbPath + "-shm")

	return nil
}

func extractZipFile(f *zip.File, destPath string) error {
	rc, err := f.Open()
	if err != nil {
		return fmt.Errorf("vault: leyendo %s del backup: %w", f.Name, err)
	}
	defer rc.Close()

	out, err := os.OpenFile(destPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("vault: escribiendo %s restaurado: %w", f.Name, err)
	}
	defer out.Close()

	if _, err := io.Copy(out, rc); err != nil {
		return fmt.Errorf("vault: copiando %s restaurado: %w", f.Name, err)
	}
	return nil
}
