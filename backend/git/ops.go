package git

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// runNetwork executes a command that talks to a remote: longer deadline, and
// auth environment applied. Every remote operation goes through here so the
// askpass wiring exists in exactly one place.
func (r *Runner) runNetwork(root string, auth AuthConfig, args ...string) (string, error) {
	env, err := authEnv(auth)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), networkTimeout)
	defer cancel()
	out, err := r.runRaw(ctx, root, env, args...)
	return string(out), err
}

// Clone copies a remote repository into targetPath and returns the resulting
// working-tree root.
//
// targetPath is the destination directory itself, not its parent — the caller
// picked a folder in a native dialog, and silently creating a subdirectory
// named after the URL would put the repo somewhere the user did not choose.
func (r *Runner) Clone(url, targetPath string, auth AuthConfig) (string, error) {
	if strings.TrimSpace(url) == "" {
		return "", fmt.Errorf("la URL del repositorio no puede estar vacía")
	}
	if strings.HasPrefix(url, "-") {
		return "", fmt.Errorf("URL inválida: %q no puede empezar con '-'", url)
	}
	if strings.TrimSpace(targetPath) == "" {
		return "", fmt.Errorf("la carpeta de destino no puede estar vacía")
	}

	abs, err := filepath.Abs(targetPath)
	if err != nil {
		return "", fmt.Errorf("carpeta de destino inválida %q: %w", targetPath, err)
	}
	// Refusing a non-empty destination up front turns a confusing git error
	// into a clear one, and rules out cloning on top of existing work.
	if entries, err := os.ReadDir(abs); err == nil && len(entries) > 0 {
		return "", fmt.Errorf("la carpeta %q no está vacía", abs)
	}

	// Clone runs with no repoPath — there is no repository yet.
	if _, err := r.runNetwork("", auth, "clone", "--progress", "--", url, abs); err != nil {
		return "", err
	}
	return abs, nil
}

// Init creates a new empty repository at path, running `git init` there. The
// directory is created if it does not exist. Returns the working-tree root git
// reports, so the caller registers the canonical path.
//
// A path that is already a git repository is reported as such rather than
// silently re-init'd — `git init` on an existing repo is a no-op that would
// leave the user thinking they made a fresh one.
func (r *Runner) Init(path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", fmt.Errorf("la carpeta del repositorio no puede estar vacía")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("carpeta inválida %q: %w", path, err)
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return "", fmt.Errorf("no se pudo crear la carpeta %q: %w", abs, err)
	}
	if r.IsRepository(abs) {
		return "", fmt.Errorf("%q ya es un repositorio git", abs)
	}

	// git init runs against the target directory via -C rather than by setting
	// the process working directory, so it behaves the same whether or not the
	// directory existed a moment ago.
	if _, err := r.runLocal("", "init", abs); err != nil {
		return "", err
	}
	return r.resolveRepo(abs)
}

// Fetch updates remote-tracking refs. Mirrors the fetch dropdown.
func (r *Runner) Fetch(repoPath string, opts FetchOptions, auth AuthConfig) (string, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return "", err
	}

	args := []string{"fetch", "--progress"}
	if opts.Prune {
		args = append(args, "--prune")
	}
	if opts.Tags {
		args = append(args, "--tags")
	}
	if opts.All {
		// --all and a named remote are mutually exclusive; --all wins because
		// it is the more explicit user choice from the menu.
		args = append(args, "--all")
	} else if opts.Remote != "" {
		if err := checkRefArg("remoto", opts.Remote); err != nil {
			return "", err
		}
		args = append(args, opts.Remote)
	}
	return r.runNetwork(root, auth, args...)
}

// Pull fetches and integrates. FFOnly and Rebase are both offered by the menu
// but cannot both apply; Rebase takes precedence, matching git's own handling.
func (r *Runner) Pull(repoPath string, opts PullOptions, auth AuthConfig) (string, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return "", err
	}

	args := []string{"pull", "--progress"}
	switch {
	case opts.Rebase:
		args = append(args, "--rebase")
		if opts.Autostash {
			args = append(args, "--autostash")
		}
	case opts.FFOnly:
		args = append(args, "--ff-only")
	}

	if opts.Remote != "" {
		if err := checkRefArg("remoto", opts.Remote); err != nil {
			return "", err
		}
		args = append(args, opts.Remote)
		if opts.Branch != "" {
			if err := checkRefArg("rama", opts.Branch); err != nil {
				return "", err
			}
			args = append(args, opts.Branch)
		}
	}
	return r.runNetwork(root, auth, args...)
}

