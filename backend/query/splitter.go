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

// classifyLookaheadRunes is how much text classifyStatementStart gets,
// measured from the first REAL character of the statement — the leading
// whitespace/comments are skipped first, over the rune slice and without
// allocating (skipNoiseRunes), so the size of a statement's comment header
// no longer matters. It used to be a raw cap counted from the start of the
// statement instead, and every long banner comment silently broke
// classification: with 200 runes an auto-generated init.sql's file header
// did it, then with 8192 a 9.5KB PL/SQL header comment in a real install
// script did it again (SGCPRO.PR_PASE_LECTURAS_MAIN — classified as plain
// SQL, so its declare section's first ';' shattered the procedure into
// twenty invalid fragments). Only the opening keywords are ever needed
// here, so this only has to clear "CREATE OR REPLACE PACKAGE BODY".
const classifyLookaheadRunes = 128

// SplitStatements splits sqlText into individual statements on top-level
// `;`, respecting single/double-quoted strings, line (--) and block (/* */)
// comments, Postgres dollar-quoting ($$...$$ / $tag$...$tag$), and Oracle
// PL/SQL BEGIN/END nesting (including DECLARE sections and CREATE
// PROCEDURE/FUNCTION/TRIGGER/TYPE bodies) — a `;` inside any of those never
// splits the statement. A T-SQL `GO` alone on its own line is also honored as
// a batch boundary (see isLoneGoLine). See detect.go's doc comment for the
// accepted scope/limitations of the PL/SQL handling. Empty statements (blank
// lines, a stray trailing `;`) are dropped.
// PL/SQL frames tracked by SplitStatements' stack, innermost last.
//
//   - frameDecl:  the declarative section of a unit (a CREATE PROCEDURE's
//     IS/AS section, a DECLARE section, or a nested subprogram's own IS/AS
//     section). Closes by turning into frameBlock at that unit's BEGIN.
//   - frameBlock: an executable BEGIN…END block. A CASE pushes one too,
//     because a CASE *expression* closes with a bare END exactly like a
//     block does.
//
// A ';' only ends the statement when the stack is empty, which is what
// makes every ';' inside a unit — declarations, statements, and the ones
// closing nested subprograms — harmless.
const (
	frameDecl = iota
	frameBlock
)

