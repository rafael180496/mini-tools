package git

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Conflict resolution.
//
// When a merge or rebase stops on a conflict, the standard flow breaks: the
// file on disk holds git's raw markers, and the only way forward is a text
// editor and remembering which side "ours" means in a rebase (it is not the
// side people expect). This gives the UI what it needs to present the three
// versions and write back a resolution.

// ConflictedFiles lists the paths git is currently reporting as unmerged.
//
// Uses --diff-filter=U rather than parsing status codes: "U" in a porcelain
// status can appear on either side and in several combinations (UU, AA, DU,
// UD…), and enumerating them correctly is exactly the kind of thing that
// looks right until the day a delete/modify conflict shows up.
func (r *Runner) ConflictedFiles(repoPath string) ([]string, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return nil, err
	}

	out, err := r.runLocal(root, "diff", "--name-only", "--diff-filter=U", "-z")
	if err != nil {
		return nil, err
	}

	var files []string
	for _, p := range strings.Split(out, "\x00") {
		if p != "" {
			files = append(files, p)
		}
	}
	return files, nil
}

// ReadConflictFile returns the working-tree contents of a conflicted file,
// markers and all — that raw text is what the resolver parses into blocks.
//
// Read through the filesystem rather than through git: the conflicted file
// is precisely the one that is NOT in any git object yet, and its current
// state (including whatever the user already edited by hand) is the thing
// that matters.
func (r *Runner) ReadConflictFile(repoPath, path string) (string, error) {
	full, err := r.safeWorkingPath(repoPath, path)
	if err != nil {
		return "", err
	}

	data, err := os.ReadFile(full)
	if err != nil {
		return "", fmt.Errorf("leyendo %q: %w", path, err)
	}
	return string(data), nil
}

// ResolveConflictFile writes the resolved contents and stages the file,
// which is what tells git the conflict is settled.
//
// Writing and staging are one operation on purpose: a file written but not
// staged still counts as unmerged, so `git merge --continue` refuses and the
// user is left staring at a file that looks fixed. Doing both means "marked
// as resolved" is true the moment the button says so.
func (r *Runner) ResolveConflictFile(repoPath, path, content string) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	full, err := r.safeWorkingPath(repoPath, path)
	if err != nil {
		return err
	}

	// Preserve the file's existing mode — rewriting an executable script as
	// 0644 is a change nobody asked for and nobody notices until it fails to
	// run in CI.
	mode := os.FileMode(0o644)
	if info, err := os.Stat(full); err == nil {
		mode = info.Mode().Perm()
	}

	if err := os.WriteFile(full, []byte(content), mode); err != nil {
		return fmt.Errorf("escribiendo %q: %w", path, err)
	}

	_, err = r.runLocal(root, "add", "--", path)
	return err
}

// ContinueOperation resumes a merge, rebase or cherry-pick after the
// conflicts are resolved.
//
// op is the value GitInProgress reports, so the caller never has to guess
// which continue to run — passing the wrong one is an error message about a
// state the user is not in, which is worse than no button at all.
//
// `-c core.editor=true` is what keeps this from hanging: every --continue
// wants to open an editor for the commit message, and this process has no
// terminal for one. It is set as a config override rather than with
// --no-edit because **--continue takes no arguments** — `git merge
// --continue --no-edit` is a usage error, verified against real git rather
// than assumed (it was the first thing this function got wrong).
func (r *Runner) ContinueOperation(repoPath, op string) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}

	var sub string
	switch op {
	case "merge", "rebase", "cherry-pick", "revert":
		sub = op
	default:
		return fmt.Errorf("no hay ninguna operación en curso que continuar")
	}

	_, err = r.runLocal(root, "-c", "core.editor=true", sub, "--continue")
	return err
}

// safeWorkingPath resolves a repo-relative path to an absolute one, refusing
// anything that escapes the working tree.
//
// This is the only place in the Git module that WRITES to an arbitrary path
// the frontend named, so it is the only place a traversal could matter. The
// check is on the resolved path, not on the input string: rejecting ".."
// textually misses a symlink pointing out of the tree, and accepts a path
// that merely contains ".." harmlessly.
func (r *Runner) safeWorkingPath(repoPath, path string) (string, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(path) == "" {
		return "", fmt.Errorf("la ruta del archivo está vacía")
	}
	if filepath.IsAbs(path) {
		return "", fmt.Errorf("la ruta debe ser relativa al repositorio")
	}

	full := filepath.Join(root, path)
	rel, err := filepath.Rel(root, full)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("la ruta %q queda fuera del repositorio", path)
	}
	return full, nil
}
