// Package sqlformat reformats SQL text, the editor's "Formatear SQL"
// (DataGrip's Reformat Code).
//
// Hand-rolled on the sqlintel tokenizer, for the same reason as the rest of
// the SQL handling in this repo (.claude/rules/technical.md point 7): no
// parser library covers Oracle, Postgres, SQLite and SQL Server at once.
//
// **It can only change whitespace and the case of keywords.** The output is
// the same token stream as the input: literals, quoted identifiers and
// comments are single tokens and come out byte for byte; two tokens that
// touched in the source still touch ("a.b", "x::int", "<>", ":1"); and the
// only thing the formatter decides is where a line break and its indentation
// go, plus upper-casing words from a fixed keyword list — which is safe on
// every engine, since unquoted identifiers are case-insensitive. That is the
// whole guarantee, and it is why a formatted statement runs exactly like the
// original.
//
// **What it does not touch.** PL/SQL blocks, CREATE PROCEDURE/FUNCTION/…,
// SQL*Plus commands and DDL pass through verbatim: the statement is located
// with backend/query's splitter (the one the executor uses) and only plain
// SELECT/WITH/INSERT/UPDATE/DELETE/MERGE statements are rewritten. A block's
// layout is the author's, and a formatter that re-indents PL/SQL badly is
// worse than one that leaves it alone.
package sqlformat

import (
	"strings"

	"mini-tools/backend/query"
	"mini-tools/backend/sqlintel"
)

// Format reformats every plain SQL statement of src and leaves everything
// else — the text between statements, PL/SQL, DDL — exactly as it was.
func Format(src string) string {
	var b strings.Builder
	pos := 0
	for _, stmt := range query.SplitStatements(src) {
		at := strings.Index(src[pos:], stmt.Text)
		if at < 0 {
			// The splitter returns trimmed substrings of src, so this should
			// not happen; if it ever does, leaving the rest untouched is the
			// only safe answer.
			break
		}
		at += pos
		b.WriteString(src[pos:at])
		if stmt.Kind == query.KindSQL && formattable(stmt.Text) {
			b.WriteString(formatStatement(stmt.Text))
		} else {
			b.WriteString(stmt.Text)
		}
		pos = at + len(stmt.Text)
	}
	b.WriteString(src[pos:])
	return b.String()
}

// formattable reports whether the statement opens with a DML/query keyword.
func formattable(text string) bool {
	for _, t := range sqlintel.Code(sqlintel.Tokenize([]rune(text))) {
		switch t.Upper() {
		case "SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "MERGE":
			return t.Kind == sqlintel.TokenWord
		}
		return false
	}
	return false
}

// keywords are upper-cased. Only words whose meaning never depends on case —
// which, unquoted, is every word.
var keywords = map[string]bool{}

func init() {
	for _, k := range strings.Fields(`SELECT FROM WHERE AND OR NOT IN IS NULL AS ON JOIN LEFT RIGHT INNER
		OUTER FULL CROSS NATURAL GROUP BY ORDER HAVING UNION ALL DISTINCT INSERT INTO VALUES UPDATE SET
		DELETE MERGE USING WHEN THEN ELSE END CASE MATCHED EXISTS BETWEEN LIKE ASC DESC LIMIT OFFSET
		FETCH FIRST NEXT ROWS ROW ONLY WITH RETURNING NULLS LAST OVER PARTITION MINUS INTERSECT EXCEPT
		ANY SOME ESCAPE CONNECT START PRIOR LATERAL APPLY TOP RECURSIVE FOR NOWAIT WAIT SKIP LOCKED
		DEFAULT TRUE FALSE`) {
		keywords[k] = true
	}
}

// frame is one parenthesis level. A query frame (a subquery, a CTE body)
// lays its clauses out on their own lines; any other parenthesis (a
// function call, an IN list) is inline and inherits nothing but the flow.
type frame struct {
	isQuery bool
	// base is the indentation of this query's clause keywords.
	base int
	// openIndent is the indentation of the line the "(" was on, where the
	// matching ")" goes back to.
	openIndent int
	clause     string
	// between: a BETWEEN is waiting for its AND, which must not break.
	between bool
	// cases counts open CASE expressions, inside which nothing breaks.
	cases int
}

