package git

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Submodules: other repositories nested inside this one, pinned by the
// parent at one exact commit.
//
// The pin is the whole point and the whole confusion: the parent does not
// track a branch of the child, it tracks a commit. That is why every state
// this file reports is phrased against the pinned commit rather than
// against a branch, and why "modified" is a first-class field — a submodule
// checked out somewhere other than where the parent points is the single
// most common way a build stops reproducing.

// Submodule is one nested repository as the parent sees it.
type Submodule struct {
	// Path is relative to the parent's working tree root — the key for
	// every submodule command.
	Path string `json:"path"`
	// URL and Branch come from .gitmodules, which is the committed,
	// shared configuration; what a particular clone has in .git/config may
	// differ, and that difference is not something to hide behind one
	// value.
	URL    string `json:"url"`
	Branch string `json:"branch"`
	// Hash is the commit the parent pins.
	Hash string `json:"hash"`
	// Described is git's own annotation for that commit (a tag or a
	// branch-relative description). Empty for a submodule never
	// initialised, because there is no local clone to describe it with.
	Described string `json:"described"`
	// Initialized is false for a submodule registered in .gitmodules whose
	// working directory is still empty — the state a fresh clone leaves
	// every submodule in until someone runs update --init.
	Initialized bool `json:"initialized"`
	// Modified means the child is checked out at a commit other than the
	// pinned one. Not an error, but it is what makes a build irreproducible
	// and it is invisible in the parent's own file list.
	Modified bool `json:"modified"`
	// Conflicted is a merge conflict on the pin itself.
	Conflicted bool `json:"conflicted"`
}

// ListSubmodules reports the repository's submodules, or nil when it has
// none.
//
// The absence of .gitmodules is checked with a stat rather than by running
// git and reading the failure: .gitmodules missing is the normal state of
// almost every repository, and a probe that exits non-zero in the normal
// case fills the "Comandos ejecutados" panel with red entries for something
// that is not a problem — the same reasoning CheckoutBranch spells out.
//
// It also skips the two git invocations this function would otherwise make
// per refresh (`submodule status` and the .gitmodules config read).
// resolveRepo above still runs one, so this is "two fewer", not "none" —
// the repository root has to be resolved before anything can be stat'd
// relative to it.
func (r *Runner) ListSubmodules(repoPath string) ([]Submodule, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(filepath.Join(root, ".gitmodules")); err != nil {
		return nil, nil
	}

	out, err := r.runLocal(root, "submodule", "status")
	if err != nil {
		return nil, err
	}

	config := r.gitmodulesConfig(root)

	var list []Submodule
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		sub, ok := parseSubmoduleStatus(line)
		if !ok {
			continue
		}
		sub.URL = config[sub.Path+".url"]
		sub.Branch = config[sub.Path+".branch"]
		list = append(list, sub)
	}
	return list, nil
}

// parseSubmoduleStatus reads one line of `git submodule status`:
//
//	 <sha> <path> (<described>)
//	-<sha> <path>                 never initialised
//	+<sha> <path> (<described>)   checked out elsewhere than the pin
//	U<sha> <path>                 merge conflict on the pin
//
// The path is unquoted and may contain spaces, so it is taken as
// everything between the sha and the trailing "(…)" rather than by
// splitting on whitespace.
func parseSubmoduleStatus(line string) (Submodule, bool) {
	if len(line) < 2 {
		return Submodule{}, false
	}

	var sub Submodule
	switch line[0] {
	case '-':
		// Not initialised: git still prints the pinned sha.
		sub.Initialized = false
	case '+':
		sub.Initialized = true
		sub.Modified = true
	case 'U':
		sub.Initialized = true
		sub.Conflicted = true
	case ' ':
		sub.Initialized = true
	default:
		return Submodule{}, false
	}

	rest := line[1:]
	sp := strings.IndexByte(rest, ' ')
	if sp <= 0 {
		return Submodule{}, false
	}
	sub.Hash = rest[:sp]
	rest = rest[sp+1:]

	// The description is the LAST parenthesised group; a path may legally
	// contain parentheses, a description is always at the end.
	if strings.HasSuffix(rest, ")") {
		if open := strings.LastIndex(rest, " ("); open >= 0 {
			sub.Described = rest[open+2 : len(rest)-1]
			rest = rest[:open]
		}
	}
	sub.Path = strings.TrimSpace(rest)
	if sub.Path == "" {
		return Submodule{}, false
	}
	return sub, true
}

// gitmodulesConfig reads .gitmodules into a map keyed "<path>.<key>".
//
// Keyed by PATH and not by the section name because they are not the same
// thing: the section is a free-form name ([submodule "libs/foo"]) that
// nothing forces to match submodule.<name>.path, and every command takes
// the path. Reading it wrong would attach one submodule's URL to another.
//
// A failure here is deliberately not fatal — the list is still useful with
// the pin and the state, just without the URL.
func (r *Runner) gitmodulesConfig(root string) map[string]string {
	out, err := r.runLocal(root, "config", "--file", ".gitmodules", "--list")
	if err != nil {
		return nil
	}

	// First pass: section name → path. Second pass: everything else,
	// re-keyed by that path.
	paths := map[string]string{}
	type entry struct{ section, key, value string }
	var entries []entry

	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		eq := strings.IndexByte(line, '=')
		if eq < 0 {
			continue
		}
		full, value := line[:eq], line[eq+1:]
		if !strings.HasPrefix(full, "submodule.") {
			continue
		}
		inner := full[len("submodule."):]
		dot := strings.LastIndexByte(inner, '.')
		if dot <= 0 {
			continue
		}
		section, key := inner[:dot], inner[dot+1:]
		if key == "path" {
			paths[section] = value
		}
		entries = append(entries, entry{section, key, value})
	}

	config := make(map[string]string, len(entries))
	for _, e := range entries {
		path, ok := paths[e.section]
		if !ok {
			continue
		}
		config[path+"."+e.key] = e.value
	}
	return config
}

