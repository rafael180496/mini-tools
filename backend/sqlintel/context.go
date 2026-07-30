package sqlintel

import "strings"

// Clause is what the cursor is syntactically expecting. It is the single
// biggest input to ranking: the same prefix means "a table" after FROM and
// "a column" after WHERE, and conflating the two is exactly the bug that
// motivated this engine (a WHERE prefix matching dozens of unrelated
// tables/synonyms, burying the one column that mattered).
type Clause string

const (
	ClauseUnknown Clause = ""
	// ClauseSelect is a projection list: SELECT …, RETURNING ….
	ClauseSelect Clause = "select"
	// ClauseFrom expects a table/view name: FROM, INTO, UPDATE, USING.
	ClauseFrom Clause = "from"
	// ClauseJoin expects a table/view name right after a JOIN keyword. It is
	// kept apart from ClauseFrom so the engine knows an ON condition can be
	// predicted from foreign keys the moment the table is picked.
	ClauseJoin Clause = "join"
	// ClauseOn is a join condition: ON …, USING (…).
	ClauseOn Clause = "on"
	// ClauseWhere is a predicate: WHERE …, AND/OR continuations.
	ClauseWhere Clause = "where"
	ClauseGroupBy Clause = "group"
	ClauseHaving  Clause = "having"
	ClauseOrderBy Clause = "order"
	// ClauseSet is the assignment list of an UPDATE.
	ClauseSet Clause = "set"
	// ClauseInsertColumns is the parenthesised column list of an INSERT.
	ClauseInsertColumns Clause = "insert-columns"
	// ClauseValues is an INSERT's VALUES tuple — neither a table nor a
	// column position. Kept explicit so ranking can prefer functions and
	// bind parameters there instead of pretending it is a column list.
	ClauseValues Clause = "values"
)

// TableRef is one table/view mentioned in a query's FROM/JOIN/INTO/UPDATE,
// with the alias it was given, if any.
type TableRef struct {
	Schema string `json:"schema,omitempty"`
	Name   string `json:"name"`
	Alias  string `json:"alias,omitempty"`
	// Derived marks a subquery given an alias — "FROM (SELECT …) x". Its
	// columns are unknowable from the catalog, so it is tracked only to
	// avoid resolving the alias against a real table of the same name.
	Derived bool `json:"derived,omitempty"`
}

// Label is how the reference is written at the cursor: the alias when there
// is one, otherwise the table name. What a generated JOIN condition must
// use to be valid SQL.
func (r TableRef) Label() string {
	if r.Alias != "" {
		return r.Alias
	}
	return r.Name
}

// Context is everything the cursor position implies, resolved from the
// statement around it.
type Context struct {
	// Clause the cursor sits in.
	Clause Clause
	// Refs are the tables visible at the cursor: the innermost query
	// block's FROM/JOIN plus every enclosing block's (a correlated
	// subquery can reference its outer query's aliases).
	Refs []TableRef
	// DotPrefix is the qualifier typed before a ".", e.g. "u" in "u.na|" or
	// "public" in "public.|". Empty when the cursor is not qualified.
	DotPrefix string
	// DotParent is the qualifier before DotPrefix in a three-part name,
	// e.g. "hr" in "hr.employees.|". Empty otherwise.
	DotParent string
	// Prefix is the partial word being typed at the cursor.
	Prefix string
	// From is the rune offset where Prefix starts — the replacement range's
	// left edge, which the editor needs to apply a completion.
	From int
	// InLiteral is true when the cursor is inside a string literal or a
	// comment, where nothing should be suggested at all.
	InLiteral bool
	// JoinTarget is the table just named after a JOIN whose ON condition is
	// still missing — the trigger for FK-driven join prediction.
	JoinTarget *TableRef
	// LeftRefs are the references that precede JoinTarget in the same query
	// block, i.e. the candidates the join condition can point back at.
	LeftRefs []TableRef
}

