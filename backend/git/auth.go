package git

import (
	"fmt"
	"net/url"
	"os"
	"strings"
)

// Environment variables used to hand a secret to the askpass helper. They are
// only ever set on the child git process, never exported into the app's own
// environment.
const (
	envAskpassActive   = "MINITOOLS_ASKPASS"
	envAskpassUsername = "MINITOOLS_ASKPASS_USERNAME"
	envAskpassSecret   = "MINITOOLS_ASKPASS_SECRET"
)

// IsAskpassInvocation reports whether this process was re-executed by git as
// its askpass helper rather than started as the app. main() must check this
// before wails.Run and hand off to AskpassMain — see the wiring note there.
func IsAskpassInvocation() bool {
	return os.Getenv(envAskpassActive) == "1" && len(os.Args) > 1
}

// AskpassMain answers git's credential prompt and exits.
//
// This is how a PAT reaches git without ever touching a command line or a
// remote URL. git invokes $GIT_ASKPASS with the prompt as argv[1] and reads
// one line from stdout. We point GIT_ASKPASS at this very binary, so no helper
// executable has to be shipped, written to disk, or found on PATH — which also
// means the secret never lands in a temp file.
//
// The prompt text is git's, and differs across versions and platforms, so it
// is matched loosely: anything mentioning a username gets the username, and
// everything else (password, passphrase, token) gets the secret.
func AskpassMain() {
	prompt := strings.ToLower(os.Args[1])
	switch {
	case strings.Contains(prompt, "username"), strings.Contains(prompt, "usuario"):
		fmt.Println(os.Getenv(envAskpassUsername))
	default:
		fmt.Println(os.Getenv(envAskpassSecret))
	}
	os.Exit(0)
}

// authEnv translates an AuthConfig into environment additions for one git
// invocation.
//
// The zero-value config returns nil, which is the important default: git then
// resolves credentials the way it always does — OS credential helper, keychain,
// ~/.gitconfig, ssh-agent, ~/.ssh/config. That path covers most users and is
// strictly better than anything this package could reimplement, so explicit
// auth is an override, not a requirement.
func authEnv(cfg AuthConfig) ([]string, error) {
	switch cfg.Mode {
	case "":
		return nil, nil
	case "ssh":
		return sshEnv(cfg)
	case "token":
		return tokenEnv(cfg)
	default:
		return nil, fmt.Errorf("modo de autenticación desconocido: %q", cfg.Mode)
	}
}

func sshEnv(cfg AuthConfig) ([]string, error) {
	var opts []string

	if cfg.SSHKeyPath != "" {
		if _, err := os.Stat(cfg.SSHKeyPath); err != nil {
			return nil, fmt.Errorf("no se puede leer la clave SSH %q: %w", cfg.SSHKeyPath, err)
		}
		// IdentitiesOnly=yes stops ssh from offering every key the agent
		// holds before the one that was explicitly chosen. Without it, a
		// server that rejects too many keys fails with "Too many
		// authentication failures" even though the right key was supplied.
		opts = append(opts, "-i", shellQuote(cfg.SSHKeyPath), "-o", "IdentitiesOnly=yes")
	}

	env := []string{"GIT_SSH_COMMAND=ssh " + strings.Join(opts, " ")}

	if cfg.SSHKeyPassphrase != "" {
		self, err := os.Executable()
		if err != nil {
			return nil, fmt.Errorf("no se pudo resolver el ejecutable para askpass: %w", err)
		}
		// SSH_ASKPASS_REQUIRE=force is what makes this work in a GUI app:
		// without it ssh only consults SSH_ASKPASS when it has no controlling
		// terminal AND DISPLAY is set, which is unreliable here. It needs
		// OpenSSH 8.4+; on older versions the DISPLAY fallback below is what
		// takes effect instead.
		env = append(env,
			"SSH_ASKPASS="+self,
			"SSH_ASKPASS_REQUIRE=force",
			"DISPLAY=:0",
			envAskpassActive+"=1",
			envAskpassSecret+"="+cfg.SSHKeyPassphrase,
		)
	}
	return env, nil
}

func tokenEnv(cfg AuthConfig) ([]string, error) {
	if cfg.Token == "" {
		return nil, fmt.Errorf("el modo token requiere un token o password")
	}
	self, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("no se pudo resolver el ejecutable para askpass: %w", err)
	}

	username := cfg.Username
	if username == "" {
		// Forges that authenticate by PAT ignore the username but git still
		// asks for one; a non-empty placeholder keeps the exchange moving.
		username = "git"
	}

	return []string{
		"GIT_ASKPASS=" + self,
		envAskpassActive + "=1",
		envAskpassUsername + "=" + username,
		envAskpassSecret + "=" + cfg.Token,
	}, nil
}

// redactURL strips embedded credentials from a remote URL before it crosses
// the Go↔React binding.
//
// This is not hypothetical hygiene: a remote configured as
// https://<token>@github.com/user/repo.git stores the PAT in plain text in
// .git/config, and `git remote -v` prints it. Returning that verbatim would
// put a live credential in the frontend, in React state, and in any rendered
// tooltip — violating .claude/rules/technical.md point 9 ("el frontend nunca
// ve un DSN ni un password").
//
// The placeholder is alphanumeric because url.String() percent-encodes
// anything else, turning "***" into an unreadable "%2A%2A%2A". The userinfo is
// replaced rather than dropped so the UI can still show that
// the URL carries an embedded credential, which is itself worth surfacing.
func redactURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.User == nil {
		// SCP-style SSH remotes (git@github.com:user/repo.git) do not parse
		// as URLs and carry no secret — the part before "@" is a username.
		return raw
	}
	if _, hasPassword := u.User.Password(); hasPassword {
		u.User = url.UserPassword(u.User.Username(), "REDACTED")
	} else {
		// A single userinfo component on an http(s) remote is the token
		// itself; on ssh it is just the login name.
		if u.Scheme == "http" || u.Scheme == "https" {
			u.User = url.User("REDACTED")
		}
	}
	return u.String()
}

// shellQuote wraps a value for GIT_SSH_COMMAND, which git splits with
// shell-style word rules — unlike every other argument in this package, which
// goes to exec untouched. A key path containing a space (common on macOS,
// "~/Library/Application Support/...") breaks without this.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