// SplitStatements splits sqlText into individual statements on top-level
// `;`, respecting single/double-quoted strings, line (--) and block (/* */)
// comments, Postgres dollar-quoting ($$...$$ / $tag$...$tag$), and Oracle
// PL/SQL block structure (DECLARE sections, CREATE
// PROCEDURE/FUNCTION/PACKAGE/TRIGGER/TYPE bodies, and the subprograms
// nested inside their declarative sections) — a `;` inside any of those
// never splits the statement. A lone `/` line (SQL*Plus's "run the
// buffered block" terminator) closes whatever statement is open, and a
// T-SQL `GO` alone on its own line is honored as a batch boundary (see
// isLoneGoLine). SQL*Plus client commands (SHOW ERRORS, SET SERVEROUTPUT,
// …) come out as their own KindSQLPlus statements — see sqlplusCommandEnd.
// See detect.go's doc comment for the accepted scope/limitations of the
// PL/SQL handling. Empty statements (blank lines, a stray trailing `;`) are
// dropped.
func SplitStatements(sqlText string) []Statement {
	runes := []rune(sqlText)
	n := len(runes)

	var out []Statement
	stmtStart := 0
	// Open PL/SQL frames, innermost last — see the frameDecl/frameBlock
	// constants above.
	var stack []int
	// headerPending: a PL/SQL unit header has been read (the statement's own
	// CREATE … PROCEDURE, or a PROCEDURE/FUNCTION declared inside a
	// declarative section) and we are waiting for the IS/AS that opens its
	// declarative section — or for the `;` that means it was only a forward
	// declaration and no body follows.
	headerPending := false
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
		stack = nil
		headerPending = false
		inPLSQL = false
		started = false
	}

	ensureStarted := func(i int) {
		if started {
			return
		}
		started = true
		code := skipNoiseRunes(runes, i)
		lookahead := code + classifyLookaheadRunes
		if lookahead > n {
			lookahead = n
		}
		headerPending, inPLSQL = classifyStatementStart(string(runes[code:lookahead]))
	}

	topIs := func(kind int) bool {
		return len(stack) > 0 && stack[len(stack)-1] == kind
	}
	pop := func() {
		if len(stack) > 0 {
			stack = stack[:len(stack)-1]
		}
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
		// buffered block" terminator (the classic `END;\n/\n` convention of
		// every generated install script) — never valid Oracle syntax on its
		// own. It is authoritative: whatever statement is still open ends
		// here, whatever the frame stack believes. That makes it the safety
		// net for the shapes this hand-rolled tokenizer can't model (a
		// `CREATE TYPE … AS OBJECT (…)` never reaches a BEGIN, for one), and
		// it can only ever END a statement early — never swallow the next
		// one — so it costs nothing on scripts that don't use it.
		//
		// Left in, the "/" would also (a) survive as a stray character in
		// whatever statement follows, which Oracle chokes on, and (b) as the
		// next non-space character, break classifyStatementStart's
		// DECLARE/BEGIN/CREATE prefix check for that next statement.
		if c == '/' && (i+1 >= n || runes[i+1] != '*') && isLoneSlashLine(runes, i) {
			if started {
				flush(i)
			}
			i++
			stmtStart = i
			continue
		}

		// SQL*Plus client commands are line-oriented and never reach the
		// server, so they end at the newline rather than at a ';' — without
		// this, a `SHOW ERRORS PROCEDURE x` line (which carries no ';' at
		// all) glued itself to the GRANT that followed it and took that
		// GRANT down with it under one ORA-00900.
		if !started {
			if end, ok := sqlplusCommandEnd(runes, i); ok {
				if text := strings.TrimSpace(string(runes[stmtStart:end])); text != "" {
					out = append(out, Statement{Text: text, Kind: KindSQLPlus})
				}
				i = end
				if i < n && runes[i] == '\n' {
					i++
				}
				stmtStart = i
				continue
			}
		}

		ensureStarted(i)

		// "GO" alone on its own line (optionally with a repeat count, "GO 5")
		// is T-SQL's batch separator — sqlcmd/SSMS split on it and never send
		// it to the server. Treated as a statement/batch boundary here, the
		// same idea as the SQL*Plus lone "/" above, and flushing regardless of
		// the frame stack because GO always ends the current batch in T-SQL.
		// Safe for the non-T-SQL engines: a line that is only "GO" isn't valid
		// SQL in any of them either, so this never mis-splits a real statement.
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
				headerPending = false // dollar-quoted bodies are self-delimiting; see detect.go
				i += len(tag)
				continue
			}
		}

		// La sección declarativa de un CREATE PROCEDURE/FUNCTION/PACKAGE BODY
		// puede declarar SUBPROGRAMAS anidados, y cada uno trae su propia
		// sección declarativa y su propio BEGIN…END:
		//
		//     CREATE PROCEDURE p AS
		//       v_x NUMBER;
		//       FUNCTION ya_procesado (...) RETURN BOOLEAN IS
		//           v_estado NUMBER;          <-- este ';' NO cierra nada
		//       BEGIN … END ya_procesado;
		//     BEGIN            <-- éste es el BEGIN del cuerpo
		//
		// Por eso el anidamiento se lleva con una pila de frames en vez de
		// con un contador de "subprogramas pendientes": el contador se
		// decrementaba con el PRIMER ';' de la sección declarativa del
		// subprograma (el de `v_estado NUMBER;`), así que su `END
		// ya_procesado;` se tomaba como fin del statement y el procedure se
		// partía en pedazos — el BEGIN principal viajaba solo a Oracle, que
		// respondía PLS-00201 por cada variable que ese fragmento ya no
		// tenía (casos reales: SGCPRO.PR_LECB0100, SGCPRO.PR_LECB0200,
		// SGCPRO.PR_FACT_INCONSISTENCIAS).
		if !headerPending && topIs(frameDecl) {
			nested := ""
			for _, kw := range [...]string{"PROCEDURE", "FUNCTION"} {
				if matchKeywordAt(runes, i, kw) {
					nested = kw
					break
				}
			}
			if nested != "" {
				headerPending = true
				i += len(nested)
				continue
			}
		}
		// Un COMPOUND TRIGGER abre su sección declarativa con esas dos
		// palabras en vez de con IS/AS, y adentro no declara subprogramas
		// sino puntos de disparo (`BEFORE STATEMENT IS … END BEFORE
		// STATEMENT;`), que sí se comportan como subprogramas anidados: cada
		// uno trae su propio IS/BEGIN/END.
		if headerPending && matchKeywordAt(runes, i, "COMPOUND") {
			if next, end := peekNextWordSpan(runes, i+len("COMPOUND")); next == "TRIGGER" {
				stack = append(stack, frameDecl)
				headerPending = false
				i = end
				continue
			}
		}
		if !headerPending && topIs(frameDecl) {
			if end, ok := timingPointEnd(runes, i); ok {
				headerPending = true
				i = end
				continue
			}
		}
		// IS/AS abre la sección declarativa del header que veníamos leyendo.
		// Sólo con headerPending: un `CURSOR c IS SELECT …` o un `TYPE t IS
		// RECORD (…)` dentro de la misma sección no abre nada.
		if headerPending && (matchKeywordAt(runes, i, "IS") || matchKeywordAt(runes, i, "AS")) &&
			!isComparisonIS(runes, i+2) {
			stack = append(stack, frameDecl)
			headerPending = false
			i += 2 // IS / AS
			continue
		}

		if matchKeywordAt(runes, i, "DECLARE") {
			stack = append(stack, frameDecl)
			headerPending = false
			i += len("DECLARE")
			continue
		}
		if matchKeywordAt(runes, i, "BEGIN") {
			// El BEGIN del cuerpo convierte la sección declarativa de ESA
			// unidad en su bloque ejecutable; un BEGIN dentro de un cuerpo
			// abre un bloque anónimo anidado.
			if topIs(frameDecl) {
				stack[len(stack)-1] = frameBlock
			} else {
				stack = append(stack, frameBlock)
			}
			headerPending = false
			i += len("BEGIN")
			continue
		}
		// CASE opens its own frame, the same kind BEGIN does. Real bug found
		// live: a CASE *expression* (CASE WHEN ... THEN ... ELSE ... END,
		// used as a value — e.g. an argument in a function call) closes with
		// a BARE "END", no trailing "CASE" — indistinguishable from a real
		// BEGIN...END block closer by the END-handling below alone. Without
		// tracking CASE's own open here, that bare END wrongly popped the
		// ENCLOSING block one level early, so the next semicolon after it got
		// treated as a top-level statement terminator — shattering the rest
		// of a real procedure body into dozens of invalid fragments
		// (confirmed: SGCPRO.PR_REFACT_NIR, whose v_ctx := T_REFACT_CTX(...,
		// FECHA_TAR => CASE WHEN ... END, ...) call sits inside its BEGIN
		// block).
		if matchKeywordAt(runes, i, "CASE") {
			stack = append(stack, frameBlock)
			i += len("CASE")
			continue
		}
		if matchKeywordAt(runes, i, "END") {
			next, nextEnd := peekNextWordSpan(runes, i+len("END"))
			switch next {
			case "IF", "LOOP":
				// END IF / END LOOP never pushed a frame (see above), so
				// there's nothing to undo here either.
				i += len("END")
			case "CASE":
				// END CASE — pops the CASE pushed above. Consume the trailing
				// "CASE" word too, or the next loop iteration would match it
				// as a brand new CASE keyword and push again.
				pop()
				i = nextEnd
			default:
				// Bare END (optionally followed by the unit's name): closes
				// whatever's actually open — a BEGIN block, a CASE
				// expression, or a package/type spec that never had a BEGIN.
				pop()
				i += len("END")
			}
			continue
		}

		if c == ';' {
			if len(stack) == 0 {
				flush(i)
				i++
				stmtStart = i
				continue
			}
			// Dentro de una unidad el ';' separa declaraciones y sentencias,
			// nunca statements. Si veníamos leyendo el header de un
			// subprograma anidado, este ';' significa que era una declaración
			// adelantada (`PROCEDURE x(...);`) y nunca va a traer IS/BEGIN.
			headerPending = false
			i++
			continue
		}

		i++
	}

	flush(n)
	return out
}

