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
func (r *Runner) CheckoutBranch(repoPath, name string) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if err := checkRefArg("rama", name); err != nil {
		return err
	}
	_, err = r.runLocal(root, "checkout", name)
	return err
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
