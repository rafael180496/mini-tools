package git

import (
	"fmt"
	"runtime"
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

// CredentialCache is how git itself remembers HTTPS passwords, which is a
// different thing from how this app remembers them.
//
// The two coexist on purpose. The app stores a PAT in its own vault and
// feeds it to git through askpass (see auth.go), which never touches git's
// configuration; git's credential helper is what answers when the app
// defers ("let git decide" — the AuthConfig zero value) and, more to the
// point, what answers when the SAME repository is used from a terminal.
// Someone who clones here and pulls from a shell wants the second one, and
// until now there was no way to see or set it without editing .gitconfig.
type CredentialCache struct {
	// Helper is the configured credential.helper, "" when none is set.
	Helper string `json:"helper"`
	// Global reports that the value comes from ~/.gitconfig rather than
	// from this repository. It changes what turning it off means — unsetting
	// a global helper affects every repository on the machine — so it is
	// reported rather than inferred.
	Global bool `json:"global"`
	// Available are the helpers worth offering on THIS operating system.
	// Listing "osxkeychain" on Linux or "wincred" on macOS would offer a
	// setting that silently fails on the next fetch, which is the worst
	// kind of broken: it looks configured.
	Available []CredentialHelperOption `json:"available"`
}

// CredentialHelperOption is one offerable helper.
type CredentialHelperOption struct {
	Value string `json:"value"`
	Label string `json:"label"`
	// Secure distinguishes a helper backed by the OS keychain from one that
	// writes the password to a plain file (`store`) or keeps it in memory
	// for a while (`cache`). The UI is expected to say so: "remember my
	// password" and "write my password to ~/.git-credentials in clear text"
	// are not the same offer.
	Secure bool `json:"secure"`
}

// CredentialHelpers reports the effective credential.helper and the options
// that make sense on this machine.
//
// Read with --get rather than --get-all: a repository can legitimately
// configure several helpers that git consults in order, but offering that in
// a dropdown would be a configuration editor, not a setting. What the UI
// shows is the first one, which is the one that answers.
func (r *Runner) CredentialHelpers(repoPath string) (CredentialCache, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return CredentialCache{}, err
	}

	out := CredentialCache{Available: credentialHelperOptions()}
	// El scope local sale del listado completo, que siempre sale con 0.
	// Preguntar con `--get` una clave que no está sale con 1 y deja una
	// entrada en rojo en "Comandos ejecutados" cada vez que se abre este
	// diálogo — y no tener credential.helper configurado es el caso normal.
	if local := r.localConfig(root)["credential.helper"]; local != "" {
		out.Helper = local
		return out, nil
	}
	// Igual que el local: `--list` en vez de `--get`. En una máquina que ya
	// tenga ~/.gitconfig —o sea cualquiera con user.name configurado— sale
	// con 0 y no deja rastro rojo; sin el archivo falla igual que `--get`,
	// así que nunca es peor.
	if global := r.configList(root, "--global")["credential.helper"]; global != "" {
		out.Helper = global
		out.Global = true
	}
	return out, nil
}

// SetCredentialHelper writes (or clears) credential.helper.
//
// An empty helper unsets the key, which restores "git asks every time" —
// and, when the value being cleared is the global one, does so for every
// repository on the machine. That is why the scope is a parameter and not a
// guess: the caller knows which of the two the user was looking at.
func (r *Runner) SetCredentialHelper(repoPath, helper string, global bool) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if helper != "" && !isKnownCredentialHelper(helper) {
		// Not a security boundary — setOrUnset already refuses a leading
		// "-" and there is no shell — but a typo'd helper name turns into
		// "git: 'credential-xyz' is not a git command" on the next fetch,
		// far from where it was introduced.
		return fmt.Errorf("credential helper desconocido: %q", helper)
	}
	scope := "--local"
	if global {
		scope = "--global"
	}
	return r.setOrUnset(root, scope, "credential.helper", helper)
}

// credentialHelperOptions is the per-OS list. `cache` is deliberately given
// a timeout: bare `cache` expires in 15 minutes, which is short enough that
// people conclude the setting did not work.
func credentialHelperOptions() []CredentialHelperOption {
	switch runtime.GOOS {
	case "darwin":
		return []CredentialHelperOption{
			{Value: "osxkeychain", Label: "Llavero de macOS", Secure: true},
			{Value: "cache --timeout=3600", Label: "Recordar 1 hora (en memoria)", Secure: true},
			{Value: "store", Label: "Archivo en texto plano (~/.git-credentials)"},
		}
	case "windows":
		return []CredentialHelperOption{
			{Value: "manager", Label: "Administrador de credenciales de Windows", Secure: true},
			{Value: "wincred", Label: "Credenciales de Windows (clásico)", Secure: true},
			{Value: "store", Label: "Archivo en texto plano (~/.git-credentials)"},
		}
	default:
		return []CredentialHelperOption{
			{Value: "cache --timeout=3600", Label: "Recordar 1 hora (en memoria)", Secure: true},
			// El único de toda la lista que NO viene con git: hay que
			// instalarlo aparte (o compilarlo, en varias distros) y suele
			// vivir en /usr/lib/git-core, fuera del PATH, así que sondear
			// con LookPath daría falsos negativos. Entre un sondeo que se
			// equivoca la mitad de las veces y una etiqueta honesta, la
			// etiqueta: el usuario sabe si lo tiene, la app no.
			{Value: "libsecret", Label: "Llavero del escritorio (requiere git-credential-libsecret)", Secure: true},
			{Value: "store", Label: "Archivo en texto plano (~/.git-credentials)"},
		}
	}
}

func isKnownCredentialHelper(helper string) bool {
	for _, o := range credentialHelperOptions() {
		if o.Value == helper {
			return true
		}
	}
	return false
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
