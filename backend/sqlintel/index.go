package sqlintel

import (
	"sort"
	"strings"

	"mini-tools/backend/db"
)

// ColumnEntry is one indexed column. It carries the FK it participates in
// (if any) so a join condition can be built without a second lookup.
type ColumnEntry struct {
	Name         string
	Lower        string
	DataType     string
	Nullable     bool
	IsPrimaryKey bool
	// Table is the owning table, so a completion item built from a column
	// alone can still say where it came from.
	Table *TableEntry
	// FK points at the referenced table.column when this column is a
	// foreign key, nil otherwise.
	FK *db.ForeignKey
}

// Qualified is "table.column", the detail text shown next to a suggestion.
func (c *ColumnEntry) Qualified() string { return c.Table.Name + "." + c.Name }

// TableEntry is one indexed table or view with its columns pre-bucketed for
// lookup. Views are indexed identically — db.SchemaMetadata does not tag
// them apart, and completion treats them the same anyway.
type TableEntry struct {
	Schema string
	Name   string
	Lower  string
	// Qualified is "schema.name" when the table has a schema, else "name".
	Qualified string

	// FromScript marks a table that exists only in the buffer being edited —
	// a CREATE TABLE further up the file, a CTE of this statement. Surfaced
	// in the suggestion's detail line, because "this name is not in the
	// database yet" is something the author needs to see, not be shielded
	// from.
	FromScript bool

	Columns   []*ColumnEntry
	columnsBy map[string]*ColumnEntry
	// outgoing groups this table's foreign keys by referenced table (lower
	// case), which is what join resolution needs: a composite FK is several
	// db.ForeignKey rows that must be ANDed together into one condition.
	outgoing map[string][]*db.ForeignKey
}

// Column looks a column up by name, case-insensitively.
func (t *TableEntry) Column(name string) (*ColumnEntry, bool) {
	c, ok := t.columnsBy[strings.ToLower(name)]
	return c, ok
}

// RoutineEntry is a stored procedure or function from the catalog — the
// user's own routines, offered alongside the dialect's built-in functions.
//
// It carries the full parameter list rather than just the name because a
// name on its own is the one thing a caller already knows. What they cannot
// remember is the order, the types and which arguments come back OUT — so
// that is what the completion item, its info panel and the signature
// tooltip are all built from. See signature.go for the formatting.
type RoutineEntry struct {
	Schema string
	// Package is the owning Oracle package, empty for a standalone routine
	// and always empty on the other engines.
	Package string
	Name    string
	Lower   string
	// Call is what has to be written to invoke it: "PKG.MEMBER" for a
	// package member, the bare name otherwise. It is the completion label,
	// which is why it is precomputed instead of concatenated per keystroke.
	Call string
	// CallLower is Call folded once, for the fuzzy matcher.
	CallLower  string
	ReturnType string
	IsFunction bool
	// Overload distinguishes same-named declarations; empty when the
	// routine is the only one with its name.
	Overload string
	Comment  string
	Args     []db.RoutineArg
}

// SchemaIndex is the in-memory, read-only index one connection's metadata
// is compiled into. It is built once per metadata refresh and then only
// read, so it needs no locking of its own — the Manager swaps whole
// pointers instead of mutating an index in place.
//
// Lookup cost is what the sub-15ms budget rides on: exact table/column
// resolution is a map hit, and the fuzzy scan is a linear pass over
// pre-lowercased strings with no allocation per candidate.
type SchemaIndex struct {
	Tables   []*TableEntry
	Columns  []*ColumnEntry
	Routines []RoutineEntry
	Schemas  []string

	tablesBy  map[string][]*TableEntry
	schemasBy map[string][]*TableEntry
	// packageMembers indexes an Oracle package's routines by the lowercased
	// package name, so "PKG." can be completed without scanning Routines.
	packageMembers map[string][]RoutineEntry
	// incoming is the reverse of TableEntry.outgoing: referenced table (lower
	// case) → the tables holding a foreign key at it. Join prediction needs
	// both directions, and without this the only way to answer "what can join
	// onto USUARIOS?" is a scan of every table's FKs — a full sweep of the
	// catalog on a keystroke.
	incoming map[string][]*TableEntry
	// script holds the objects the edited buffer declares (see script.go).
	// It is a per-request overlay attached by withScript, never part of a
	// stored index: it changes with every keystroke, while the catalog index
	// is rebuilt only on a metadata refresh.
	script []*TableEntry
}

// withScript returns a view of idx that also resolves the objects declared
// in the buffer. The clone is a shallow struct copy — the slices and maps
// built by BuildIndex are read-only from that point on, so sharing them
// across requests is safe and keeps this O(1) instead of recompiling a
// catalog of thousands of tables on every keystroke.
func (idx *SchemaIndex) withScript(script []*TableEntry) *SchemaIndex {
	if len(script) == 0 {
		return idx
	}
	var clone SchemaIndex
	if idx != nil {
		clone = *idx
	}
	clone.script = script
	return &clone
}

