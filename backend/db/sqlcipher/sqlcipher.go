// Package sqlcipher reads SQLCipher-encrypted SQLite databases in pure Go, by
// decrypting them to a plaintext copy that the app's normal modernc.org/sqlite
// driver can then open.
//
// # Why not the SQLCipher driver
//
// Every Go SQLCipher driver bundles the C SQLCipher amalgamation and needs
// cgo, which .claude/rules/technical.md point 1 forbids outright — cgo would
// break the pure-Go single-binary guarantee AND the Windows-cross-compile-from
// -macOS that the whole release process depends on. So instead of linking
// SQLCipher, this package reimplements just the read path of its on-disk
// format (documented and stable) using only the standard library's crypto:
// PBKDF2 for key derivation, AES-256-CBC for page decryption. No new
// dependency enters go.mod.
//
// # Scope: read-only
//
// Decryption produces a plaintext copy; the original stays encrypted and is
// never written. Saving edits back would require re-encrypting the whole file
// (re-deriving keys, recomputing per-page HMACs) — a separate, larger effort.
// A connection opened this way is therefore effectively read-only: queries and
// browsing work, writes land only in the throwaway plaintext copy.
//
// # Format
//
// The crypto here was verified byte-for-byte against SQLCipher 4.17's own CLI:
// a v4 and a v3 database created by real sqlcipher decrypt with this code to
// output that modernc.org/sqlite opens with identical row data, and a wrong
// passphrase is rejected (the header check below doubles as key verification).
//
// SQLCipher lays a database out in fixed-size pages. The first 16 bytes of the
// file are a random salt (stored in cleartext) used for key derivation. Each
// page is [ciphertext][iv][hmac][padding]; the last `reserve` bytes hold the
// per-page IV and HMAC. Page 1 keeps its first 16 bytes as the salt in the
// encrypted file, and on decryption those are replaced by the standard SQLite
// header "SQLite format 3\0". Everything else is AES-256-CBC over the page
// body with the per-page IV.
package sqlcipher

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/pbkdf2"
	"crypto/sha1"
	"crypto/sha512"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"hash"
	"os"
	"strings"
)

// sqliteHeader is the 16-byte magic every plaintext SQLite database starts
// with. SQLCipher stores the salt in these bytes instead; decryption puts the
// header back so modernc.org/sqlite recognises the file.
var sqliteHeader = []byte("SQLite format 3\x00")

// variant is one set of SQLCipher parameters. They changed across major
// versions, so a database of unknown origin is tried against each in order
// until one produces a valid SQLite header — which, since it can only happen
// with the right key AND the right parameters, also validates the passphrase.
type variant struct {
	name     string
	pageSize int
	reserve  int // trailing bytes per page holding IV + HMAC (+ alignment padding)
	iter     int // PBKDF2 iteration count
	prf      func() hash.Hash
}

// variants covers the two versions in real use. v4 (default since 2017) and v3
// (legacy). v1/v2 predate the HMAC page format and are rare enough to leave
// unsupported rather than guess at; a v1/v2 file simply fails to decrypt and
// the caller surfaces "clave incorrecta o versión no soportada".
//
//   - reserve: v4 = 16-byte IV + 64-byte HMAC-SHA512 = 80 (already 16-aligned);
//     v3 = 16 + 20-byte HMAC-SHA1 = 36, rounded up to the next AES block
//     multiple = 48.
var variants = []variant{
	{name: "SQLCipher 4", pageSize: 4096, reserve: 80, iter: 256000, prf: sha512.New},
	{name: "SQLCipher 3", pageSize: 1024, reserve: 48, iter: 64000, prf: sha1.New},
}

// LooksEncrypted reports whether the file at path appears to be a
// SQLCipher-encrypted database rather than a plaintext SQLite one.
//
// The check is the file's first 16 bytes: a plaintext SQLite database always
// starts with the exact header "SQLite format 3\0", and SQLCipher replaces
// those bytes with a random salt. So "does not start with the header" is a
// reliable "is encrypted (or not a SQLite file at all)" signal, used to
// pre-set the encryption toggle when the user picks a file. It never derives a
// key or reads more than the header, so it is cheap and cannot fail on a wrong
// passphrase — there is no passphrase involved.
func LooksEncrypted(path string) (bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer f.Close()

	head := make([]byte, len(sqliteHeader))
	n, err := f.Read(head)
	if err != nil || n < len(sqliteHeader) {
		// Too short to be a real database either way; treat as "not a plain
		// SQLite file", but surface the read error if there was one.
		if err != nil {
			return false, err
		}
		return true, nil
	}
	return !bytes.Equal(head, sqliteHeader), nil
}

