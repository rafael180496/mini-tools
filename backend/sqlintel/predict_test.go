package sqlintel

import (
	"strings"
	"testing"

	"mini-tools/backend/db"
)

// completeFor es complete() con otro índice y otro motor, y sin tope de
// resultados: algunas pruebas preguntan por lo que queda al FINAL de la lista.
func completeFor(t *testing.T, idx *SchemaIndex, dbType, sql string, explicit bool) Response {
	t.Helper()
	at := strings.Index(sql, "|")
	if at < 0 {
		t.Fatal("test SQL needs a | cursor marker")
	}
	text := sql[:at] + sql[at+1:]
	return Complete(idx, Request{DBType: dbType, SQL: text, Offset: len([]rune(sql[:at])), Explicit: explicit, Limit: 5000}, nil)
}

// indexWithFunction suma una función al catálogo de prueba: lo único de las
// rutinas que puede ir dentro de una expresión.
func indexWithFunction() *SchemaIndex {
	return BuildIndex(&db.SchemaMetadata{
		Tables: []db.Table{
			{Schema: "SGCPRO", Name: "CARGVAR", Columns: []db.Column{
				{Name: "F_ACTUAL", DataType: "DATE"},
				{Name: "NIS_RAD", DataType: "NUMBER"},
			}},
		},
		Procedures: []db.Procedure{{Schema: "SGCPRO", Name: "PR_INFORMANTE"}},
		Functions:  []db.Function{{Schema: "SGCPRO", Name: "FN_PERIODO", ReturnType: "NUMBER"}},
		Packages: []db.Package{{Schema: "SGCPRO", Name: "PKG_X", Members: []db.PackageMember{
			{Name: "ABRIR"},
			{Name: "TOTAL", IsFunction: true, ReturnType: "NUMBER"},
		}}},
	})
}

func hasKind(resp Response, kind string) bool { return len(labels(resp, kind)) > 0 }

// ---- 1. INSERT (...) ------------------------------------------------------

func TestInsertColumnListOffersOnlyTheTargetColumns(t *testing.T) {
	resp := complete(t, "INSERT INTO SGCPRO.CARGVAR (|", false)
	cols := labels(resp, KindColumn)
	if !has(cols, "F_ACTUAL") || !has(cols, "NIS_RAD") {
		t.Fatalf("expected the target's columns, got %v", labels(resp, ""))
	}
	for _, it := range resp.Items {
		if it.Kind != KindColumn {
			t.Fatalf("only columns belong in an INSERT column list, got %+v", it)
		}
	}
	if has(cols, "PROGRAMA") {
		t.Fatalf("columns of another table leaked: %v", cols)
	}
}

func TestInsertColumnListLeavesOutWhatIsAlreadyWritten(t *testing.T) {
	// Antes y después del cursor.
	resp := complete(t, "INSERT INTO SGCPRO.CARGVAR (F_ACTUAL, |, X) VALUES (1, 2, 3)", true)
	cols := labels(resp, KindColumn)
	if has(cols, "F_ACTUAL") {
		t.Fatalf("F_ACTUAL is already in the list: %v", cols)
	}
	if !has(cols, "NIS_RAD") {
		t.Fatalf("NIS_RAD is still free: %v", cols)
	}
	if hasKind(resp, KindFunction) || hasKind(resp, KindKeyword) || hasKind(resp, KindTable) {
		t.Fatalf("a column list is columns only, got %v", labels(resp, ""))
	}
}

func TestInsertColumnListWithAnUnknownTableKeepsTheBroadAnswer(t *testing.T) {
	resp := complete(t, "INSERT INTO NO_EXISTE (|", true)
	if len(resp.Items) == 0 {
		t.Fatal("an unresolved table must not turn into an empty list")
	}
}

// ---- 2. SET / WHERE -------------------------------------------------------

func TestSetTargetOffersOnlyColumnsNotYetAssigned(t *testing.T) {
	resp := complete(t, "UPDATE SGCPRO.CARGVAR SET |", false)
	for _, it := range resp.Items {
		if it.Kind != KindColumn {
			t.Fatalf("a SET target is a column, got %+v", it)
		}
	}
	resp = complete(t, "UPDATE SGCPRO.CARGVAR SET F_ACTUAL = SYSDATE, |", true)
	cols := labels(resp, KindColumn)
	if has(cols, "F_ACTUAL") || !has(cols, "NIS_RAD") {
		t.Fatalf("expected only NIS_RAD, got %v", cols)
	}
	if hasKind(resp, KindFunction) || hasKind(resp, KindTable) {
		t.Fatalf("no functions or tables as a SET target: %v", labels(resp, ""))
	}
}