type formatter struct {
	tokens []sqlintel.Token
	out    strings.Builder
	stack  []*frame
	// lineIndent is the indentation of the line being written.
	lineIndent int
	// pendingBreak is the indentation of a line break owed before the next
	// token, -1 when none. Deferring the break is what makes asking for one
	// twice harmless.
	pendingBreak int
	isMerge      bool
	wrote        bool
	prev         *sqlintel.Token
}

func formatStatement(text string) string {
	f := &formatter{
		tokens:       sqlintel.Tokenize([]rune(text)),
		stack:        []*frame{{isQuery: true}},
		pendingBreak: -1,
	}
	for i := range f.tokens {
		f.token(i)
	}
	return strings.TrimRight(f.out.String(), " ")
}

func (f *formatter) top() *frame { return f.stack[len(f.stack)-1] }

func (f *formatter) breakAt(indent int) {
	if !f.wrote {
		return
	}
	f.pendingBreak = indent
}

// nextCode returns the next non-comment token after i, if any.
func (f *formatter) nextCode(i int) (sqlintel.Token, bool) {
	for j := i + 1; j < len(f.tokens); j++ {
		if f.tokens[j].Kind != sqlintel.TokenComment {
			return f.tokens[j], true
		}
	}
	return sqlintel.Token{}, false
}

func isPunct(t sqlintel.Token, s string) bool { return t.Kind == sqlintel.TokenPunct && t.Text == s }

func (f *formatter) token(i int) {
	t := f.tokens[i]
	fr := f.top()
	upper := ""
	if t.Kind == sqlintel.TokenWord {
		upper = t.Upper()
	}
	if !f.wrote && upper == "MERGE" {
		f.isMerge = true
	}

	// Layout decisions that come BEFORE the token.
	if fr.isQuery && fr.cases == 0 && upper != "" && !f.qualified() {
		f.clauseBreak(i, upper, fr)
	}
	if isPunct(t, ")") && len(f.stack) > 1 {
		closed := f.top()
		f.stack = f.stack[:len(f.stack)-1]
		if closed.isQuery {
			f.breakAt(closed.openIndent)
		}
		fr = f.top()
	}

	f.write(t, upper)

	// Layout decisions that come AFTER the token.
	switch {
	case t.Kind == sqlintel.TokenComment && strings.HasPrefix(t.Text, "--"):
		f.pendingBreak = f.lineIndent
	case isPunct(t, "("):
		next, ok := f.nextCode(i)
		if ok && (next.Is("SELECT") || next.Is("WITH")) {
			nf := &frame{isQuery: true, base: f.lineIndent + 4, openIndent: f.lineIndent}
			f.stack = append(f.stack, nf)
			f.breakAt(nf.base)
		} else {
			// Inline: inherits the clause so a CASE count or a BETWEEN stays
			// local to the parenthesis.
			f.stack = append(f.stack, &frame{base: fr.base, openIndent: f.lineIndent, clause: fr.clause})
		}
	case isPunct(t, ",") && fr.isQuery && fr.cases == 0:
		switch fr.clause {
		case "SELECT":
			f.breakAt(fr.base + 7)
		case "SET":
			f.breakAt(fr.base + 4)
		case "FROM":
			f.breakAt(fr.base + 5)
		case "WITH":
			f.breakAt(fr.base)
		}
	}

	if upper == "CASE" {
		fr.cases++
	} else if upper == "END" && fr.cases > 0 {
		fr.cases--
	} else if upper == "BETWEEN" {
		fr.between = true
	}
}

// qualified reports whether the word being looked at is the right side of a
// dot ("t.date"): a column, whatever it is called.
func (f *formatter) qualified() bool {
	return f.prev != nil && isPunct(*f.prev, ".")
}

