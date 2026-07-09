package query

import "testing"

// Regression test for a real bug found live against Oracle: SplitStatements
// deliberately strips the delimiting ";" from every flushed statement, but
// Oracle's PL/SQL grammar requires it right after a block's final END to
// terminate the block — without it, Oracle reports "PLS-00103: encountered
// the symbol end-of-file when expecting ; <an identifier> ...". Every
// anonymous block/CREATE PROCEDURE-FUNCTION-TRIGGER body sent through
// runOraclePLSQLBlock failed with this until ensureTrailingSemicolon was
// added.
func TestEnsureTrailingSemicolon(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"missing semicolon", "BEGIN\n  NULL;\nEND", "BEGIN\n  NULL;\nEND;"},
		{"already has semicolon", "BEGIN\n  NULL;\nEND;", "BEGIN\n  NULL;\nEND;"},
		{"trailing whitespace after END", "BEGIN\n  NULL;\nEND  \n\n", "BEGIN\n  NULL;\nEND;"},
		{"trailing whitespace after semicolon", "BEGIN\n  NULL;\nEND;\n\n", "BEGIN\n  NULL;\nEND;\n\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ensureTrailingSemicolon(tc.in); got != tc.want {
				t.Errorf("ensureTrailingSemicolon(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
