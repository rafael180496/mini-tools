package sqlintel

import (
	"strings"
	"testing"

	"mini-tools/backend/db"
)

// testIndex is a small Oracle-shaped catalog: two tables in SGCPRO, a
// standalone procedure with named parameters, and a package.
func testIndex() *SchemaIndex {
	return BuildIndex(&db.SchemaMetadata{
		Tables: []db.Table{
			{Schema: "SGCPRO", Name: "BATCH_CTRL_MODULO", Columns: []db.Column{
				{Name: "PROGRAMA", DataType: "VARCHAR2"},
				{Name: "IND_ESTADO", DataType: "NUMBER"},
				{Name: "DESCRIP_ERROR", DataType: "VARCHAR2"},
			}},
			{Schema: "SGCPRO", Name: "CARGVAR", Columns: []db.Column{
				{Name: "F_ACTUAL", DataType: "DATE"},
				{Name: "NIS_RAD", DataType: "NUMBER"},
			}},
		},
		Procedures: []db.Procedure{
			{Schema: "SGCPRO", Name: "PR_INFORMANTE", Args: []db.RoutineArg{
				{Name: "P_FECHA_BATCH", DataType: "DATE", Mode: "IN"},
				{Name: "P_USUARIO", DataType: "VARCHAR2", Mode: "IN", HasDefault: true},
				{Name: "P_CANT", DataType: "NUMBER", Mode: "OUT"},
				{Name: "P_RETORNO", DataType: "NUMBER", Mode: "OUT"},
			}},
		},
		Packages: []db.Package{
			{Schema: "SGCPRO", Name: "PKG_AUD", Members: []db.PackageMember{{Name: "DESACTIVAR_SESION"}}},
		},
	})
}

// complete runs the engine with "|" marking the cursor.
func complete(t *testing.T, sql string, explicit bool) Response {
	t.Helper()
	at := strings.Index(sql, "|")
	if at < 0 {
		t.Fatal("test SQL needs a | cursor marker")
	}
	text := sql[:at] + sql[at+1:]
	return Complete(testIndex(), Request{DBType: "oracle", SQL: text, Offset: len([]rune(sql[:at])), Explicit: explicit}, nil)
}

func labels(resp Response, kind string) []string {
	var out []string
	for _, it := range resp.Items {
		if kind == "" || it.Kind == kind {
			out = append(out, it.Label)
		}
	}
	return out
}

func has(list []string, want string) bool {
	for _, s := range list {
		if strings.EqualFold(s, want) {
			return true
		}
	}
	return false
}

// Inside a block every statement used to be one: a WHERE in the second
// SELECT was offered the columns of the first one's table too.
func TestCompleteScopesEachStatementInsideABlock(t *testing.T) {
	resp := complete(t, `BEGIN
  SELECT COUNT(*) INTO v_n FROM SGCPRO.CARGVAR WHERE NIS_RAD = 1;
  UPDATE SGCPRO.BATCH_CTRL_MODULO SET IND_ESTADO = 1 WHERE |
END;`, true)
	cols := labels(resp, KindColumn)
	if !has(cols, "PROGRAMA") {
		t.Fatalf("expected BATCH_CTRL_MODULO columns, got %v", cols)
	}
	if has(cols, "F_ACTUAL") {
		t.Fatalf("CARGVAR belongs to the previous statement, got %v", cols)
	}
}

func TestCompleteOffersNamedArgumentsOfTheCalledProcedure(t *testing.T) {
	resp := complete(t, `DECLARE
  v_cant NUMBER; v_ret NUMBER;
BEGIN
  SGCPRO.PR_INFORMANTE(
      p_fecha_batch => DATE '2026-09-10',
      |
END;`, false)
	params := labels(resp, KindParam)
	if !has(params, "P_USUARIO") || !has(params, "P_CANT") {
		t.Fatalf("expected the remaining parameters, got %v", labels(resp, ""))
	}
	if has(params, "P_FECHA_BATCH") {
		t.Fatalf("an argument already passed by name must not be offered again: %v", params)
	}
	if resp.Items[0].Kind != KindParam {
		t.Fatalf("parameters should lead the list, got %+v", resp.Items[0])
	}
	for _, it := range resp.Items {
		if it.Kind == KindParam && it.Apply != it.Label+" => " {
			t.Fatalf("a parameter inserts in named notation, got %q", it.Apply)
		}
		if it.Kind == KindTable {
			t.Fatalf("the table list does not belong in an argument: %+v", it)
		}
	}
}