// timingPointEnd matches a COMPOUND TRIGGER timing-point header ("BEFORE
// STATEMENT", "AFTER EACH ROW", "INSTEAD OF EACH ROW", …) at runes[i],
// returning the index just past the two keywords that identify it. Inside a
// compound trigger these play the role a nested PROCEDURE/FUNCTION plays
// inside an ordinary unit: each one opens with IS and closes with its own
// `END BEFORE STATEMENT;`.
func timingPointEnd(runes []rune, i int) (int, bool) {
	for _, kw := range [...]string{"BEFORE", "AFTER", "INSTEAD"} {
		if !matchKeywordAt(runes, i, kw) {
			continue
		}
		next, end := peekNextWordSpan(runes, i+len(kw))
		switch next {
		case "STATEMENT", "EACH", "OF":
			return end, true
		}
	}
	return 0, false
}

// isComparisonIS reports whether the IS/AS keyword just consumed (rest
// starts right after it) is really the `IS [NOT] NULL`-style predicate
// rather than the opener of a declarative section. Needed because a trigger
// header can carry one before its body — `CREATE TRIGGER … WHEN (:new.x IS
// NOT NULL) BEGIN …` — while headerPending is still set.
func isComparisonIS(runes []rune, rest int) bool {
	word, _ := peekNextWordSpan(runes, rest)
	switch word {
	case "NOT", "NULL", "EMPTY", "JSON", "NAN", "INFINITE":
		return true
	}
	return false
}

