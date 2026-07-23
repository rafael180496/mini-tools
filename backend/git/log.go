package git

import (
	"strconv"
	"strings"
)

// Field and record separators for the log format. \x1f (unit separator) and
// \x1e (record separator) are used instead of a printable delimiter because a
// commit message can legally contain any printable sequence — including
// whatever delimiter looked "safe enough" — but effectively never contains
// these control characters.
const (
	fieldSep  = "\x1f"
	recordSep = "\x1e"
)

// logFormat lays out one commit as NUL-safe fields.
//
// The record separator leads the format rather than trailing it, which looks
// backwards but is the only layout that works with --numstat: git emits the
// numstat block *after* the formatted header, so a trailing separator would
// push each commit's stats into the next record. Leading it means splitting on
// recordSep yields "header fields + this commit's numstat" per chunk, at the
// cost of one empty leading chunk.
//
// The trailing field separator after %b is what keeps that numstat block in a
// field of its own instead of glued to the commit body.
const logFormat = recordSep +
	"%H" + fieldSep +
	"%h" + fieldSep +
	"%an" + fieldSep +
	"%ae" + fieldSep +
	"%aI" + fieldSep +
	"%P" + fieldSep +
	"%D" + fieldSep +
	"%s" + fieldSep +
	"%b" + fieldSep

// LogOptions bounds a history walk. MaxCount is required in practice — a
// repository with a hundred thousand commits will happily serialize all of
// them, and the graph view only ever renders a window.
type LogOptions struct {
	// MaxCount caps the number of commits returned. Zero applies
	// defaultLogLimit rather than meaning "unlimited", because an accidental
	// zero should degrade to a slow-but-survivable page, not an OOM.
	MaxCount int `json:"maxCount"`

	// Skip offsets the walk, for paging further back in history.
	Skip int `json:"skip"`

	// Rev limits the walk to a branch, tag, or commit. Empty walks HEAD.
	Rev string `json:"rev"`

	// Revs walks an explicit set of refs instead of All/Rev. This is what
	// "hide branch" is built on: hiding a ref means walking every ref EXCEPT
	// that one, which --all cannot express. Ignored when empty.
	Revs []string `json:"revs"`

	// All walks every ref instead of a single branch — this is what makes the
	// graph show side branches rather than a straight line.
	All bool `json:"all"`

	// Path limits history to commits touching one file or directory.
	Path string `json:"path"`

	// WithStats requests per-commit churn. Off by default because --numstat
	// roughly doubles the cost of the walk and the graph does not need it
	// until a commit is selected.
	WithStats bool `json:"withStats"`
}

const defaultLogLimit = 500

// GetCommitLog walks the history and returns commits newest-first.
func (r *Runner) GetCommitLog(repoPath string, opts LogOptions) ([]CommitInfo, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return nil, err
	}

	limit := opts.MaxCount
	if limit <= 0 {
		limit = defaultLogLimit
	}

	args := []string{
		"log",
		"--pretty=format:" + logFormat,
		"--max-count=" + strconv.Itoa(limit),
	}
	if opts.Skip > 0 {
		args = append(args, "--skip="+strconv.Itoa(opts.Skip))
	}
	if opts.WithStats {
		// No -z here on purpose: with -z, a rename splits its old and new
		// path into separate NUL-delimited fields, and parseNumstat — which
		// treats NUL as a record break — would count that one rename as extra
		// changed files. Only the counts are read here, so git's default
		// quoting of exotic paths is harmless.
		args = append(args, "--numstat")
	}
	if len(opts.Revs) > 0 {
		// Takes precedence over All: an explicit set is always a narrowing of
		// "everything", so honouring --all here would silently undo the
		// user's hidden branches.
		for _, rev := range opts.Revs {
			if err := checkRefArg("revisión", rev); err != nil {
				return nil, err
			}
			args = append(args, rev)
		}
	} else if opts.All {
		args = append(args, "--all")
	} else if opts.Rev != "" {
		if err := checkRefArg("revisión", opts.Rev); err != nil {
			return nil, err
		}
		args = append(args, opts.Rev)
	}
	if opts.Path != "" {
		// "--" is what stops a path that happens to match a branch name from
		// being resolved as a revision.
		args = append(args, "--", opts.Path)
	}

	out, err := r.runLocal(root, args...)
	if err != nil {
		// A repository with no commits yet is a normal state for a fresh
		// `git init`, not an error the UI should shout about.
		if isEmptyRepoErr(err) {
			return []CommitInfo{}, nil
		}
		return nil, err
	}

	return parseLog(out, opts.WithStats), nil
}

