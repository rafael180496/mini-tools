package sqlintel

import (
	"sort"
	"strconv"
	"strings"
)

// Item kinds. The frontend maps these onto CodeMirror's completion icons,
// so the set is a contract with frontend/src/codemirror/sqlIntel.ts.
const (
	KindTable    = "table"
	KindColumn   = "column"
	KindSchema   = "schema"
	KindFunction = "function"
	KindRoutine  = "routine"
	KindKeyword  = "keyword"
	KindSnippet  = "snippet"
	KindJoin     = "join"
)

// Request is one completion query from the editor.
type Request struct {
	ConnID string `json:"connId"`
	DBType string `json:"dbType"`
	// SQL is the full document text. Sending the whole buffer rather than a
	// slice keeps the frontend from having to know where statements begin —
	// the engine already isolates the statement around the cursor, and the
	// text travels in the direction (frontend → Go) that is never the
	// bottleneck. The reply is where bytes are worth counting.
	SQL string `json:"sql"`
	// Offset is the cursor position as a UTF-16 code-unit index, which is
	// what CodeMirror positions are. See offsets.go.
	Offset int `json:"offset"`
	// Explicit is true when the user pressed the completion shortcut rather
	// than just typing — it widens the results (an empty prefix still lists
	// the scope instead of returning nothing).
	Explicit bool `json:"explicit"`
	// Limit caps the returned items; 0 means defaultLimit.
	Limit int `json:"limit"`
}

// Item is one suggestion. The JSON keys are deliberately one letter: a
// single reply can carry a few hundred items, and the field names would
// otherwise be most of the payload crossing the Wails bridge. Long-form
// text (Info) is omitted unless it adds something the detail line does not.
type Item struct {
	Label  string `json:"l"`
	Kind   string `json:"k"`
	Detail string `json:"d,omitempty"`
	// Apply is what to insert when it differs from Label — a snippet
	// template with ${1:…} placeholders, or a function call with its
	// parentheses. Empty means "insert Label verbatim".
	Apply string `json:"a,omitempty"`
	Info  string `json:"i,omitempty"`
	Score int    `json:"s"`
}

// Response is what the editor renders.
type Response struct {
	// From is where the replacement range starts, as a UTF-16 offset the
	// editor can use directly.
	From  int    `json:"from"`
	Items []Item `json:"items"`
	// Inline is the ghost-text continuation shown in grey ahead of the
	// cursor, accepted with Tab. Empty when there is nothing confident
	// enough to predict.
	Inline string `json:"inline,omitempty"`
	// Clause is what the cursor was resolved to be in — surfaced for the
	// status line and for debugging a surprising suggestion list.
	Clause string `json:"clause,omitempty"`
	// Truncated reports that more items matched than Limit allowed.
	Truncated bool `json:"truncated,omitempty"`
	// Indexing is true when the connection's schema index has not been
	// built yet, so the frontend can say "cargando esquema…" instead of
	// letting the user think the schema is simply empty. Keyword, function
	// and snippet suggestions are still returned in that state.
	Indexing bool `json:"indexing,omitempty"`
}

const defaultLimit = 60

// UsageFunc reports how many times an item was accepted in this session,
// feeding the frequency component of the ranking.
type UsageFunc func(kind, name string) int