// AddSubmodule registers a new submodule and clones it.
//
// branch is optional; with one, git records `submodule.<name>.branch` in
// .gitmodules so `update --remote` knows what to follow. Without it the
// submodule simply stays pinned at whatever commit is cloned, which is the
// common case and the one people mean by "add a submodule".
func (r *Runner) AddSubmodule(repoPath, url, path, branch string, auth AuthConfig) (string, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(url) == "" {
		return "", fmt.Errorf("la URL del submódulo no puede estar vacía")
	}
	if strings.HasPrefix(strings.TrimSpace(url), "-") {
		return "", fmt.Errorf("URL inválida: %q no puede empezar con '-'", url)
	}
	// La ruta es opcional: sin ella git usa el último tramo de la URL, que es
	// lo que la gente quiere casi siempre y ahorra escribirla dos veces.
	path = strings.TrimSpace(path)
	if path != "" {
		if err := checkRefArg("ruta", path); err != nil {
			return "", err
		}
	}

	args := []string{"submodule", "add"}
	if branch != "" {
		if err := checkRefArg("rama", branch); err != nil {
			return "", err
		}
		args = append(args, "-b", branch)
	}
	// "--" so a URL or a path is never read as a flag, same guard every
	// other ref-taking command in this package uses.
	args = append(args, "--", url)
	if path != "" {
		args = append(args, path)
	}
	return r.runNetwork(root, auth, args...)
}

// UpdateSubmodules checks the submodules out at the commits the parent
// pins.
//
// init distinguishes the two menu entries this backs: without it only
// submodules that already have a local clone are touched ("update all
// initialized"), with it a submodule that has never been cloned is set up
// too — which is a clone over the network against a URL the user may not
// have credentials for, so it is a separate, explicit choice.
func (r *Runner) UpdateSubmodules(repoPath string, init, recursive bool, auth AuthConfig) (string, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return "", err
	}
	return r.runNetwork(root, auth, submoduleUpdateArgs(init, recursive, "")...)
}

// UpdateSubmodule is UpdateSubmodules narrowed to one path.
func (r *Runner) UpdateSubmodule(repoPath, path string, init, recursive bool, auth AuthConfig) (string, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return "", err
	}
	if err := checkRefArg("ruta", path); err != nil {
		return "", err
	}
	return r.runNetwork(root, auth, submoduleUpdateArgs(init, recursive, path)...)
}

func submoduleUpdateArgs(init, recursive bool, path string) []string {
	args := []string{"submodule", "update", "--progress"}
	if init {
		args = append(args, "--init")
	}
	if recursive {
		args = append(args, "--recursive")
	}
	if path != "" {
		args = append(args, "--", path)
	}
	return args
}

// SyncSubmodules copies the URLs from .gitmodules into each submodule's own
// .git/config.
//
// It is the fix for the one submodule failure that looks like nothing:
// someone changes a remote URL in .gitmodules and commits it, everyone
// pulls, and every clone keeps fetching the OLD url because .gitmodules is
// only read when a submodule is first set up. Purely local — it rewrites
// config, it does not talk to a remote.
func (r *Runner) SyncSubmodules(repoPath string, recursive bool) (string, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return "", err
	}
	args := []string{"submodule", "sync"}
	if recursive {
		args = append(args, "--recursive")
	}
	return r.runLocal(root, args...)
}

// RemoveSubmodule unregisters a submodule completely.
//
// Three steps, because git's own "remove a submodule" is three commands and
// stopping after any of them leaves the repository in a state where adding
// the same submodule back fails with a message about a git directory found
// locally:
//
//  1. deinit  — empties the working directory and drops .git/config's entry
//  2. git rm  — removes the path from the index and from .gitmodules
//  3. delete .git/modules/<path> — the cached clone git keeps behind
//
// Step 3 is the one git leaves to the user, and skipping it is exactly what
// makes a later re-add fail. The path is rebuilt from the repository root
// and verified to stay inside .git/modules before anything is deleted:
// this is the only place in the package that removes a directory, and a
// submodule path is user input.
func (r *Runner) RemoveSubmodule(repoPath, path string) error {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return err
	}
	if err := checkRefArg("ruta", path); err != nil {
		return err
	}

	if _, err := r.runLocal(root, "submodule", "deinit", "-f", "--", path); err != nil {
		return err
	}
	if _, err := r.runLocal(root, "rm", "-f", "--", path); err != nil {
		return err
	}

	cached, err := submoduleGitDir(root, path)
	if err != nil {
		// The two git steps already succeeded; refusing to report success
		// over a path that could not be validated is the right trade, but
		// the message has to say what WAS done.
		return fmt.Errorf("el submódulo se quitó del repositorio, pero no se pudo limpiar su clon en .git/modules: %w", err)
	}
	if err := os.RemoveAll(cached); err != nil {
		return fmt.Errorf("el submódulo se quitó del repositorio, pero quedó su clon en %s: %w", cached, err)
	}
	return nil
}

// submoduleGitDir resolves .git/modules/<path> and refuses anything that
// escapes it — a submodule path containing ".." must never turn a cleanup
// into a delete somewhere else on disk.
func submoduleGitDir(root, path string) (string, error) {
	base := filepath.Join(root, ".git", "modules")
	target := filepath.Clean(filepath.Join(base, path))
	rel, err := filepath.Rel(base, target)
	if err != nil {
		return "", err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", fmt.Errorf("ruta de submódulo inválida: %q", path)
	}
	return target, nil
}
