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

// classifyLookaheadRunes bounds how far ensureStarted looks ahead to find
// the real first keyword (DECLARE/BEGIN/CREATE) for classifyStatementStart.
// Needs to be generous: a real script can have a long header/boilerplate
// comment block before a statement (an auto-generated init.sql's file
// banner ran ~400 runes in one real case that tripped the previous 200-rune
// cap — classification silently fell through to "not PL/SQL", and the
// declare section's first semicolon then split the block in half). Cheap
// per statement either way (ensureStarted runs once per statement, guarded
// by `started`), so err on the generous side rather than re-tuning this
// every time a longer comment header shows up in practice.
const classifyLookaheadRunes = 8192

// SplitStatements splits sqlText into individual statements on top-level
// `;`, respecting single/double-quoted strings, line (--) and block (/* */)
// comments, Postgres dollar-quoting ($$...$$ / $tag$...$tag$), and Oracle
// PL/SQL BEGIN/END nesting (including DECLARE sections and CREATE
// PROCEDURE/FUNCTION/TRIGGER/TYPE bodies) — a `;` inside any of those never
// splits the statement. A T-SQL `GO` alone on its own line is also honored as
// a batch boundary (see isLoneGoLine). See detect.go's doc comment for the
// accepted scope/limitations of the PL/SQL handling. Empty statements (blank
// lines, a stray trailing `;`) are dropped.
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
		lookahead := i + classifyLookaheadRunes
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

		// A "/" alone on its own line is SQL*Plus's client-side "run the
		// buffered block" terminator (the classic `END;\n/\n` convention
		// pasted from tnsnames/sqlplus scripts) — never valid Oracle syntax
		// on its own. Left in, it would (a) survive as a stray character in
		// whatever statement follows, which Oracle chokes on, and (b) as
		// the very next non-space character, break classifyStatementStart's
		// DECLARE/BEGIN/CREATE prefix check for that next statement. Only
		// treated as noise between statements (!started, nothing real
		// accumulated yet) so a genuine division operator elsewhere is
		// never touched.
		if !started && c == '/' && (i+1 >= n || runes[i+1] != '*') && isLoneSlashLine(runes, i) {
			stmtStart = i + 1
			i++
			continue
		}

		ensureStarted(i)

		// "GO" alone on its own line (optionally with a repeat count, "GO 5")
		// is T-SQL's batch separator — sqlcmd/SSMS split on it and never send
		// it to the server. Treated as a statement/batch boundary here, the
		// same idea as the SQL*Plus lone "/" above, and flushing regardless of
		// blockDepth because GO always ends the current batch in T-SQL. Safe
		// for the non-T-SQL engines: a line that is only "GO" isn't valid SQL
		// in any of them either, so this never mis-splits a real statement.
		if matchKeywordAt(runes, i, "GO") && isLoneGoLine(runes, i) {
			flush(i)
			j := i
			for j < n && runes[j] != '\n' {
				j++
			}
			if j < n {
				j++ // consume the newline too
			}
			i = j
			stmtStart = i
			continue
		}

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
		// CASE opens its own nesting level on the SAME counter as BEGIN.
		// Real bug found live: a CASE *expression* (CASE WHEN ... THEN ...
		// ELSE ... END, used as a value — e.g. an argument in a function
		// call) closes with a BARE "END", no trailing "CASE" — indistinguishable
		// from a real BEGIN...END block closer by the old END-handling below
		// alone. Without tracking CASE's own open here, that bare END wrongly
		// decremented the ENCLOSING block's depth one level early, so the
		// next semicolon after it got treated as a top-level statement
		// terminator — shattering the rest of a real procedure body into
		// dozens of invalid fragments (confirmed: SGCPRO.PR_REFACT_NIR, whose
		// v_ctx := T_REFACT_CTX(..., FECHA_TAR => CASE WHEN ... END, ...)
		// call sits inside its BEGIN block). A CASE *statement* (ending in
		// "END CASE;") already worked before this fix (see the END-handling
		// below); this only had to stop miscounting the expression form.
		if matchKeywordAt(runes, i, "CASE") {
			blockDepth++
			i += len("CASE")
			continue
		}
		if matchKeywordAt(runes, i, "END") {
			next, nextEnd := peekNextWordSpan(runes, i+len("END"))
			switch next {
			case "IF", "LOOP":
				// END IF / END LOOP never incremented this counter (see
				// above), so there's nothing to undo here either.
				i += len("END")
			case "CASE":
				// END CASE — closes the CASE pushed above. Consume the
				// trailing "CASE" word too, or the next loop iteration would
				// match it as a brand new CASE keyword and push again.
				if blockDepth > 0 {
					blockDepth--
				}
				i = nextEnd
			default:
				// Bare END: closes whatever's actually open — a real BEGIN
				// block, or a CASE *expression* (no trailing CASE word).
				// Either way the counter it incremented is the same one, so
				// popping it here is correct regardless of which it was.
				if blockDepth > 0 {
					blockDepth--
				}
				i += len("END")
			}
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

// peekNextWordSpan returns the next whitespace-delimited word starting at or
// after i (skipping leading whitespace), uppercased, plus the index right
// after it — so a caller that needs to consume the word (not just peek at
// it, see the END-CASE handling above) can jump straight there instead of
// re-deriving its length. Returns ("", i) with end pointing at the first
// non-space position if there's no word (i.e. nothing left to consume).
func peekNextWordSpan(runes []rune, i int) (word string, end int) {
	n := len(runes)
	for i < n && unicode.IsSpace(runes[i]) {
		i++
	}
	start := i
	for i < n && isWordChar(runes[i]) {
		i++
	}
	if i == start {
		return "", start
	}
	return strings.ToUpper(string(runes[start:i])), i
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

// isLoneSlashLine reports whether runes[i] (a '/') is alone on its line —
// only whitespace between it and the previous/next newline (or start/end of
// text) on either side. That shape is unambiguous: real Oracle/Postgres
// syntax never starts a statement with a bare division operator, so this
// only ever matches the SQL*Plus terminator convention.
func isLoneSlashLine(runes []rune, i int) bool {
	for j := i - 1; j >= 0; j-- {
		if runes[j] == '\n' {
			break
		}
		if !unicode.IsSpace(runes[j]) {
			return false
		}
	}
	for j := i + 1; j < len(runes); j++ {
		if runes[j] == '\n' {
			break
		}
		if !unicode.IsSpace(runes[j]) {
			return false
		}
	}
	return true
}

// isLoneGoLine reports whether the "GO" keyword at runes[i] stands alone on
// its line — only whitespace before it back to the line start, and only
// whitespace (plus an optional integer repeat count, "GO 5") after it to the
// line end. matchKeywordAt already guarantees the word boundary, so "GOTO" or
// a "GO" glued to another token never reaches here.
func isLoneGoLine(runes []rune, i int) bool {
	for j := i - 1; j >= 0; j-- {
		if runes[j] == '\n' {
			break
		}
		if !unicode.IsSpace(runes[j]) {
			return false
		}
	}
	n := len(runes)
	j := i + len("GO")
	for j < n && runes[j] != '\n' && unicode.IsSpace(runes[j]) {
		j++
	}
	for j < n && unicode.IsDigit(runes[j]) { // optional repeat count
		j++
	}
	for j < n && runes[j] != '\n' {
		if !unicode.IsSpace(runes[j]) {
			return false
		}
		j++
	}
	return true
}

// skipLeadingNoise strips whitespace, "--" line comments, "/* */" block
// comments, and lone SQL*Plus "/" terminator lines from the front of s,
// repeatedly, until none remain — used only to find the real first keyword
// for classifyStatementStart. It never touches the actual statement text
// sent to the database (comments/whitespace stay exactly as written there;
// the tokenizing loop above is what excludes a lone "/" from that text).
func skipLeadingNoise(s string) string {
	for {
		before := s
		s = strings.TrimLeft(s, " \t\r\n")

		switch {
		case strings.HasPrefix(s, "--"):
			if idx := strings.IndexByte(s, '\n'); idx >= 0 {
				s = s[idx+1:]
			} else {
				s = ""
			}
		case strings.HasPrefix(s, "/*"):
			if idx := strings.Index(s, "*/"); idx >= 0 {
				s = s[idx+2:]
			} else {
				s = ""
			}
		case strings.HasPrefix(s, "/"):
			rest := s[1:]
			lineTail := rest
			eol := strings.IndexByte(rest, '\n')
			if eol >= 0 {
				lineTail = rest[:eol]
			}
			if strings.TrimSpace(lineTail) != "" {
				// Not alone on its line (e.g. a real division operator) —
				// stop, this isn't noise we can safely skip.
				return s
			}
			if eol >= 0 {
				s = rest[eol+1:]
			} else {
				s = ""
			}
		}

		if s == before {
			return s
		}
	}
}
