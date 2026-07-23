package vault

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	mtcrypto "mini-tools/backend/crypto"
)

// GitCredential is a stored Personal Access Token for one forge host.
//
// It deliberately has NO token field. The struct crosses the Go↔React binding
// (it is what the settings dialog lists), and .claude/rules/technical.md
// point 9 is absolute: the frontend never sees a credential. The token is read
// back only by GitToken below, which is called from app.go to build the auth
// environment for a git invocation and never returned to the UI.
type GitCredential struct {
	ID        string `json:"id"`
	Host      string `json:"host"`
	Username  string `json:"username"`
	CreatedAt int64  `json:"createdAt"`
}

// ErrNoGitCredential is returned by GitToken when nothing is stored for a
// host. It is a normal outcome, not a failure — no stored token means "let git
// resolve credentials itself" (OS keychain, helper, ssh-agent), which is the
// correct default.
var ErrNoGitCredential = errors.New("vault: no hay credencial guardada para ese host")

// SaveGitCredential stores or replaces the token for a host. host is
// normalised (lowercased, scheme and path stripped) so "https://GitHub.com/x"
// and "github.com" resolve to the same entry instead of silently creating two.
func (s *Store) SaveGitCredential(host, username, token string) (*GitCredential, error) {
	h := NormalizeGitHost(host)
	if h == "" {
		return nil, fmt.Errorf("vault: el host no puede estar vacío")
	}
	if strings.TrimSpace(token) == "" {
		return nil, fmt.Errorf("vault: el token no puede estar vacío")
	}

	key, err := s.gate.Key()
	if err != nil {
		return nil, err
	}
	ciphertext, nonce, err := mtcrypto.Encrypt(key, []byte(token))
	if err != nil {
		return nil, fmt.Errorf("vault: cifrando token: %w", err)
	}

	// Replacing an existing host keeps its id, so anything already referencing
	// it stays valid.
	var id string
	err = s.db.QueryRow(`SELECT id FROM git_credentials WHERE host = ?`, h).Scan(&id)
	switch {
	case err == nil:
		if _, err := s.db.Exec(
			`UPDATE git_credentials SET username = ?, encrypted_token = ?, nonce = ? WHERE id = ?`,
			username, ciphertext, nonce, id,
		); err != nil {
			return nil, fmt.Errorf("vault: actualizando credencial git: %w", err)
		}
		var createdAt int64
		_ = s.db.QueryRow(`SELECT created_at FROM git_credentials WHERE id = ?`, id).Scan(&createdAt)
		return &GitCredential{ID: id, Host: h, Username: username, CreatedAt: createdAt}, nil

	case errors.Is(err, sql.ErrNoRows):
		id, err = newID()
		if err != nil {
			return nil, err
		}
		createdAt := time.Now().Unix()
		if _, err := s.db.Exec(
			`INSERT INTO git_credentials (id, host, username, encrypted_token, nonce, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
			id, h, username, ciphertext, nonce, createdAt,
		); err != nil {
			return nil, fmt.Errorf("vault: guardando credencial git: %w", err)
		}
		return &GitCredential{ID: id, Host: h, Username: username, CreatedAt: createdAt}, nil

	default:
		return nil, fmt.Errorf("vault: buscando credencial git: %w", err)
	}
}

// ListGitCredentials returns the stored hosts and usernames — never a token.
func (s *Store) ListGitCredentials() ([]GitCredential, error) {
	rows, err := s.db.Query(`SELECT id, host, username, created_at FROM git_credentials ORDER BY host`)
	if err != nil {
		return nil, fmt.Errorf("vault: listando credenciales git: %w", err)
	}
	defer rows.Close()

	creds := []GitCredential{}
	for rows.Next() {
		var c GitCredential
		if err := rows.Scan(&c.ID, &c.Host, &c.Username, &c.CreatedAt); err != nil {
			return nil, fmt.Errorf("vault: leyendo credencial git: %w", err)
		}
		creds = append(creds, c)
	}
	return creds, rows.Err()
}

// GitToken decrypts the token for a host.
//
// This is the ONLY read path for the plaintext, and it exists to be called
// from app.go when building a git.AuthConfig — never to be bound to the
// frontend. Callers get ErrNoGitCredential when nothing is stored, which they
// must treat as "fall back to git's own credential resolution", not as an
// error to surface.
func (s *Store) GitToken(host string) (username, token string, err error) {
	h := NormalizeGitHost(host)
	if h == "" {
		return "", "", ErrNoGitCredential
	}

	key, err := s.gate.Key()
	if err != nil {
		return "", "", err
	}

	var ciphertext, nonce []byte
	err = s.db.QueryRow(
		`SELECT username, encrypted_token, nonce FROM git_credentials WHERE host = ?`, h,
	).Scan(&username, &ciphertext, &nonce)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", ErrNoGitCredential
	}
	if err != nil {
		return "", "", fmt.Errorf("vault: leyendo credencial git: %w", err)
	}

	plaintext, err := mtcrypto.Decrypt(key, ciphertext, nonce)
	if err != nil {
		return "", "", fmt.Errorf("vault: descifrando token git: %w", err)
	}
	return username, string(plaintext), nil
}

// DeleteGitCredential removes a stored token.
func (s *Store) DeleteGitCredential(id string) error {
	res, err := s.db.Exec(`DELETE FROM git_credentials WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("vault: borrando credencial git: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("vault: borrando credencial git: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("vault: credencial %q no encontrada", id)
	}
	return nil
}

// NormalizeGitHost reduces any of the forms a user might paste — a full clone
// URL, an SSH remote, a bare hostname — to just the host, lowercased.
//
// Matching on the host is what lets one stored token serve every repository
// from that forge. Doing it loosely here rather than demanding a clean
// hostname means pasting the URL straight from the browser works.
func NormalizeGitHost(raw string) string {
	h := strings.TrimSpace(raw)
	if h == "" {
		return ""
	}
	// Strip scheme.
	if i := strings.Index(h, "://"); i != -1 {
		h = h[i+3:]
	}
	// Strip any embedded credentials — a user pasting a URL that already has a
	// token in it must not end up with the token as part of the host key.
	if i := strings.LastIndex(h, "@"); i != -1 {
		h = h[i+1:]
	}
	// Strip path (https form) and the scp-style colon (git@host:owner/repo).
	if i := strings.IndexAny(h, "/:"); i != -1 {
		h = h[:i]
	}
	return strings.ToLower(h)
}
