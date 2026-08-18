package sqlintel

import (
	"strconv"
	"strings"

	"mini-tools/backend/db"
)

// Signature help: "what am I passing right now?".
//
// Completion answers a question you ask before you start typing a call. The
// moment the opening parenthesis is in, completion is done and the question
// changes to which argument the cursor is sitting on — and that is the
// question you keep asking for as long as the call is open, which is why it
// is a tooltip that follows the cursor and not a list.
//
// The resolver is the same shape as everything else here: fault tolerant by
// construction (the input is a half-written call), token-based rather than
// grammar-based, and silent when it cannot make sense of the position.

// SignatureRequest is one "what is under the cursor?" query.
type SignatureRequest struct {
	ConnID string `json:"connId"`
	DBType string `json:"dbType"`
	SQL    string `json:"sql"`
	// Offset is a UTF-16 code-unit index, same convention as Request.Offset.
	Offset int `json:"offset"`
}

// SignatureParam is one argument slot as rendered in the tooltip.
type SignatureParam struct {
	// Label is the argument as declared: "p_id IN NUMBER".
	Label string `json:"label"`
	// Optional marks an argument with a default, which the caller may omit.
	Optional bool `json:"optional,omitempty"`
	// Out marks an argument the routine writes back rather than reads.
	Out bool `json:"out,omitempty"`
}

// SignatureInfo is one candidate signature. There is more than one only
// when the name is overloaded.
type SignatureInfo struct {
	// Label is the whole signature, "PKG.PROC(a IN NUMBER, b OUT VARCHAR2)".
	Label string `json:"label"`
	// Name and Return are Label's two ends, sent apart so the tooltip can
	// render the parameter list from Params and highlight the active slot
	// without having to cut Label back up — a split that would go wrong the
	// first time a type spelled its own parentheses, like NUMBER(10,2).
	Name   string `json:"name,omitempty"`
	Return string `json:"return,omitempty"`
	// Doc is the routine's comment where the engine has one.
	Doc    string           `json:"doc,omitempty"`
	Params []SignatureParam `json:"params"`
	// Active is the index into Params the cursor is currently on, or -1
	// when the cursor is past the last declared argument (too many were
	// passed) or the call takes none.
	Active int `json:"active"`
}

// SignatureResponse is what the tooltip renders. An empty Signatures means
// "the cursor is not inside a call I know", which the frontend shows as
// nothing at all rather than as an error.
type SignatureResponse struct {
	Signatures []SignatureInfo `json:"signatures,omitempty"`
	// From and To bracket the call's parentheses as UTF-16 offsets. The
	// frontend anchors the tooltip at From and, more importantly, uses the
	// range to know the tooltip is stale the moment the cursor leaves it —
	// without that it would have to ask Go again on every cursor move.
	From int `json:"from"`
	To   int `json:"to"`
}

// --- formatting -------------------------------------------------------------

// argLabel renders one parameter the way its declaration reads: name, mode,
// type. The mode is dropped for plain IN arguments — it is the default on
// every engine and printing it on every argument turns the signature into
// noise, whereas an OUT is exactly what the caller must not miss.
func argLabel(a db.RoutineArg) string {
	var b strings.Builder
	if a.Name != "" {
		b.WriteString(a.Name)
	}
	if a.Mode != "" && a.Mode != db.ArgModeIn {
		if b.Len() > 0 {
			b.WriteByte(' ')
		}
		b.WriteString(a.Mode)
	}
	if a.DataType != "" {
		if b.Len() > 0 {
			b.WriteByte(' ')
		}
		b.WriteString(a.DataType)
	}
	if b.Len() == 0 {
		return "?"
	}
	return b.String()
}

// Params renders every argument as a tooltip slot.
func (r RoutineEntry) Params() []SignatureParam {
	params := make([]SignatureParam, 0, len(r.Args))
	for _, a := range r.Args {
		params = append(params, SignatureParam{
			Label:    argLabel(a),
			Optional: a.HasDefault,
			Out:      a.Mode == db.ArgModeOut || a.Mode == db.ArgModeInOut,
		})
	}
	return params
}

