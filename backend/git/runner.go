package git

import (
	"bytes"
	"context"
	"mini-tools/backend/i18n"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// defaultTimeout bounds local, non-network commands. Network operations pass
// their own longer deadline — a clone of a large repository legitimately runs
// for minutes, while a `git log` that takes 30s means something is wrong.
const defaultTimeout = 30 * time.Second

// networkTimeout bounds fetch/pull/push/clone. Long enough for a real clone
// over a slow link, short enough that a hung connection eventually surfaces as
// an error instead of a spinner that never resolves.
const networkTimeout = 10 * time.Minute

// execCommand is the single construction point for a git child process, so
// every invocation in this package is built the same way.
var execCommand = exec.CommandContext

// Runner executes git commands. It resolves the git binary once at
// construction; the resolution result (including failure) is cached because
// PATH does not change under a running desktop app, and re-running LookPath on
// every command would be pure overhead.
type Runner struct {
	mu      sync.RWMutex
	path    string
	version string
	err     error

	// log records every invocation for the command drawer. See
	// commandlog.go — arguments only, never the environment, because that
	// is where credentials travel.
	log commandLog
}

// Availability is what the frontend needs to decide between rendering the Git
// module and rendering a "git not installed" state.
type Availability struct {
	Available bool   `json:"available"`
	Version   string `json:"version"`
	Path      string `json:"path"`
	Error     string `json:"error"`
}

func NewRunner() *Runner {
	r := &Runner{}
	r.probe()
	return r
}

// probe locates the git binary and reads its version. Called once at
// construction and re-runnable via Refresh if the user installs git without
// restarting the app.
func (r *Runner) probe() {
	path, err := exec.LookPath("git")
	r.mu.Lock()
	defer r.mu.Unlock()
	if err != nil {
		r.path, r.version, r.err = "", "", &probeError{i18n.Msg{ES: "git no está instalado o no está en el PATH: %w", EN: "git is not installed or not on the PATH: %w"}, []any{err}, err}
		return
	}
	r.path, r.err = path, nil

	ctx, cancel := context.WithTimeout(context.Background(), defaultTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "--version")
	cmd.Env = hardenedEnv(nil)
	out, verr := cmd.Output()
	if verr != nil {
		r.err = &probeError{i18n.Msg{ES: "no se pudo ejecutar %q: %w", EN: "could not run %q: %w"}, []any{path, verr}, verr}
		return
	}
	r.version = strings.TrimSpace(strings.TrimPrefix(string(bytes.TrimSpace(out)), "git version "))
}

// probeError es el fallo del sondeo de git. Se guarda en el Runner al
// arrancar —antes de que se lea el idioma elegido— y se muestra mucho
// después, así que el texto se arma al leerlo y no al crearlo.
type probeError struct {
	m     i18n.Msg
	args  []any
	cause error
}

func (e *probeError) Error() string { return i18n.Errorf(e.m, e.args...).Error() }
func (e *probeError) Unwrap() error { return e.cause }

// Refresh re-runs the probe, so a user who installs git while the app is open
// can recover without restarting.
func (r *Runner) Refresh() Availability {
	r.probe()
	return r.Probe()
}

// Probe reports the cached availability of the git binary.
func (r *Runner) Probe() Availability {
	r.mu.RLock()
	defer r.mu.RUnlock()
	a := Availability{Available: r.err == nil && r.path != "", Version: r.version, Path: r.path}
	if r.err != nil {
		a.Error = r.err.Error()
	}
	return a
}

func (r *Runner) binary() (string, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.err != nil {
		return "", r.err
	}
	if r.path == "" {
		return "", i18n.New(i18n.Msg{ES: "git no está disponible", EN: "git is not available"})
	}
	return r.path, nil
}

// hardenedEnv builds the environment every git invocation runs under.
//
// GIT_TERMINAL_PROMPT=0 is the load-bearing one: without it, a git that needs
// credentials blocks forever waiting on a terminal that does not exist inside
// a GUI app, and the operation appears to hang rather than fail. With it, git
// returns a real authentication error the UI can act on.
//
// LC_ALL=C pins the language of git's own messages so parsing stays stable on
// a non-English system. Porcelain output is already locale-independent, but
// error text is not, and errors are shown to the user.
func hardenedEnv(extra []string) []string {
	env := append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		"LC_ALL=C",
		// Never let a pager attach — git would wait on a pager that has no
		// terminal to write to.
		"GIT_PAGER=cat",
		"PAGER=cat",
		// Sin terminal git asume 80 columnas y el diffstat de un pull recorta
		// las rutas largas a ".../resto": la UI no podría abrir esos archivos.
		"COLUMNS=1000",
	)
	return append(env, extra...)
}

