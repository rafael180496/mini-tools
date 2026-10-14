package sqlintel

import "strings"

// What a PL/SQL block knows about itself.
//
// The catalog answers "which tables and columns exist", but inside an
// anonymous block or a procedure body half of what gets written is neither:
// it is the v_cant declared four lines up, and the p_fecha_batch of the
// procedure being called. Both live only in the buffer — the same situation
// as the CREATE TABLE of script.go — so completion either reads them out of
// the text or offers a column list where the author is typing a variable.
//
// Same rules as the rest of the package: a token walk, not a grammar; a
// missed declaration costs one absent suggestion and nothing else.

// Variable is one name a PL/SQL block declares: a local variable, a
// constant, a cursor, or a parameter of the enclosing procedure/function.
type Variable struct {
	Name string
	Type string
	// Param marks a parameter of the routine whose body the cursor is in,
	// as opposed to something its declaration section declares.
	Param bool
}

// CallSlot is the routine call the cursor sits in, at a position where a
// named argument ("p_x => …") can start.
type CallSlot struct {
	// Name is the callee as written: "PROC", "PKG.PROC", "OWNER.PKG.PROC".
	Name string
	// Used are the parameter names the call already passes by name, lower
	// case — offering them again would produce a call Oracle rejects.
	Used map[string]bool
}

// declSkip are words that open a declaration that is not a variable, or a
// construct this pass does not model. The declaration is skipped up to its
// ";".
var declSkip = map[string]bool{
	"TYPE": true, "SUBTYPE": true, "PRAGMA": true,
}

// plsqlScope is one level of the declaration stack: a DECLARE block, a
// procedure/function, or a package.
type plsqlScope struct {
	vars []Variable
	// inBody is true once the scope's BEGIN has been seen; until then the
	// tokens are its declaration section.
	inBody bool
	// depth counts the BEGIN/END pairs open inside the body, so a nested
	// BEGIN … END does not close the scope that owns it.
	depth int
}

// BlockVariables returns what the PL/SQL blocks enclosing the cursor
// declare, innermost first. Empty outside any block.
func BlockVariables(tokens []Token, cursor int) []Variable {
	var stack []*plsqlScope
	top := func() *plsqlScope {
		if len(stack) == 0 {
			return nil
		}
		return stack[len(stack)-1]
	}
	push := func(vars []Variable) {
		stack = append(stack, &plsqlScope{vars: vars})
	}

	// declStart: the next word begins a declaration (right after DECLARE,
	// IS/AS of a routine header, or a ";" inside a declaration section).
	declStart := false
	// caseDepth counts open CASE constructs, whose END is not a block's.
	caseDepth := 0

	for i := 0; i < len(tokens); i++ {
		t := tokens[i]
		if t.Start >= cursor {
			break
		}

		if t.Kind == TokenPunct {
			if t.Text == ";" {
				if s := top(); s != nil && !s.inBody {
					declStart = true
				}
			}
			continue
		}
		if t.Kind != TokenWord {
			if declStart && t.Kind == TokenQuoted {
				declStart = false
			}
			continue
		}

		switch t.Upper() {
		case "DECLARE":
			push(nil)
			declStart = true
			continue
		case "PROCEDURE", "FUNCTION":
			if next, params, ok := readRoutineHeader(tokens, i, cursor); ok {
				push(params)
				declStart = true
				i = next - 1
				continue
			}
		case "PACKAGE":
			// "PACKAGE [BODY] name IS|AS" opens the package's own
			// declaration section, whose variables every member sees.
			j := i + 1
			if j < len(tokens) && tokens[j].Is("BODY") {
				j++
			}
			if j < len(tokens) && tokens[j].IsWordLike() {
				_, _, after := readQualifiedName(tokens, j)
				if after < len(tokens) && (tokens[after].Is("IS") || tokens[after].Is("AS")) && tokens[after].Start < cursor {
					push(nil)
					declStart = true
					i = after
					continue
				}
			}
		case "BEGIN":
			declStart = false
			switch s := top(); {
			case s == nil:
				stack = append(stack, &plsqlScope{inBody: true, depth: 1})
			case !s.inBody:
				s.inBody = true
				s.depth = 1
			default:
				s.depth++
			}
			continue
		case "CASE":
			caseDepth++
		case "END":
			declStart = false
			if i+1 < len(tokens) && (tokens[i+1].Is("IF") || tokens[i+1].Is("LOOP") || tokens[i+1].Is("CASE")) {
				if tokens[i+1].Is("CASE") && caseDepth > 0 {
					caseDepth--
				}
				i++ // the IF/LOOP/CASE belongs to this END
				continue
			}
			if caseDepth > 0 {
				caseDepth--
				continue
			}
			if s := top(); s != nil {
				if s.inBody {
					s.depth--
					if s.depth <= 0 {
						stack = stack[:len(stack)-1]
					}
				} else {
					// A package without an initialisation section ends with
					// a bare "END name;" straight from its declarations.
					stack = stack[:len(stack)-1]
				}
			}
			if s := top(); s != nil && !s.inBody {
				declStart = true
			}
			continue
		}

		if !declStart {
			continue
		}
		declStart = false
		s := top()
		if s == nil || s.inBody {
			continue
		}
		if declSkip[t.Upper()] {
			continue
		}
		if t.Is("CURSOR") {
			if i+1 < len(tokens) && tokens[i+1].IsWordLike() && tokens[i+1].Start < cursor {
				s.vars = append(s.vars, Variable{Name: tokens[i+1].Value, Type: "CURSOR"})
			}
			continue
		}
		// "name [CONSTANT] type [NOT NULL] [:= | DEFAULT value];"
		if i+1 >= len(tokens) || tokens[i+1].Start >= cursor {
			continue
		}
		s.vars = append(s.vars, Variable{Name: t.Value, Type: declType(tokens, i+1)})
	}

	var out []Variable
	seen := map[string]bool{}
	for k := len(stack) - 1; k >= 0; k-- {
		for _, v := range stack[k].vars {
			lower := strings.ToLower(v.Name)
			if seen[lower] {
				continue
			}
			seen[lower] = true
			out = append(out, v)
		}
	}
	return out
}