// ArgList renders just the parenthesised parameter list.
func (r RoutineEntry) ArgList() string {
	labels := make([]string, 0, len(r.Args))
	for _, a := range r.Args {
		labels = append(labels, argLabel(a))
	}
	return "(" + strings.Join(labels, ", ") + ")"
}

// Signature is the tooltip's header: the whole call as declared.
func (r RoutineEntry) Signature() string {
	sig := r.Call + r.ArgList()
	if r.IsFunction && r.ReturnType != "" {
		sig += " → " + r.ReturnType
	}
	return sig
}

// Detail is the completion item's right-hand text. It leaves the name out —
// the label already carries it, and the whole point of the line is the part
// the label cannot show: what this call takes and what it gives back.
func (r RoutineEntry) Detail() string {
	d := r.ArgList()
	if r.IsFunction && r.ReturnType != "" {
		d += " → " + r.ReturnType
	}
	switch {
	case r.Package != "":
		d += " · package " + r.Package
	case r.Schema != "":
		d += " · " + r.Schema
	}
	if r.Overload != "" {
		d += " · sobrecarga " + r.Overload
	}
	return d
}

// Snippet is what gets inserted when the completion is accepted: the call
// with one tab stop per argument, pre-filled with the argument's name so
// the placeholder itself says what goes there.
//
// Every argument gets a stop, optional and OUT ones included. An OUT
// argument still needs a variable passed into it in a PL/SQL call, and
// silently dropping the optional ones would hide from the caller that they
// exist at all — which is the opposite of what this feature is for.
func (r RoutineEntry) Snippet() string { return r.Call + r.ArgSnippet() }

// ArgSnippet is Snippet without the callee name — what the "PKG.|" path
// needs, where the package half is already typed.
func (r RoutineEntry) ArgSnippet() string {
	if len(r.Args) == 0 {
		return "()"
	}
	var b strings.Builder
	b.WriteByte('(')
	for i, a := range r.Args {
		if i > 0 {
			b.WriteString(", ")
		}
		name := a.Name
		if name == "" {
			name = "arg" + strconv.Itoa(i+1)
		}
		b.WriteString("${")
		b.WriteString(strconv.Itoa(i + 1))
		b.WriteByte(':')
		b.WriteString(name)
		b.WriteByte('}')
	}
	b.WriteByte(')')
	return b.String()
}

// Info is the expanded panel body: what the routine is, what it gives back,
// its comment, and one line per argument. It is deliberately more verbose
// than the detail line — the panel only opens for the item the user is
// actually looking at.
func (r RoutineEntry) Info() string {
	var lines []string

	kind := "Procedimiento almacenado"
	if r.IsFunction {
		kind = "Función almacenada"
	}
	if r.Package != "" {
		kind += " · package " + r.Package
	}
	if r.Schema != "" {
		kind += " · " + r.Schema
	}
	if r.Overload != "" {
		kind += " · sobrecarga " + r.Overload
	}
	lines = append(lines, kind)

	if r.Comment != "" {
		lines = append(lines, "", r.Comment)
	}

	if len(r.Args) == 0 {
		lines = append(lines, "", "Sin parámetros.")
	} else {
		lines = append(lines, "", "Parámetros:")
		for _, a := range r.Args {
			line := "  · " + argLabel(a)
			if a.HasDefault {
				line += "  (opcional)"
			}
			lines = append(lines, line)
		}
	}

	if r.IsFunction && r.ReturnType != "" {
		lines = append(lines, "", "Retorna: "+r.ReturnType)
	}

	return strings.Join(lines, "\n")
}

// --- resolution -------------------------------------------------------------

// callSite is the parsed shape of the call the cursor sits inside.
type callSite struct {
	// name is the dotted callee as written: "PROC", "PKG.PROC",
	// "OWNER.PKG.PROC".
	name string
	// openParen and closeParen are rune offsets; closeParen is the end of
	// the text when the call is still unclosed, which is the normal state
	// while typing.
	openParen  int
	closeParen int
	// argIndex is the zero-based comma count between the open paren and the
	// cursor.
	argIndex int
	// namedArg is the parameter named with Oracle's "p_x => value" notation
	// at the cursor's position, empty when positional notation is in use.
	// It takes precedence over argIndex: with named notation the position
	// of an argument says nothing about which parameter it fills.
	namedArg string
}