// scriptTable resolves name against the buffer's own declarations.
func (idx *SchemaIndex) scriptTable(schema, name string) (*TableEntry, bool) {
	if idx == nil {
		return nil, false
	}
	lower := strings.ToLower(name)
	for _, t := range idx.script {
		if t.Lower != lower {
			continue
		}
		if schema == "" || strings.EqualFold(t.Schema, schema) {
			return t, true
		}
	}
	return nil, false
}

// BuildIndex compiles metadata into a SchemaIndex. A nil meta yields an
// empty (but usable) index, so callers never need a nil check.
func BuildIndex(meta *db.SchemaMetadata) *SchemaIndex {
	idx := &SchemaIndex{
		tablesBy:       map[string][]*TableEntry{},
		schemasBy:      map[string][]*TableEntry{},
		incoming:       map[string][]*TableEntry{},
		packageMembers: map[string][]RoutineEntry{},
	}
	if meta == nil {
		return idx
	}

	schemaSeen := map[string]bool{}

	for i := range meta.Tables {
		t := &meta.Tables[i]
		entry := &TableEntry{
			Schema:    t.Schema,
			Name:      t.Name,
			Lower:     strings.ToLower(t.Name),
			Qualified: qualify(t.Schema, t.Name),
			columnsBy: make(map[string]*ColumnEntry, len(t.Columns)),
			outgoing:  map[string][]*db.ForeignKey{},
		}

		fkByColumn := make(map[string]*db.ForeignKey, len(t.ForeignKeys))
		for j := range t.ForeignKeys {
			fk := &t.ForeignKeys[j]
			fkByColumn[strings.ToLower(fk.Column)] = fk
			key := strings.ToLower(fk.ReferencedTable)
			if _, already := entry.outgoing[key]; !already {
				idx.incoming[key] = append(idx.incoming[key], entry)
			}
			entry.outgoing[key] = append(entry.outgoing[key], fk)
		}

		for j := range t.Columns {
			c := &t.Columns[j]
			lower := strings.ToLower(c.Name)
			col := &ColumnEntry{
				Name:         c.Name,
				Lower:        lower,
				DataType:     c.DataType,
				Nullable:     c.Nullable,
				IsPrimaryKey: c.IsPrimaryKey,
				Table:        entry,
				FK:           fkByColumn[lower],
			}
			entry.Columns = append(entry.Columns, col)
			entry.columnsBy[lower] = col
			idx.Columns = append(idx.Columns, col)
		}

		idx.Tables = append(idx.Tables, entry)
		idx.tablesBy[entry.Lower] = append(idx.tablesBy[entry.Lower], entry)
		if t.Schema != "" {
			lowerSchema := strings.ToLower(t.Schema)
			idx.schemasBy[lowerSchema] = append(idx.schemasBy[lowerSchema], entry)
			if !schemaSeen[lowerSchema] {
				schemaSeen[lowerSchema] = true
				idx.Schemas = append(idx.Schemas, t.Schema)
			}
		}
	}

	for _, p := range meta.Procedures {
		idx.addRoutine(RoutineEntry{
			Schema: p.Schema, Name: p.Name,
			Overload: p.Overload, Comment: p.Comment, Args: p.Args,
		})
	}
	for _, f := range meta.Functions {
		idx.addRoutine(RoutineEntry{
			Schema: f.Schema, Name: f.Name,
			ReturnType: f.ReturnType, IsFunction: true,
			Overload: f.Overload, Comment: f.Comment, Args: f.Args,
		})
	}
	// Package members are indexed as routines in their own right, under the
	// "PKG.MEMBER" name a call has to write. On Oracle this is where most
	// callable code lives, so leaving them out would mean the completion
	// knows about the package and nothing inside it.
	for _, pkg := range meta.Packages {
		for _, m := range pkg.Members {
			idx.addRoutine(RoutineEntry{
				Schema: pkg.Schema, Package: pkg.Name, Name: m.Name,
				ReturnType: m.ReturnType, IsFunction: m.IsFunction,
				Overload: m.Overload, Args: m.Args,
			})
		}
	}

	sort.Strings(idx.Schemas)
	return idx
}

// addRoutine derives the call name and the lookup keys a RoutineEntry needs
// and appends it to the index. Every routine goes through here so the
// derived fields can never drift between the three call sites that build
// them.
func (idx *SchemaIndex) addRoutine(r RoutineEntry) {
	r.Lower = strings.ToLower(r.Name)
	r.Call = r.Name
	if r.Package != "" {
		r.Call = r.Package + "." + r.Name
	}
	r.CallLower = strings.ToLower(r.Call)
	idx.Routines = append(idx.Routines, r)
	if r.Package != "" {
		lower := strings.ToLower(r.Package)
		idx.packageMembers[lower] = append(idx.packageMembers[lower], r)
	}
}