// readRoutineHeader parses "PROCEDURE|FUNCTION name [(params)] [RETURN type]
// IS|AS" starting at i. ok is false for a forward declaration or a package
// spec entry (it ends in ";" and has no body), and for a header the cursor
// is still writing.
func readRoutineHeader(tokens []Token, i, cursor int) (next int, params []Variable, ok bool) {
	j := i + 1
	if j >= len(tokens) || !tokens[j].IsWordLike() {
		return 0, nil, false
	}
	_, _, j = readQualifiedName(tokens, j)

	if j < len(tokens) && tokens[j].Kind == TokenPunct && tokens[j].Text == "(" {
		params = readParamList(tokens, j)
		j = skipParens(tokens, j)
	}
	for ; j < len(tokens) && tokens[j].Start < cursor; j++ {
		t := tokens[j]
		if t.Kind == TokenPunct && t.Text == ";" {
			return 0, nil, false
		}
		if t.Is("IS") || t.Is("AS") {
			return j + 1, params, true
		}
	}
	return 0, nil, false
}

// readParamList reads "(p_a IN NUMBER, p_b OUT VARCHAR2 DEFAULT 'x')".
func readParamList(tokens []Token, open int) []Variable {
	var out []Variable
	for _, col := range readColumnList(tokens, open) {
		out = append(out, Variable{Name: col.name, Type: col.dataType, Param: true})
	}
	// readColumnList renders only the word after the name, which for a
	// parameter is its mode. Re-read the type past IN/OUT/NOCOPY.
	for k := range out {
		out[k].Type = paramType(tokens, open, out[k].Name)
	}
	return out
}

// paramType finds a parameter's declared type inside its list, skipping the
// mode words that sit between the name and the type.
func paramType(tokens []Token, open int, name string) string {
	end := skipParens(tokens, open)
	for i := open + 1; i < end; i++ {
		if !strings.EqualFold(tokens[i].Value, name) || !tokens[i].IsWordLike() {
			continue
		}
		j := i + 1
		var mode []string
		for j < end && (tokens[j].Is("IN") || tokens[j].Is("OUT") || tokens[j].Is("NOCOPY")) {
			mode = append(mode, tokens[j].Upper())
			j++
		}
		typ := declType(tokens, j)
		if len(mode) > 0 && !(len(mode) == 1 && mode[0] == "IN") {
			typ = strings.Join(mode, " ") + " " + typ
		}
		return typ
	}
	return ""
}