// Analyze resolves the cursor's context inside src. cursor is a rune offset.
// It never fails: unparsable input yields a Context with ClauseUnknown,
// which callers treat as "suggest broadly" rather than "suggest nothing".
func Analyze(src []rune, cursor int) Context {
	if cursor < 0 {
		cursor = 0
	}
	if cursor > len(src) {
		cursor = len(src)
	}

	all := Tokenize(src)
	ctx := Context{From: cursor}
	if InLiteralOrComment(all, cursor) {
		ctx.InLiteral = true
		return ctx
	}

	tokens := Code(all)
	lo, hi := statementRange(tokens, cursor)
	stmt := tokens[lo:hi]

	ctx.Prefix, ctx.From = cursorWord(stmt, cursor)
	ctx.DotPrefix, ctx.DotParent = dotQualifiers(stmt, ctx.From)

	an := newAnalyzer(stmt, cursor)
	an.run()

	ctx.Clause = an.cursorClause
	ctx.Refs = an.visibleRefs()
	ctx.JoinTarget, ctx.LeftRefs = an.pendingJoin()
	return ctx
}

// statementRange narrows tokens to the statement containing cursor, so a
// multi-statement script does not leak the previous statement's FROM into
// this one's scope. Splitting is on top-level ";" only, with a BEGIN/END
// depth counter so a PL/SQL block's internal semicolons do not split it —
// the same rule backend/query/splitter.go uses, minus its DECLARE-section
// tracking (a mis-split here costs one imprecise suggestion, not a broken
// execution, so the cheaper approximation is the right trade).
func statementRange(tokens []Token, cursor int) (int, int) {
	lo, hi := 0, len(tokens)
	depth := 0

	for i, t := range tokens {
		switch {
		case t.Is("BEGIN"):
			depth++
		case t.Is("END"):
			// "END IF" / "END LOOP" / "END CASE" close their own construct,
			// not a BEGIN block — only a bare END pops the depth.
			if !followsWith(tokens, i, "IF", "LOOP", "CASE") && depth > 0 {
				depth--
			}
		case t.Kind == TokenPunct && t.Text == ";" && depth == 0:
			if t.End <= cursor {
				lo = i + 1
			} else {
				hi = i
				return lo, hi
			}
		}
	}
	return lo, hi
}

func followsWith(tokens []Token, i int, words ...string) bool {
	if i+1 >= len(tokens) {
		return false
	}
	for _, w := range words {
		if tokens[i+1].Is(w) {
			return true
		}
	}
	return false
}

// cursorWord returns the partial identifier being typed at the cursor and
// the rune offset it starts at. A cursor sitting right after a delimiter
// (space, dot, comma) yields an empty prefix anchored at the cursor.
func cursorWord(tokens []Token, cursor int) (string, int) {
	for _, t := range tokens {
		if !t.IsWordLike() {
			continue
		}
		if cursor > t.Start && cursor <= t.End {
			runes := []rune(t.Text)
			return string(runes[:cursor-t.Start]), t.Start
		}
	}
	return "", cursor
}

// dotQualifiers walks backwards from the replacement start to read a
// qualified name being typed: "u.|" gives ("u", ""), "hr.emp.|" gives
// ("emp", "hr"). Anything else gives empty strings.
func dotQualifiers(tokens []Token, from int) (prefix, parent string) {
	idx := -1
	for i, t := range tokens {
		if t.End <= from {
			idx = i
			continue
		}
		break
	}
	if idx < 0 || tokens[idx].Kind != TokenPunct || tokens[idx].Text != "." {
		return "", ""
	}
	if idx-1 < 0 || !tokens[idx-1].IsWordLike() {
		return "", ""
	}
	prefix = tokens[idx-1].Value
	if idx-3 >= 0 && tokens[idx-2].Kind == TokenPunct && tokens[idx-2].Text == "." && tokens[idx-3].IsWordLike() {
		parent = tokens[idx-3].Value
	}
	return prefix, parent
}

