package git

import (
	"bytes"
	"context"
	"fmt"
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
		r.path, r.version, r.err = "", "", fmt.Errorf("git no está instalado o no está en el PATH: %w", err)
		return
	}
	r.path, r.err = path, nil

	ctx, cancel := context.WithTimeout(context.Background(), defaultTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "--version")
	cmd.Env = hardenedEnv(nil)
	out, verr := cmd.Output()
	if verr != nil {
		r.err = fmt.Errorf("no se pudo ejecutar %q: %w", path, verr)
		return
	}
	r.version = strings.TrimSpace(strings.TrimPrefix(string(bytes.TrimSpace(out)), "git version "))
}

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
		return "", fmt.Errorf("git no está disponible")
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

	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if ctx.Err() == context.DeadlineExceeded {
			return nil, fmt.Errorf("git %s: la operación excedió el tiempo límite", args[0])
		}
		if msg == "" {
			return nil, fmt.Errorf("git %s: %w", args[0], err)
		}
		// The error text is git's own stderr, which may name a remote or a
		// path but never a credential — tokens travel through askpass, not
		// argv, so they cannot appear here.
		return nil, fmt.Errorf("git %s: %s", args[0], msg)
	}
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

// checkRefArg rejects a user-supplied ref, path, or remote name that would be
// parsed as a flag. exec passes arguments without a shell so quoting is not a
// concern, but `git checkout --orphan` reached through a branch name literally
// called "--orphan" would still be a real bug.
func checkRefArg(kind, v string) error {
	if v == "" {
		return fmt.Errorf("%s no puede estar vacío", kind)
	}
	if strings.HasPrefix(v, "-") {
		return fmt.Errorf("%s inválido: %q no puede empezar con '-'", kind, v)
	}
	return nil
}

// resolveRepo validates that path is inside a git working tree and returns its
// canonical root. Every exported operation funnels through this, so a caller
// cannot aim a write at a directory that merely looks like a repository, and
// the frontend can pass any path inside the tree rather than exactly the root.
func (r *Runner) resolveRepo(path string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("la ruta del repositorio no puede estar vacía")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("ruta de repositorio inválida %q: %w", path, err)
	}
	if info, err := os.Stat(abs); err != nil || !info.IsDir() {
		return "", fmt.Errorf("la ruta %q no es un directorio accesible", path)
	}
	out, err := r.runLocal(abs, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", fmt.Errorf("%q no es un repositorio git: %w", path, err)
	}
	root := strings.TrimSpace(out)
	if root == "" {
		return "", fmt.Errorf("%q no es un repositorio git", path)
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