// declType renders the type of a declaration starting at i, up to whatever
// ends it: ";", ":=", DEFAULT, a "," or ")" of a parameter list.
func declType(tokens []Token, i int) string {
	var parts []Token
	depth := 0
	for ; i < len(tokens) && len(parts) < 12; i++ {
		t := tokens[i]
		// ":=" opens the initial value. Depending on what follows it the
		// tokenizer may hand it over as punctuation or as the start of a
		// bind parameter, so it is matched on the text.
		if depth == 0 && strings.HasPrefix(t.Text, ":") {
			return renderType(parts)
		}
		if t.Kind == TokenPunct {
			switch t.Text {
			case ";":
				return renderType(parts)
			case "(":
				depth++
			case ")":
				if depth == 0 {
					return renderType(parts)
				}
				depth--
			case ",":
				if depth == 0 {
					return renderType(parts)
				}
			}
		}
		if depth == 0 && (t.Is("DEFAULT") || t.Is("CONSTANT")) {
			if t.Is("DEFAULT") {
				return renderType(parts)
			}
			continue
		}
		parts = append(parts, t)
	}
	return renderType(parts)
}

// CallSlotAt reports the routine call the cursor is in when the cursor is
// where an argument begins — right after "(" or ",", or typing the first
// word of the argument. Past that point ("p_x => |", "a + |") the argument's
// name is already settled and nil is returned.
func CallSlotAt(tokens []Token, cursor, from int) *CallSlot {
	site, ok := findCallSite(tokens, cursor)
	if !ok {
		return nil
	}
	openIdx := -1
	for i, t := range tokens {
		if t.Kind == TokenPunct && t.Text == "(" && t.Start == site.openParen {
			openIdx = i
			break
		}
	}
	if openIdx < 0 {
		return nil
	}

	// First token of the argument the cursor is in.
	argStart := openIdx + 1
	depth := 0
	for i := openIdx; i < len(tokens) && tokens[i].Start < cursor; i++ {
		t := tokens[i]
		if t.Kind != TokenPunct {
			continue
		}
		switch t.Text {
		case "(":
			depth++
		case ")":
			depth--
		case ",":
			if depth == 1 {
				argStart = i + 1
			}
		}
	}
	if argStart < len(tokens) && tokens[argStart].Start < from {
		return nil
	}

	used := map[string]bool{}
	depth = 0
	atArg := true
	for i := openIdx; i < len(tokens); i++ {
		t := tokens[i]
		if t.Kind == TokenPunct {
			switch t.Text {
			case "(":
				depth++
				if depth == 1 {
					atArg = true
				}
				continue
			case ")":
				depth--
				if depth == 0 {
					i = len(tokens)
				}
				continue
			case ",":
				if depth == 1 {
					atArg = true
				}
				continue
			case ";":
				i = len(tokens)
				continue
			}
		}
		if depth != 1 || !atArg {
			continue
		}
		atArg = false
		if t.IsWordLike() && i+2 < len(tokens) &&
			tokens[i+1].Kind == TokenPunct && tokens[i+1].Text == "=" &&
			tokens[i+2].Kind == TokenPunct && tokens[i+2].Text == ">" {
			used[strings.ToLower(t.Value)] = true
		}
	}
	return &CallSlot{Name: site.name, Used: used}
}

// renderType joins a declared type back into text: a space only between two
// words ("NOT NULL", "50 CHAR"), none around punctuation, so "%TYPE" and
// "NUMBER(10,2)" read the way they were written.
func renderType(parts []Token) string {
	var b strings.Builder
	prevWord := false
	for _, t := range parts {
		word := t.Kind != TokenPunct
		if word && prevWord {
			b.WriteByte(' ')
		}
		b.WriteString(t.Text)
		prevWord = word
	}
	return b.String()
}
