package vault

import (
	"archive/zip"
	"database/sql"
	"io"
	"os"
	"path/filepath"

	"mini-tools/backend/appdata"
	mtcrypto "mini-tools/backend/crypto"
	"mini-tools/backend/i18n"
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
		return i18n.Errorf(i18n.Msg{ES: "vault: creando directorio temporal: %w", EN: "vault: creating temporary directory: %w"}, err)
	}
	defer os.RemoveAll(tmpDir)

	tmpDBPath := filepath.Join(tmpDir, "vault.db")
	if _, err := s.db.Exec(`VACUUM INTO ?`, tmpDBPath); err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: generando snapshot de la base: %w", EN: "vault: generating database snapshot: %w"}, err)
	}

	saltPath, err := appdata.SaltPath()
	if err != nil {
		return err
	}
	// El salt se comprueba ANTES de crear nada: sin él el backup no sirve, y
	// descubrirlo a mitad de la escritura es lo que producía el desastre
	// descrito abajo.
	if _, err := os.Stat(saltPath); err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: falta salt.bin (%s), sin el cual un backup no se puede restaurar: %w", EN: "vault: salt.bin is missing (%s), and without it a backup cannot be restored: %w"}, saltPath, err)
	}

	// # Por qué se escribe a un temporal y se renombra al final
	//
	// Antes se escribía DIRECTO sobre destPath. Si algo fallaba a mitad —el
	// salt ausente era el caso real— la función devolvía error, pero el
	// archivo ya estaba creado y el `zip.Writer` alcanzaba a cerrar su
	// directorio central: quedaba un .mtbackup **válido y abrible, con solo
	// vault.db adentro**. Y como el backup automático escribe SIEMPRE sobre
	// la misma ruta, ese archivo inservible pisaba al último bueno.
	//
	// El resultado es el peor de todos: backups que existen, pesan lo
	// esperado y abren, pero no se pueden restaurar — y nadie se entera
	// hasta que los necesita. Escribir a un temporal y renombrar sobre el
	// destino solo cuando todo salió bien hace que un backup fallido deje
	// intacto al anterior.
	tmpOut, err := os.CreateTemp(filepath.Dir(destPath), ".mini-tools-backup-*.tmp")
	if err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: creando archivo de backup: %w", EN: "vault: creating backup file: %w"}, err)
	}
	tmpOutPath := tmpOut.Name()
	// Si algo falla, el temporal se borra: no queda basura al lado del
	// backup bueno.
	committed := false
	defer func() {
		tmpOut.Close()
		if !committed {
			os.Remove(tmpOutPath)
		}
	}()

	zw := zip.NewWriter(tmpOut)
	if err := addFileToZip(zw, "vault.db", tmpDBPath); err != nil {
		zw.Close()
		return err
	}
	if err := addFileToZip(zw, "salt.bin", saltPath); err != nil {
		zw.Close()
		return err
	}
	if err := zw.Close(); err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: finalizando archivo de backup: %w", EN: "vault: finalizing backup file: %w"}, err)
	}
	if err := tmpOut.Sync(); err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: sincronizando el backup a disco: %w", EN: "vault: syncing the backup to disk: %w"}, err)
	}
	if err := tmpOut.Close(); err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: cerrando el backup: %w", EN: "vault: closing the backup: %w"}, err)
	}

	// Se relee lo que se acabó de escribir antes de darlo por bueno. Un
	// backup se prueba el día que hace falta, y ese es el peor momento para
	// descubrir que le falta una pieza.
	if err := checkBackupComplete(tmpOutPath); err != nil {
		return err
	}

	if err := os.Rename(tmpOutPath, destPath); err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: publicando el backup en %q: %w", EN: "vault: publishing the backup to %q: %w"}, destPath, err)
	}
	committed = true
	return nil
}

// checkBackupComplete abre el archivo recién escrito y comprueba que tenga
// las dos piezas. Es barato y convierte un backup roto en un error visible
// en el momento de hacerlo, no meses después.
func checkBackupComplete(path string) error {
	r, err := zip.OpenReader(path)
	if err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: el backup recién creado no se puede abrir: %w", EN: "vault: the newly created backup cannot be opened: %w"}, err)
	}
	defer r.Close()

	var hasDB, hasSalt bool
	for _, f := range r.File {
		switch f.Name {
		case "vault.db":
			hasDB = true
		case "salt.bin":
			hasSalt = true
		}
	}
	if !hasDB || !hasSalt {
		return i18n.Errorf(i18n.Msg{ES: "vault: el backup quedó incompleto (vault.db=%v, salt.bin=%v) y no se publicó", EN: "vault: the backup was left incomplete (vault.db=%v, salt.bin=%v) and was not published"}, hasDB, hasSalt)
	}
	return nil
}