// sqlplusOneWordCommands are SQL*Plus/SQLcl client commands whose first word
// alone identifies them; everything to the end of the line is arguments.
// None of them is valid SQL in any engine mini-tools supports, and they are
// only ever matched at the very start of a statement AND of a line, so a
// `CONNECT BY` inside a query or an `EXIT WHEN` inside a PL/SQL loop is
// never mistaken for one.
var sqlplusOneWordCommands = map[string]bool{
	"SPOOL": true, "PROMPT": true, "REM": true, "REMARK": true,
	"DEFINE": true, "UNDEFINE": true, "ACCEPT": true, "PAUSE": true,
	"TTITLE": true, "BTITLE": true, "WHENEVER": true, "CLEAR": true,
	"HOST": true, "EXIT": true, "QUIT": true, "CONNECT": true,
	"DISCONNECT": true, "STARTUP": true, "SHUTDOWN": true,
	"COLUMN": true, "VARIABLE": true, "PRINT": true, "TIMING": true,
	"STORE": true, "REPFOOTER": true, "REPHEADER": true,
}

// sqlplusSetOptions are the SET options that belong to SQL*Plus's client
// state, not to a server-side SET. Deliberately a whitelist: Postgres
// (`SET search_path …`) and SQL Server (`SET NOCOUNT ON`) both have a real
// SET statement, and neither uses any of these names.
var sqlplusSetOptions = map[string]bool{
	"SERVEROUTPUT": true, "ECHO": true, "FEEDBACK": true, "FEED": true,
	"HEADING": true, "HEADS": true, "VERIFY": true, "VER": true,
	"LINESIZE": true, "LIN": true, "PAGESIZE": true, "PAGES": true,
	"TERMOUT": true, "TERM": true, "TRIMSPOOL": true, "TRIMOUT": true,
	"DEFINE": true, "ESCAPE": true, "TIMING": true, "TIME": true,
	"SQLBLANKLINES": true, "SQLPROMPT": true, "SQLTERMINATOR": true,
	"BLOCKTERMINATOR": true, "LONG": true, "LONGCHUNKSIZE": true,
	"NEWPAGE": true, "NUMWIDTH": true, "NUMFORMAT": true, "COLSEP": true,
	"RECSEP": true, "WRAP": true, "AUTOPRINT": true, "AUTOTRACE": true,
	"MARKUP": true, "CONCAT": true, "ARRAYSIZE": true, "CMDSEP": true,
	"SCAN": true, "PAUSE": true, "EDITFILE": true, "EMBEDDED": true,
	"FLUSH": true, "SPACE": true, "TAB": true, "UNDERLINE": true,
	"ERRORLOGGING": true, "COPYCOMMIT": true, "SUFFIX": true,
	"APPINFO": true, "COLINVISIBLE": true,
}

