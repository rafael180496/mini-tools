package git

import (
	"fmt"
	"strings"
)

// Worktrees: checking out several branches at once, in separate
// directories, instead of stashing and switching back and forth.

// Worktree is one checkout of the repository.
type Worktree struct {
	Path   string `json:"path"`
	Branch string `json:"branch"`
	Head   string `json:"head"`
	// IsMain marks the original clone. It cannot be removed, and saying so
	// up front beats letting git refuse after the click.
	IsMain bool `json:"isMain"`
	// Detached/Locked/Prunable are states that change what can be done with
	// it: a prunable worktree points at a directory that no longer exists.
	Detached bool   `json:"detached"`
	Locked   bool   `json:"locked"`
	Prunable bool   `json:"prunable"`
	Reason   string `json:"reason,omitempty"`
}

// ListWorktrees enumerates the repository's checkouts.
//
// --porcelain rather than the default output for the usual reason: the
// human format aligns columns by content width, and parsing it means
// guessing. The porcelain form is one key-per-line with a blank line
// between entries.
func (r *Runner) ListWorktrees(repoPath string) ([]Worktree, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return nil, err
	}

	out, err := r.runLocal(root, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, err
	}

	var list []Worktree
	var current Worktree
	started := false

	flush := func() {
		if started {
			// The first entry git reports is always the main working tree.
			current.IsMain = len(list) == 0
			list = append(list, current)
			current = Worktree{}
			started = false
		}
	}

	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			flush()
			continue
		}
		key, value, _ := strings.Cut(line, " ")
		switch key {
		case "worktree":
			flush()
			started = true
			current.Path = value
		case "HEAD":
			current.Head = value
		case "branch":
			// git reports the full ref; the short name is what the UI shows.
			current.Branch = strings.TrimPrefix(value, "refs/heads/")
		case "detached":
			current.Detached = true
		case "locked":
			current.Locked = true
			current.Reason = value
		case "prunable":
			current.Prunable = true
			current.Reason = value
		}
	}
	flush()

	return list, nil
}

// AddWorktree creates a checkout of branch at path.
//
// createBranch makes a NEW branch starting at the current HEAD instead of
// checking out an existing one — the two are different commands (-b vs
// plain), and picking the wrong one either fails or silently checks out
// something else.
func (r *Runner) AddWorktree(repoPath, path, branch string, createBranch bool) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if strings.TrimSpace(path) == "" {
		return fmt.Errorf("falta la carpeta donde crear el worktree")
	}
	if strings.TrimSpace(branch) == "" {
		return fmt.Errorf("falta la rama del worktree")
	}
	if err := checkRefArg("rama", branch); err != nil {
		return err
	}
	if strings.HasPrefix(path, "-") {
		return fmt.Errorf("la ruta no puede empezar con «-»")
	}

	args := []string{"worktree", "add"}
	if createBranch {
		args = append(args, "-b", branch, path)
	} else {
		args = append(args, path, branch)
	}

	_, err = r.runLocal(root, args...)
	return err
}

// RemoveWorktree deletes a checkout.
//
// force is needed when the worktree has uncommitted changes; without it git
// refuses, which is the right default — removing a directory with
// unsaved work in it should take a deliberate second step.
func (r *Runner) RemoveWorktree(repoPath, path string, force bool) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if strings.TrimSpace(path) == "" || strings.HasPrefix(path, "-") {
		return fmt.Errorf("ruta de worktree inválida")
	}

	args := []string{"worktree", "remove"}
	if force {
		args = append(args, "--force")
	}
	args = append(args, path)

	_, err = r.runLocal(root, args...)
	return err
}

// PruneWorktrees drops the administrative entries of worktrees whose
// directory is gone — the "prunable" ones ListWorktrees reports.
func (r *Runner) PruneWorktrees(repoPath string) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	_, err = r.runLocal(root, "worktree", "prune")
	return err
}