// Complete resolves the cursor context and ranks everything that can go
// there. It never returns an error: a request the engine cannot make sense
// of yields an empty item list, which the editor renders as "no
// suggestions" — the correct outcome for a cursor inside a string literal
// or a half-typed expression nothing matches.
func Complete(idx *SchemaIndex, req Request, usage UsageFunc) Response {
	if usage == nil {
		usage = func(string, string) int { return 0 }
	}
	limit := req.Limit
	if limit <= 0 {
		limit = defaultLimit
	}

	text := []rune(req.SQL)
	cursor := RuneOffset(text, req.Offset)
	ctx := Analyze(text, cursor)

	resp := Response{
		From:     UTF16Offset(text, ctx.From),
		Clause:   string(ctx.Clause),
		Indexing: idx.Empty(),
	}
	if ctx.InLiteral {
		return resp
	}

	dialect := DialectFor(req.DBType)
	prefix := strings.ToLower(ctx.Prefix)

	// An empty prefix on an implicit trigger would dump the entire scope on
	// every keystroke; only an explicit request (Ctrl-Space) or a qualified
	// position ("u.") is allowed to list everything.
	if prefix == "" && !req.Explicit && ctx.DotPrefix == "" && ctx.JoinTarget == nil {
		return resp
	}

	c := &collector{prefix: prefix, usage: usage, clause: ctx.Clause}

	if ctx.DotPrefix != "" {
		c.qualified(idx, ctx)
	} else {
		c.unqualified(idx, dialect, ctx)
	}

	c.joins(idx, ctx)

	sort.SliceStable(c.items, func(i, j int) bool {
		if c.items[i].Score != c.items[j].Score {
			return c.items[i].Score > c.items[j].Score
		}
		return c.items[i].Label < c.items[j].Label
	})

	if len(c.items) > limit {
		c.items = c.items[:limit]
		resp.Truncated = true
	}
	resp.Items = c.items
	resp.Inline = inlineSuggestion(idx, ctx, c.items)
	return resp
}

// InlineOnly answers just the ghost-text question. It exists as a separate
// entry point because the ghost-text plugin fires on cursor movement, not
// only while the completion popup is open, and it has no use for the item
// list — returning a bare string keeps that (frequent) call's payload at a
// few bytes instead of a few kilobytes.
func InlineOnly(idx *SchemaIndex, req Request) string {
	text := []rune(req.SQL)
	cursor := RuneOffset(text, req.Offset)
	ctx := Analyze(text, cursor)
	if ctx.InLiteral {
		return ""
	}
	return inlineSuggestion(idx, ctx, nil)
}

// collector accumulates scored items for one request.
type collector struct {
	prefix string
	clause Clause
	usage  UsageFunc
	items  []Item
}

// add scores a candidate and keeps it if it matches the typed prefix.
// bonus is the caller's confidence in this candidate given the clause; it
// is added on top of the fuzzy score, never multiplied, so a strong textual
// match in a less likely category still beats a weak match in a likely one.
func (c *collector) add(label, kind, detail, apply, info string, bonus int) {
	score, ok := Match(c.prefix, strings.ToLower(label))
	if !ok {
		return
	}
	score += bonus
	// Frequency of use inside this session, capped so a much-used table can
	// climb over its peers without ever outranking a better textual match
	// from a different tier.
	if used := c.usage(kind, label); used > 0 {
		boost := used * 15
		if boost > 120 {
			boost = 120
		}
		score += boost
	}
	c.items = append(c.items, Item{
		Label: label, Kind: kind, Detail: detail, Apply: apply, Info: info, Score: score,
	})
}

// qualified handles "alias.", "table.", "schema." and "schema.table.".
// Only that scope is offered — mixing in unrelated names is precisely what
// makes a qualified completion useless.
func (c *collector) qualified(idx *SchemaIndex, ctx Context) {
	if ctx.DotParent != "" {
		// "schema.table.|" — resolve both halves before trusting either.
		if t, ok := idx.Table(ctx.DotParent, ctx.DotPrefix); ok {
			c.columnsOf(t, 400)
			return
		}
	}

	table, schemaTables := idx.ResolveQualifier(ctx.DotPrefix, ctx.Refs)
	switch {
	case table != nil:
		c.columnsOf(table, 400)
	case len(schemaTables) > 0:
		for _, t := range schemaTables {
			c.add(t.Name, KindTable, t.Qualified, "", "", 400)
		}
	}
}