// Push publishes local commits. Mirrors the push dropdown.
//
// When both Force and ForceWithLease are set, --force-with-lease wins.
// Discarding someone else's commits should require asking for plain --force
// on its own, never arriving there as a side effect of two checkboxes.
func (r *Runner) Push(repoPath string, opts PushOptions, auth AuthConfig) (string, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return "", err
	}

	args := []string{"push", "--progress"}
	switch {
	case opts.ForceWithLease:
		args = append(args, "--force-with-lease")
	case opts.Force:
		args = append(args, "--force")
	}
	if opts.NoVerify {
		args = append(args, "--no-verify")
	}
	if opts.SetUpstream {
		args = append(args, "--set-upstream")
	}
	if opts.Tags {
		args = append(args, "--tags")
	}

	if opts.Remote != "" {
		if err := checkRefArg("remoto", opts.Remote); err != nil {
			return "", err
		}
		args = append(args, opts.Remote)
		if opts.Branch != "" {
			if err := checkRefArg("rama", opts.Branch); err != nil {
				return "", err
			}
			args = append(args, opts.Branch)
		}
	}
	return r.runNetwork(root, auth, args...)
}

// --- Branching -------------------------------------------------------------

// CheckoutBranch switches the working tree to an existing branch, tag, or
// commit.
//
// Cuando name es una rama REMOTA ("origin/feature/X") no se hace checkout de
// la ref remota: eso deja el repositorio en HEAD desacoplado (detached HEAD),
// un estado del que la mayoría de la gente sale perdiendo trabajo. En su
// lugar se crea —si no existe ya— la rama local correspondiente siguiendo a
// la remota, que es lo que quiere decir "quiero trabajar en esta rama", y si
// ya existe simplemente se cambia a ella.
//
// La detección se hace con datos, no probando comandos: se listan los
// remotos y se pregunta por la rama local con `git branch --list`, dos
// invocaciones que SIEMPRE salen con código 0. Sondear con
// `rev-parse --verify --quiet` habría sido más corto, pero sale con código 1
// cuando la ref no existe, y eso llenaría de entradas en rojo el panel
// "Comandos ejecutados" en el caso normal — un log de auditoría que marca
// errores donde no los hubo deja de servir para encontrar los de verdad.
func (r *Runner) CheckoutBranch(repoPath, name string) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if err := checkRefArg("rama", name); err != nil {
		return err
	}

	if short, ok := r.localNameForRemoteBranch(root, name); ok {
		if r.localBranchExists(root, short) {
			_, err = r.runLocal(root, "checkout", short)
			return err
		}
		_, err = r.runLocal(root, "checkout", "-b", short, "--track", name)
		return err
	}

	_, err = r.runLocal(root, "checkout", name)
	return err
}

// localNameForRemoteBranch decide si name es una rama remota y, si lo es,
// devuelve el nombre que tendría su rama local ("origin/feature/X" →
// "feature/X").
//
// Solo se le quita el PRIMER segmento, y únicamente si coincide con un remoto
// configurado: una rama local puede llamarse "origin/algo" perfectamente, y
// una remota puede tener todas las barras que quiera. Comparar contra la
// lista real de remotos es lo único que distingue los dos casos.
func (r *Runner) localNameForRemoteBranch(root, name string) (string, bool) {
	out, err := r.runLocal(root, "remote")
	if err != nil {
		// Sin lista de remotos no se puede afirmar que sea una rama remota;
		// se sigue por el camino de siempre en vez de adivinar.
		return "", false
	}
	for _, remote := range strings.Fields(out) {
		prefix := remote + "/"
		if !strings.HasPrefix(name, prefix) {
			continue
		}
		short := strings.TrimPrefix(name, prefix)
		// "origin/HEAD" es un puntero simbólico a la rama por defecto del
		// remoto, no una rama: crear una local llamada "HEAD" sería un
		// desastre silencioso.
		if short == "" || short == "HEAD" {
			return "", false
		}
		return short, true
	}
	return "", false
}

// localBranchExists usa `git branch --list`, que sale con código 0 exista o
// no la rama (la respuesta es la salida vacía o no), a diferencia de los
// comandos de verificación de refs. Ver la nota de CheckoutBranch.
func (r *Runner) localBranchExists(root, name string) bool {
	out, err := r.runLocal(root, "branch", "--list", name)
	if err != nil {
		return false
	}
	return strings.TrimSpace(out) != ""
}

// CreateBranch creates a branch and optionally checks it out. startPoint
// defaults to HEAD when empty.
func (r *Runner) CreateBranch(repoPath, name, startPoint string, checkout bool) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if err := checkRefArg("rama", name); err != nil {
		return err
	}

	args := []string{"branch", name}
	if checkout {
		args = []string{"checkout", "-b", name}
	}
	if startPoint != "" {
		if err := checkRefArg("punto de partida", startPoint); err != nil {
			return err
		}
		args = append(args, startPoint)
	}
	_, err = r.runLocal(root, args...)
	return err
}

