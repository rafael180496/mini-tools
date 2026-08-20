package sqlintel

import "strings"

// Match scores how well candidate answers the typed query, returning
// (score, matched). Both arguments must already be lower case — every
// indexed name is pre-lowered at build time precisely so this stays
// allocation-free on the hot path.
//
// The tiers below are ordered by how confident a human would be that the
// candidate is what they meant, and the gaps between them are wide enough
// that no length bonus can push a weaker tier above a stronger one:
//
//	exact           1000   typed the whole name
//	prefix           800   "cust" → customers
//	word boundary    600   "addr" → customer_address (segment start)
//	acronym          500   "ca"   → customer_address (initials)
//	substring        350   "tome" → customers
//	subsequence      200   "cst"  → customers (in order, gapped)
//
// An empty query matches everything at a neutral score, which is what makes
// Ctrl-Space with nothing typed list the whole scope.
func Match(query, candidate string) (int, bool) {
	if query == "" {
		return 50, true
	}
	if len(query) > len(candidate) {
		return 0, false
	}

	if query == candidate {
		return 1000, true
	}
	if strings.HasPrefix(candidate, query) {
		// Shorter candidates win among prefix matches: for "id", the column
		// "id" should outrank "identity_provider_id".
		return 800 + lengthBonus(query, candidate), true
	}
	if score, ok := boundaryPrefix(query, candidate); ok {
		return score, true
	}
	if score, ok := acronym(query, candidate); ok {
		return score, true
	}
	if strings.Contains(candidate, query) {
		return 350 + lengthBonus(query, candidate), true
	}
	if score, ok := subsequence(query, candidate); ok {
		return score, true
	}
	return 0, false
}

// lengthBonus rewards a candidate that the query already covers most of,
// capped at 99 so it can never bridge the 150+ gap between two tiers.
func lengthBonus(query, candidate string) int {
	if len(candidate) == 0 {
		return 0
	}
	bonus := 99 * len(query) / len(candidate)
	if bonus > 99 {
		return 99
	}
	return bonus
}

// boundaryPrefix matches a query against the start of any word inside the
// candidate, where words are split on "_" and on digit runs — the shape of
// almost every SQL identifier ("customer_address", "line_item_2").
//
// The digit half of that sentence used to be documentation only: the loop
// checked for "_" and nothing else, so "2" did not reach "line_item_2" and
// neither did "01" reach "tab01". A numeric suffix is often the only thing
// telling two otherwise identical names apart, which makes it exactly what
// someone types to pick between them.
func boundaryPrefix(query, candidate string) (int, bool) {
	for i := 1; i < len(candidate); i++ {
		if !isSegmentStart(candidate, i) {
			continue
		}
		if strings.HasPrefix(candidate[i:], query) {
			return 600 + lengthBonus(query, candidate), true
		}
	}
	return 0, false
}

// isSegmentStart reports whether index i begins a new word inside an
// identifier: right after an underscore, or where a digit run starts.
// Candidates are pre-lowered, so there is no camelCase boundary left to
// find — the capital that would have marked one is gone before this runs.
func isSegmentStart(candidate string, i int) bool {
	prev, cur := candidate[i-1], candidate[i]
	if prev == '_' {
		return true
	}
	return isASCIIDigit(cur) && !isASCIIDigit(prev)
}

func isASCIIDigit(c byte) bool { return c >= '0' && c <= '9' }

// acronym matches the initials of the candidate's underscore-separated
// segments: "ca" → customer_address, "oid" → order_item_detail.
func acronym(query, candidate string) (int, bool) {
	if len(query) < 2 {
		return 0, false
	}
	initials := make([]byte, 0, 8)
	for i := 0; i < len(candidate); i++ {
		c := candidate[i]
		if c == '_' {
			continue
		}
		if i == 0 || isSegmentStart(candidate, i) {
			initials = append(initials, c)
		}
	}
	if strings.HasPrefix(string(initials), query) {
		return 500, true
	}
	return 0, false
}

// subsequence matches the query's characters in order with gaps allowed.
// It is the loosest tier and scores by how tightly packed the match is, so
// "cst" prefers "customers" (early, dense) over a long name that happens to
// contain the same letters far apart.
func subsequence(query, candidate string) (int, bool) {
	qi := 0
	first, last := -1, -1
	for ci := 0; ci < len(candidate) && qi < len(query); ci++ {
		if candidate[ci] == query[qi] {
			if first < 0 {
				first = ci
			}
			last = ci
			qi++
		}
	}
	if qi < len(query) {
		return 0, false
	}
	span := last - first + 1
	density := 99 * len(query) / span
	return 200 + density, true
}
