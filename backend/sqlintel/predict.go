package sqlintel

import (
	"regexp"
	"strings"

	"mini-tools/backend/i18n"
)

// Este archivo es la predicción por posición: lo que el motor sugiere porque
// sabe QUÉ sigue, no porque algo del catálogo coincida con lo tecleado. Las
// piezas son chicas y cada una apoya en lo que Analyze ya resolvió (cláusula,
// alcance, Slot); ninguna re-parsea.

// predicted adds a keyword the position itself asked for. It is remembered so
// the generic keyword sweep does not list the same word a second time, at a
// lower score, right below it.
func (c *collector) predicted(label, detail, apply string, bonus int) {
	if c.predictedWords == nil {
		c.predictedWords = map[string]bool{}
	}
	c.predictedWords[strings.ToLower(label)] = true
	c.add(label, KindKeyword, detail, apply, "", bonus)
}

// kw escribe una palabra clave como el resto del documento: en minúsculas si
// el script está escrito así (ver keywordsInLowerCase).
func (c *collector) kw(s string) string {
	if c.lowerKeywords {
		return strings.ToLower(s)
	}
	return s
}

// aggregateCall detects an aggregate function call inside an expression text.
var aggregateCall = regexp.MustCompile(`(?i)\b(?:count|sum|avg|min|max|listagg|string_agg|array_agg|group_concat|stddev|variance|median)\s*\(`)

// isAggregateExpr reports whether the expression (the text an alias renames)
// aggregates. GROUP BY cannot name such an alias.
func isAggregateExpr(expr string) bool { return aggregateCall.MatchString(expr) }

// targetColumns answers the two positions whose candidates are exactly the
// columns of ONE table: the column list of an INSERT and the target of a SET
// assignment. It reports false — leaving the general path to run — when the
// table does not resolve, so the engine never offers less than it could.
//
// Columns already written in the same list are left out: repeating one is an
// error in both constructs (ORA-00957, "column specified more than once").
func (c *collector) targetColumns(idx *SchemaIndex, ctx Context) bool {
	if idx == nil || ctx.DotPrefix != "" {
		return false
	}
	if ctx.Clause != ClauseInsertColumns && ctx.Slot.Kind != SlotSetTarget {
		return false
	}
	for _, ref := range ctx.Refs {
		t, ok := idx.Resolve(ref)
		if !ok || len(t.Columns) == 0 {
			continue
		}
		c.columnsOfExcept(t, 500, ctx.Listed)
		return true
	}
	return false
}

// slotItems adds what the cursor position itself asks for.
func (c *collector) slotItems(idx *SchemaIndex, ctx Context) {
	switch ctx.Slot.Kind {
	case SlotOperator:
		c.operators(idx, ctx)
	case SlotSortDir:
		c.sortDirections()
	}
}

// opDef is one comparison offered after a column.
type opDef struct {
	label  string
	apply  string
	detail i18n.Msg
}

var (
	opEq      = opDef{"=", "= ", i18n.Msg{ES: "igual a", EN: "equal to"}}
	opNe      = opDef{"<>", "<> ", i18n.Msg{ES: "distinto de", EN: "not equal to"}}
	opGt      = opDef{">", "> ", i18n.Msg{ES: "mayor que", EN: "greater than"}}
	opLt      = opDef{"<", "< ", i18n.Msg{ES: "menor que", EN: "less than"}}
	opGe      = opDef{">=", ">= ", i18n.Msg{ES: "mayor o igual que", EN: "greater than or equal to"}}
	opLe      = opDef{"<=", "<= ", i18n.Msg{ES: "menor o igual que", EN: "less than or equal to"}}
	opIn      = opDef{"IN", "IN (${1})", i18n.Msg{ES: "IN (valor1, valor2)", EN: "IN (value1, value2)"}}
	opNotIn   = opDef{"NOT IN", "NOT IN (${1})", i18n.Msg{ES: "NOT IN (valor1, valor2)", EN: "NOT IN (value1, value2)"}}
	opLike    = opDef{"LIKE", "LIKE '%${1}%'", i18n.Msg{ES: "contiene el texto", EN: "contains the text"}}
	opBetween = opDef{"BETWEEN", "BETWEEN ${1:desde} AND ${2:hasta}", i18n.Msg{ES: "entre dos valores", EN: "between two values"}}
	opIsNull  = opDef{"IS NULL", "IS NULL", i18n.Msg{ES: "sin valor", EN: "has no value"}}
	opNotNull = opDef{"IS NOT NULL", "IS NOT NULL", i18n.Msg{ES: "con valor", EN: "has a value"}}
)