// run executes git inside repoPath and returns stdout. stderr is folded into
// the error because git writes the useful part of a failure there.
//
// Arguments are passed to exec directly — there is no shell, so a branch name
// or path containing shell metacharacters is inert. The one real injection
// vector left is an argument that begins with "-" being read as a flag, which
// callers guard with checkRefArg / a "--" separator.
func (r *Runner) run(ctx context.Context, repoPath string, args ...string) (string, error) {
	out, err := r.runRaw(ctx, repoPath, nil, args...)
	return string(out), err
}

// runRaw is run without the string conversion, for output that is binary or
// NUL-delimited. env carries per-call additions (auth), appended after the
// hardened base so it can override it.
func (r *Runner) runRaw(ctx context.Context, repoPath string, env []string, args ...string) ([]byte, error) {
	bin, err := r.binary()
	if err != nil {
		return nil, err
	}

	cmd := exec.CommandContext(ctx, bin, args...)
	if repoPath != "" {
		cmd.Dir = repoPath
	}
	cmd.Env = hardenedEnv(env)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	started := time.Now()

	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		r.record(repoPath, args, started, true, msg)
		if ctx.Err() == context.DeadlineExceeded {
			return nil, i18n.Errorf(i18n.Msg{ES: "git %s: la operación excedió el tiempo límite", EN: "git %s: the operation timed out"}, subcommand(args))
		}
		if msg == "" {
			return nil, i18n.Errorf(i18n.Msg{ES: "git %s: %w", EN: "git %s: %w"}, subcommand(args), err)
		}
		// The error text is git's own stderr, which may name a remote or a
		// path but never a credential — tokens travel through askpass, not
		// argv, so they cannot appear here.
		return nil, i18n.Errorf(i18n.Msg{ES: "git %s: %s", EN: "git %s: %s"}, subcommand(args), msg)
	}
	r.record(repoPath, args, started, false, "")
	return stdout.Bytes(), nil
}

// runLocal is the common case: a read-only command with the default timeout
// and no auth.
func (r *Runner) runLocal(repoPath string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultTimeout)
	defer cancel()
	return r.run(ctx, repoPath, args...)
}

func (r *Runner) runLocalRaw(repoPath string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultTimeout)
	defer cancel()
	return r.runRaw(ctx, repoPath, nil, args...)
}

// subcommand is the name to blame in an error message: the first argument
// that is not a global flag.
//
// Some calls prepend "-c key=value" to neutralise the editor, and labelling
// their failures with args[0] produced "git -c: cannot rebase…" — the one
// word in the message that tells the user WHICH command failed, replaced by
// a flag. Falls back to args[0] so a call made entirely of flags still says
// something.
func subcommand(args []string) string {
	for i := 0; i < len(args); i++ {
		if args[i] == "-c" || args[i] == "--config-env" {
			i++ // skip its value too
			continue
		}
		if !strings.HasPrefix(args[i], "-") {
			return args[i]
		}
	}
	if len(args) > 0 {
		return args[0]
	}
	return "git"
}

