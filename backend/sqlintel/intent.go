package sqlintel

import "strings"

// SlotKind es lo que el cursor está a punto de escribir cuando la cláusula
// sola no lo dice. La cláusula contesta "¿qué tipo de nombre va acá?"; el
// slot contesta "¿qué sigue a lo que ya escribiste?": tras "WHERE col " va un
// operador, tras "ORDER BY col " un sentido, tras "FROM t " la cláusula
// siguiente. Son posiciones en las que el catálogo no tiene nada que decir y
// aun así hay una respuesta casi segura.
type SlotKind int

const (
	SlotNone SlotKind = iota
	// SlotOperator: "WHERE col |", "AND t.col |", "ON a.x |", "SET col |".
	SlotOperator
	// SlotSortDir: "ORDER BY col |".
	SlotSortDir
	// SlotAfterTable: "FROM t |", "FROM t c |", "UPDATE t |", "INSERT INTO t |".
	SlotAfterTable
	// SlotSetTarget: la columna que se asigna en "UPDATE t SET |" o
	// "SET a = 1, |" (no el valor, que viene después del "=").
	SlotSetTarget
	// SlotGroupStart: "GROUP BY |", el único punto donde cabe la lista entera.
	SlotGroupStart
)

// Slot describe la posición. Column/Qualifier nombran el operando ya
// escrito (SlotOperator, SlotSortDir); Verb es la sentencia que contiene la
// tabla recién escrita (SlotAfterTable).
type Slot struct {
	Kind      SlotKind
	Qualifier string
	Column    string
	Verb      string
}

// nonOperand son las palabras que, escritas justo antes del cursor, NO son un
// nombre de columna aunque el tokenizador las vea como identificadores.
var nonOperand = map[string]bool{
	"AND": true, "OR": true, "NOT": true, "IN": true, "IS": true, "LIKE": true,
	"BETWEEN": true, "NULL": true, "EXISTS": true, "CASE": true, "WHEN": true,
	"THEN": true, "ELSE": true, "END": true, "ASC": true, "DESC": true,
	"ANY": true, "ALL": true, "SOME": true, "DISTINCT": true, "SET": true,
	"BY": true, "FIRST": true, "LAST": true, "NULLS": true,
}

// isOperand reports whether t could be the column (or alias) of a condition.
func isOperand(t Token) bool {
	if !t.IsWordLike() {
		return false
	}
	if t.Kind == TokenWord {
		up := t.Upper()
		return !isReserved(up) && !nonOperand[up]
	}
	return true
}

func isPunct(t Token, s string) bool { return t.Kind == TokenPunct && t.Text == s }

// lastBefore devuelve el índice del último token que termina antes de from,
// es decir, el token detrás del cual está el cursor. La palabra que se está
// escribiendo empieza en from y por eso queda fuera.
func lastBefore(stmt []Token, from int) int {
	last := -1
	for i, t := range stmt {
		if t.End > from {
			break
		}
		last = i
	}
	return last
}

// skipName retrocede sobre un nombre con puntos ("a.b.c") y devuelve el
// índice de su primer token.
func skipName(stmt []Token, p int) int {
	i := p
	for i-2 >= 0 && isPunct(stmt[i-1], ".") && stmt[i-2].IsWordLike() {
		i -= 2
	}
	return i
}

// parenDepth cuenta los paréntesis abiertos entre el inicio y stmt[upTo)
// (sin incluir upTo).
func parenDepth(stmt []Token, upTo int) int {
	depth := 0
	for i := 0; i < upTo && i < len(stmt); i++ {
		switch {
		case isPunct(stmt[i], "("):
			depth++
		case isPunct(stmt[i], ")"):
			if depth > 0 {
				depth--
			}
		}
	}
	return depth
}

// isBetweenAnd reporta si el AND de stmt[andIdx] es el del "x BETWEEN a AND
// b": ahí lo que sigue es el segundo extremo, no una condición nueva.
func isBetweenAnd(stmt []Token, andIdx int) bool {
	depth := 0
	for j := andIdx - 1; j >= 0; j-- {
		t := stmt[j]
		switch {
		case isPunct(t, ")"):
			depth++
			continue
		case isPunct(t, "("):
			if depth == 0 {
				return false
			}
			depth--
			continue
		}
		if depth > 0 || t.Kind != TokenWord {
			continue
		}
		switch t.Upper() {
		case "BETWEEN":
			return true
		case "AND", "OR", "WHERE", "ON", "HAVING", "WHEN", "SET", "SELECT", "THEN":
			return false
		}
	}
	return false
}

