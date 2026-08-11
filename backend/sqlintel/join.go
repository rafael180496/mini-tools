package sqlintel

import (
	"strconv"
	"strings"

	"mini-tools/backend/db"
)

// JoinCondition is a predicted ON clause between two tables in scope.
type JoinCondition struct {
	// Condition is the ready-to-insert predicate, e.g.
	// "o.customer_id = c.id" — already written with whatever aliases the
	// query gave the two tables, so it can be inserted verbatim.
	Condition string `json:"condition"`
	// Left/Right are the two references it links, for the detail line.
	Left  string `json:"left"`
	Right string `json:"right"`
	// ViaPrimaryKey is true when the FK points at the other table's primary
	// key — the normal case, and a signal the guess is a safe one.
	ViaPrimaryKey bool `json:"viaPrimaryKey,omitempty"`
}

// ResolveJoin predicts the ON condition linking target to one of the
// references already in scope, using the foreign keys the schema declares.
// It looks in both directions (target → left and left → target), since
// "FROM orders JOIN customers" declares the FK on orders and
// "FROM customers JOIN orders" declares it on orders as well.
//
// Every candidate is returned, best first, rather than only the top one:
// two tables can be linked by more than one foreign key (created_by and
// updated_by both pointing at users), and silently picking one would be
// wrong half the time. The caller offers them as separate items.
func ResolveJoin(idx *SchemaIndex, target TableRef, left []TableRef) []JoinCondition {
	if idx == nil {
		return nil
	}
	targetTable, ok := idx.Resolve(target)
	if !ok {
		return nil
	}

	var out []JoinCondition
	for _, ref := range left {
		leftTable, ok := idx.Resolve(ref)
		if !ok {
			continue
		}
		// The already-present table is the child holding the FK…
		out = append(out, conditionsFrom(leftTable, ref.Label(), targetTable, target.Label())...)
		// …or the table being joined is.
		out = append(out, conditionsFrom(targetTable, target.Label(), leftTable, ref.Label())...)
	}
	return dedupeConditions(out)
}

// ResolveJoinBetween is the same prediction addressed by name instead of by
// parsed reference — what the standalone "how do these two tables join?"
// binding uses. Aliases are optional and default to the table names.
func ResolveJoinBetween(idx *SchemaIndex, leftName, leftAlias, rightName, rightAlias string) []JoinCondition {
	left := TableRef{Name: leftName, Alias: leftAlias}
	right := TableRef{Name: rightName, Alias: rightAlias}
	return ResolveJoin(idx, right, []TableRef{left})
}

// uniqueAlias invents the alias a generated JOIN clause will use: the
// initials of the name's underscore-separated segments, which is what people
// write by hand ("film_actor" → fa, "AN_TRABPEND_AF" → ata, "codigos" → c).
// A collision with an identifier the query already uses is resolved by
// numbering rather than by picking a different scheme, so the alias stays
// predictable.
func uniqueAlias(name string, taken map[string]bool) string {
	var initials strings.Builder
	for _, part := range strings.Split(name, "_") {
		if part == "" {
			continue
		}
		initials.WriteString(strings.ToLower(part[:1]))
	}
	base := initials.String()
	if base == "" {
		base = "t"
	}
	if !taken[base] {
		return base
	}
	for n := 2; ; n++ {
		candidate := base + strconv.Itoa(n)
		if !taken[candidate] {
			return candidate
		}
	}
}

// conditionsFrom builds the conditions declared by child's foreign keys
// pointing at parent. A composite foreign key produces ONE condition with
// its parts ANDed together, never one condition per column — half a
// composite key is not a valid join.
func conditionsFrom(child *TableEntry, childLabel string, parent *TableEntry, parentLabel string) []JoinCondition {
	fks := child.outgoing[strings.ToLower(parent.Name)]
	if len(fks) == 0 {
		return nil
	}

	var out []JoinCondition
	for _, group := range groupForeignKeys(fks) {
		parts := make([]string, 0, len(group))
		allPK := true
		for _, fk := range group {
			parts = append(parts,
				qualifyRef(childLabel, fk.Column)+" = "+qualifyRef(parentLabel, fk.ReferencedColumn))
			if col, ok := parent.Column(fk.ReferencedColumn); !ok || !col.IsPrimaryKey {
				allPK = false
			}
		}
		out = append(out, JoinCondition{
			Condition:     strings.Join(parts, " AND "),
			Left:          childLabel,
			Right:         parentLabel,
			ViaPrimaryKey: allPK,
		})
	}
	return out
}

// groupForeignKeys splits the FK rows pointing at one table into the
// constraints they most likely belong to.
//
// db.ForeignKey carries no constraint name (none of the four metadata
// queries in backend/db/metadata.go select one — they map child column to
// referenced column and nothing else), so the constraint boundary has to be
// inferred. The rule: a referenced column that repeats starts a new
// constraint. That is exactly right for the two shapes that matter —
// a composite key (child columns land on DIFFERENT referenced columns, so
// they merge) and several single-column keys to the same table (all land on
// the same primary key, so they split).
//
// Accepted limitation: two independent single-column foreign keys pointing
// at two DIFFERENT unique columns of the same parent would be merged into
// one ANDed condition. It is rare, and the failure mode is a visibly odd
// suggestion the user simply does not accept — not a wrong query silently
// executed. Fixing it properly means selecting constraint names in all four
// metadata queries, which is a metadata change, not a completion change.
func groupForeignKeys(fks []*db.ForeignKey) [][]*db.ForeignKey {
	var groups [][]*db.ForeignKey
	var used []map[string]bool

	for _, fk := range fks {
		ref := strings.ToLower(fk.ReferencedColumn)
		placed := false
		for i := range groups {
			if used[i][ref] {
				continue
			}
			groups[i] = append(groups[i], fk)
			used[i][ref] = true
			placed = true
			break
		}
		if !placed {
			groups = append(groups, []*db.ForeignKey{fk})
			used = append(used, map[string]bool{ref: true})
		}
	}
	return groups
}

func qualifyRef(label, column string) string {
	if label == "" {
		return column
	}
	return label + "." + column
}

// dedupeConditions drops repeats and floats primary-key joins to the front:
// those are the ones a human would have written by hand.
func dedupeConditions(in []JoinCondition) []JoinCondition {
	seen := map[string]bool{}
	unique := make([]JoinCondition, 0, len(in))
	for _, c := range in {
		if seen[c.Condition] {
			continue
		}
		seen[c.Condition] = true
		unique = append(unique, c)
	}

	ordered := make([]JoinCondition, 0, len(unique))
	for _, c := range unique {
		if c.ViaPrimaryKey {
			ordered = append(ordered, c)
		}
	}
	for _, c := range unique {
		if !c.ViaPrimaryKey {
			ordered = append(ordered, c)
		}
	}
	return ordered
}