func TestSetValueStillOffersFunctions(t *testing.T) {
	resp := complete(t, "UPDATE SGCPRO.CARGVAR SET F_ACTUAL = |", true)
	if !hasKind(resp, KindFunction) {
		t.Fatalf("the value of an assignment is an expression: %v", labels(resp, ""))
	}
	// Una coma DENTRO de una llamada no abre otro destino de asignación.
	resp = complete(t, "UPDATE SGCPRO.CARGVAR SET F_ACTUAL = NVL(NIS_RAD, |", true)
	if !hasKind(resp, KindFunction) {
		t.Fatalf("a comma inside a call is not a new SET target: %v", labels(resp, ""))
	}
}

func TestWhereHasNoTablesOnTheSelfOpenedPopup(t *testing.T) {
	for _, sql := range []string{
		"UPDATE SGCPRO.CARGVAR SET F_ACTUAL = 1 WHERE |",
		"UPDATE SGCPRO.CARGVAR SET F_ACTUAL = 1 WHERE NIS_RAD = 1 AND |",
	} {
		resp := complete(t, sql, false)
		if hasKind(resp, KindTable) {
			t.Fatalf("%q: tables are noise here, got %v", sql, labels(resp, ""))
		}
		if !has(labels(resp, KindColumn), "NIS_RAD") {
			t.Fatalf("%q: expected the columns, got %v", sql, labels(resp, ""))
		}
	}
}

func TestWhereKeepsTablesBehindColumnsOnCtrlSpace(t *testing.T) {
	resp := completeFor(t, testIndex(), "oracle", "SELECT * FROM SGCPRO.CARGVAR WHERE |", true)
	lastCol, firstTable := -1, -1
	for i, it := range resp.Items {
		switch it.Kind {
		case KindColumn:
			lastCol = i
		case KindTable:
			if firstTable < 0 {
				firstTable = i
			}
		}
	}
	if lastCol < 0 || firstTable < 0 || firstTable < lastCol {
		t.Fatalf("columns first, tables behind: columns end at %d, tables start at %d", lastCol, firstTable)
	}
}

// ---- 3. Procedimientos en expresiones -------------------------------------

func TestProceduresAreNotOfferedWhereAnExpressionGoes(t *testing.T) {
	idx := indexWithFunction()
	for _, sql := range []string{
		"SELECT * FROM SGCPRO.CARGVAR WHERE P|",
		"SELECT * FROM SGCPRO.CARGVAR WHERE |",
		"SELECT | FROM SGCPRO.CARGVAR",
		"SELECT * FROM SGCPRO.CARGVAR ORDER BY |",
		"SELECT * FROM SGCPRO.CARGVAR WHERE NIS_RAD = SGCPRO.|",
	} {
		resp := completeFor(t, idx, "oracle", sql, true)
		routines := labels(resp, KindRoutine)
		if has(routines, "PR_INFORMANTE") || has(routines, "PKG_X.ABRIR") || has(routines, "ABRIR") {
			t.Fatalf("%q: a procedure cannot be an expression, got %v", sql, routines)
		}
	}
}

func TestFunctionsOfTheCatalogAreStillOfferedInExpressions(t *testing.T) {
	idx := indexWithFunction()
	resp := completeFor(t, idx, "oracle", "SELECT * FROM SGCPRO.CARGVAR WHERE NIS_RAD = F|", true)
	if !has(labels(resp, KindRoutine), "FN_PERIODO") {
		t.Fatalf("a catalog function belongs in a WHERE, got %v", labels(resp, ""))
	}
	resp = completeFor(t, idx, "oracle", "SELECT PKG_X.|", true)
	members := labels(resp, KindRoutine)
	if !has(members, "TOTAL") || has(members, "ABRIR") {
		t.Fatalf("only the package's function belongs in a SELECT list, got %v", members)
	}
}