// conditionLead reporta si stmt[b] abre una condición nueva, de modo que la
// palabra que le sigue es el operando izquierdo de un predicado.
func conditionLead(stmt []Token, b int) bool {
	t := stmt[b]
	switch {
	case t.Kind == TokenWord:
		switch t.Upper() {
		case "WHERE", "OR", "NOT", "ON", "HAVING", "WHEN":
			return true
		case "AND":
			return !isBetweenAnd(stmt, b)
		}
	case isPunct(t, "("):
		// "WHERE (col |" abre una condición; "COUNT(col |" no.
		if b == 0 {
			return true
		}
		prev := stmt[b-1]
		if isPunct(prev, "(") {
			return true
		}
		if prev.Kind == TokenWord {
			switch prev.Upper() {
			case "WHERE", "AND", "OR", "NOT", "ON", "HAVING", "WHEN":
				return true
			}
		}
	}
	return false
}

// tableLead reporta si stmt[b] deja al cursor en posición de tabla.
func tableLead(stmt []Token, b int) bool {
	t := stmt[b]
	if isPunct(t, ",") {
		return true
	}
	if t.Kind != TokenWord {
		return false
	}
	switch t.Upper() {
	case "FROM", "INTO", "UPDATE", "JOIN", "USING":
		return true
	}
	return false
}

// verbAt devuelve la sentencia que gobierna la posición p: el último
// SELECT/UPDATE/DELETE/INSERT/MERGE escrito en ese nivel de paréntesis. Un
// "UPDATE" que ya pasó por su SET es "UPDATE_SET": ahí solo cabe un WHERE.
func verbAt(stmt []Token, p int) string {
	depth := 0
	verbs := map[int]string{}
	for i := 0; i <= p && i < len(stmt); i++ {
		t := stmt[i]
		switch {
		case isPunct(t, "("):
			depth++
			delete(verbs, depth)
		case isPunct(t, ")"):
			if depth > 0 {
				delete(verbs, depth)
				depth--
			}
		case t.Kind == TokenWord:
			switch up := t.Upper(); up {
			case "SELECT", "UPDATE", "DELETE", "INSERT", "MERGE":
				verbs[depth] = up
			case "SET":
				if verbs[depth] == "UPDATE" {
					verbs[depth] = "UPDATE_SET"
				}
			}
		}
	}
	if v := verbs[depth]; v != "" {
		return v
	}
	return "SELECT"
}

// detectSlot lee lo que hay detrás del cursor y dice qué clase de token se
// espera. Trabaja sobre tokens de la sentencia ya recortada: no re-parsea,
// solo mira el vecindario inmediato del cursor.
func detectSlot(stmt []Token, ctx Context) Slot {
	if ctx.InLiteral || ctx.DotPrefix != "" {
		return Slot{}
	}
	p := lastBefore(stmt, ctx.From)
	if p < 0 {
		return Slot{}
	}
	prev := stmt[p]

	switch ctx.Clause {
	case ClauseWhere, ClauseOn, ClauseHaving:
		if !isOperand(prev) {
			return Slot{}
		}
		start := skipName(stmt, p)
		if start-1 >= 0 && conditionLead(stmt, start-1) {
			return operandSlot(stmt, start, p, SlotOperator)
		}

	case ClauseSet:
		if prev.Is("SET") || (isPunct(prev, ",") && parenDepth(stmt, p) == 0) {
			return Slot{Kind: SlotSetTarget}
		}
		if !isOperand(prev) {
			return Slot{}
		}
		start := skipName(stmt, p)
		b := start - 1
		if b >= 0 && (stmt[b].Is("SET") || (isPunct(stmt[b], ",") && parenDepth(stmt, b) == 0)) {
			return operandSlot(stmt, start, p, SlotOperator)
		}

	case ClauseOrderBy:
		if !isOperand(prev) && prev.Kind != TokenNumber {
			return Slot{}
		}
		start := skipName(stmt, p)
		b := start - 1
		if b >= 0 && (stmt[b].Is("BY") || (isPunct(stmt[b], ",") && parenDepth(stmt, b) == 0)) {
			return operandSlot(stmt, start, p, SlotSortDir)
		}

	case ClauseGroupBy:
		if prev.Is("BY") {
			return Slot{Kind: SlotGroupStart}
		}

	case ClauseFrom, ClauseJoin:
		if verb, ok := afterTable(stmt, p); ok {
			return Slot{Kind: SlotAfterTable, Verb: verb}
		}
	}
	return Slot{}
}

// operandSlot arma el slot a partir del operando stmt[start..p].
func operandSlot(stmt []Token, start, p int, kind SlotKind) Slot {
	s := Slot{Kind: kind, Column: stmt[p].Value}
	if p-2 >= start && isPunct(stmt[p-1], ".") {
		s.Qualifier = stmt[p-2].Value
	}
	return s
}