// frame is one nesting level: a query block (SELECT …) or just a
// parenthesised group. Only query blocks own table references; a plain
// group (a function call's arguments, a boolean grouping) inherits its
// parent's scope, which is what makes "WHERE (a AND b|" still see the
// FROM's tables.
type frame struct {
	parent  *frame
	clause  Clause
	refs    []TableRef
	isQuery bool
}

// queryFrame walks up to the frame that owns table references.
func (f *frame) queryFrame() *frame {
	for f.parent != nil && !f.isQuery {
		f = f.parent
	}
	return f
}

type analyzer struct {
	tokens []Token
	cursor int

	root *frame
	cur  *frame

	cursorFrame  *frame
	cursorClause Clause
	recorded     bool

	// joinTarget/joinFrame track the most recent "JOIN <table>" whose ON
	// condition has not been written yet — the state the FK join predictor
	// needs. Like the clause, they are snapshotted AT the cursor rather
	// than read at the end of the pass: for "JOIN c ON |" the condition
	// that follows the cursor is exactly what is being predicted, so
	// letting the rest of the pass clear the target would erase the
	// prediction in the one case it matters.
	joinTarget *TableRef
	joinFrame  *frame

	cursorJoinTarget *TableRef
	cursorJoinFrame  *frame
}

func newAnalyzer(tokens []Token, cursor int) *analyzer {
	root := &frame{isQuery: true}
	return &analyzer{tokens: tokens, cursor: cursor, root: root, cur: root}
}

// run makes a single pass over the whole statement — not just the text
// before the cursor. Parsing past the cursor is what lets "SELECT | FROM
// users" suggest users' columns: the FROM that gives the cursor its scope
// is typed after it. The cursor's own state (clause and owning frame) is
// snapshotted the moment the pass crosses it, then the pass keeps going to
// finish filling that frame's references.
func (a *analyzer) run() {
	i := 0
	for i < len(a.tokens) {
		t := a.tokens[i]

		if !a.recorded && t.Start >= a.cursor {
			a.snapshot()
		}

		switch {
		case t.Kind == TokenPunct && t.Text == "(":
			a.openParen(i)
			i++

		case t.Kind == TokenPunct && t.Text == ")":
			a.closeParen(i)
			i++

		case t.Kind == TokenPunct && t.Text == "=" && a.cur.clause == ClauseOn:
			// The join condition is already being typed by hand; stop
			// predicting one over the top of it.
			a.joinTarget = nil
			i++

		case t.Kind == TokenWord:
			consumed := a.word(i)
			i += consumed

		default:
			i++
		}
	}

	if !a.recorded {
		a.snapshot()
	}
}

func (a *analyzer) snapshot() {
	a.cursorFrame = a.cur
	a.cursorClause = a.cur.clause
	a.cursorJoinTarget = a.joinTarget
	a.cursorJoinFrame = a.joinFrame
	a.recorded = true
}

func (a *analyzer) openParen(i int) {
	child := &frame{parent: a.cur, clause: a.cur.clause}
	// A "(" immediately followed by SELECT/WITH opens a real query block
	// with its own FROM scope; anything else is a grouping that inherits.
	if i+1 < len(a.tokens) && (a.tokens[i+1].Is("SELECT") || a.tokens[i+1].Is("WITH")) {
		child.isQuery = true
		child.clause = ClauseSelect
	} else if a.cur.clause == ClauseFrom || a.cur.clause == ClauseJoin {
		// "INSERT INTO t (col, …" — the table reference is already parsed,
		// so an open paren here starts the column list, not another table.
		child.clause = ClauseInsertColumns
	}
	a.cur = child
}

