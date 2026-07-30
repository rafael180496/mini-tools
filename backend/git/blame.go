package git

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// BlameLine is who last touched one line of a file.
//
// Line is the 1-based line number in the blamed revision, which is what the
// caller maps its diff rows onto. Everything else is the commit that
// introduced the line as it currently reads.
type BlameLine struct {
	Line      int    `json:"line"`
	Hash      string `json:"hash"`
	ShortHash string `json:"shortHash"`
	Author    string `json:"author"`
	Email     string `json:"email"`
	// Date is RFC 3339, author date — same convention as CommitInfo.Date.
	Date    string `json:"date"`
	Summary string `json:"summary"`
	// Uncommitted marks git's all-zero hash, which is what blame reports for
	// a line that only exists in the working tree. Surfaced as a flag rather
	// than as a hash of zeros so the UI can say "sin commitear" instead of
	// showing 0000000 as if it were a commit.
	Uncommitted bool `json:"uncommitted"`
}

// Blame reports, line by line, which commit last changed a file at rev.
//
// Uses --line-porcelain rather than the default output: the default is a
// human-readable format whose columns shift with the longest author name,
// and parsing it means guessing at widths. The porcelain form is
// key/value per line and is what git documents as the machine-readable one.
// It repeats the commit header for every line, which is more bytes but
// removes the "remember the last header you saw" state that the non-line
// porcelain form would need.
//
// rev may be empty (blame the working tree), a commit, or a branch.
func (r *Runner) Blame(repoPath, path, rev string) ([]BlameLine, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("la ruta del archivo está vacía")
	}

	args := []string{"blame", "--line-porcelain"}
	if rev != "" {
		if err := checkRefArg("revisión", rev); err != nil {
			return nil, err
		}
		args = append(args, rev)
	}
	// "--" is what stops a path that happens to look like a revision from
	// being resolved as one.
	args = append(args, "--", path)

	out, err := r.runLocal(root, args...)
	if err != nil {
		return nil, err
	}
	return parseBlamePorcelain(out), nil
}

// parseBlamePorcelain reads the --line-porcelain stream.
//
// The format is: a header line "<hash> <origLine> <finalLine> [<count>]",
// then key/value lines, then the content line prefixed with a tab. Anything
// unrecognised is skipped rather than treated as an error — blame output
// gains keys between git versions, and a new one must not break the parse.
func parseBlamePorcelain(out string) []BlameLine {
	var lines []BlameLine
	var current BlameLine
	var authorTime, authorTZ string
	inEntry := false

	flush := func() {
		if !inEntry {
			return
		}
		current.Date = formatBlameDate(authorTime, authorTZ)
		lines = append(lines, current)
		current = BlameLine{}
		authorTime, authorTZ = "", ""
		inEntry = false
	}

	for _, raw := range strings.Split(out, "\n") {
		if raw == "" {
			continue
		}

		// The content line: everything before it belonged to this entry.
		if strings.HasPrefix(raw, "\t") {
			flush()
			continue
		}

		key, value, _ := strings.Cut(raw, " ")

		// A 40-char hex first field starts a new entry.
		if len(key) == 40 && isHex(key) {
			flush()
			inEntry = true
			current.Hash = key
			current.ShortHash = key[:7]
			// git reports an all-zero hash for a line that exists only in
			// the working tree.
			current.Uncommitted = strings.Trim(key, "0") == ""
			// The final-line number is the third field of the header.
			fields := strings.Fields(value)
			if len(fields) >= 2 {
				current.Line, _ = strconv.Atoi(fields[1])
			}
			continue
		}

		switch key {
		case "author":
			current.Author = value
		case "author-mail":
			current.Email = strings.Trim(value, "<>")
		case "author-time":
			authorTime = value
		case "author-tz":
			authorTZ = value
		case "summary":
			current.Summary = value
		}
	}
	flush()

	return lines
}

// formatBlameDate turns blame's unix timestamp plus its "+0200"-style
// offset into RFC 3339, matching CommitInfo.Date so the UI formats both
// through one path.
//
// The offset is applied as a fixed zone rather than converted to local
// time: blame reports the author's own timezone, and rewriting it to the
// reader's would quietly change what the timestamp says happened.
func formatBlameDate(unix, tz string) string {
	if unix == "" {
		return ""
	}
	secs, err := strconv.ParseInt(unix, 10, 64)
	if err != nil {
		return ""
	}

	t := time.Unix(secs, 0).UTC()
	if len(tz) == 5 && (tz[0] == '+' || tz[0] == '-') {
		hours, errH := strconv.Atoi(tz[1:3])
		mins, errM := strconv.Atoi(tz[3:5])
		if errH == nil && errM == nil {
			offset := hours*3600 + mins*60
			if tz[0] == '-' {
				offset = -offset
			}
			return t.In(time.FixedZone(tz, offset)).Format(time.RFC3339)
		}
	}
	return t.Format(time.RFC3339)
}

func isHex(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') && (c < 'A' || c > 'F') {
			return false
		}
	}
	return true
}
