package git

import (
	"fmt"
	"strconv"
	"strings"
)

// GetStatus reads the working tree. `status --porcelain=v1 -z` is used rather
// than the human-readable form because -z keeps paths intact: a filename
// containing a newline or a quote would be mangled by line splitting or by
// git's own path quoting, and those files exist in the wild.
func (r *Runner) GetStatus(repoPath string) (*RepoStatus, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return nil, err
	}

	out, err := r.runLocalRaw(root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--branch")
	if err != nil {
		return nil, err
	}

	st := &RepoStatus{Files: []FileStatus{}}
	entries := splitNUL(string(out))

	for i := 0; i < len(entries); i++ {
		e := entries[i]
		if e == "" {
			continue
		}
		// The --branch header rides in the same stream, prefixed "## ".
		if strings.HasPrefix(e, "## ") {
			parseBranchHeader(strings.TrimPrefix(e, "## "), st)
			continue
		}
		if len(e) < 3 {
			continue
		}

		f := FileStatus{
			IndexStatus: string(e[0]),
			WorkStatus:  string(e[1]),
			Path:        e[3:],
		}
		f.Untracked = f.IndexStatus == "?"
		f.Staged = !f.Untracked && f.IndexStatus != " "

		// A rename or copy emits two NUL-separated paths: the new path in this
		// entry and the original in the next one. Consuming it here is what
		// keeps the entry stream aligned — skipping this would shift every
		// subsequent file by one.
		if f.IndexStatus == "R" || f.IndexStatus == "C" {
			if i+1 < len(entries) {
				f.OrigPath = entries[i+1]
				i++
			}
		}
		st.Files = append(st.Files, f)
	}

	st.HasChanges = len(st.Files) > 0
	return st, nil
}

// parseBranchHeader reads the "## main...origin/main [ahead 1, behind 2]"
// line that --branch prepends.
func parseBranchHeader(h string, st *RepoStatus) {
	// A detached HEAD reports "## HEAD (no branch)".
	if strings.HasPrefix(h, "HEAD (no branch)") {
		st.Detached = true
		return
	}

	track := ""
	if i := strings.Index(h, " ["); i >= 0 {
		track = h[i+1:]
		h = h[:i]
	}
	if i := strings.Index(h, "..."); i >= 0 {
		st.Branch, st.Upstream = h[:i], h[i+3:]
	} else {
		st.Branch = h
	}
	st.Ahead, st.Behind = parseTrack(track)
}

// DiffTarget selects what to diff. The three modes are distinct git
// invocations, not variations of one, so they are modelled explicitly rather
// than inferred from which fields happen to be set.
type DiffTarget struct {
	// Mode is "worktree" (unstaged changes), "staged" (index vs HEAD), or
	// "commit" (a commit against its first parent).
	Mode string `json:"mode"`

	// Commit is required when Mode is "commit".
	Commit string `json:"commit"`

	// Path limits the diff to one file. Empty diffs everything, which the
	// commit-detail view uses to populate its file list.
	Path string `json:"path"`

	// ContextLines overrides the default 3 lines of context. Zero uses git's
	// default.
	ContextLines int `json:"contextLines"`

	// IgnoreWhitespace drops whitespace-only changes (-w). Useful on a commit
	// that reindented a file, where the real change is three lines buried in
	// four hundred.
	IgnoreWhitespace bool `json:"ignoreWhitespace"`
}

