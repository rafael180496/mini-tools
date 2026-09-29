package vault

import (
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	mtcrypto "mini-tools/backend/crypto"
	"mini-tools/backend/i18n"
)

// Central store for SSH private keys, so one key can be linked to many
// connections instead of being pasted into each of them.
//
// Before this, a key used by six servers lived as six independent copies: a
// rotated key meant editing six connections, and there was no way to see
// which key a connection actually used. Here the material is stored once,
// encrypted under the same vault key as every DSN, and connections reference
// it by id.

// SSHKeySummary is what the frontend sees. The key material and passphrase
// are NEVER part of it — same rule as ConnectionSummary and the DSN.
type SSHKeySummary struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// KeyType is the algorithm reported by the key itself ("ssh-ed25519",
	// "ssh-rsa", …), derived at save time.
	KeyType string `json:"keyType"`
	// Fingerprint is the SHA256 fingerprint in the format ssh-keygen prints,
	// which is what makes a key recognisable in a list without decrypting it
	// — and is public information by design.
	Fingerprint string `json:"fingerprint"`
	// HasPassphrase reports whether a passphrase was stored alongside. Shown
	// so it is obvious why a key works here but asks for a passphrase in a
	// terminal.
	HasPassphrase bool  `json:"hasPassphrase"`
	CreatedAt     int64 `json:"createdAt"`
}