// clauseBreak puts a clause keyword on its own line and records the clause.
func (f *formatter) clauseBreak(i int, upper string, fr *frame) {
	next, _ := f.nextCode(i)
	prevUpper := ""
	if f.prev != nil && f.prev.Kind == sqlintel.TokenWord {
		prevUpper = f.prev.Upper()
	}
	switch upper {
	case "SELECT":
		fr.clause = "SELECT"
		f.breakAt(fr.base)
	case "FROM":
		fr.clause = "FROM"
		if prevUpper != "DELETE" {
			f.breakAt(fr.base)
		}
	case "WHERE", "HAVING":
		fr.clause = upper
		f.breakAt(fr.base)
	case "SET":
		// "UPDATE t SET", and MERGE's "WHEN MATCHED THEN UPDATE SET".
		fr.clause = "SET"
		f.breakAt(fr.base)
	case "VALUES", "RETURNING", "LIMIT", "OFFSET", "FETCH":
		fr.clause = upper
		f.breakAt(fr.base)
	case "UNION", "INTERSECT", "MINUS", "EXCEPT":
		fr.clause = upper
		f.breakAt(fr.base)
	case "GROUP", "ORDER":
		if next.Is("BY") {
			fr.clause = upper
			f.breakAt(fr.base)
		}
	case "CONNECT":
		if next.Is("BY") {
			fr.clause = "CONNECT"
			f.breakAt(fr.base)
		}
	case "START":
		if next.Is("WITH") {
			fr.clause = "CONNECT"
			f.breakAt(fr.base)
		}
	case "WITH":
		if prevUpper != "START" {
			fr.clause = "WITH"
		}
	case "USING":
		if f.isMerge {
			fr.clause = "USING"
			f.breakAt(fr.base)
		}
	case "WHEN":
		if f.isMerge && fr == f.stack[0] {
			fr.clause = "WHEN"
			f.breakAt(fr.base)
		}
	case "LEFT", "RIGHT", "FULL", "INNER", "CROSS", "NATURAL":
		if next.Is("JOIN") || next.Is("OUTER") || next.Is("APPLY") {
			fr.clause = "JOIN"
			f.breakAt(fr.base)
		}
	case "OUTER":
		if next.Is("APPLY") && !isJoinModifier(prevUpper) {
			fr.clause = "JOIN"
			f.breakAt(fr.base)
		}
	case "JOIN":
		fr.clause = "JOIN"
		if !isJoinModifier(prevUpper) && prevUpper != "OUTER" {
			f.breakAt(fr.base)
		}
	case "AND", "OR":
		if fr.between && upper == "AND" {
			fr.between = false
			return
		}
		switch fr.clause {
		case "WHERE", "HAVING", "JOIN", "CONNECT":
			f.breakAt(fr.base + 2)
		}
	}
}

func isJoinModifier(u string) bool {
	switch u {
	case "LEFT", "RIGHT", "FULL", "INNER", "CROSS", "NATURAL":
		return true
	}
	return false
}

// write emits a token with the separator it is owed.
func (f *formatter) write(t sqlintel.Token, upper string) {
	if f.pendingBreak >= 0 && f.wrote {
		trimTrailingSpaces(&f.out)
		f.out.WriteByte('\n')
		f.out.WriteString(strings.Repeat(" ", f.pendingBreak))
		f.lineIndent = f.pendingBreak
	} else if f.wrote && f.needsSpace(t) {
		f.out.WriteByte(' ')
	}
	f.pendingBreak = -1

	text := t.Text
	if upper != "" && keywords[upper] && !f.qualified() {
		text = upper
	}
	f.out.WriteString(text)
	f.wrote = true
	tt := t
	f.prev = &tt
}

// needsSpace decides the separator between the previous token and t when no
// line break sits between them.
func (f *formatter) needsSpace(t sqlintel.Token) bool {
	p := f.prev
	if p == nil {
		return false
	}
	if t.Kind == sqlintel.TokenPunct && (t.Text == "," || t.Text == ")" || t.Text == ";") {
		return false
	}
	if isPunct(*p, "(") {
		return false
	}
	if isPunct(*p, ",") {
		return true
	}
	// Everything else keeps what the source had: tokens that touched keep
	// touching (a.b, fn(, x::int, <>, -1), tokens that were apart get one
	// space.
	return p.End != t.Start
}

func trimTrailingSpaces(b *strings.Builder) {
	s := b.String()
	trimmed := strings.TrimRight(s, " ")
	if len(trimmed) == len(s) {
		return
	}
	b.Reset()
	b.WriteString(trimmed)
}