// DecryptToFile reads the SQLCipher database at srcPath, decrypts it with key,
// and writes a plaintext SQLite database to destPath. destPath is created with
// 0600 permissions — it holds the decrypted data and must not be world
// readable.
//
// key is either a passphrase or a raw 32-byte key in SQLCipher's hex form
// (`x'<64 hex chars>'` or a bare 64-hex string); see deriveKey.
func DecryptToFile(srcPath, key, destPath string) (detectedVariant string, err error) {
	data, err := os.ReadFile(srcPath)
	if err != nil {
		return "", fmt.Errorf("sqlcipher: leyendo %q: %w", srcPath, err)
	}
	if len(data) < 512 {
		return "", fmt.Errorf("sqlcipher: %q es demasiado chico para ser una base SQLite", srcPath)
	}
	// An unencrypted SQLite file starts with the plaintext header; decrypting
	// it would be a mistake, so reject it clearly instead of producing garbage.
	if bytes.HasPrefix(data, sqliteHeader) {
		return "", fmt.Errorf("sqlcipher: %q no está cifrada (es una base SQLite normal) — desactivá la opción de cifrado", srcPath)
	}

	plain, name, err := decrypt(data, key)
	if err != nil {
		return "", err
	}
	// 0600: the decrypted copy is as sensitive as the passphrase itself.
	if err := os.WriteFile(destPath, plain, 0o600); err != nil {
		return "", fmt.Errorf("sqlcipher: escribiendo copia descifrada: %w", err)
	}
	return name, nil
}

// decrypt tries every known variant and returns the first that yields a valid
// plaintext SQLite database.
func decrypt(data []byte, key string) ([]byte, string, error) {
	for _, v := range variants {
		if out := tryVariant(data, key, v); out != nil {
			return out, v.name, nil
		}
	}
	return nil, "", fmt.Errorf("no se pudo descifrar: clave incorrecta, o una versión de SQLCipher no soportada (se probó %s)", variantNames())
}

func tryVariant(data []byte, key string, v variant) []byte {
	if len(data) < v.pageSize || len(data)%v.pageSize != 0 {
		return nil
	}
	salt := data[:16]
	aesKey, err := deriveKey(key, salt, v)
	if err != nil {
		return nil
	}
	block, err := aes.NewCipher(aesKey)
	if err != nil {
		return nil
	}

	usable := v.pageSize - v.reserve
	nPages := len(data) / v.pageSize
	out := make([]byte, 0, len(data))

	for p := 0; p < nPages; p++ {
		page := data[p*v.pageSize : (p+1)*v.pageSize]
		// Page 1 keeps the 16-byte salt in cleartext at its start; its
		// ciphertext therefore begins at offset 16.
		off := 0
		if p == 0 {
			off = 16
		}
		iv := page[usable : usable+16]
		ct := page[off:usable]
		if len(ct)%aes.BlockSize != 0 {
			return nil
		}
		pt := make([]byte, len(ct))
		cipher.NewCBCDecrypter(block, iv).CryptBlocks(pt, ct)

		if p == 0 {
			out = append(out, sqliteHeader...)
		}
		out = append(out, pt...)
		// The plaintext database keeps the same page size and reserved-bytes
		// layout; the reserved area is just zeroed. SQLite honours the
		// "reserved bytes per page" field in the header (byte 20, which comes
		// out of the decrypted page 1), so the file stays valid.
		out = append(out, make([]byte, v.reserve)...)
	}

	if !validHeader(out, v.pageSize) {
		return nil
	}
	return out
}

// deriveKey turns key into the 32-byte AES key. A raw key in SQLCipher's hex
// form (`x'…'` or a bare 64-hex string) is used directly, bypassing PBKDF2 —
// this is how `PRAGMA key = "x'…'"` works. Anything else is treated as a
// passphrase and run through PBKDF2 with the file's salt.
func deriveKey(key string, salt []byte, v variant) ([]byte, error) {
	if raw, ok := rawKey(key); ok {
		return raw, nil
	}
	return pbkdf2.Key(v.prf, key, salt, v.iter, 32)
}

// rawKey recognises SQLCipher's raw-key syntax and decodes it to 32 bytes.
func rawKey(key string) ([]byte, bool) {
	h := key
	if strings.HasPrefix(h, "x'") && strings.HasSuffix(h, "'") {
		h = h[2 : len(h)-1]
	}
	if len(h) != 64 {
		return nil, false
	}
	b, err := hex.DecodeString(h)
	if err != nil {
		return nil, false
	}
	return b, true
}

// validHeader checks the reconstructed page-1 header against SQLite's fixed
// invariants. This is what confirms both the passphrase and the variant were
// right: with a wrong key the decrypted bytes are random and these constants
// will not line up.
func validHeader(out []byte, pageSize int) bool {
	if len(out) < 24 || !bytes.Equal(out[:16], sqliteHeader) {
		return false
	}
	ps := int(binary.BigEndian.Uint16(out[16:18]))
	if ps == 1 {
		ps = 65536 // SQLite encodes a 64 KiB page size as the value 1.
	}
	if ps != pageSize {
		return false
	}
	// File-format read/write versions are 1 (rollback journal) or 2 (WAL).
	if out[18] < 1 || out[18] > 2 || out[19] < 1 || out[19] > 2 {
		return false
	}
	// The payload-fraction bytes are hard-coded to 64/32/32 in every SQLite
	// database ever written; they are the strongest cheap validity signal.
	return out[21] == 64 && out[22] == 32 && out[23] == 32
}

func variantNames() string {
	names := make([]string, len(variants))
	for i, v := range variants {
		names[i] = v.name
	}
	return strings.Join(names, ", ")
}