func (a *analyzer) closeParen(i int) {
	if a.cur.parent == nil {
		return
	}
	closed := a.cur
	a.cur = a.cur.parent
	// "FROM (SELECT …) alias" — the identifier after the closing paren
	// names a derived table, not a catalog table.
	if closed.isQuery && (a.cur.clause == ClauseFrom || a.cur.clause == ClauseJoin) {
		if alias, ok := a.aliasAfter(i); ok {
			q := a.cur.queryFrame()
			q.refs = append(q.refs, TableRef{Name: alias, Alias: alias, Derived: true})
		}
	}
}

// word handles one keyword or identifier, returning how many tokens it
// consumed (a table reference swallows its schema qualifier and alias).
func (a *analyzer) word(i int) int {
	t := a.tokens[i]
	upper := t.Upper()

	if next, ok := a.keyword(i, upper); ok {
		return next
	}

	// Not a keyword: in a table position it names a table, everywhere else
	// it is an expression the analyzer does not need to model.
	if a.cur.clause == ClauseFrom || a.cur.clause == ClauseJoin {
		return a.tableRef(i)
	}
	return 1
}

// keyword applies a clause transition, reporting whether the token was one.
func (a *analyzer) keyword(i int, upper string) (int, bool) {
	switch upper {
	case "SELECT":
		a.cur.clause = ClauseSelect
		a.cur.isQuery = true
	case "FROM", "INTO", "USING":
		a.cur.clause = ClauseFrom
	case "UPDATE", "MERGE":
		a.cur.clause = ClauseFrom
	case "DELETE", "INSERT", "WITH", "AS", "DISTINCT", "ALL":
		// Structural but not scope-changing: DELETE/INSERT are followed by
		// FROM/INTO, which do the real work.
	case "JOIN":
		a.cur.clause = ClauseJoin
	case "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS", "NATURAL", "LATERAL", "APPLY":
		// Join modifiers — the JOIN token right after them sets the clause.
	case "ON":
		// The join target deliberately survives ON: the cursor sitting
		// right after it is the whole point of the prediction. It is
		// dropped once a comparison operator shows the condition is
		// already being written (see run's "=" case).
		a.cur.clause = ClauseOn
	case "WHERE":
		a.cur.clause = ClauseWhere
		a.joinTarget = nil
	case "AND", "OR", "NOT", "IN", "EXISTS", "BETWEEN", "LIKE", "IS", "CASE", "WHEN", "THEN", "ELSE":
		// Predicate continuations keep whatever clause is active — the
		// cursor after "WHERE a AND |" is still in a predicate. Deliberately
		// a no-op rather than a reset.
	case "GROUP":
		a.cur.clause = ClauseGroupBy
	case "ORDER":
		a.cur.clause = ClauseOrderBy
	case "HAVING":
		a.cur.clause = ClauseHaving
	case "BY":
		// Consumed by GROUP/ORDER above.
	case "SET":
		a.cur.clause = ClauseSet
	case "VALUES":
		a.cur.clause = ClauseValues
	case "RETURNING":
		a.cur.clause = ClauseSelect
	case "UNION", "INTERSECT", "EXCEPT", "MINUS":
		// A new query block follows; drop the previous one's clause so the
		// next SELECT starts clean.
		a.cur.clause = ClauseUnknown
	case "LIMIT", "OFFSET", "FETCH":
		a.cur.clause = ClauseUnknown
	default:
		return 0, false
	}
	return 1, true
}

// tableRef parses "[schema.]name [AS] [alias]" starting at i and records it
// on the owning query frame.
func (a *analyzer) tableRef(i int) int {
	consumed := 1
	ref := TableRef{Name: a.tokens[i].Value}

	// schema.table (and catalog.schema.table, where only the last two parts
	// matter to the catalog this engine indexes).
	for i+consumed+1 < len(a.tokens) &&
		a.tokens[i+consumed].Kind == TokenPunct && a.tokens[i+consumed].Text == "." &&
		a.tokens[i+consumed+1].IsWordLike() {
		ref.Schema = ref.Name
		ref.Name = a.tokens[i+consumed+1].Value
		consumed += 2
	}

	if alias, ok := a.aliasAfter(i + consumed - 1); ok {
		ref.Alias = alias
		if a.tokens[i+consumed].Is("AS") {
			consumed++
		}
		consumed++
	}

	q := a.cur.queryFrame()
	q.refs = append(q.refs, ref)

	if a.cur.clause == ClauseJoin {
		joined := ref
		a.joinTarget = &joined
		a.joinFrame = q
	}
	return consumed
}