func TestCompleteOffersBlockVariablesAsArgumentValues(t *testing.T) {
	resp := complete(t, `DECLARE
  v_cant NUMBER;
  v_ret  NUMBER(10,2) := 0;
  CURSOR c_mod IS SELECT * FROM SGCPRO.BATCH_CTRL_MODULO;
BEGIN
  SGCPRO.PR_INFORMANTE(p_cant => v_|
END;`, false)
	vars := labels(resp, KindVariable)
	if !has(vars, "v_cant") || !has(vars, "v_ret") {
		t.Fatalf("expected the block's variables, got %v", labels(resp, ""))
	}
	for _, it := range resp.Items {
		if it.Label == "v_ret" && it.Detail != "NUMBER(10,2)" {
			t.Fatalf("variable type rendered as %q", it.Detail)
		}
	}
}

func TestBlockVariablesEndWithTheirBlock(t *testing.T) {
	sql := `DECLARE v_x NUMBER; BEGIN NULL; END;
SELECT * FROM SGCPRO.CARGVAR WHERE `
	vars := BlockVariables(Code(Tokenize([]rune(sql))), len([]rune(sql)))
	if len(vars) != 0 {
		t.Fatalf("a closed block's variables leaked out: %+v", vars)
	}
}

func TestBlockVariablesIncludeRoutineParameters(t *testing.T) {
	sql := `CREATE OR REPLACE PROCEDURE PR_X (p_fecha IN DATE, p_ret OUT NUMBER) IS
  v_total NUMBER;
BEGIN
  IF p_fecha IS NULL THEN v_total := 0; END IF;
  SELECT CASE WHEN 1 = 1 THEN 1 END INTO v_total FROM DUAL;
  `
	vars := BlockVariables(Code(Tokenize([]rune(sql))), len([]rune(sql)))
	var names []string
	for _, v := range vars {
		names = append(names, v.Name)
		if v.Name == "p_ret" && v.Type != "OUT NUMBER" {
			t.Fatalf("p_ret type = %q", v.Type)
		}
	}
	if !has(names, "v_total") || !has(names, "p_fecha") || !has(names, "p_ret") {
		t.Fatalf("expected locals and parameters, got %v", names)
	}
}

// "SGCPRO." completed to a table list only, so a schema-qualified call to a
// procedure had nothing to complete to.
func TestCompleteSchemaQualifierOffersRoutinesAndPackages(t *testing.T) {
	resp := complete(t, "BEGIN\n  SGCPRO.|\nEND;", true)
	all := labels(resp, "")
	if !has(labels(resp, KindRoutine), "PR_INFORMANTE") {
		t.Fatalf("expected the schema's procedure, got %v", all)
	}
	if !has(labels(resp, KindPackage), "PKG_AUD") {
		t.Fatalf("expected the schema's package, got %v", all)
	}
	if !has(labels(resp, KindTable), "CARGVAR") {
		t.Fatalf("tables must still be there, got %v", all)
	}
}

func TestCompleteSchemaQualifierInFromRanksTablesFirst(t *testing.T) {
	resp := complete(t, "SELECT * FROM SGCPRO.|", true)
	if len(resp.Items) == 0 || resp.Items[0].Kind != KindTable {
		t.Fatalf("after FROM a table leads, got %v", labels(resp, ""))
	}
}

func TestCompleteOpensOnTheValueOfANamedArgument(t *testing.T) {
	resp := complete(t, `DECLARE
  v_cant NUMBER;
BEGIN
  SGCPRO.PR_INFORMANTE(p_cant => |
END;`, false)
	if len(resp.Items) == 0 || resp.Items[0].Label != "v_cant" {
		t.Fatalf("expected the block's variable first, got %v", labels(resp, ""))
	}
}