// typeFamily buckets a catalog type name into the three families the
// operator order cares about. Matching by substring on purpose: the catalog
// spells types per engine ("VARCHAR2(40)", "character varying", "nvarchar",
// "TIMESTAMP(6) WITH TIME ZONE").
func typeFamily(dataType string) string {
	t := strings.ToLower(dataType)
	switch {
	case t == "":
		return ""
	case strings.Contains(t, "char"), strings.Contains(t, "text"), strings.Contains(t, "clob"), strings.Contains(t, "string"):
		return "text"
	case strings.Contains(t, "date"), strings.Contains(t, "time"), strings.Contains(t, "interval"):
		return "date"
	case strings.Contains(t, "int"), strings.Contains(t, "num"), strings.Contains(t, "dec"),
		strings.Contains(t, "float"), strings.Contains(t, "double"), strings.Contains(t, "real"),
		strings.Contains(t, "money"), strings.Contains(t, "serial"):
		return "number"
	}
	return ""
}

// operatorOrder is the order in which each family wants its comparisons: a
// text column is searched with LIKE, a date with a range, a number with
// either; an unknown type gets the generic order.
func operatorOrder(family string) []opDef {
	switch family {
	case "text":
		return []opDef{opEq, opLike, opIn, opNe, opIsNull, opNotNull, opNotIn, opBetween}
	case "number":
		return []opDef{opEq, opIn, opGe, opLe, opBetween, opNe, opGt, opLt, opIsNull, opNotNull, opNotIn}
	case "date":
		return []opDef{opEq, opBetween, opGe, opLe, opIsNull, opNotNull, opGt, opLt, opIn}
	}
	return []opDef{opEq, opIn, opIsNull, opLike, opBetween, opNe, opNotNull, opGe, opLe, opNotIn}
}

// operandColumn resolves the column written before the cursor. known is
// false when the scope cannot say (nothing resolved, unknown qualifier), in
// which case the operators are still offered; found is false when the scope
// DID resolve and the name is not in it — a function, a keyword, a variable —
// and an operator list there would be a guess.
func operandColumn(idx *SchemaIndex, ctx Context) (col *ColumnEntry, known, found bool) {
	if idx == nil {
		return nil, false, true
	}
	name := ctx.Slot.Column
	if q := ctx.Slot.Qualifier; q != "" {
		table, _ := idx.ResolveQualifier(q, ctx.Refs)
		if table == nil {
			return nil, false, true
		}
		if c, ok := table.Column(name); ok {
			return c, true, true
		}
		return nil, true, false
	}
	for _, ref := range ctx.Refs {
		t, ok := idx.Resolve(ref)
		if !ok || len(t.Columns) == 0 {
			continue
		}
		known = true
		if c, ok := t.Column(name); ok {
			return c, true, true
		}
	}
	if !known {
		return nil, false, true
	}
	// An alias of the SELECT list is a legal operand in HAVING.
	for _, p := range ctx.Projected {
		if strings.EqualFold(p.Name, name) {
			return nil, true, true
		}
	}
	return nil, true, false
}

// operators offers the comparisons that follow a column in a condition. In a
// SET assignment the only thing that follows the target is "=".
func (c *collector) operators(idx *SchemaIndex, ctx Context) {
	col, _, found := operandColumn(idx, ctx)
	if !found {
		return
	}
	var ops []opDef
	if ctx.Clause == ClauseSet {
		ops = []opDef{opEq}
	} else {
		family := ""
		if col != nil {
			family = typeFamily(col.DataType)
		}
		ops = operatorOrder(family)
	}
	for i, op := range ops {
		bonus := 1000 - 20*i
		// A NOT NULL column is never null: the test stays available (the
		// catalog's nullability is not always reliable) but sinks.
		if col != nil && !col.Nullable && (op.label == "IS NULL" || op.label == "IS NOT NULL") {
			bonus -= 400
		}
		label := c.kw(op.label)
		c.predicted(label, op.detail.Text(), c.kw(op.apply), bonus)
	}
}