// sqlplusShowOptions are the SHOW arguments that mean the SQL*Plus command.
// Also a whitelist, and for the same reason: Postgres's `SHOW <parameter>`
// is a real statement, so only names that are unambiguously SQL*Plus's are
// listed (`SHOW ALL`, a valid Postgres statement, is deliberately absent).
var sqlplusShowOptions = map[string]bool{
	"ERRORS": true, "ERR": true, "SERVEROUTPUT": true, "SPOOL": true,
	"RELEASE": true, "USER": true, "SGA": true, "PARAMETERS": true,
	"PARAMETER": true, "RECYCLEBIN": true, "PDBS": true, "CON_ID": true,
	"CON_NAME": true, "TTITLE": true, "BTITLE": true, "AUTOCOMMIT": true,
	"LNO": true, "PNO": true, "EDITION": true,
}

// sqlplusCommandEnd reports whether runes[i] starts a SQL*Plus/SQLcl client
// command, returning the index of the end of its line (the '\n' itself, or
// len(runes)). Requires i to be at the start of its line — SQL*Plus only
// recognises these commands there, and requiring it keeps the match from
// firing on anything that merely follows a ';' on the same line.
func sqlplusCommandEnd(runes []rune, i int) (int, bool) {
	for j := i - 1; j >= 0; j-- {
		if runes[j] == '\n' {
			break
		}
		if !unicode.IsSpace(runes[j]) {
			return 0, false
		}
	}

	n := len(runes)
	lineEnd := i
	for lineEnd < n && runes[lineEnd] != '\n' {
		lineEnd++
	}

	// "@script.sql" / "@@script.sql" — run another script, client-side.
	if runes[i] == '@' {
		return lineEnd, true
	}

	first, afterFirst := peekNextWordSpan(runes, i)
	switch {
	case sqlplusOneWordCommands[first]:
		return lineEnd, true
	case first == "SET":
		second, _ := peekNextWordSpan(runes, afterFirst)
		if sqlplusSetOptions[second] {
			return lineEnd, true
		}
	case first == "SHOW":
		second, _ := peekNextWordSpan(runes, afterFirst)
		// A bare "SHOW" is SQL*Plus too (it errors out client-side); an
		// argument we don't know is left alone so a Postgres `SHOW work_mem`
		// still reaches the server.
		if second == "" || sqlplusShowOptions[second] {
			return lineEnd, true
		}
	}
	return 0, false
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

// skipNoiseRunes is skipLeadingNoise over the rune slice: it returns the
// index of the first character of runes[i:] that is neither whitespace, a
// "--" line comment, a "/* */" block comment, nor a lone SQL*Plus "/"
// terminator line. Same rules as skipLeadingNoise, but it allocates nothing
// and never has to materialise the rest of the script as a string — which
// is what lets the splitter classify a statement without capping how much
// comment header it is willing to look past.
func skipNoiseRunes(runes []rune, i int) int {
	n := len(runes)
	for i < n {
		switch {
		case unicode.IsSpace(runes[i]):
			i++
		case runes[i] == '-' && i+1 < n && runes[i+1] == '-':
			for i < n && runes[i] != '\n' {
				i++
			}
		case runes[i] == '/' && i+1 < n && runes[i+1] == '*':
			i += 2
			for i+1 < n && !(runes[i] == '*' && runes[i+1] == '/') {
				i++
			}
			if i+1 < n {
				i += 2
			} else {
				i = n
			}
		case runes[i] == '/' && isLoneSlashLine(runes, i):
			i++
		default:
			return i
		}
	}
	return n
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
