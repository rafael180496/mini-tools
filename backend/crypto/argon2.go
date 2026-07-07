package crypto

import "golang.org/x/crypto/argon2"

// Argon2id parameters tuned for an interactive, once-per-unlock derivation.
const (
	argonTime    = 3
	argonMemory  = 64 * 1024 // 64 MiB
	argonThreads = 4
	KeySize      = 32 // AES-256
)

// DeriveKey derives a 32-byte AES-256 key from the master password and the
// per-install salt using Argon2id.
func DeriveKey(password, salt []byte) []byte {
	return argon2.IDKey(password, salt, argonTime, argonMemory, argonThreads, KeySize)
}