// sortDirections offers ASC / DESC (and NULLS FIRST / LAST where the engine
// has them) after a sort key.
func (c *collector) sortDirections() {
	c.predicted(c.kw("DESC"), i18n.T(i18n.Msg{ES: "orden descendente", EN: "descending order"}), "", 1000)
	c.predicted(c.kw("ASC"), i18n.T(i18n.Msg{ES: "orden ascendente (el predeterminado)", EN: "ascending order (the default)"}), "", 980)
	if c.dialect == nil {
		return
	}
	switch c.dialect.Name {
	case "oracle", "postgres", "sqlite":
		c.predicted(c.kw("NULLS FIRST"), i18n.T(i18n.Msg{ES: "los nulos primero", EN: "nulls first"}), "", 940)
		c.predicted(c.kw("NULLS LAST"), i18n.T(i18n.Msg{ES: "los nulos al final", EN: "nulls last"}), "", 930)
	}
}

// nextDef is one clause offered right after a table.
type nextDef struct {
	label  string
	apply  string
	detail i18n.Msg
}

var (
	nextOn      = nextDef{"ON", "ON ", i18n.Msg{ES: "condición del JOIN", EN: "JOIN condition"}}
	nextWhere   = nextDef{"WHERE", "WHERE ", i18n.Msg{ES: "filtrar filas", EN: "filter rows"}}
	nextJoin    = nextDef{"INNER JOIN", "INNER JOIN ", i18n.Msg{ES: "unir con otra tabla", EN: "join another table"}}
	nextLeft    = nextDef{"LEFT JOIN", "LEFT JOIN ", i18n.Msg{ES: "unir conservando todas las filas de la izquierda", EN: "join keeping every left row"}}
	nextGroup   = nextDef{"GROUP BY", "GROUP BY ", i18n.Msg{ES: "agrupar filas", EN: "group rows"}}
	nextOrder   = nextDef{"ORDER BY", "ORDER BY ", i18n.Msg{ES: "ordenar el resultado", EN: "sort the result"}}
	nextSet     = nextDef{"SET", "SET ", i18n.Msg{ES: "columnas a modificar", EN: "columns to change"}}
	nextValues  = nextDef{"VALUES", "VALUES (${1})", i18n.Msg{ES: "valores a insertar", EN: "values to insert"}}
	nextSelect  = nextDef{"SELECT", "SELECT ", i18n.Msg{ES: "insertar el resultado de una consulta", EN: "insert a query's result"}}
	nextNoItems = []nextDef(nil)
)

// nextClauses offers what normally follows a table: the alias slot is the
// aliasHint's, and this is the rest of it — the clause that continues the
// statement, chosen by which statement it is.
func (c *collector) nextClauses(ctx Context) {
	if ctx.Slot.Kind != SlotAfterTable {
		return
	}
	var defs []nextDef
	switch ctx.Slot.Verb {
	case "UPDATE":
		defs = []nextDef{nextSet, nextWhere}
	case "UPDATE_SET", "DELETE":
		defs = []nextDef{nextWhere}
	case "INSERT":
		defs = []nextDef{nextValues, nextSelect}
	case "MERGE":
		defs = nextNoItems
	default:
		defs = []nextDef{nextWhere, nextJoin, nextLeft, nextGroup, nextOrder}
		if ctx.JoinTarget != nil {
			defs = append([]nextDef{nextOn}, defs...)
		}
	}
	// Just under the alias hint (900): with a table just written the alias is
	// still the first thing a person types.
	for i, d := range defs {
		c.predicted(c.kw(d.label), d.detail.Text(), c.kw(d.apply), 880-10*i)
	}
}

// groupByList offers the whole GROUP BY list at once: every column the SELECT
// projects without aggregating. SQL requires exactly that set, so after
// "GROUP BY " the right answer is usually all of them, not the first.
func (c *collector) groupByList(ctx Context) {
	if ctx.Slot.Kind != SlotGroupStart {
		return
	}
	var cols []string
	for _, p := range ctx.Projected {
		if !p.IsAlias {
			cols = append(cols, p.Name)
		}
	}
	// One column is already the boosted first item; the list is worth an item
	// of its own only when it saves typing.
	if len(cols) < 2 {
		return
	}
	list := strings.Join(cols, ", ")
	c.add(list, KindExpand, i18n.T(i18n.Msg{ES: "columnas del SELECT sin agregar", EN: "non-aggregated SELECT columns"}), list,
		i18n.T(i18n.Msg{ES: "Todas las columnas que el SELECT muestra sin función de agregado: el conjunto que GROUP BY exige.", EN: "Every column the SELECT shows without an aggregate: the set GROUP BY requires."}),
		700)
}