func TestProceduresRemainAtTheStartOfAStatement(t *testing.T) {
	resp := completeFor(t, indexWithFunction(), "oracle", "|", true)
	if !has(labels(resp, KindRoutine), "PR_INFORMANTE") {
		t.Fatalf("a statement may be a call, got %v", labels(resp, KindRoutine))
	}
}

// ---- 4. Predicción por posición -------------------------------------------

func TestOperatorsFollowAColumnInACondition(t *testing.T) {
	cases := []struct {
		sql   string
		first string
		want  []string
	}{
		{"SELECT * FROM SGCPRO.CARGVAR WHERE NIS_RAD |", "=", []string{"IN", "BETWEEN", "IS NULL", "LIKE"}[:3]},
		{"SELECT * FROM SGCPRO.CARGVAR WHERE NIS_RAD = 1 AND F_ACTUAL |", "=", []string{"BETWEEN", ">=", "IS NULL"}},
		{"SELECT * FROM SGCPRO.CARGVAR c WHERE c.NIS_RAD |", "=", []string{"IN", "BETWEEN"}},
		{"SELECT * FROM SGCPRO.CARGVAR c JOIN SGCPRO.BATCH_CTRL_MODULO b ON b.PROGRAMA |", "=", []string{"LIKE", "IN"}},
	}
	for _, tc := range cases {
		resp := complete(t, tc.sql, true)
		if len(resp.Items) == 0 || resp.Items[0].Label != tc.first {
			t.Fatalf("%q: expected %q first, got %v", tc.sql, tc.first, labels(resp, ""))
		}
		for _, w := range tc.want {
			if !has(labels(resp, KindKeyword), w) {
				t.Fatalf("%q: expected operator %q in %v", tc.sql, w, labels(resp, KindKeyword))
			}
		}
	}
}

func TestOperatorOrderFollowsTheColumnType(t *testing.T) {
	text := complete(t, "SELECT * FROM SGCPRO.BATCH_CTRL_MODULO WHERE PROGRAMA |", true)
	if text.Items[1].Label != "LIKE" {
		t.Fatalf("a text column is searched with LIKE, got %v", labels(text, ""))
	}
	date := complete(t, "SELECT * FROM SGCPRO.CARGVAR WHERE F_ACTUAL |", true)
	if date.Items[1].Label != "BETWEEN" {
		t.Fatalf("a date column is bounded with BETWEEN, got %v", labels(date, ""))
	}
}

func TestOperatorsCarryUsableInsertions(t *testing.T) {
	resp := complete(t, "SELECT * FROM SGCPRO.CARGVAR WHERE NIS_RAD |", true)
	apply := map[string]string{}
	for _, it := range resp.Items {
		if it.Kind == KindKeyword {
			apply[it.Label] = it.Apply
		}
	}
	if apply["IN"] != "IN (${1})" || apply["BETWEEN"] != "BETWEEN ${1:desde} AND ${2:hasta}" || apply["IS NULL"] != "IS NULL" {
		t.Fatalf("unexpected insertions: %v", apply)
	}
	// El prefijo tecleado filtra el mismo conjunto, sin duplicar la palabra.
	resp = complete(t, "SELECT * FROM SGCPRO.CARGVAR WHERE NIS_RAD be|", false)
	n := 0
	for _, it := range resp.Items {
		if it.Kind == KindKeyword && strings.EqualFold(it.Label, "BETWEEN") {
			n++
			if it.Apply == "" {
				t.Fatalf("the predicted BETWEEN should carry its template, got %+v", it)
			}
		}
	}
	if n != 1 {
		t.Fatalf("BETWEEN listed %d times: %v", n, labels(resp, KindKeyword))
	}
}

func TestOperatorsAreNotOfferedWhereTheyDoNotFit(t *testing.T) {
	for _, sql := range []string{
		// Segundo extremo de un BETWEEN.
		"SELECT * FROM SGCPRO.CARGVAR WHERE NIS_RAD BETWEEN 1 AND NIS_RAD |",
		// No es una columna del alcance.
		"SELECT * FROM SGCPRO.CARGVAR WHERE UPPER |",
		// Argumento de una llamada.
		"SELECT * FROM SGCPRO.CARGVAR WHERE FN(NIS_RAD |",
		// Operando derecho.
		"SELECT * FROM SGCPRO.CARGVAR WHERE NIS_RAD = F_ACTUAL |",
	} {
		resp := complete(t, sql, true)
		for _, it := range resp.Items {
			if it.Kind == KindKeyword && (it.Label == "=" || it.Label == "BETWEEN" && it.Apply != "") {
				t.Fatalf("%q: operator %q out of place: %v", sql, it.Label, labels(resp, ""))
			}
		}
	}
}

