package query

import "strings"

// Kind classifies one statement for the executor: plain SQL runs through
// the normal Query/Exec path, a PL/SQL block runs through go-ora's
// anonymous-block path with DBMS_OUTPUT capture (Oracle only).
type Kind string

const (
	KindSQL        Kind = "sql"
	KindPLSQLBlock Kind = "plsql"
)

// plsqlUnitKeywords are the CREATE [OR REPLACE] units whose body opens with
// BEGIN (Oracle-style) rather than a Postgres dollar-quoted body. A CREATE
// PACKAGE BODY with multiple member procedures (multiple independent
// BEGIN/END pairs) is not guaranteed to split correctly — see
// .claude/rules/technical.md point 7: this is a hand-rolled classifier, not
// a full PL/SQL grammar, and that's the accepted scope.
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
//   - awaitingBegin: true if semicolons must be suppressed until the first
//     BEGIN is seen (DECLARE section, or a CREATE unit's IS/AS section) —
//     used by the splitter.
//   - isPLSQL: true if this statement is a PL/SQL unit at all.
func classifyStatementStart(s string) (awaitingBegin, isPLSQL bool) {
	trimmed := skipLeadingNoise(s)
	upper := strings.ToUpper(trimmed)

	switch {
	case strings.HasPrefix(upper, "DECLARE"):
		return true, true
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