// unqualified is the bare-prefix path, where the clause decides what is
// even a candidate.
func (c *collector) unqualified(idx *SchemaIndex, dialect *Dialect, ctx Context) {
	switch ctx.Clause {
	case ClauseFrom, ClauseJoin:
		c.tables(idx)
		c.schemas(idx)
		c.keywords(dialect, 0)

	case ClauseSelect, ClauseWhere, ClauseOn, ClauseGroupBy, ClauseHaving,
		ClauseOrderBy, ClauseSet, ClauseInsertColumns:
		c.columnsInScope(idx, ctx)
		c.functions(dialect, ctx.Clause)
		c.routines(idx)
		c.keywords(dialect, 0)
		// Table names stay available but sink below columns: writing
		// "orders.id" in a WHERE is legal, just rarer than naming a column.
		c.tablesWithBonus(idx, -150)

	case ClauseValues:
		c.functions(dialect, ctx.Clause)
		c.routines(idx)
		c.keywords(dialect, 0)

	default:
		// Start of a statement, or a position the parser could not classify.
		// Offer everything, led by statement templates — never nothing.
		c.snippets(dialect)
		c.keywords(dialect, 100)
		c.tables(idx)
		c.functions(dialect, ctx.Clause)
	}
}

func (c *collector) tables(idx *SchemaIndex) { c.tablesWithBonus(idx, 300) }

func (c *collector) tablesWithBonus(idx *SchemaIndex, bonus int) {
	if idx == nil {
		return
	}
	for _, t := range idx.Tables {
		detail := t.Qualified
		if len(t.Columns) > 0 {
			detail += " · " + strconv.Itoa(len(t.Columns)) + " col"
		}
		c.add(t.Name, KindTable, detail, "", "", bonus)
	}
}

func (c *collector) schemas(idx *SchemaIndex) {
	if idx == nil {
		return
	}
	for _, s := range idx.Schemas {
		c.add(s, KindSchema, "esquema", "", "", 200)
	}
}

// columnsInScope offers the columns of the tables the statement actually
// references. When nothing resolved yet — a query whose FROM is not typed —
// it falls back to every indexed column rather than to nothing, so the
// engine never suggests less than it could.
func (c *collector) columnsInScope(idx *SchemaIndex, ctx Context) {
	if idx == nil {
		return
	}
	found := false
	for _, ref := range ctx.Refs {
		t, ok := idx.Resolve(ref)
		if !ok {
			continue
		}
		found = true
		// A qualified label is offered alongside the bare one when the
		// reference has an alias, so "u.email" is one keystroke away in a
		// multi-table query where a bare "email" would be ambiguous.
		c.columnsOf(t, 500)
		if ref.Alias != "" {
			for _, col := range t.Columns {
				c.add(ref.Alias+"."+col.Name, KindColumn, columnDetail(col), "", "", 380)
			}
		}
	}
	if found {
		return
	}
	seen := make(map[string]bool, len(idx.Columns))
	for _, col := range idx.Columns {
		if seen[col.Lower] {
			continue
		}
		seen[col.Lower] = true
		c.add(col.Name, KindColumn, columnDetail(col), "", "", 250)
	}
}

func (c *collector) columnsOf(t *TableEntry, bonus int) {
	for _, col := range t.Columns {
		extra := 0
		// A primary key is what a WHERE or an ON is usually about, and a
		// foreign key is the next most likely; small nudges, not overrides.
		if col.IsPrimaryKey {
			extra = 20
		} else if col.FK != nil {
			extra = 10
		}
		c.add(col.Name, KindColumn, columnDetail(col), "", columnInfo(col), bonus+extra)
	}
}

func (c *collector) functions(d *Dialect, clause Clause) {
	aggregateOK := clause == ClauseSelect || clause == ClauseHaving ||
		clause == ClauseOrderBy || clause == ClauseGroupBy
	for _, f := range d.AllFunctions() {
		bonus := 150
		if f.Aggregate && !aggregateOK {
			// An aggregate in a WHERE is not valid SQL; keep it visible
			// (the parse may be wrong) but well below everything else.
			bonus = -200
		}
		apply := f.Snippet
		if apply == "" {
			apply = f.Name + "(${1})"
		}
		c.add(f.Name, KindFunction, f.Signature, apply, f.Doc, bonus)
	}
}