// GetDiff returns the unified diff for a target. The patch is handed back as
// raw text: CodeMirror's merge view consumes unified diffs directly, so
// parsing hunks in Go would only add a lossy intermediate representation.
func (r *Runner) GetDiff(repoPath string, target DiffTarget) (*FileDiff, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return nil, err
	}

	args := []string{"diff"}
	switch target.Mode {
	case "worktree", "":
		// default: index vs working tree
	case "staged":
		args = append(args, "--cached")
	case "commit":
		if err := checkRefArg("commit", target.Commit); err != nil {
			return nil, err
		}
		// show, not diff: it handles a root commit (no parent) correctly,
		// where `diff <hash>^ <hash>` fails outright.
		args = []string{"show", "--format=", target.Commit}
	default:
		return nil, fmt.Errorf("modo de diff desconocido: %q", target.Mode)
	}

	if target.ContextLines > 0 {
		args = append(args, "--unified="+strconv.Itoa(target.ContextLines))
	}
	if target.IgnoreWhitespace {
		args = append(args, "-w")
	}
	// --no-color: a colored patch carries ANSI escapes CodeMirror would render
	// as garbage. --no-ext-diff: a user's configured external difftool must
	// not be launched from inside a GUI app.
	args = append(args, "--no-color", "--no-ext-diff")

	if target.Path != "" {
		args = append(args, "--", target.Path)
	}

	out, err := r.runLocal(root, args...)
	if err != nil {
		return nil, err
	}

	d := &FileDiff{Path: target.Path, Patch: out}
	// git announces an unrenderable file rather than emitting a patch body.
	if strings.Contains(out, "Binary files ") || strings.Contains(out, "GIT binary patch") {
		d.IsBinary = true
		d.Patch = ""
	}

	if stat, serr := r.diffStat(root, target); serr == nil {
		d.Stat = stat
	}
	return d, nil
}

// diffStat runs the same selection with --numstat. It is a second invocation
// rather than being folded into the patch call because mixing --numstat with a
// patch produces output that has to be split apart again — two cheap processes
// beat one fragile parser.
func (r *Runner) diffStat(root string, target DiffTarget) (DiffStat, error) {
	args := []string{"diff", "--numstat"}
	switch target.Mode {
	case "staged":
		args = append(args, "--cached")
	case "commit":
		args = []string{"show", "--numstat", "--format=", target.Commit}
	}
	if target.Path != "" {
		args = append(args, "--", target.Path)
	}
	out, err := r.runLocal(root, args...)
	if err != nil {
		return DiffStat{}, err
	}
	return parseNumstat(out), nil
}

// GetChangedFiles lists the files a commit touched, with per-file churn. This
// is what fills the middle panel when a commit is selected; the diff itself is
// only fetched once the user picks a file.
func (r *Runner) GetChangedFiles(repoPath, commit string) ([]FileDiff, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return nil, err
	}
	if err := checkRefArg("commit", commit); err != nil {
		return nil, err
	}

	out, err := r.runLocalRaw(root, "show", "--numstat", "--format=", "-z", commit)
	if err != nil {
		return nil, err
	}

	files := []FileDiff{}
	// With -z, numstat emits "adds\tdels\t\0oldpath\0newpath\0" for renames
	// and "adds\tdels\tpath\0" otherwise — the rename case puts the paths in
	// their own NUL-separated fields instead of quoting them.
	entries := splitNUL(string(out))
	for i := 0; i < len(entries); i++ {
		parts := strings.Split(entries[i], "\t")
		if len(parts) < 3 {
			continue
		}
		f := FileDiff{Path: parts[2]}
		f.IsBinary = parts[0] == "-" && parts[1] == "-"
		if n, err := strconv.Atoi(parts[0]); err == nil {
			f.Stat.Insertions = n
		}
		if n, err := strconv.Atoi(parts[1]); err == nil {
			f.Stat.Deletions = n
		}
		f.Stat.FilesChanged = 1

		if f.Path == "" && i+2 < len(entries) {
			f.OrigPath, f.Path = entries[i+1], entries[i+2]
			i += 2
		}
		files = append(files, f)
	}
	return files, nil
}

// GetFileAtCommit returns a file's full contents as of a commit, for the
// side-by-side view where CodeMirror needs both complete documents rather than
// a patch.
func (r *Runner) GetFileAtCommit(repoPath, commit, path string) (string, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return "", err
	}
	if err := checkRefArg("commit", commit); err != nil {
		return "", err
	}
	if path == "" {
		return "", fmt.Errorf("la ruta del archivo no puede estar vacía")
	}
	// commit:path is git's object syntax; the path is relative to the repo
	// root, never to the process working directory.
	return r.runLocal(root, "show", commit+":"+path)
}