func TestSetTargetIsFollowedByEqualsOnly(t *testing.T) {
	resp := complete(t, "UPDATE SGCPRO.CARGVAR SET NIS_RAD |", true)
	if resp.Items[0].Label != "=" {
		t.Fatalf("expected = first, got %v", labels(resp, ""))
	}
	for _, it := range resp.Items {
		if it.Kind == KindKeyword && it.Apply != "" && it.Label != "=" {
			t.Fatalf("only '=' follows a SET target, got %+v", it)
		}
	}
}

func TestOperatorsKeepTheScriptsKeywordCase(t *testing.T) {
	resp := complete(t, "select * from sgcpro.cargvar where nis_rad |", true)
	if !has(labels(resp, KindKeyword), "in") {
		t.Fatalf("a lower-case script gets lower-case operators: %v", labels(resp, KindKeyword))
	}
}

func TestSortDirectionFollowsASortKey(t *testing.T) {
	resp := complete(t, "SELECT * FROM SGCPRO.CARGVAR ORDER BY NIS_RAD |", true)
	got := labels(resp, KindKeyword)
	for _, w := range []string{"DESC", "ASC", "NULLS FIRST", "NULLS LAST"} {
		if !has(got, w) {
			t.Fatalf("expected %s in %v", w, got)
		}
	}
	if resp.Items[0].Label != "DESC" {
		t.Fatalf("expected DESC first, got %v", labels(resp, ""))
	}
	// Después de la coma también, y con una columna calificada.
	resp = complete(t, "SELECT * FROM SGCPRO.CARGVAR c ORDER BY c.F_ACTUAL DESC, c.NIS_RAD |", true)
	if !has(labels(resp, KindKeyword), "ASC") {
		t.Fatalf("a second sort key takes a direction too: %v", labels(resp, ""))
	}
	// SQL Server no tiene NULLS FIRST/LAST.
	resp = completeFor(t, testIndex(), "sqlserver", "SELECT * FROM SGCPRO.CARGVAR ORDER BY NIS_RAD |", true)
	if has(labels(resp, KindKeyword), "NULLS FIRST") || !has(labels(resp, KindKeyword), "DESC") {
		t.Fatalf("SQL Server: DESC yes, NULLS FIRST no: %v", labels(resp, KindKeyword))
	}
}

func TestSortDirectionIsNotOfferedInsideACall(t *testing.T) {
	resp := complete(t, "SELECT * FROM SGCPRO.CARGVAR ORDER BY COALESCE(NIS_RAD, F_ACTUAL |", true)
	if has(labels(resp, KindKeyword), "NULLS FIRST") {
		t.Fatalf("an argument of a call is not a sort key: %v", labels(resp, KindKeyword))
	}
}

func TestGroupByLeadsWithTheNonAggregatedColumns(t *testing.T) {
	resp := complete(t, "SELECT NIS_RAD, F_ACTUAL, COUNT(*) AS total FROM SGCPRO.CARGVAR GROUP BY |", true)
	if has(labels(resp, KindAlias), "total") {
		t.Fatalf("an aggregate alias cannot be grouped by: %v", labels(resp, KindAlias))
	}
	var list Item
	for _, it := range resp.Items {
		if it.Kind == KindExpand {
			list = it
		}
	}
	if list.Label != "NIS_RAD, F_ACTUAL" || list.Apply != "NIS_RAD, F_ACTUAL" {
		t.Fatalf("expected the whole non-aggregated list, got %+v", list)
	}
	// Con una sola columna proyectada la lista no aporta nada.
	resp = complete(t, "SELECT NIS_RAD, COUNT(*) AS total FROM SGCPRO.CARGVAR GROUP BY |", true)
	if hasKind(resp, KindExpand) {
		t.Fatalf("a one-column list is the column itself: %v", labels(resp, ""))
	}
	if resp.Items[0].Label != "NIS_RAD" {
		t.Fatalf("the projected column leads, got %v", labels(resp, ""))
	}
	// El alias de un agregado SÍ sirve para ordenar.
	resp = complete(t, "SELECT NIS_RAD, COUNT(*) AS total FROM SGCPRO.CARGVAR ORDER BY |", true)
	if !has(labels(resp, KindAlias), "total") {
		t.Fatalf("ORDER BY may use the alias: %v", labels(resp, ""))
	}
	// Ya con una columna escrita, la lista completa no se vuelve a ofrecer.
	resp = complete(t, "SELECT NIS_RAD, F_ACTUAL, COUNT(*) FROM SGCPRO.CARGVAR GROUP BY NIS_RAD, |", true)
	if hasKind(resp, KindExpand) {
		t.Fatalf("the full list is for the start of GROUP BY: %v", labels(resp, ""))
	}
}