// afterTable reporta si el cursor está justo después de una tabla (o de su
// alias) en posición de FROM/JOIN/INTO/UPDATE, y qué sentencia es.
func afterTable(stmt []Token, p int) (string, bool) {
	if !isOperand(stmt[p]) {
		return "", false
	}
	start := skipName(stmt, p)
	b := start - 1
	if b < 0 {
		return "", false
	}
	if tableLead(stmt, b) {
		return verbAt(stmt, p), true
	}
	// "FROM t c |" / "FROM t AS c |": el token es el alias y la tabla va antes.
	if stmt[b].Is("AS") {
		b--
	}
	if b >= 0 && isOperand(stmt[b]) {
		s2 := skipName(stmt, b)
		if s2-1 >= 0 && tableLead(stmt, s2-1) {
			return verbAt(stmt, p), true
		}
	}
	return "", false
}

// listedColumns recoge los nombres que la lista del cursor ya escribió:
// las columnas de "INSERT INTO t (a, b, |)" o los destinos de asignación de
// "SET a = 1, b = 2, |". Sirve para no volver a ofrecer una columna que ya
// está puesta — repetirla es un error en las dos construcciones.
func listedColumns(stmt []Token, ctx Context) map[string]bool {
	switch ctx.Clause {
	case ClauseInsertColumns:
		return listedInsertColumns(stmt, ctx)
	case ClauseSet:
		return listedSetTargets(stmt, ctx)
	}
	return nil
}

func listedInsertColumns(stmt []Token, ctx Context) map[string]bool {
	var stack []int
	for i, t := range stmt {
		if t.End > ctx.From {
			break
		}
		switch {
		case isPunct(t, "("):
			stack = append(stack, i)
		case isPunct(t, ")"):
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
		}
	}
	if len(stack) == 0 {
		return nil
	}
	out := map[string]bool{}
	depth := 0
	for i := stack[len(stack)-1] + 1; i < len(stmt); i++ {
		t := stmt[i]
		switch {
		case isPunct(t, "("):
			depth++
		case isPunct(t, ")"):
			if depth == 0 {
				return out
			}
			depth--
		case depth == 0 && t.IsWordLike() && t.Start != ctx.From &&
			(isPunct(stmt[i-1], "(") || isPunct(stmt[i-1], ",")):
			out[strings.ToLower(t.Value)] = true
		}
	}
	return out
}

// setEnders cierran la lista de asignaciones de un SET.
var setEnders = map[string]bool{
	"WHERE": true, "FROM": true, "RETURNING": true, "RETURN": true, "WHEN": true, "ORDER": true,
}

func listedSetTargets(stmt []Token, ctx Context) map[string]bool {
	cursorDepth := 0
	for _, t := range stmt {
		if t.End > ctx.From {
			break
		}
		switch {
		case isPunct(t, "("):
			cursorDepth++
		case isPunct(t, ")"):
			if cursorDepth > 0 {
				cursorDepth--
			}
		}
	}
	// El SET más reciente de este nivel que no terminó antes del cursor.
	setIdx, depth := -1, 0
	for i, t := range stmt {
		if t.Start >= ctx.From {
			break
		}
		switch {
		case isPunct(t, "("):
			depth++
		case isPunct(t, ")"):
			if depth > 0 {
				depth--
			}
		case depth == cursorDepth && t.Kind == TokenWord:
			if t.Upper() == "SET" {
				setIdx = i
			} else if setEnders[t.Upper()] {
				setIdx = -1
			}
		}
	}
	if setIdx < 0 {
		return nil
	}
	out := map[string]bool{}
	depth = 0
	for i := setIdx + 1; i < len(stmt); i++ {
		t := stmt[i]
		switch {
		case isPunct(t, "("):
			depth++
			continue
		case isPunct(t, ")"):
			if depth == 0 {
				return out
			}
			depth--
			continue
		case isPunct(t, ";"):
			return out
		}
		if depth > 0 {
			continue
		}
		if t.Kind == TokenWord && setEnders[t.Upper()] {
			return out
		}
		// "col =" con un SET o una coma detrás del nombre (calificado o no).
		if t.IsWordLike() && t.Start != ctx.From && i+1 < len(stmt) && isPunct(stmt[i+1], "=") {
			start := skipName(stmt, i)
			if start-1 >= 0 && (stmt[start-1].Is("SET") || isPunct(stmt[start-1], ",")) {
				out[strings.ToLower(t.Value)] = true
			}
		}
	}
	return out
}