// SaveSSHKey validates, describes and stores a private key.
//
// The key is PARSED before being stored, not just written to disk: a typo, a
// truncated paste, or a public key pasted where the private one belongs would
// otherwise be discovered at connection time, on a server, with an error that
// blames the connection rather than the key. Parsing here also yields the type
// and fingerprint shown in the list.
func (s *Store) SaveSSHKey(name, privateKey, passphrase string) (*SSHKeySummary, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, i18n.Errorf(i18n.Msg{ES: "vault: la llave necesita un nombre", EN: "vault: the key needs a name"})
	}
	if strings.TrimSpace(privateKey) == "" {
		return nil, i18n.Errorf(i18n.Msg{ES: "vault: la llave está vacía", EN: "vault: the key is empty"})
	}

	keyType, fingerprint, err := describeKey(privateKey, passphrase)
	if err != nil {
		return nil, err
	}

	key, err := s.gate.Key()
	if err != nil {
		return nil, err
	}

	encKey, keyNonce, err := mtcrypto.Encrypt(key, []byte(privateKey))
	if err != nil {
		return nil, i18n.Errorf(i18n.Msg{ES: "vault: cifrando la llave: %w", EN: "vault: encrypting the key: %w"}, err)
	}

	// A passphrase-less key stores SQL NULL rather than the encryption of an
	// empty string, so HasPassphrase reads back correctly.
	var encPass, passNonce interface{}
	if passphrase != "" {
		c, n, err := mtcrypto.Encrypt(key, []byte(passphrase))
		if err != nil {
			return nil, i18n.Errorf(i18n.Msg{ES: "vault: cifrando la passphrase: %w", EN: "vault: encrypting the passphrase: %w"}, err)
		}
		encPass, passNonce = c, n
	}

	id, err := newID()
	if err != nil {
		return nil, err
	}
	createdAt := time.Now().Unix()

	if _, err := s.db.Exec(
		`INSERT INTO ssh_keys (id, name, key_type, fingerprint, encrypted_key, key_nonce, encrypted_passphrase, passphrase_nonce, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, name, keyType, fingerprint, encKey, keyNonce, encPass, passNonce, createdAt,
	); err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return nil, i18n.Errorf(i18n.Msg{ES: "vault: ya existe una llave llamada %q", EN: "vault: a key named %q already exists"}, name)
		}
		return nil, i18n.Errorf(i18n.Msg{ES: "vault: guardando la llave: %w", EN: "vault: saving the key: %w"}, err)
	}

	return &SSHKeySummary{
		ID: id, Name: name, KeyType: keyType, Fingerprint: fingerprint,
		HasPassphrase: passphrase != "", CreatedAt: createdAt,
	}, nil
}

// describeKey parses the PEM and returns its algorithm and SHA256
// fingerprint.
func describeKey(privateKey, passphrase string) (string, string, error) {
	var signer ssh.Signer
	var err error
	if passphrase != "" {
		signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(privateKey), []byte(passphrase))
	} else {
		signer, err = ssh.ParsePrivateKey([]byte(privateKey))
	}
	if err != nil {
		// Distinguish the one failure the user can act on directly. Without
		// this the message is "ssh: this private key is passphrase protected",
		// which reads like the key is broken.
		var passErr *ssh.PassphraseMissingError
		if errors.As(err, &passErr) {
			return "", "", i18n.Errorf(i18n.Msg{ES: "vault: la llave está protegida por passphrase — hay que indicarla para guardarla", EN: "vault: the key is protected by a passphrase — enter it to save the key"})
		}
		return "", "", i18n.Errorf(i18n.Msg{ES: "vault: la llave no se pudo leer: %w", EN: "vault: the key could not be read: %w"}, err)
	}

	pub := signer.PublicKey()
	sum := sha256.Sum256(pub.Marshal())
	return pub.Type(), "SHA256:" + strings.TrimRight(base64.StdEncoding.EncodeToString(sum[:]), "="), nil
}

// ListSSHKeys returns every stored key without any material, ordered by name.
func (s *Store) ListSSHKeys() ([]SSHKeySummary, error) {
	rows, err := s.db.Query(
		`SELECT id, name, key_type, fingerprint, encrypted_passphrase IS NOT NULL, created_at FROM ssh_keys ORDER BY name`)
	if err != nil {
		return nil, i18n.Errorf(i18n.Msg{ES: "vault: listando llaves: %w", EN: "vault: listing keys: %w"}, err)
	}
	defer rows.Close()

	out := []SSHKeySummary{}
	for rows.Next() {
		var k SSHKeySummary
		if err := rows.Scan(&k.ID, &k.Name, &k.KeyType, &k.Fingerprint, &k.HasPassphrase, &k.CreatedAt); err != nil {
			return nil, i18n.Errorf(i18n.Msg{ES: "vault: leyendo llave: %w", EN: "vault: reading key: %w"}, err)
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// RenameSSHKey changes a key's label without touching its material.
func (s *Store) RenameSSHKey(id, name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return i18n.Errorf(i18n.Msg{ES: "vault: la llave necesita un nombre", EN: "vault: the key needs a name"})
	}
	res, err := s.db.Exec(`UPDATE ssh_keys SET name = ? WHERE id = ?`, name, id)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return i18n.Errorf(i18n.Msg{ES: "vault: ya existe una llave llamada %q", EN: "vault: a key named %q already exists"}, name)
		}
		return i18n.Errorf(i18n.Msg{ES: "vault: renombrando la llave: %w", EN: "vault: renaming the key: %w"}, err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return i18n.Errorf(i18n.Msg{ES: "vault: llave %q no encontrada", EN: "vault: key %q not found"}, id)
	}
	return nil
}

// DeleteSSHKey removes a key. Callers should check SSHKeyUsage first — a
// deleted key leaves every connection referencing it unable to authenticate,
// and there is no undo.
func (s *Store) DeleteSSHKey(id string) error {
	res, err := s.db.Exec(`DELETE FROM ssh_keys WHERE id = ?`, id)
	if err != nil {
		return i18n.Errorf(i18n.Msg{ES: "vault: borrando la llave: %w", EN: "vault: deleting the key: %w"}, err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return i18n.Errorf(i18n.Msg{ES: "vault: llave %q no encontrada", EN: "vault: key %q not found"}, id)
	}
	return nil
}

// SSHKeyMaterial decrypts a key and its passphrase. BACKEND ONLY — the return
// value must never reach a bound App method's response, same rule as
// ConnectionDSN.
func (s *Store) SSHKeyMaterial(id string) (string, string, error) {
	key, err := s.gate.Key()
	if err != nil {
		return "", "", err
	}

	var encKey, keyNonce []byte
	var encPass, passNonce []byte
	err = s.db.QueryRow(
		`SELECT encrypted_key, key_nonce, encrypted_passphrase, passphrase_nonce FROM ssh_keys WHERE id = ?`, id).
		Scan(&encKey, &keyNonce, &encPass, &passNonce)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", i18n.Errorf(i18n.Msg{ES: "vault: la llave vinculada a esta conexión ya no existe", EN: "vault: the key linked to this connection no longer exists"})
	}
	if err != nil {
		return "", "", i18n.Errorf(i18n.Msg{ES: "vault: leyendo la llave: %w", EN: "vault: reading the key: %w"}, err)
	}

	plain, err := mtcrypto.Decrypt(key, encKey, keyNonce)
	if err != nil {
		return "", "", i18n.Errorf(i18n.Msg{ES: "vault: descifrando la llave: %w", EN: "vault: decrypting the key: %w"}, err)
	}

	passphrase := ""
	if len(encPass) > 0 {
		p, err := mtcrypto.Decrypt(key, encPass, passNonce)
		if err != nil {
			return "", "", i18n.Errorf(i18n.Msg{ES: "vault: descifrando la passphrase: %w", EN: "vault: decrypting the passphrase: %w"}, err)
		}
		passphrase = string(p)
	}

	return string(plain), passphrase, nil
}