// Signature resolves the call under the cursor and returns every signature
// that can answer it. Like Complete, it never errors: an unresolvable
// position yields an empty response.
func Signature(idx *SchemaIndex, req SignatureRequest) SignatureResponse {
	text := []rune(req.SQL)
	cursor := RuneOffset(text, req.Offset)

	tokens := Tokenize(text)
	if InLiteralOrComment(tokens, cursor) {
		return SignatureResponse{}
	}

	site, ok := findCallSite(Code(tokens), cursor)
	if !ok {
		return SignatureResponse{}
	}

	resp := SignatureResponse{
		From: UTF16Offset(text, site.openParen),
		To:   UTF16Offset(text, site.closeParen),
	}

	for _, r := range matchRoutines(idx, site.name) {
		resp.Signatures = append(resp.Signatures, buildSignature(r, site))
	}
	if len(resp.Signatures) > 0 {
		return resp
	}

	// No stored routine by that name: it may be one of the dialect's
	// built-ins, which have a signature string but no structured argument
	// list — so the tooltip shows the signature without highlighting a slot.
	if f, ok := DialectFor(req.DBType).Function(site.name); ok {
		label := f.Signature
		if label == "" {
			label = f.Name + "(…)"
		}
		resp.Signatures = append(resp.Signatures, SignatureInfo{
			Label: label, Name: f.Name, Doc: f.Doc, Params: nil, Active: -1,
		})
		return resp
	}

	return SignatureResponse{}
}

// buildSignature renders one routine against the cursor's position in the
// argument list.
func buildSignature(r RoutineEntry, site callSite) SignatureInfo {
	info := SignatureInfo{
		Label:  r.Signature(),
		Name:   r.Call,
		Return: r.ReturnType,
		Doc:    r.Comment,
		Params: r.Params(),
		Active: -1,
	}
	if !r.IsFunction {
		info.Return = ""
	}
	switch {
	case site.namedArg != "":
		for i, a := range r.Args {
			if strings.EqualFold(a.Name, site.namedArg) {
				info.Active = i
				break
			}
		}
	case site.argIndex < len(r.Args):
		info.Active = site.argIndex
	}
	return info
}

// matchRoutines finds every indexed routine a dotted call name can refer to.
// The name is matched from the right — "PKG.PROC" against Package+Name,
// "OWNER.PKG.PROC" additionally against the schema — because the leading
// qualifiers are the optional part of a call, not the identifying one.
func matchRoutines(idx *SchemaIndex, name string) []RoutineEntry {
	if idx == nil || name == "" {
		return nil
	}
	parts := strings.Split(name, ".")
	for i := range parts {
		parts[i] = strings.Trim(strings.TrimSpace(parts[i]), `"[]`+"`")
	}

	var wantSchema, wantPackage string
	wantName := parts[len(parts)-1]
	if len(parts) >= 2 {
		wantPackage = parts[len(parts)-2]
	}
	if len(parts) >= 3 {
		wantSchema = parts[len(parts)-3]
	}

	var out []RoutineEntry
	for _, r := range idx.Routines {
		if !strings.EqualFold(r.Name, wantName) {
			continue
		}
		if wantPackage != "" {
			// A two-part name is ambiguous by nature: "SGCPRO.FACTURAR" is
			// a package member on one connection and a schema-qualified
			// standalone routine on another. Accept either reading rather
			// than picking one and showing nothing when it was the other.
			if !strings.EqualFold(r.Package, wantPackage) && !strings.EqualFold(r.Schema, wantPackage) {
				continue
			}
		}
		if wantSchema != "" && !strings.EqualFold(r.Schema, wantSchema) {
			continue
		}
		out = append(out, r)
	}
	return out
}

