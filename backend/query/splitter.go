package query

import (
	"strings"
	"unicode"
)

// Statement is one piece of a (possibly multi-statement) script, along with
// its classification.
type Statement struct {
	Text string
	Kind Kind
}

// SplitStatements splits sqlText into individual statements on top-level
// `;`, respecting single/double-quoted strings, line (--) and block (/* */)
// comments, Postgres dollar-quoting ($$...$$ / $tag$...$tag$), and Oracle
// PL/SQL BEGIN/END nesting (including DECLARE sections and CREATE
// PROCEDURE/FUNCTION/TRIGGER/TYPE bodies) — a `;` inside any of those never
// splits the statement. See detect.go's doc comment for the accepted
// scope/limitations of the PL/SQL handling. Empty statements (blank lines,
// a stray trailing `;`) are dropped.
func SplitStatements(sqlText string) []Statement {
	runes := []rune(sqlText)
	n := len(runes)

	var out []Statement
	stmtStart := 0
	blockDepth := 0
	awaitingBegin := false
	inPLSQL := false
	started := false // whether we've classified the statement starting at stmtStart yet

	var inSingle, inDouble, inLineComment, inBlockComment bool
	var dollarTag string // non-empty (includes both $ signs) while inside a dollar-quoted span

	flush := func(end int) {
		text := strings.TrimSpace(string(runes[stmtStart:end]))
		if text != "" {
			kind := KindSQL
			if inPLSQL {
				kind = KindPLSQLBlock
			}
			out = append(out, Statement{Text: text, Kind: kind})
		}
		blockDepth = 0
		awaitingBegin = false
		inPLSQL = false
		started = false
	}

	ensureStarted := func(i int) {
		if started {
			return
		}
		started = true
		lookahead := i + 200
		if lookahead > n {
			lookahead = n
		}
		awaitingBegin, inPLSQL = classifyStatementStart(string(runes[i:lookahead]))
	}

	i := 0
	for i < n {
		c := runes[i]

		if inLineComment {
			if c == '\n' {
				inLineComment = false
			}
			i++
			continue
		}
		if inBlockComment {
			if c == '*' && i+1 < n && runes[i+1] == '/' {
				inBlockComment = false
				i += 2
				continue
			}
			i++
			continue
		}
		if inSingle {
			if c == '\'' {
				if i+1 < n && runes[i+1] == '\'' {
					i += 2
					continue
				}
				inSingle = false
			}
			i++
			continue
		}
		if inDouble {
			if c == '"' {
				inDouble = false
			}
			i++
			continue
		}
		if dollarTag != "" {
			if strings.HasPrefix(string(runes[i:]), dollarTag) {
				i += len(dollarTag)
				dollarTag = ""
				continue
			}
			i++
			continue
		}

		// Not inside any quoted/comment/dollar span — skip leading
		// whitespace without triggering classification early.
		if unicode.IsSpace(c) {
			i++
			continue
		}

		ensureStarted(i)

		if c == '-' && i+1 < n && runes[i+1] == '-' {
			inLineComment = true
			i += 2
			continue
		}
		if c == '/' && i+1 < n && runes[i+1] == '*' {
			inBlockComment = true
			i += 2
			continue
		}
		if c == '\'' {
			inSingle = true
			i++
			continue
		}
		if c == '"' {
			inDouble = true
			i++
			continue
		}
		if c == '$' {
			if tag, ok := matchDollarTag(runes, i); ok {
				dollarTag = tag
				awaitingBegin = false // dollar-quoted bodies are self-delimiting; see detect.go
				i += len(tag)
				continue
			}
		}

		if matchKeywordAt(runes, i, "BEGIN") {
			awaitingBegin = false
			blockDepth++
			i += len("BEGIN")
			continue
		}
		if matchKeywordAt(runes, i, "END") {
			next := peekNextWord(runes, i+len("END"))
			if next != "IF" && next != "LOOP" && next != "CASE" {
				if blockDepth > 0 {
					blockDepth--
				}
			}
			i += len("END")
			continue
		}

		if c == ';' && !awaitingBegin && blockDepth == 0 {
			flush(i)
			i++
			stmtStart = i
			continue
		}

		i++
	}

	flush(n)
	return out
}

func isWordChar(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_'
}

// matchKeywordAt reports whether kw (already uppercase) matches runes at i,
// case-insensitively, on a word boundary on both sides.
func matchKeywordAt(runes []rune, i int, kw string) bool {
	n := len(runes)
	kwLen := len(kw)
	if i+kwLen > n {
		return false
	}
	if i > 0 && isWordChar(runes[i-1]) {
		return false
	}
	if i+kwLen < n && isWordChar(runes[i+kwLen]) {
		return false
	}
	for j := 0; j < kwLen; j++ {
		if unicode.ToUpper(runes[i+j]) != rune(kw[j]) {
			return false
		}
	}
	return true
}

// peekNextWord returns the next whitespace-delimited word starting at or
// after i (skipping leading whitespace), uppercased, or "" if none.
func peekNextWord(runes []rune, i int) string {
	n := len(runes)
	for i < n && unicode.IsSpace(runes[i]) {
		i++
	}
	start := i
	for i < n && isWordChar(runes[i]) {
		i++
	}
	if i == start {
		return ""
	}
	return strings.ToUpper(string(runes[start:i]))
}

// matchDollarTag matches a Postgres dollar-quote delimiter ($$ or
// $tag$) starting at i, returning the full delimiter text (including both
// $ signs).
func matchDollarTag(runes []rune, i int) (string, bool) {
	n := len(runes)
	if i >= n || runes[i] != '$' {
		return "", false
	}
	j := i + 1
	for j < n && isWordChar(runes[j]) {
		j++
	}
	if j >= n || runes[j] != '$' {
		return "", false
	}
	return string(runes[i : j+1]), true
}