// PackageMembers returns the routines declared by an Oracle package, for
// the "PKG.|" completion path. Nil for anything that is not a package.
func (idx *SchemaIndex) PackageMembers(name string) []RoutineEntry {
	if idx == nil {
		return nil
	}
	return idx.packageMembers[strings.ToLower(name)]
}

// Empty reports whether the index holds nothing to suggest — the state
// before a connection's first metadata fetch completes.
func (idx *SchemaIndex) Empty() bool { return idx == nil || len(idx.Tables) == 0 }

// TableCount is what the frontend shows to explain why suggestions are (or
// are not) available yet.
func (idx *SchemaIndex) TableCount() int {
	if idx == nil {
		return 0
	}
	return len(idx.Tables)
}

// Table resolves a table by name, optionally restricted to a schema. When
// several schemas hold a table of the same name and none was specified, the
// first indexed one wins — ambiguous by nature, and picking one beats
// suggesting nothing.
func (idx *SchemaIndex) Table(schema, name string) (*TableEntry, bool) {
	if idx == nil {
		return nil, false
	}
	// The buffer wins over the catalog: a CTE named like an existing table
	// shadows it inside that statement, which is what SQL itself does.
	if t, ok := idx.scriptTable(schema, name); ok {
		return t, true
	}
	candidates := idx.tablesBy[strings.ToLower(name)]
	if len(candidates) == 0 {
		return nil, false
	}
	if schema == "" {
		return candidates[0], true
	}
	for _, t := range candidates {
		if strings.EqualFold(t.Schema, schema) {
			return t, true
		}
	}
	return nil, false
}

// TablesInSchema returns every table of a schema, for "schema.|" completion.
func (idx *SchemaIndex) TablesInSchema(schema string) []*TableEntry {
	if idx == nil {
		return nil
	}
	out := idx.schemasBy[strings.ToLower(schema)]
	for _, t := range idx.script {
		if strings.EqualFold(t.Schema, schema) {
			out = append(out[:len(out):len(out)], t)
		}
	}
	return out
}

// AllTables walks the catalog and the buffer's own declarations, script
// objects first — they are the ones the author has in mind right now.
func (idx *SchemaIndex) AllTables(fn func(*TableEntry)) {
	if idx == nil {
		return
	}
	for _, t := range idx.script {
		fn(t)
	}
	for _, t := range idx.Tables {
		fn(t)
	}
}

// RelatedTables returns the tables joinable to t through a declared foreign
// key, in either direction, without scanning the catalog.
func (idx *SchemaIndex) RelatedTables(t *TableEntry) []*TableEntry {
	if idx == nil || t == nil {
		return nil
	}
	seen := map[*TableEntry]bool{t: true}
	var out []*TableEntry
	for name := range t.outgoing {
		for _, cand := range idx.tablesBy[name] {
			if !seen[cand] {
				seen[cand] = true
				out = append(out, cand)
			}
		}
	}
	for _, cand := range idx.incoming[t.Lower] {
		if !seen[cand] {
			seen[cand] = true
			out = append(out, cand)
		}
	}
	return out
}

// Resolve maps a parsed TableRef to its indexed table. Derived tables
// (subquery aliases) never resolve — their columns are not in the catalog.
func (idx *SchemaIndex) Resolve(ref TableRef) (*TableEntry, bool) {
	if ref.Derived {
		return nil, false
	}
	return idx.Table(ref.Schema, ref.Name)
}

// ResolveQualifier maps a "u." / "users." / "public." prefix to what it can
// mean at the cursor, in priority order: an alias in scope, a table in
// scope, a schema, then any table in the catalog. Returns at most one of
// table/schemaTables — whichever the prefix turned out to name.
func (idx *SchemaIndex) ResolveQualifier(prefix string, refs []TableRef) (table *TableEntry, schemaTables []*TableEntry) {
	if idx == nil || prefix == "" {
		return nil, nil
	}

	for _, r := range refs {
		if r.Alias != "" && strings.EqualFold(r.Alias, prefix) {
			if t, ok := idx.Resolve(r); ok {
				return t, nil
			}
			// A derived table's alias resolved but has no catalog columns:
			// stop here rather than falling through to a real table that
			// happens to share the name, which would suggest wrong columns.
			return nil, nil
		}
	}
	for _, r := range refs {
		if r.Alias == "" && strings.EqualFold(r.Name, prefix) {
			if t, ok := idx.Resolve(r); ok {
				return t, nil
			}
		}
	}
	if tables := idx.TablesInSchema(prefix); len(tables) > 0 {
		return nil, tables
	}
	if t, ok := idx.Table("", prefix); ok {
		return t, nil
	}
	return nil, nil
}

func qualify(schema, name string) string {
	if schema == "" {
		return name
	}
	return schema + "." + name
}