func addFileToZip(zw *zip.Writer, name, srcPath string) error {
	src, err := os.Open(srcPath)
	if err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: abriendo %s para el backup: %w", EN: "vault: opening %s for the backup: %w"}, name, err)
	}
	defer src.Close()

	w, err := zw.Create(name)
	if err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: agregando %s al backup: %w", EN: "vault: adding %s to the backup: %w"}, name, err)
	}
	if _, err := io.Copy(w, src); err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: escribiendo %s en el backup: %w", EN: "vault: writing %s to the backup: %w"}, name, err)
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
		return i18n.Errorf(i18n.Msg{ES: "vault: abriendo archivo de backup: %w", EN: "vault: opening backup file: %w"}, err)
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
	if dbFile == nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: backup inválido: no contiene vault.db", EN: "vault: invalid backup: it does not contain vault.db"})
	}

	tmpDir, err := os.MkdirTemp("", "mini-tools-restore-check-*")
	if err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: creando directorio temporal: %w", EN: "vault: creating temporary directory: %w"}, err)
	}
	defer os.RemoveAll(tmpDir)

	tmpDBPath := filepath.Join(tmpDir, "vault.db")
	if err := extractZipFile(dbFile, tmpDBPath); err != nil {
		return err
	}

	salt, err := backupSalt(saltFile, tmpDir)
	if err != nil {
		return err
	}

	db, err := sql.Open("sqlite", tmpDBPath)
	if err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: abriendo backup para verificar: %w", EN: "vault: opening backup to verify: %w"}, err)
	}
	defer db.Close()

	var ciphertext, nonce []byte
	if err := db.QueryRow(`SELECT verifier, verifier_nonce FROM vault_meta WHERE id = 1`).Scan(&ciphertext, &nonce); err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: el backup no tiene un verificador válido: %w", EN: "vault: the backup has no valid verifier: %w"}, err)
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

// backupSalt devuelve el salt con el que se derivó la clave del backup.
//
// # El repliegue al salt local, y por qué existe
//
// Lo normal es que el backup traiga el suyo. Pero hubo backups —los
// automáticos, hasta que se arregló Backup— que quedaron **sin salt.bin**:
// la escritura fallaba a mitad y dejaba un zip válido con solo la base
// adentro. Rechazarlos de plano dejaría a esos usuarios sin forma de
// recuperar sus datos, cuando en la enorme mayoría de los casos el salt que
// hace falta está justo al lado: el de esta instalación, que no cambia nunca
// una vez creado.
//
// Solo repliega si el backup NO trae salt. Si trae uno, ese manda: un backup
// que viene de otra máquina tiene su propio salt y usar el local daría una
// clave equivocada.
func backupSalt(saltFile *zip.File, tmpDir string) ([]byte, error) {
	if saltFile != nil {
		tmpSaltPath := filepath.Join(tmpDir, "salt.bin")
		if err := extractZipFile(saltFile, tmpSaltPath); err != nil {
			return nil, err
		}
		salt, err := os.ReadFile(tmpSaltPath)
		if err != nil {
			return nil, i18n.Errorf(i18n.Msg{ES: "vault: leyendo salt del backup: %w", EN: "vault: reading salt from the backup: %w"}, err)
		}
		return salt, nil
	}

	localPath, err := appdata.SaltPath()
	if err != nil {
		return nil, err
	}
	salt, err := os.ReadFile(localPath)
	if err != nil {
		return nil, i18n.Errorf(i18n.Msg{
			ES: "vault: este backup no incluye salt.bin y esta instalación tampoco tiene uno en %s. " +
				"Sin el salt no hay forma de derivar la clave: buscá un backup anterior que sí lo traiga " +
				"y copiale su salt.bin a este archivo",
			EN: "vault: this backup does not include salt.bin and this installation does not have one at %s either. " +
				"Without the salt there is no way to derive the key: look for an older backup that does include it " +
				"and copy its salt.bin to this file",
		}, localPath)
	}
	return salt, nil
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
		return i18n.Errorf(i18n.Msg{ES: "vault: abriendo archivo de backup: %w", EN: "vault: opening backup file: %w"}, err)
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
	if dbFile == nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: backup inválido: no contiene vault.db", EN: "vault: invalid backup: it does not contain vault.db"})
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
	// Un backup sin salt se restaura conservando el LOCAL: es el mismo con
	// el que se cifró (ver backupSalt). Pisarlo con nada, o negarse a
	// restaurar, dejaría los datos inalcanzables teniendo la clave al lado.
	if saltFile != nil {
		if err := extractZipFile(saltFile, saltPath); err != nil {
			return err
		}
	} else if _, err := os.Stat(saltPath); err != nil {
		return i18n.Errorf(i18n.Msg{
			ES: "vault: el backup no incluye salt.bin y esta instalación tampoco lo tiene: " +
				"la base restaurada quedaría ilegible, así que no se restauró nada",
			EN: "vault: the backup does not include salt.bin and this installation does not have one either: " +
				"the restored database would be unreadable, so nothing was restored",
		})
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
		return i18n.Errorf(i18n.Msg{ES: "vault: leyendo %s del backup: %w", EN: "vault: reading %s from the backup: %w"}, f.Name, err)
	}
	defer rc.Close()

	out, err := os.OpenFile(destPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: escribiendo %s restaurado: %w", EN: "vault: writing restored %s: %w"}, f.Name, err)
	}
	defer out.Close()

	if _, err := io.Copy(out, rc); err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: copiando %s restaurado: %w", EN: "vault: copying restored %s: %w"}, f.Name, err)
	}
	return nil
}