// DeleteBranch removes a local branch. force switches -d to -D, which discards
// commits that are not merged anywhere — the caller is expected to have
// confirmed with the user first.
func (r *Runner) DeleteBranch(repoPath, name string, force bool) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if err := checkRefArg("rama", name); err != nil {
		return err
	}
	flag := "-d"
	if force {
		flag = "-D"
	}
	_, err = r.runLocal(root, "branch", flag, name)
	return err
}

// --- Remotes ---------------------------------------------------------------

// AddRemote registers a new remote.
func (r *Runner) AddRemote(repoPath, name, url string) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if err := checkRefArg("remoto", name); err != nil {
		return err
	}
	if strings.TrimSpace(url) == "" || strings.HasPrefix(url, "-") {
		return fmt.Errorf("URL de remoto inválida: %q", url)
	}
	_, err = r.runLocal(root, "remote", "add", name, url)
	return err
}

// RenameRemote implements the sidebar's "Rename origin" action.
func (r *Runner) RenameRemote(repoPath, oldName, newName string) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if err := checkRefArg("remoto", oldName); err != nil {
		return err
	}
	if err := checkRefArg("nuevo nombre de remoto", newName); err != nil {
		return err
	}
	_, err = r.runLocal(root, "remote", "rename", oldName, newName)
	return err
}

// SetRemoteURL implements "Update Remote URL".
func (r *Runner) SetRemoteURL(repoPath, name, url string) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if err := checkRefArg("remoto", name); err != nil {
		return err
	}
	if strings.TrimSpace(url) == "" || strings.HasPrefix(url, "-") {
		return fmt.Errorf("URL de remoto inválida: %q", url)
	}
	_, err = r.runLocal(root, "remote", "set-url", name, url)
	return err
}

// RemoveRemote implements "Delete origin".
func (r *Runner) RemoveRemote(repoPath, name string) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if err := checkRefArg("remoto", name); err != nil {
		return err
	}
	_, err = r.runLocal(root, "remote", "remove", name)
	return err
}

// --- Staging and committing ------------------------------------------------

// StageFiles adds paths to the index. Passing no paths is rejected rather than
// treated as "stage everything" — an empty selection reaching this call is a
// frontend bug, and silently staging the whole tree would be the worst
// possible interpretation of it.
func (r *Runner) StageFiles(repoPath string, paths []string) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if len(paths) == 0 {
		return fmt.Errorf("no se indicó ningún archivo para stagear")
	}
	args := append([]string{"add", "--"}, paths...)
	_, err = r.runLocal(root, args...)
	return err
}

// StageAll stages every change including untracked files — the explicit
// "stage all" button, distinct from StageFiles with an empty slice.
func (r *Runner) StageAll(repoPath string) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	_, err = r.runLocal(root, "add", "--all")
	return err
}

// UnstageFiles removes paths from the index, leaving the working tree alone.
func (r *Runner) UnstageFiles(repoPath string, paths []string) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if len(paths) == 0 {
		return fmt.Errorf("no se indicó ningún archivo para quitar del stage")
	}
	// `restore --staged` rather than `reset HEAD --`: it behaves correctly in
	// a repository with no commits yet, where HEAD does not resolve.
	args := append([]string{"restore", "--staged", "--"}, paths...)
	_, err = r.runLocal(root, args...)
	return err
}

// DiscardChanges throws away working-tree modifications for the given paths.
// Destructive and unrecoverable — there is no reflog for uncommitted work —
// so the caller must confirm with the user before calling it.
func (r *Runner) DiscardChanges(repoPath string, paths []string) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if len(paths) == 0 {
		return fmt.Errorf("no se indicó ningún archivo para descartar")
	}
	args := append([]string{"restore", "--worktree", "--"}, paths...)
	_, err = r.runLocal(root, args...)
	return err
}

// ApplyPatch feeds a patch to `git apply`, which is how per-hunk and per-line
// staging works: the frontend builds a partial patch from the diff it is
// already showing, and git applies it to the index.
//
// cached=true stages the patch; cached=false with reverse=true is "discard
// this hunk" in the working tree.
func (r *Runner) ApplyPatch(repoPath, patch string, cached, reverse bool) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if strings.TrimSpace(patch) == "" {
		return fmt.Errorf("el patch está vacío")
	}

	args := []string{"apply", "--whitespace=nowarn"}
	if cached {
		args = append(args, "--cached")
	}
	if reverse {
		args = append(args, "--reverse")
	}
	// A patch cannot be passed as an argument — it is multi-line text of
	// arbitrary size, so it goes over stdin.
	return r.runWithStdin(root, patch, args...)
}

