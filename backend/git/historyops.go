package git

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// History-rewriting and history-replaying operations — the destructive end of
// the module. Everything here either creates commits that undo other commits
// (Revert), copies commits between branches (CherryPick), or moves a branch
// pointer and possibly the working tree (Reset).
//
// None of these prompt on their own; each is reached from a context menu that
// must have confirmed with the user first (ConfirmDialog, never
// window.confirm). The doc comments below spell out exactly what is
// recoverable and what is not, because that is what the confirmation text has
// to tell the user.

// Revert creates a new commit that undoes the changes of another one. It is
// the safe inverse: history is added to, never rewritten, so a revert is
// itself revertible and nothing is lost.
//
// noCommit stages the inverse changes without committing, letting the user
// amend them first — git's `--no-commit`.
//
// A revert of a merge commit fails without -m telling git which parent to
// treat as mainline. Rather than silently picking one, that failure is passed
// through: choosing the wrong mainline produces a technically-successful commit
// that undoes the wrong side, which is far worse than an error message.
func (r *Runner) Revert(repoPath, commit string, noCommit bool) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if err := checkRefArg("commit", commit); err != nil {
		return err
	}
	args := []string{"revert", "--no-edit"}
	if noCommit {
		args = append(args, "--no-commit")
	}
	args = append(args, commit)
	_, err = r.runLocal(root, args...)
	return err
}

// CherryPick applies the changes of a commit onto the current branch as a new
// commit. Like Revert it only adds history.
//
// A conflict leaves the repository mid-cherry-pick; the error surfaces that
// state and the user resolves it in the working tree. CherryPickAbort backs
// out of it.
func (r *Runner) CherryPick(repoPath, commit string, noCommit bool) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if err := checkRefArg("commit", commit); err != nil {
		return err
	}
	args := []string{"cherry-pick"}
	if noCommit {
		args = append(args, "--no-commit")
	}
	args = append(args, commit)
	_, err = r.runLocal(root, args...)
	return err
}

// CherryPickAbort restores the state from before a cherry-pick that hit a
// conflict.
func (r *Runner) CherryPickAbort(repoPath string) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	_, err = r.runLocal(root, "cherry-pick", "--abort")
	return err
}

// RevertAbort is the equivalent for a conflicted revert.
func (r *Runner) RevertAbort(repoPath string) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	_, err = r.runLocal(root, "revert", "--abort")
	return err
}

// Reset moves the current branch to point at commit. mode selects how much
// else moves with it, and the three differ enormously in what they destroy:
//
//   - "soft"  — moves the branch only. The index and working tree are
//     untouched, so every change from the skipped commits stays staged.
//     Nothing is lost.
//   - "mixed" — moves the branch and resets the index, leaving changes in the
//     working tree as unstaged edits. Nothing is lost. This is git's default.
//   - "hard"  — moves the branch, index AND working tree. Every uncommitted
//     change is destroyed with no reflog entry to recover it, and commits left
//     behind are only reachable through the reflog until it expires.
//
// "hard" is accepted but never defaulted to: the caller has to name it
// explicitly, and the UI confirms it separately from the other two.
func (r *Runner) Reset(repoPath, commit, mode string) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if err := checkRefArg("commit", commit); err != nil {
		return err
	}
	var flag string
	switch mode {
	case "soft":
		flag = "--soft"
	case "mixed", "":
		flag = "--mixed"
	case "hard":
		flag = "--hard"
	default:
		return fmt.Errorf("modo de reset desconocido: %q (soft, mixed o hard)", mode)
	}
	_, err = r.runLocal(root, "reset", flag, commit)
	return err
}

// Merge joins ref into the current branch. noFF forces a merge commit even
// when a fast-forward was possible, which is what people mean by "keep the
// branch visible in the history".
func (r *Runner) Merge(repoPath, ref string, noFF bool) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if err := checkRefArg("referencia", ref); err != nil {
		return err
	}
	args := []string{"merge", "--no-edit"}
	if noFF {
		args = append(args, "--no-ff")
	}
	args = append(args, ref)
	_, err = r.runLocal(root, args...)
	return err
}

// MergeAbort backs out of a merge that hit conflicts.
func (r *Runner) MergeAbort(repoPath string) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	_, err = r.runLocal(root, "merge", "--abort")
	return err
}

// InProgress reports whether the repository is stuck mid-merge, mid-rebase,
// mid-cherry-pick or mid-revert.
//
// This drives the UI's ability to offer "abort" at all. Without it, a user who
// hits a conflict sees operations fail with git's rather opaque "you have
// unmerged paths" and has no in-app way out — which is exactly the moment
// someone abandons a GUI client for the terminal.
func (r *Runner) InProgress(repoPath string) (string, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return "", err
	}
	// git exposes these as marker files/directories inside the git dir rather
	// than through any porcelain command. They are checked on the filesystem
	// rather than with `rev-parse --verify` because two of them (rebase-merge,
	// rebase-apply) are directories, not refs — rev-parse would never resolve
	// them and an in-progress rebase would be reported as "clean".
	//
	// --git-path resolves each name against the real git dir, which is what
	// makes this work inside a worktree or a submodule, where .git is a file
	// pointing elsewhere.
	for _, probe := range []struct{ name, state string }{
		{"MERGE_HEAD", "merge"},
		{"CHERRY_PICK_HEAD", "cherry-pick"},
		{"REVERT_HEAD", "revert"},
		{"rebase-merge", "rebase"},
		{"rebase-apply", "rebase"},
	} {
		out, err := r.runLocal(root, "rev-parse", "--git-path", probe.name)
		if err != nil {
			continue
		}
		p := strings.TrimSpace(out)
		if !filepath.IsAbs(p) {
			p = filepath.Join(root, p)
		}
		if _, err := os.Stat(p); err == nil {
			return probe.state, nil
		}
	}
	return "", nil
}