func TestClausesThatFollowATable(t *testing.T) {
	cases := []struct {
		sql  string
		want []string
		not  []string
	}{
		{"SELECT * FROM SGCPRO.CARGVAR |", []string{"WHERE", "INNER JOIN", "LEFT JOIN", "GROUP BY", "ORDER BY"}, []string{"SET", "VALUES"}},
		{"SELECT * FROM SGCPRO.CARGVAR c |", []string{"WHERE", "ORDER BY"}, nil},
		{"SELECT * FROM SGCPRO.CARGVAR AS c |", []string{"WHERE"}, nil},
		{"SELECT * FROM SGCPRO.CARGVAR, SGCPRO.BATCH_CTRL_MODULO |", []string{"WHERE"}, nil},
		{"SELECT * FROM SGCPRO.CARGVAR c JOIN SGCPRO.BATCH_CTRL_MODULO b |", []string{"ON", "WHERE"}, nil},
		{"UPDATE SGCPRO.CARGVAR |", []string{"SET", "WHERE"}, []string{"GROUP BY", "INNER JOIN"}},
		{"DELETE FROM SGCPRO.CARGVAR |", []string{"WHERE"}, []string{"SET", "GROUP BY"}},
		{"INSERT INTO SGCPRO.CARGVAR |", []string{"VALUES", "SELECT"}, []string{"WHERE", "GROUP BY"}},
	}
	for _, tc := range cases {
		resp := complete(t, tc.sql, true)
		kws := labels(resp, KindKeyword)
		// Lo predicho va antes que cualquier palabra suelta.
		for _, w := range tc.want {
			pos := -1
			for i, it := range resp.Items {
				if it.Kind == KindKeyword && it.Label == w && it.Score > 800 {
					pos = i
					break
				}
			}
			if pos < 0 {
				t.Fatalf("%q: expected %q among the predicted clauses, got %v", tc.sql, w, kws)
			}
		}
		for _, w := range tc.not {
			for _, it := range resp.Items {
				if it.Kind == KindKeyword && it.Label == w && it.Score > 800 {
					t.Fatalf("%q: %q does not follow here", tc.sql, w)
				}
			}
		}
		// Detrás de una tabla no va otra tabla.
		if hasKind(resp, KindTable) {
			t.Fatalf("%q: a table does not follow a table: %v", tc.sql, labels(resp, KindTable))
		}
	}
}

func TestClauseAfterATableIsListedOnceWhileTyping(t *testing.T) {
	resp := complete(t, "SELECT * FROM SGCPRO.CARGVAR c WH|", false)
	n := 0
	for _, it := range resp.Items {
		if it.Kind == KindKeyword && strings.EqualFold(it.Label, "WHERE") {
			n++
		}
	}
	if n != 1 || strings.ToUpper(resp.Items[0].Label) != "WHERE" {
		t.Fatalf("WHERE once and first, got %v", labels(resp, ""))
	}
}