func parseLog(out string, withStats bool) []CommitInfo {
	records := strings.Split(out, recordSep)
	commits := make([]CommitInfo, 0, len(records))

	for _, rec := range records {
		// Consecutive records are separated by the record mark plus whatever
		// newline git emitted; trimming keeps the hash field clean.
		rec = strings.Trim(rec, "\n\x00")
		if rec == "" {
			continue
		}
		fields := strings.Split(rec, fieldSep)
		if len(fields) < 9 {
			continue
		}

		c := CommitInfo{
			Hash:      fields[0],
			ShortHash: fields[1],
			Author:    fields[2],
			Email:     fields[3],
			Date:      fields[4],
			Subject:   fields[7],
			Body:      strings.TrimRight(fields[8], "\n"),
		}
		c.Parents = strings.Fields(fields[5])
		if c.Parents == nil {
			c.Parents = []string{}
		}
		c.Branches, c.Tags, c.IsHead = parseDecoration(fields[6])

		if withStats && len(fields) > 9 {
			c.Stats = parseNumstat(fields[9])
		}
		commits = append(commits, c)
	}
	return commits
}

// parseDecoration splits %D — git's own ref decoration — into branches and
// tags. Relying on git to resolve this is why the graph does not need a second
// pass over refs to know which commit carries "origin/main".
//
// Entries look like: "HEAD -> main, origin/main, tag: v1.0".
func parseDecoration(d string) (branches []string, tags []string, isHead bool) {
	// Empty (not nil) slices: these are marshalled straight to the frontend,
	// and a nil slice becomes JSON null, which turns every `commit.branches.map`
	// in the graph into a TypeError.
	branches, tags = []string{}, []string{}
	d = strings.TrimSpace(d)
	if d == "" {
		return branches, tags, false
	}
	for _, raw := range strings.Split(d, ",") {
		ref := strings.TrimSpace(raw)
		switch {
		case ref == "":
		case ref == "HEAD":
			isHead = true
		case strings.HasPrefix(ref, "HEAD -> "):
			isHead = true
			branches = append(branches, strings.TrimPrefix(ref, "HEAD -> "))
		case strings.HasPrefix(ref, "tag: "):
			tags = append(tags, strings.TrimPrefix(ref, "tag: "))
		default:
			branches = append(branches, ref)
		}
	}
	return branches, tags, isHead
}

// parseNumstat sums a --numstat block into a DiffStat. Binary files are
// reported by git as "-\t-\tpath" and contribute a changed file but no lines,
// which is the honest representation — counting them as zero-line changes
// would understate nothing, but counting them as text would be a lie.
func parseNumstat(block string) DiffStat {
	var st DiffStat
	for _, line := range strings.FieldsFunc(block, func(r rune) bool { return r == '\n' || r == '\x00' }) {
		parts := strings.Split(strings.TrimSpace(line), "\t")
		if len(parts) < 2 {
			continue
		}
		st.FilesChanged++
		if n, err := strconv.Atoi(parts[0]); err == nil {
			st.Insertions += n
		}
		if n, err := strconv.Atoi(parts[1]); err == nil {
			st.Deletions += n
		}
	}
	return st
}

// GetCommitStats returns the churn of a single commit. Separate from the log
// walk so the graph can stay cheap and only pay for stats on selection.
func (r *Runner) GetCommitStats(repoPath, hash string) (DiffStat, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return DiffStat{}, err
	}
	if err := checkRefArg("commit", hash); err != nil {
		return DiffStat{}, err
	}
	out, err := r.runLocal(root, "show", "--numstat", "--format=", hash)
	if err != nil {
		return DiffStat{}, err
	}
	return parseNumstat(out), nil
}

// isEmptyRepoErr recognises the "no commits yet" family of failures, which git
// reports differently depending on version and command.
func isEmptyRepoErr(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "does not have any commits yet") ||
		strings.Contains(msg, "bad default revision") ||
		strings.Contains(msg, "unknown revision") ||
		strings.Contains(msg, "ambiguous argument 'head'")
}
