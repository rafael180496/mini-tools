package sqlintel

import (
	"strings"

	"mini-tools/backend/db"
)

// Objects a script declares about itself.
//
// A catalog index only knows what the database already has. Half the SQL
// anyone writes in an editor refers to something that is not there yet: the
// table two statements above in an install script, the CTE at the top of the
// query being written. Those names are unresolvable against the catalog by
// definition, so completion either reads them out of the buffer or is blind
// to exactly the objects the author just typed.
//
// The parsing here is deliberately shallow — token walks over CREATE TABLE
// and WITH, not a grammar. A missed declaration costs one absent suggestion;
// it can never produce a wrong query, because nothing is executed from it.

// constraintWords open a table-level constraint inside a CREATE TABLE body,
// where the first word of the group is not a column name.
var constraintWords = map[string]bool{
	"CONSTRAINT": true, "PRIMARY": true, "FOREIGN": true, "UNIQUE": true,
	"CHECK": true, "KEY": true, "INDEX": true, "EXCLUDE": true, "PERIOD": true,
}

// createModifiers sit between CREATE and TABLE/VIEW and carry no name.
var createModifiers = map[string]bool{
	"OR": true, "REPLACE": true, "GLOBAL": true, "LOCAL": true, "PRIVATE": true,
	"TEMPORARY": true, "TEMP": true, "UNLOGGED": true, "MATERIALIZED": true,
	"FORCE": true, "NO": true, "EDITIONABLE": true, "NONEDITIONABLE": true,
}

// ScriptTables reads the objects the buffer declares: every CREATE
// TABLE/VIEW in the whole document (all), and the CTEs of the statement
// under the cursor (stmt). The two scopes differ on purpose — a table
// created anywhere in the file is real for the rest of the session, while a
// CTE only exists inside the statement that declares it.
func ScriptTables(all, stmt []Token) []*TableEntry {
	var out []*TableEntry
	seen := map[string]bool{}

	add := func(e *TableEntry) {
		if e == nil || e.Lower == "" || seen[e.Lower] {
			return
		}
		seen[e.Lower] = true
		out = append(out, e)
	}

	for i := 0; i < len(all); i++ {
		if all[i].Is("CREATE") {
			add(readCreate(all, i))
		}
	}
	for _, e := range readCTEs(stmt) {
		add(e)
	}
	return out
}

// readCreate parses "CREATE [modifiers] TABLE|VIEW [IF NOT EXISTS]
// [schema.]name [(columns)]" starting at the CREATE token.
func readCreate(tokens []Token, i int) *TableEntry {
	j := i + 1
	for j < len(tokens) && tokens[j].Kind == TokenWord && createModifiers[tokens[j].Upper()] {
		j++
	}
	if j >= len(tokens) || !(tokens[j].Is("TABLE") || tokens[j].Is("VIEW")) {
		return nil
	}
	isTable := tokens[j].Is("TABLE")
	j++

	// "IF NOT EXISTS" — three words carrying no name.
	if j+2 < len(tokens) && tokens[j].Is("IF") && tokens[j+1].Is("NOT") && tokens[j+2].Is("EXISTS") {
		j += 3
	}
	if j >= len(tokens) || !tokens[j].IsWordLike() {
		return nil
	}

	schema, name, next := readQualifiedName(tokens, j)
	entry := newScriptTable(schema, name)
	if isTable && next < len(tokens) && tokens[next].Kind == TokenPunct && tokens[next].Text == "(" {
		for _, col := range readColumnList(tokens, next) {
			addScriptColumn(entry, col.name, col.dataType)
		}
	}
	return entry
}

// readCTEs parses "WITH [RECURSIVE] name [(cols)] AS (…) [, name AS (…)]".
// Only a WITH that opens the statement is read: one nested inside a subquery
// declares names that are not visible where the cursor is, and following it
// there would mean modelling scope, which is the analyzer's job, not this
// pass's.
func readCTEs(tokens []Token) []*TableEntry {
	if len(tokens) == 0 || !tokens[0].Is("WITH") {
		return nil
	}
	i := 1
	if i < len(tokens) && tokens[i].Is("RECURSIVE") {
		i++
	}

	var out []*TableEntry
	for i < len(tokens) {
		if !tokens[i].IsWordLike() {
			break
		}
		entry := newScriptTable("", tokens[i].Value)
		i++

		// Optional explicit column list: "WITH totals (mes, importe) AS (…)".
		if i < len(tokens) && tokens[i].Kind == TokenPunct && tokens[i].Text == "(" {
			for _, col := range readColumnList(tokens, i) {
				addScriptColumn(entry, col.name, "")
			}
			i = skipParens(tokens, i)
		}
		if i >= len(tokens) || !tokens[i].Is("AS") {
			break
		}
		i++
		// Postgres optimizer hints between AS and the body.
		for i < len(tokens) && (tokens[i].Is("NOT") || tokens[i].Is("MATERIALIZED")) {
			i++
		}
		if i >= len(tokens) || tokens[i].Kind != TokenPunct || tokens[i].Text != "(" {
			break
		}
		out = append(out, entry)
		i = skipParens(tokens, i)

		if i < len(tokens) && tokens[i].Kind == TokenPunct && tokens[i].Text == "," {
			i++
			continue
		}
		break
	}
	return out
}

