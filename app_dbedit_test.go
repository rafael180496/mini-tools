package main

import (
	"strings"
	"testing"
)

func exprTarget() EditTarget {
	return EditTarget{
		Editable: true,
		Table:    "SGCPRO.BATCH_CTRL_MODULO",
		KeyCols:  []string{"PROGRAMA"},
		Columns: []EditColumn{
			{Name: "PROGRAMA", Kind: "text", IsKey: true},
			{Name: "F_FIN", Kind: "datetime", Nullable: true, Editable: true},
		},
	}
}

func ptr(s string) *string { return &s }

// An expression goes into the UPDATE as written, in parentheses, and the key
// binds start at 1 because the value no longer takes a slot.
func TestBuildUpdateWithExpression(t *testing.T) {
	oracle := func(n int) string { return ":" + string(rune('0'+n)) }
	stmt, args, err := buildUpdate(exprTarget(), CellEdit{Column: "F_FIN", Value: ptr("SYSDATE - 1"), Key: map[string]string{"PROGRAMA": "LECB0200"}, Expression: true}, oracle)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stmt, `= (SYSDATE - 1) WHERE`) || !strings.Contains(stmt, `= :1`) {
		t.Fatalf("unexpected statement: %s", stmt)
	}
	if len(args) != 1 || args[0] != "LECB0200" {
		t.Fatalf("only the key should be bound, got %v", args)
	}
}

// What would change WHICH statement runs, rather than which value is
// written, is rejected before anything reaches the database.
func TestBuildUpdateRejectsUnsafeExpressions(t *testing.T) {
	for _, expr := range []string{
		"1; DELETE FROM x",
		"1 -- se come el WHERE",
		"1 /* comentario */",
		"1), PROGRAMA = (2",
		"TRUNC(SYSDATE",
		"'sin cerrar",
		"   ",
	} {
		_, _, err := buildUpdate(exprTarget(), CellEdit{Column: "F_FIN", Value: ptr(expr), Key: map[string]string{"PROGRAMA": "X"}, Expression: true}, literalStyle)
		if err == nil {
			t.Errorf("expression %q should be rejected", expr)
		}
	}
	// A ";" or "--" inside a literal is just text.
	if _, _, err := buildUpdate(exprTarget(), CellEdit{Column: "F_FIN", Value: ptr("TO_DATE('2026-01-01 --;', 'YYYY-MM-DD --;')"), Key: map[string]string{"PROGRAMA": "X"}, Expression: true}, literalStyle); err != nil {
		t.Errorf("literal content was treated as code: %v", err)
	}
}
