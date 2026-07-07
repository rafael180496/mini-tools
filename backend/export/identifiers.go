package export

import "strings"

// quoteIdent double-quotes a SQL identifier (ANSI/Postgres/Oracle style),
// doubling any embedded quote — used by the hand-rolled DDL reconstruction
// for Postgres.
func quoteIdent(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

func quoteIdents(names []string) []string {
	out := make([]string, len(names))
	for i, n := range names {
		out[i] = quoteIdent(n)
	}
	return out
}