// runWithStdin is the one command shape that needs to write to the child, kept
// separate so runRaw stays simple.
func (r *Runner) runWithStdin(root, stdin string, args ...string) error {
	bin, err := r.binary()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), defaultTimeout)
	defer cancel()

	cmd := execCommand(ctx, bin, args...)
	cmd.Dir = root
	cmd.Env = hardenedEnv(nil)
	cmd.Stdin = strings.NewReader(stdin)

	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return fmt.Errorf("git %s: %s", args[0], msg)
		}
		return fmt.Errorf("git %s: %w", args[0], err)
	}
	return nil
}

// Commit records the staged changes. amend rewrites the previous commit
// instead of adding one.
func (r *Runner) Commit(repoPath, message string, amend bool) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if strings.TrimSpace(message) == "" {
		return fmt.Errorf("el mensaje del commit no puede estar vacío")
	}

	// --file=- feeds the message over stdin. Passing it as -m would be fine
	// for exec, but stdin also sidesteps platform argument-length limits on a
	// long commit body.
	args := []string{"commit", "--file=-", "--cleanup=strip"}
	if amend {
		args = append(args, "--amend")
	}
	return r.runWithStdin(root, message, args...)
}

// --- Stash -----------------------------------------------------------------

// StashPush saves the working tree. includeUntracked also stashes new files,
// which git leaves behind by default and users routinely expect to be included.
func (r *Runner) StashPush(repoPath, message string, includeUntracked bool) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	args := []string{"stash", "push"}
	if includeUntracked {
		args = append(args, "--include-untracked")
	}
	if message != "" {
		args = append(args, "--message", message)
	}
	_, err = r.runLocal(root, args...)
	return err
}

// StashApply restores a stash. drop=true makes it a pop.
func (r *Runner) StashApply(repoPath, ref string, drop bool) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if err := checkRefArg("stash", ref); err != nil {
		return err
	}
	action := "apply"
	if drop {
		action = "pop"
	}
	_, err = r.runLocal(root, "stash", action, ref)
	return err
}

// StashDrop deletes a stash entry without restoring it.
func (r *Runner) StashDrop(repoPath, ref string) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if err := checkRefArg("stash", ref); err != nil {
		return err
	}
	_, err = r.runLocal(root, "stash", "drop", ref)
	return err
}

// --- Repository discovery --------------------------------------------------

// OpenRepository validates a folder and returns its Repository descriptor,
// with Name defaulting to the directory name. It is what the "Open" action in
// the sidebar calls before persisting anything.
func (r *Runner) OpenRepository(path string) (*Repository, error) {
	root, err := r.resolveRepo(path)
	if err != nil {
		return nil, err
	}
	return &Repository{Name: filepath.Base(root), Path: root}, nil
}

// IsRepository reports whether a path is inside a git working tree, without
// the error noise — for enabling or disabling UI affordances.
func (r *Runner) IsRepository(path string) bool {
	_, err := r.resolveRepo(path)
	return err == nil
}

// LastCommitDate is a cheap freshness signal for sorting the sidebar without
// loading each repository's full history.
func (r *Runner) LastCommitDate(repoPath string) (time.Time, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return time.Time{}, err
	}
	out, err := r.runLocal(root, "log", "-1", "--format=%aI")
	if err != nil {
		if isEmptyRepoErr(err) {
			return time.Time{}, nil
		}
		return time.Time{}, err
	}
	return time.Parse(time.RFC3339, strings.TrimSpace(out))
}

// StashDiff returns the patch a stash entry would apply, so it can be
// reviewed BEFORE popping it.
//
// This is the whole point of the stash panel: `git stash pop` is not
// reversible in any obvious way once it conflicts, and the entry it came
// from is gone. Seeing what is inside first turns "I think this is the one"
// into a decision.
//
// includeUntracked adds the untracked files the stash captured, which
// `git stash show` omits by default — a stash pushed with -u looks empty
// without it, which reads as "the stash lost my files".
func (r *Runner) StashDiff(repoPath, ref string, includeUntracked bool) (string, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(ref) == "" {
		return "", fmt.Errorf("falta la referencia del stash")
	}
	if err := checkRefArg("stash", ref); err != nil {
		return "", err
	}

	args := []string{"stash", "show", "--patch", "--no-color"}
	if includeUntracked {
		args = append(args, "--include-untracked")
	}
	args = append(args, ref)

	out, err := r.runLocal(root, args...)
	if err != nil {
		return "", err
	}

	// A stash holding ONLY untracked files produces an EMPTY patch and exits
	// zero — it does not fail, which is what an earlier version of this
	// assumed. Verified against real git, not deduced: the retry has to
	// trigger on empty output, or a `git stash push -u` of new files shows
	// up as "this stash is empty" and looks like the stash lost them.
	if strings.TrimSpace(out) == "" && !includeUntracked {
		return r.StashDiff(repoPath, ref, true)
	}
	return out, nil
}
