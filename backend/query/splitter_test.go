package query

import (
	"strings"
	"testing"
)

// Regression test for a real bug found against support-lab's database/init.sql:
// a DECLARE block preceded by the classic SQL*Plus "END;\n/\n" terminator
// (optionally followed by a header comment) used to get misclassified as
// plain SQL — classifyStatementStart saw the stray "/" (or a comment line)
// as the first character instead of "DECLARE", so awaitingBegin never got
// set, and the first semicolon in the declare section split the block in
// half. On the 69-statement init.sql this doubled the statement count and
// sent Oracle a truncated "DECLARE v_exists NUMBER" fragment with no BEGIN,
// producing "PLS-00103: encountered the symbol end-of-file".
func TestSplitStatements_SQLPlusTerminatorBeforeDeclareBlock(t *testing.T) {
	sql := `
BEGIN
  DBMS_OUTPUT.PUT_LINE('first block');
END;
/

-- --- 15_export_cleanup_log.sql ---
DECLARE
  v_exists NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_exists FROM all_tables WHERE table_name = 'X';
  IF v_exists = 0 THEN
    EXECUTE IMMEDIATE 'CREATE TABLE X (id NUMBER)';
  END IF;
END;
/
`
	stmts := SplitStatements(sql)
	if len(stmts) != 2 {
		t.Fatalf("expected 2 statements, got %d: %#v", len(stmts), stmts)
	}
	for i, s := range stmts {
		if s.Kind != KindPLSQLBlock {
			t.Errorf("statement %d: expected KindPLSQLBlock, got %v (text: %q)", i, s.Kind, s.Text)
		}
	}
	if got := stmts[1].Text; !strings.Contains(got, "DECLARE") || !strings.Contains(got, "BEGIN") || !strings.Contains(got, "END") {
		t.Errorf("second statement is missing DECLARE/BEGIN/END — looks truncated: %q", got)
	}
	// The stray "/" terminator must never survive into the statement text
	// sent to the database — it isn't valid Oracle syntax.
	for i, s := range stmts {
		if strings.Contains(s.Text, "\n/\n") || s.Text == "/" {
			t.Errorf("statement %d still contains a stray SQL*Plus '/' terminator: %q", i, s.Text)
		}
	}
}

func TestSplitStatements_DivisionOperatorNotMistakenForTerminator(t *testing.T) {
	sql := `SELECT a / b FROM dual;`
	stmts := SplitStatements(sql)
	if len(stmts) != 1 {
		t.Fatalf("expected 1 statement, got %d: %#v", len(stmts), stmts)
	}
	if !strings.Contains(stmts[0].Text, "a / b") {
		t.Errorf("division operator was incorrectly stripped: %q", stmts[0].Text)
	}
}

// Regression test for a second real bug found against the same file: a long
// auto-generated file-banner comment (~400 runes on init.sql, 6 lines) ahead
// of the very first DECLARE overran ensureStarted's old 200-rune lookahead
// window before classifyStatementStart ever saw "DECLARE" — same silent
// misclassification, same truncation-on-first-semicolon symptom, but this
// time on the very first statement in the file (nothing preceded it, so the
// "/" terminator fix above didn't cover this case).
func TestSplitStatements_LongHeaderCommentBeforeDeclareBlock(t *testing.T) {
	var b strings.Builder
	b.WriteString("-- =====================================================\n")
	b.WriteString("-- ARCHIVO GENERADO AUTOMÁTICAMENTE — NO EDITAR A MANO.\n")
	b.WriteString("-- Fuente editable: database/schema/NN_modulo.sql\n")
	b.WriteString("-- Regenerar con: python3 database/generate_init_sql.py\n")
	b.WriteString("-- Ver claude/05-database.md para la regla completa.\n")
	b.WriteString("-- =====================================================\n")
	b.WriteString("\n-- --- 00_users.sql ---\n")
	b.WriteString("DECLARE\n  v_exists NUMBER;\nBEGIN\n  IF v_exists = 0 THEN\n    NULL;\n  END IF;\nEND;\n/\n")

	stmts := SplitStatements(b.String())
	if len(stmts) != 1 {
		t.Fatalf("expected 1 statement, got %d: %#v", len(stmts), stmts)
	}
	if stmts[0].Kind != KindPLSQLBlock {
		t.Errorf("expected KindPLSQLBlock, got %v (text: %q)", stmts[0].Kind, stmts[0].Text)
	}
	if !strings.Contains(stmts[0].Text, "BEGIN") || !strings.HasSuffix(strings.TrimSpace(stmts[0].Text), "END") {
		t.Errorf("statement looks truncated: %q", stmts[0].Text)
	}
}