type scriptColumn struct{ name, dataType string }

// readColumnList reads the top-level entries of the parenthesised list that
// starts at open, returning the ones that name a column. Nested parens (a
// VARCHAR2(50), a CHECK body) are skipped over rather than descended into.
func readColumnList(tokens []Token, open int) []scriptColumn {
	var out []scriptColumn
	depth := 0
	atGroupStart := false

	for i := open; i < len(tokens); i++ {
		t := tokens[i]
		if t.Kind == TokenPunct {
			switch t.Text {
			case "(":
				depth++
				if depth == 1 {
					atGroupStart = true
				}
				continue
			case ")":
				depth--
				if depth == 0 {
					return out
				}
				continue
			case ",":
				if depth == 1 {
					atGroupStart = true
				}
				continue
			}
		}
		if depth != 1 || !atGroupStart {
			continue
		}
		atGroupStart = false
		if !t.IsWordLike() || (t.Kind == TokenWord && constraintWords[t.Upper()]) {
			continue
		}
		out = append(out, scriptColumn{name: t.Value, dataType: readDataType(tokens, i+1)})
	}
	return out
}

// readDataType renders the type that follows a column name, with its
// precision when it has one: "VARCHAR2(50)", "NUMBER(10,2)", "DATE".
func readDataType(tokens []Token, i int) string {
	if i >= len(tokens) || !tokens[i].IsWordLike() {
		return ""
	}
	var b strings.Builder
	b.WriteString(strings.ToUpper(tokens[i].Value))
	i++
	// A multi-word type ("TIMESTAMP WITH TIME ZONE") stops at the precision
	// or at whatever ends the column; one extra word is enough to be useful
	// without re-implementing four dialects' type grammars.
	if i < len(tokens) && tokens[i].Kind == TokenPunct && tokens[i].Text == "(" {
		end := skipParens(tokens, i)
		for ; i < end; i++ {
			b.WriteString(tokens[i].Text)
		}
	}
	return b.String()
}

// skipParens returns the index just past the ")" closing the "(" at open.
func skipParens(tokens []Token, open int) int {
	depth := 0
	for i := open; i < len(tokens); i++ {
		if tokens[i].Kind != TokenPunct {
			continue
		}
		switch tokens[i].Text {
		case "(":
			depth++
		case ")":
			depth--
			if depth == 0 {
				return i + 1
			}
		}
	}
	return len(tokens)
}

// readQualifiedName reads "[schema.]name" at i, returning the index after it.
func readQualifiedName(tokens []Token, i int) (schema, name string, next int) {
	name = tokens[i].Value
	next = i + 1
	for next+1 < len(tokens) &&
		tokens[next].Kind == TokenPunct && tokens[next].Text == "." &&
		tokens[next+1].IsWordLike() {
		schema = name
		name = tokens[next+1].Value
		next += 2
	}
	return schema, name, next
}

func newScriptTable(schema, name string) *TableEntry {
	return &TableEntry{
		Schema:     schema,
		Name:       name,
		Lower:      strings.ToLower(name),
		Qualified:  qualify(schema, name),
		FromScript: true,
		columnsBy:  map[string]*ColumnEntry{},
		outgoing:   map[string][]*db.ForeignKey{},
	}
}

func addScriptColumn(t *TableEntry, name, dataType string) {
	lower := strings.ToLower(name)
	if _, exists := t.columnsBy[lower]; exists {
		return
	}
	col := &ColumnEntry{
		Name:     name,
		Lower:    lower,
		DataType: dataType,
		Nullable: true,
		Table:    t,
	}
	t.Columns = append(t.Columns, col)
	t.columnsBy[lower] = col
}
