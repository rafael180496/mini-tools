package explain

import (
	"regexp"
	"sort"
	"strings"
)

// Index suggestions. Seeing a red "Seq Scan" tells a developer there is a
// problem; handing them the CREATE INDEX that fixes it is the difference
// between a diagnostic and a tool.
//
// These are suggestions, deliberately never executed automatically: an
// index is a real write to a real database, it costs disk and slows down
// writes, and the right column order depends on knowledge this package does
// not have. The UI offers the statement to copy; the user decides.

// columnRef matches a qualified or bare identifier used in a predicate,
// including a quoted one. The leading boundary keeps it from matching the
// tail of a longer word.
var columnRef = regexp.MustCompile(`(?i)\b([a-z_][a-z0-9_$#]*|"[^"]+"|\[[^\]]+\])\s*(?:=|<>|!=|>=|<=|>|<|~~|~|LIKE\b|IN\b|BETWEEN\b|IS\b)`)

// predicateNoise is the words that appear in the left-hand position of a
// comparison but are not columns. Filtering them beats trying to write a
// full expression parser for a hint.
var predicateNoise = map[string]bool{
	"and": true, "or": true, "not": true, "null": true, "true": true,
	"false": true, "any": true, "all": true, "case": true, "when": true,
	"then": true, "else": true, "end": true, "cast": true, "coalesce": true,
	"lower": true, "upper": true, "trim": true, "abs": true, "length": true,
	"substr": true, "to_char": true, "to_date": true, "nvl": true,
	"isnull": true, "ifnull": true, "date": true, "datetime": true,
}

// SuggestIndex builds a CREATE INDEX statement covering the columns a full
// scan is filtering on. Returns "" when there is nothing solid to suggest —
// no table name, or a filter nothing recognisable could be extracted from.
// A wrong suggestion is worse than none: the user would create an index
// that costs writes and fixes nothing.
func SuggestIndex(engine string, n *PlanNode) string {
	if n == nil || n.ObjectName == "" {
		return ""
	}
	columns := filterColumns(n.Filter, n.ObjectName)
	if len(columns) == 0 {
		return ""
	}
	// More than three columns is almost certainly the extractor being
	// fooled by a complex expression rather than a genuinely composite
	// index; suggesting it would be confidently wrong.
	if len(columns) > 3 {
		columns = columns[:3]
	}

	table := n.ObjectName
	quote := identQuoter(engine)

	quoted := make([]string, len(columns))
	for i, c := range columns {
		quoted[i] = quote(c)
	}

	// IF NOT EXISTS makes the snippet safe to paste twice, but only
	// Postgres and SQLite accept it on CREATE INDEX — Oracle (before 23c)
	// and SQL Server do not, and emitting it there would hand the user a
	// statement that fails.
	create := "CREATE INDEX "
	if engine == "postgres" || engine == "sqlite" {
		create = "CREATE INDEX IF NOT EXISTS "
	}
	return create + quote(indexName(table, columns)) + " ON " + quote(table) +
		" (" + strings.Join(quoted, ", ") + ");"
}

// SuggestAnalyze is the "your statistics are stale" remedy, which is
// spelled differently per engine.
func SuggestAnalyze(engine, table string) string {
	quote := identQuoter(engine)
	switch engine {
	case "postgres":
		if table == "" {
			return "ANALYZE;"
		}
		return "ANALYZE " + quote(table) + ";"
	case "sqlite":
		return "ANALYZE;"
	case "oracle":
		if table == "" {
			return ""
		}
		return "BEGIN DBMS_STATS.GATHER_TABLE_STATS(USER, '" + strings.ToUpper(table) + "'); END;\n/"
	case "sqlserver":
		if table == "" {
			return ""
		}
		return "UPDATE STATISTICS " + quote(table) + ";"
	default:
		return ""
	}
}

// filterColumns pulls the column names out of a predicate string. It is a
// regex over an expression the engine already normalised, not a parser —
// same tolerance as everything else in this package: a miss costs a
// suggestion, never correctness.
func filterColumns(filter, table string) []string {
	if strings.TrimSpace(filter) == "" {
		return nil
	}

	seen := map[string]bool{}
	var columns []string
	for _, m := range columnRef.FindAllStringSubmatch(filter, -1) {
		raw := strings.Trim(m[1], `"[]`)
		lower := strings.ToLower(raw)
		if predicateNoise[lower] {
			continue
		}
		// Postgres writes filters qualified ("t.col"); keep the column.
		if idx := strings.LastIndex(raw, "."); idx >= 0 {
			raw = raw[idx+1:]
			lower = strings.ToLower(raw)
		}
		// A bare parameter placeholder or a literal is not a column.
		if raw == "" || raw == table || predicateNoise[lower] {
			continue
		}
		if seen[lower] {
			continue
		}
		seen[lower] = true
		columns = append(columns, raw)
	}
	return columns
}

// indexName follows the idx_<table>_<cols> convention every engine's
// community uses, truncated to stay under the shortest identifier limit of
// the four (Oracle's 30 characters before 12.2).
func indexName(table string, columns []string) string {
	parts := []string{"idx", sanitizeIdent(table)}
	// Sorted so the same column set always yields the same index name,
	// whatever order the filter happened to mention them in.
	sorted := append([]string(nil), columns...)
	sort.Strings(sorted)
	for _, c := range sorted {
		parts = append(parts, sanitizeIdent(c))
	}
	name := strings.Join(parts, "_")
	if len(name) > 30 {
		name = name[:30]
	}
	return strings.TrimRight(name, "_")
}

func sanitizeIdent(s string) string {
	s = strings.ToLower(strings.Trim(s, `"[]`))
	if idx := strings.LastIndex(s, "."); idx >= 0 {
		s = s[idx+1:]
	}
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// identQuoter returns the engine's identifier quoting. Only applied when
// the identifier needs it — a quoted lower-case name in Oracle would refer
// to a different object than the unquoted one, so quoting everything
// unconditionally would produce statements that fail.
func identQuoter(engine string) func(string) string {
	switch engine {
	case "sqlserver":
		return func(s string) string {
			if needsQuoting(s) {
				return "[" + s + "]"
			}
			return s
		}
	default:
		return func(s string) string {
			if needsQuoting(s) {
				return `"` + s + `"`
			}
			return s
		}
	}
}

func needsQuoting(s string) bool {
	if s == "" {
		return false
	}
	for i, r := range s {
		isLower := r >= 'a' && r <= 'z'
		isDigit := r >= '0' && r <= '9'
		if isLower || r == '_' || (isDigit && i > 0) {
			continue
		}
		return true
	}
	return false
}
