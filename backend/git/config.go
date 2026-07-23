package git

import (
	"fmt"
	"strings"
)

// Identity is the author identity git will stamp on commits made in a
// repository.
//
// Local and Global are reported separately because that distinction is the
// whole point of the feature: a repository with no local identity silently
// inherits the global one, and the single most common "why does this commit
// say the wrong email" is exactly that inheritance being invisible. Effective
// is what git would actually use right now.
type Identity struct {
	LocalName   string `json:"localName"`
	LocalEmail  string `json:"localEmail"`
	GlobalName  string `json:"globalName"`
	GlobalEmail string `json:"globalEmail"`

	// Effective is what a commit right now would carry — the local value when
	// set, otherwise the global one.
	EffectiveName  string `json:"effectiveName"`
	EffectiveEmail string `json:"effectiveEmail"`

	// UsingGlobal is true when this repository has no local override and is
	// therefore inheriting. The UI says so explicitly instead of showing empty
	// fields that look like "no identity configured".
	UsingGlobal bool `json:"usingGlobal"`
}

// GetIdentity reads user.name/user.email at both the local and global scope.
func (r *Runner) GetIdentity(repoPath string) (*Identity, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return nil, err
	}

	id := &Identity{
		LocalName:   r.configValue(root, "--local", "user.name"),
		LocalEmail:  r.configValue(root, "--local", "user.email"),
		GlobalName:  r.configValue(root, "--global", "user.name"),
		GlobalEmail: r.configValue(root, "--global", "user.email"),
	}

	id.EffectiveName = id.LocalName
	if id.EffectiveName == "" {
		id.EffectiveName = id.GlobalName
	}
	id.EffectiveEmail = id.LocalEmail
	if id.EffectiveEmail == "" {
		id.EffectiveEmail = id.GlobalEmail
	}
	id.UsingGlobal = id.LocalName == "" && id.LocalEmail == ""

	return id, nil
}

// configValue reads one config key at one scope, treating "not set" as an
// empty string rather than an error.
//
// `git config --get` exits 1 when a key is absent, which is a normal state
// here — a repository without a local user.email is the common case, not a
// failure — so the error is swallowed deliberately.
func (r *Runner) configValue(root, scope, key string) string {
	out, err := r.runLocal(root, "config", scope, "--get", key)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

// SetIdentity writes user.name/user.email for a repository.
//
// global=true writes to ~/.gitconfig, affecting every repository on the
// machine that has no local override; global=false writes to this
// repository's .git/config only. The distinction is surfaced in the UI rather
// than guessed at, because writing the wrong one either does nothing visible
// (local override shadows the global write) or changes every other project.
//
// An empty value REMOVES the key rather than setting it to "". Setting
// user.email to an empty string produces commits with an empty author email,
// which git accepts and every forge rejects; unsetting restores inheritance,
// which is what a user clearing the field means.
func (r *Runner) SetIdentity(repoPath, name, email string, global bool) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	scope := "--local"
	if global {
		scope = "--global"
	}

	if err := r.setOrUnset(root, scope, "user.name", name); err != nil {
		return err
	}
	return r.setOrUnset(root, scope, "user.email", email)
}

func (r *Runner) setOrUnset(root, scope, key, value string) error {
	v := strings.TrimSpace(value)
	if v == "" {
		// --unset exits 5 when the key was not set to begin with, which is not
		// an error for us: the desired end state (key absent) already holds.
		if _, err := r.runLocal(root, "config", scope, "--unset", key); err != nil {
			if strings.Contains(err.Error(), "exit status 5") || strings.Contains(strings.ToLower(err.Error()), "no such") {
				return nil
			}
			// A missing global config file is likewise not a failure to unset.
			if scope == "--global" && strings.Contains(strings.ToLower(err.Error()), "could not lock") {
				return fmt.Errorf("no se pudo escribir ~/.gitconfig: %w", err)
			}
			return nil
		}
		return nil
	}
	// Values starting with "-" would be read as flags; `--` is not accepted
	// by git config, so the check is explicit.
	if strings.HasPrefix(v, "-") {
		return fmt.Errorf("valor inválido para %s: no puede empezar con '-'", key)
	}
	_, err := r.runLocal(root, "config", scope, key, v)
	if err != nil {
		return fmt.Errorf("no se pudo escribir %s: %w", key, err)
	}
	return nil
}

// RemoteHost returns the host of a remote's URL, for looking up a stored
// token. It reads the raw (unredacted) URL because a redacted one would still
// parse to the right host, but reading the real one keeps this correct if the
// redaction format ever changes.
func (r *Runner) RemoteHost(repoPath, remote string) (string, error) {
	raw, err := r.RemoteURLRaw(repoPath, remote)
	if err != nil {
		return "", err
	}
	return raw, nil
}