// aliasAfter reads the alias following the token at index i, if any:
// an optional AS plus a word that is not a keyword continuing the
// statement. Without the keyword guard, "FROM users WHERE …" would read
// WHERE as the alias of users — the same stopword problem the retired
// frontend parser had.
func (a *analyzer) aliasAfter(i int) (string, bool) {
	j := i + 1
	if j < len(a.tokens) && a.tokens[j].Is("AS") {
		j++
	}
	if j >= len(a.tokens) || !a.tokens[j].IsWordLike() {
		return "", false
	}
	if a.tokens[j].Kind == TokenWord && isReserved(a.tokens[j].Upper()) {
		return "", false
	}
	// An alias directly followed by "(" is a function call, not an alias.
	if j+1 < len(a.tokens) && a.tokens[j+1].Kind == TokenPunct && a.tokens[j+1].Text == "(" {
		return "", false
	}
	return a.tokens[j].Value, true
}

// visibleRefs is the cursor frame's references plus every enclosing query
// block's, nearest first — a correlated subquery sees its outer aliases.
func (a *analyzer) visibleRefs() []TableRef {
	frame := a.cursorFrame
	if frame == nil {
		frame = a.root
	}
	var out []TableRef
	seen := map[string]bool{}
	for f := frame.queryFrame(); f != nil; f = f.parent {
		if !f.isQuery {
			continue
		}
		for _, r := range f.refs {
			key := strings.ToLower(r.Schema + "." + r.Name + " " + r.Alias)
			if seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, r)
		}
	}
	return out
}

// pendingJoin returns the table just joined without an ON condition yet,
// together with the references it could join back to.
func (a *analyzer) pendingJoin() (*TableRef, []TableRef) {
	target, frame := a.cursorJoinTarget, a.cursorJoinFrame
	if target == nil || frame == nil {
		return nil, nil
	}
	var left []TableRef
	for _, r := range frame.refs {
		if r.Derived {
			continue
		}
		if strings.EqualFold(r.Name, target.Name) && strings.EqualFold(r.Alias, target.Alias) {
			continue
		}
		left = append(left, r)
	}
	return target, left
}

// reserved is the set of words that can never be a table name or an alias
// in the position the analyzer checks. It is intentionally short: only
// words that actually appear right after a table reference, since a false
// entry here would make a legitimately-named table invisible.
var reserved = map[string]bool{
	"SELECT": true, "FROM": true, "WHERE": true, "JOIN": true, "INNER": true,
	"LEFT": true, "RIGHT": true, "FULL": true, "OUTER": true, "CROSS": true,
	"NATURAL": true, "ON": true, "USING": true, "GROUP": true, "ORDER": true,
	"BY": true, "HAVING": true, "LIMIT": true, "OFFSET": true, "FETCH": true,
	"UNION": true, "INTERSECT": true, "EXCEPT": true, "MINUS": true,
	"SET": true, "VALUES": true, "INTO": true, "AND": true, "OR": true,
	"NOT": true, "AS": true, "WITH": true, "RETURNING": true, "UPDATE": true,
	"DELETE": true, "INSERT": true, "WHEN": true, "THEN": true, "ELSE": true,
	"END": true, "CASE": true, "LATERAL": true, "APPLY": true, "START": true,
	"CONNECT": true, "PARTITION": true, "WINDOW": true, "QUALIFY": true,
}

func isReserved(upper string) bool { return reserved[upper] }