// Rótulos del argumento que valida checkRefArg: van dentro del mensaje de
// error, así que se traducen con él.
var (
	argRevision         = i18n.Msg{ES: "revisión", EN: "revision"}
	argCommit           = i18n.Msg{ES: "commit", EN: "commit"}
	argRef              = i18n.Msg{ES: "referencia", EN: "reference"}
	argBranch           = i18n.Msg{ES: "rama", EN: "branch"}
	argRemote           = i18n.Msg{ES: "remoto", EN: "remote"}
	argStartPoint       = i18n.Msg{ES: "punto de partida", EN: "start point"}
	argNewRemoteName    = i18n.Msg{ES: "nuevo nombre de remoto", EN: "new remote name"}
	argStash            = i18n.Msg{ES: "stash", EN: "stash"}
	argBase             = i18n.Msg{ES: "base", EN: "base"}
	argBaseBranch       = i18n.Msg{ES: "rama base", EN: "base branch"}
	argTag              = i18n.Msg{ES: "tag", EN: "tag"}
	argUpstream         = i18n.Msg{ES: "upstream", EN: "upstream"}
	argRemoteBranch     = i18n.Msg{ES: "rama remota", EN: "remote branch"}
	argNewName          = i18n.Msg{ES: "nuevo nombre", EN: "new name"}
	argPath             = i18n.Msg{ES: "ruta", EN: "path"}
	argProductionBranch = i18n.Msg{ES: "rama de producción", EN: "production branch"}
	argDevelopBranch    = i18n.Msg{ES: "rama de desarrollo", EN: "development branch"}
)

// checkRefArg rejects a user-supplied ref, path, or remote name that would be
// parsed as a flag. exec passes arguments without a shell so quoting is not a
// concern, but `git checkout --orphan` reached through a branch name literally
// called "--orphan" would still be a real bug.
func checkRefArg(kind i18n.Msg, v string) error {
	if v == "" {
		return i18n.Errorf(i18n.Msg{ES: "%s no puede estar vacío", EN: "%s cannot be empty"}, i18n.T(kind))
	}
	if strings.HasPrefix(v, "-") {
		return i18n.Errorf(i18n.Msg{ES: "%s inválido: %q no puede empezar con '-'", EN: "invalid %s: %q cannot start with '-'"}, i18n.T(kind), v)
	}
	return nil
}

// resolveRepo validates that path is inside a git working tree and returns its
// canonical root. Every exported operation funnels through this, so a caller
// cannot aim a write at a directory that merely looks like a repository, and
// the frontend can pass any path inside the tree rather than exactly the root.
func (r *Runner) resolveRepo(path string) (string, error) {
	if path == "" {
		return "", i18n.New(i18n.Msg{ES: "la ruta del repositorio no puede estar vacía", EN: "the repository path cannot be empty"})
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", i18n.Errorf(i18n.Msg{ES: "ruta de repositorio inválida %q: %w", EN: "invalid repository path %q: %w"}, path, err)
	}
	if info, err := os.Stat(abs); err != nil || !info.IsDir() {
		return "", i18n.Errorf(i18n.Msg{ES: "la ruta %q no es un directorio accesible", EN: "the path %q is not an accessible directory"}, path)
	}
	out, err := r.runLocal(abs, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", i18n.Errorf(i18n.Msg{ES: "%q no es un repositorio git: %w", EN: "%q is not a git repository: %w"}, path, err)
	}
	root := strings.TrimSpace(out)
	if root == "" {
		return "", i18n.Errorf(i18n.Msg{ES: "%q no es un repositorio git", EN: "%q is not a git repository"}, path)
	}
	return root, nil
}

// splitNUL splits NUL-delimited output, dropping the trailing empty element.
// Used wherever a -z form is available, because paths may contain newlines and
// line-splitting would silently corrupt them.
func splitNUL(s string) []string {
	parts := strings.Split(s, "\x00")
	if n := len(parts); n > 0 && parts[n-1] == "" {
		parts = parts[:n-1]
	}
	return parts
}
