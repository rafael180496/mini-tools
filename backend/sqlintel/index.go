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
type RoutineEntry struct {
	Schema     string
	Name       string
	Lower      string
	ReturnType string
	IsFunction bool
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
}

// BuildIndex compiles metadata into a SchemaIndex. A nil meta yields an
// empty (but usable) index, so callers never need a nil check.
func BuildIndex(meta *db.SchemaMetadata) *SchemaIndex {
	idx := &SchemaIndex{
		tablesBy:  map[string][]*TableEntry{},
		schemasBy: map[string][]*TableEntry{},
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
		idx.Routines = append(idx.Routines, RoutineEntry{
			Schema: p.Schema, Name: p.Name, Lower: strings.ToLower(p.Name),
		})
	}
	for _, f := range meta.Functions {
		idx.Routines = append(idx.Routines, RoutineEntry{
			Schema: f.Schema, Name: f.Name, Lower: strings.ToLower(f.Name),
			ReturnType: f.ReturnType, IsFunction: true,
		})
	}

	sort.Strings(idx.Schemas)
	return idx
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
	return idx.schemasBy[strings.ToLower(schema)]
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