func TestNoClausePredictionWhenTheTableIsNotTheLastThing(t *testing.T) {
	// Después de un WHERE el cursor ya no está tras una tabla.
	resp := complete(t, "SELECT * FROM SGCPRO.CARGVAR WHERE |", true)
	for _, it := range resp.Items {
		if it.Kind == KindKeyword && it.Label == "INNER JOIN" && it.Score > 800 {
			t.Fatalf("no join prediction inside a WHERE: %+v", it)
		}
	}
	// Dentro de una subconsulta el verbo es el de la subconsulta.
	resp = complete(t, "UPDATE SGCPRO.CARGVAR SET NIS_RAD = (SELECT 1 FROM SGCPRO.BATCH_CTRL_MODULO |", true)
	got := labels(resp, KindKeyword)
	if !has(got, "GROUP BY") || !has(got, "WHERE") {
		t.Fatalf("a subquery after UPDATE is still a SELECT: %v", got)
	}
}

// ---- 5. Atajos -------------------------------------------------------------

func TestSnippetLabelsAreUniquePerDialectAndFullyDescribed(t *testing.T) {
	for _, name := range []string{"", "oracle", "postgres", "sqlite", "sqlserver"} {
		seen := map[string]bool{}
		for _, s := range DialectFor(name).AllSnippets() {
			if seen[s.Label] {
				t.Errorf("%q: snippet %q is defined twice", name, s.Label)
			}
			seen[s.Label] = true
			if s.Detail.ES == "" || s.Detail.EN == "" || s.Body == "" {
				t.Errorf("%q: snippet %q needs ES and EN details and a body", name, s.Label)
			}
		}
	}
}

func snippetBody(dialect, label string) string {
	for _, s := range DialectFor(dialect).AllSnippets() {
		if s.Label == label {
			return s.Body
		}
	}
	return ""
}

func TestNewShortcutsExistInEveryDialect(t *testing.T) {
	for _, name := range []string{"", "oracle", "postgres", "sqlite", "sqlserver"} {
		for _, label := range []string{"selc", "distc", "gb", "coal", "bak", "runsum", "topn", "diff", "dup", "today", "last"} {
			if snippetBody(name, label) == "" {
				t.Errorf("%q: missing shortcut %q", name, label)
			}
		}
	}
}

func TestShortcutsUseEachEnginesSyntax(t *testing.T) {
	checks := []struct{ dialect, label, want string }{
		{"oracle", "today", "TRUNC(SYSDATE)"},
		{"postgres", "today", "CURRENT_DATE + 1"},
		{"sqlite", "today", "date('now')"},
		{"sqlserver", "today", "CAST(GETDATE() AS date)"},
		{"oracle", "last", "FETCH FIRST"},
		{"postgres", "last", "LIMIT"},
		{"sqlite", "last", "LIMIT"},
		{"sqlserver", "last", "TOP"},
		{"oracle", "diff", "MINUS"},
		{"postgres", "diff", "EXCEPT"},
		{"sqlserver", "bak", "INTO"},
		{"postgres", "bak", "CREATE TABLE"},
		{"oracle", "dbms", "DBMS_OUTPUT.PUT_LINE"},
		{"oracle", "exe", "EXECUTE IMMEDIATE"},
		{"oracle", "curx", "FETCH"},
		{"oracle", "nvl", "NVL("},
		{"postgres", "json", "->>"},
		{"postgres", "insr", "RETURNING"},
		{"sqlite", "json", "json_extract"},
		{"sqlserver", "top", "TOP"},
		{"sqlserver", "nolock", "NOLOCK"},
		{"sqlserver", "tryc", "THROW"},
		{"sqlserver", "insid", "SCOPE_IDENTITY"},
	}
	for _, c := range checks {
		if body := snippetBody(c.dialect, c.label); !strings.Contains(body, c.want) {
			t.Errorf("%s/%s: expected %q in %q", c.dialect, c.label, c.want, body)
		}
	}
	// Los exclusivos de un motor no se cuelan en los demás.
	for _, other := range []string{"postgres", "sqlite", "sqlserver", ""} {
		if snippetBody(other, "dbms") != "" {
			t.Errorf("%q must not offer the Oracle-only 'dbms'", other)
		}
	}
	if snippetBody("oracle", "nolock") != "" {
		t.Error("oracle must not offer the SQL Server-only 'nolock'")
	}
}

func TestShortcutsAreOfferedAtTheStartOfAStatement(t *testing.T) {
	resp := complete(t, "selc|", true)
	if !has(labels(resp, KindSnippet), "selc") {
		t.Fatalf("expected the selc shortcut, got %v", labels(resp, ""))
	}
}