// routines offers the connection's own stored procedures and functions,
// scored just under the dialect built-ins.
func (c *collector) routines(idx *SchemaIndex) {
	if idx == nil {
		return
	}
	for _, r := range idx.Routines {
		detail := "procedimiento"
		if r.IsFunction {
			detail = "función"
			if r.ReturnType != "" {
				detail += " → " + r.ReturnType
			}
		}
		if r.Schema != "" {
			detail = r.Schema + " · " + detail
		}
		c.add(r.Name, KindRoutine, detail, r.Name+"(${1})", "", 120)
	}
}

func (c *collector) keywords(d *Dialect, bonus int) {
	for _, k := range d.AllKeywords() {
		c.add(k, KindKeyword, "", "", "", bonus)
	}
}

func (c *collector) snippets(d *Dialect) {
	for _, s := range d.AllSnippets() {
		c.add(s.Label, KindSnippet, s.Detail, s.Body, "", 400)
	}
}

// joins turns a pending "JOIN <table>" without an ON into ready-made
// conditions, offered as top-ranked items the moment the cursor reaches the
// join condition.
func (c *collector) joins(idx *SchemaIndex, ctx Context) {
	if ctx.JoinTarget == nil {
		return
	}
	if ctx.Clause != ClauseJoin && ctx.Clause != ClauseOn {
		return
	}
	for _, cond := range ResolveJoin(idx, *ctx.JoinTarget, ctx.LeftRefs) {
		label := cond.Condition
		apply := cond.Condition
		if ctx.Clause == ClauseJoin {
			// Still on the table name: the ON keyword is missing too.
			label = "ON " + cond.Condition
			apply = label
		}
		detail := cond.Left + " ↔ " + cond.Right
		if cond.ViaPrimaryKey {
			detail += " (FK → PK)"
		} else {
			detail += " (FK)"
		}
		// Join conditions bypass prefix matching: the typed prefix is a
		// column fragment, not a fragment of the whole condition string, so
		// scoring them like a plain label would drop them exactly when they
		// are most useful. They are appended pre-scored instead.
		c.items = append(c.items, Item{
			Label: label, Kind: KindJoin, Detail: detail, Apply: apply,
			Info: "Condición derivada de la llave foránea declarada en el esquema.",
			Score: 1600,
		})
	}
}

// inlineSuggestion is the grey ghost text. Two sources, in priority order:
// a predicted join condition (the highest-value prediction the schema
// makes), then the unique remainder of a strong single candidate.
func inlineSuggestion(idx *SchemaIndex, ctx Context, items []Item) string {
	if ctx.JoinTarget != nil && ctx.Prefix == "" {
		if conds := ResolveJoin(idx, *ctx.JoinTarget, ctx.LeftRefs); len(conds) > 0 {
			switch ctx.Clause {
			case ClauseJoin:
				return " ON " + conds[0].Condition
			case ClauseOn:
				return " " + conds[0].Condition
			}
		}
	}

	// Completing a word only when there is one clear winner: ghost text
	// that guesses wrong is worse than none, since it reads as if the
	// editor already knows what you meant.
	if len(ctx.Prefix) < 3 || len(items) == 0 {
		return ""
	}
	top := items[0]
	if top.Kind != KindTable && top.Kind != KindColumn {
		return ""
	}
	if len(items) > 1 && items[1].Score >= top.Score-100 {
		return ""
	}
	lower := strings.ToLower(top.Label)
	if !strings.HasPrefix(lower, strings.ToLower(ctx.Prefix)) {
		return ""
	}
	return top.Label[len(ctx.Prefix):]
}

func columnDetail(c *ColumnEntry) string {
	var b strings.Builder
	b.WriteString(c.Table.Name)
	b.WriteString(" · ")
	b.WriteString(c.DataType)
	if c.IsPrimaryKey {
		b.WriteString(" · PK")
	}
	if !c.Nullable {
		b.WriteString(" · NOT NULL")
	}
	if c.FK != nil {
		b.WriteString(" · FK→")
		b.WriteString(c.FK.ReferencedTable)
	}
	return b.String()
}

func columnInfo(c *ColumnEntry) string {
	if c.FK == nil {
		return ""
	}
	return c.Qualified() + " referencia " + c.FK.ReferencedTable + "." + c.FK.ReferencedColumn
}
