package query

import "strings"

// Kind classifies one statement for the executor: plain SQL runs through
// the normal Query/Exec path, a PL/SQL block runs through go-ora's
// anonymous-block path with DBMS_OUTPUT capture (Oracle only).
type Kind string

const (
	KindSQL        Kind = "sql"
	KindPLSQLBlock Kind = "plsql"
	// KindSQLPlus is a SQL*Plus/SQLcl CLIENT command (SHOW ERRORS, SET
	// SERVEROUTPUT ON, WHENEVER SQLERROR ..., SPOOL, PROMPT, @script, ...).
	// SQL*Plus interprets these itself and never sends them to the server,
	// so Oracle answers ORA-00900 ("invalid SQL statement") if one is
	// forwarded verbatim — which is exactly what happened with the
	// `SHOW ERRORS PROCEDURE ...` lines of a generated install script. The
	// executor skips them on Oracle; see sqlplusCommandEnd in splitter.go.
	KindSQLPlus Kind = "sqlplus"
)

// plsqlUnitKeywords are the CREATE [OR REPLACE] units whose body opens with
// BEGIN (Oracle-style) rather than a Postgres dollar-quoted body. The
// splitter tracks their declarative sections with a frame stack, so a
// PACKAGE BODY (or any unit) with several nested subprograms — each with
// its own BEGIN/END — does split correctly now. Still a hand-rolled
// classifier and not a full PL/SQL grammar (see .claude/rules/technical.md
// point 7): shapes with no BEGIN at all, like `CREATE TYPE t AS OBJECT
// (...)`, rely on the trailing SQL*Plus "/" line to close the statement.
var plsqlUnitKeywords = []string{"PROCEDURE", "FUNCTION", "PACKAGE", "TRIGGER", "TYPE"}

// IsPLSQLBlock reports whether stmt is an Oracle PL/SQL unit — an anonymous
// DECLARE/BEGIN block, or a CREATE [OR REPLACE]
// PROCEDURE/FUNCTION/PACKAGE/TRIGGER/TYPE body — as opposed to plain SQL.
func IsPLSQLBlock(stmt string) bool {
	_, isPLSQL := classifyStatementStart(stmt)
	return isPLSQL
}

// classifyStatementStart looks at the start of a (possibly multi-statement)
// text and reports:
//   - unitHeader: true if the text opens with a CREATE [OR REPLACE]
//     PROCEDURE/FUNCTION/PACKAGE/TRIGGER/TYPE header, i.e. the splitter is
//     waiting for the IS/AS that opens the unit's declarative section.
//     False for DECLARE and for a bare BEGIN: those keywords are seen by
//     the splitter's own tokenizer, which pushes the right frame for them.
//   - isPLSQL: true if this statement is a PL/SQL unit at all.
func classifyStatementStart(s string) (unitHeader, isPLSQL bool) {
	trimmed := skipLeadingNoise(s)
	upper := strings.ToUpper(trimmed)

	switch {
	case strings.HasPrefix(upper, "DECLARE"):
		return false, true
	case strings.HasPrefix(upper, "BEGIN"):
		return false, true
	case strings.HasPrefix(upper, "CREATE"):
		rest := strings.TrimSpace(strings.TrimPrefix(upper, "CREATE"))
		rest = strings.TrimSpace(strings.TrimPrefix(rest, "OR REPLACE"))
		for _, kw := range plsqlUnitKeywords {
			if strings.HasPrefix(rest, kw) {
				return true, true
			}
		}
	}

	return false, false
}

// mutationKeywords are the statement openers that change data or schema.
// SELECT and the read-only utilities (EXPLAIN, SHOW, PRAGMA, WITH … SELECT)
// are absent on purpose: this list decides when the app has to warn before
// running something, so a false positive costs a needless confirmation
// while a false negative costs the user their data.
var mutationKeywords = []string{
	"INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE", "DROP", "ALTER",
	"CREATE", "REPLACE", "GRANT", "REVOKE", "RENAME", "COMMENT",
	"CALL", "EXEC", "EXECUTE", "UPSERT", "VACUUM", "REINDEX", "REFRESH",
}

// IsMutation reports whether stmt writes anything — data or schema.
//
// Deliberately conservative about two shapes that look read-only:
//   - A CTE ("WITH x AS (…) …") is walked past to its trailing statement,
//     because "WITH t AS (…) DELETE FROM …" is a perfectly ordinary way to
//     write a delete in Postgres and reading only the first keyword would
//     classify it as a SELECT.
//   - CALL/EXEC are included even though a procedure may well be read-only:
//     nothing here can know what it does, and the safe assumption is that
//     it writes.
func IsMutation(stmt string) bool {
	trimmed := skipLeadingNoise(stmt)
	upper := strings.ToUpper(trimmed)

	if strings.HasPrefix(upper, "WITH") {
		upper = afterCTEs(upper)
	}

	for _, kw := range mutationKeywords {
		if strings.HasPrefix(upper, kw) {
			// Guard against matching a table or column that merely starts
			// with a keyword ("UPDATED_AT", "CREATEDBY"): a real statement
			// keyword is followed by whitespace or a parenthesis.
			rest := upper[len(kw):]
			if rest == "" || rest[0] == ' ' || rest[0] == '\t' || rest[0] == '\n' || rest[0] == '\r' || rest[0] == '(' {
				return true
			}
		}
	}
	return false
}

// ContainsMutation reports whether ANY statement in a (possibly
// multi-statement) script mutates. Used before EXPLAIN ANALYZE, which
// really executes what it is given.
func ContainsMutation(sqlText string) bool {
	for _, stmt := range SplitStatements(sqlText) {
		if IsMutation(stmt.Text) {
			return true
		}
	}
	return false
}

// afterCTEs skips over the WITH clause's parenthesised bodies and returns
// the statement that follows them. Parenthesis counting is enough here: the
// text has already been through skipLeadingNoise, and a parenthesis inside
// a string literal would at worst leave the scan pointing somewhere that
// matches no keyword — which falls back to "not a mutation" only for a
// statement whose CTE contains an unbalanced quoted parenthesis AND whose
// tail is a write. The executor still runs it normally; the only thing lost
// is a confirmation prompt in a case this rare.
func afterCTEs(upper string) string {
	i := len("WITH")
	depth := 0
	for i < len(upper) {
		switch upper[i] {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				// End of one CTE body. What follows is either a comma (more
				// CTEs) or the actual statement.
				j := i + 1
				for j < len(upper) && (upper[j] == ' ' || upper[j] == '\t' || upper[j] == '\n' || upper[j] == '\r') {
					j++
				}
				if j < len(upper) && upper[j] == ',' {
					i = j
					continue
				}
				return strings.TrimSpace(upper[j:])
			}
		}
		i++
	}
	return upper
}