// findCallSite walks backwards from the cursor to the parenthesis that is
// still open at that point, then reads the dotted name in front of it.
//
// Walking backwards rather than parsing forwards is what makes this work on
// an unclosed call — "SELECT foo(a, b|" has no closing paren and never will
// until the user types it, so any approach that needs a balanced expression
// would stay silent for exactly as long as the tooltip is wanted.
func findCallSite(tokens []Token, cursor int) (callSite, bool) {
	depth := 0
	commas := 0
	// commaStack remembers the argument count of the enclosing call while
	// descending into a nested one: in "outer(a, inner(x, y|", the commas
	// counted inside inner must not be attributed to outer.
	var commaStack []int

	i := len(tokens) - 1
	for ; i >= 0; i-- {
		t := tokens[i]
		if t.Start >= cursor {
			continue
		}
		if t.Kind != TokenPunct {
			continue
		}
		switch t.Text {
		case ")":
			depth++
			commaStack = append(commaStack, commas)
			commas = 0
		case "(":
			if depth == 0 {
				goto found
			}
			depth--
			if n := len(commaStack); n > 0 {
				commas = commaStack[n-1]
				commaStack = commaStack[:n-1]
			}
		case ",":
			if depth == 0 {
				commas++
			}
		case ";":
			// A statement boundary: whatever parenthesis was open belonged
			// to a previous statement, so there is no call here.
			return callSite{}, false
		}
	}
	return callSite{}, false

found:
	open := tokens[i].Start
	name, ok := readCalleeName(tokens, i-1)
	if !ok {
		return callSite{}, false
	}

	site := callSite{
		name:       name,
		openParen:  open,
		closeParen: matchingClose(tokens, i, cursor),
		argIndex:   commas,
		namedArg:   namedArgAt(tokens, i, cursor),
	}
	return site, true
}

// readCalleeName reads the dotted identifier ending at token index end,
// walking left through "name . name . name". Returns false when what
// precedes the parenthesis is not a name at all — "(a + b)" is a grouping,
// not a call, and has no signature to show.
func readCalleeName(tokens []Token, end int) (string, bool) {
	if end < 0 || !tokens[end].IsWordLike() {
		return "", false
	}
	parts := []string{tokens[end].Value}
	i := end - 1
	for i >= 1 && tokens[i].Kind == TokenPunct && tokens[i].Text == "." && tokens[i-1].IsWordLike() {
		parts = append([]string{tokens[i-1].Value}, parts...)
		i -= 2
	}
	return strings.Join(parts, "."), true
}

// matchingClose finds the rune offset just past the call's closing
// parenthesis, or the end of the scanned text when the call is still open.
func matchingClose(tokens []Token, openIdx, fallback int) int {
	depth := 0
	for i := openIdx; i < len(tokens); i++ {
		t := tokens[i]
		if t.Kind != TokenPunct {
			continue
		}
		switch t.Text {
		case "(":
			depth++
		case ")":
			depth--
			if depth == 0 {
				return t.End
			}
		case ";":
			return t.Start
		}
	}
	// Unclosed: the call extends at least to the cursor, which is all the
	// frontend needs to decide the tooltip is still in range.
	if len(tokens) > 0 {
		last := tokens[len(tokens)-1].End
		if last > fallback {
			return last
		}
	}
	return fallback
}

// namedArgAt reports the parameter named with Oracle's "p_x => value"
// notation in the argument the cursor is in, empty when the current
// argument is positional.
func namedArgAt(tokens []Token, openIdx, cursor int) string {
	depth := 0
	// argStart is the index of the first token of the argument being
	// scanned; it resets at every top-level comma.
	argStart := openIdx + 1

	for i := openIdx; i < len(tokens); i++ {
		t := tokens[i]
		if t.Start >= cursor {
			break
		}
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

	// "name => " is a word followed by '=' '>' — the tokenizer emits
	// punctuation one character at a time, so the arrow is two tokens.
	if argStart+2 < len(tokens) &&
		tokens[argStart].IsWordLike() &&
		tokens[argStart+1].Kind == TokenPunct && tokens[argStart+1].Text == "=" &&
		tokens[argStart+2].Kind == TokenPunct && tokens[argStart+2].Text == ">" {
		return tokens[argStart].Value
	}
	return ""
}
