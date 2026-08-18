package query

import (
	"fmt"
	"strconv"
	"strings"

	"mini-tools/backend/db"
	"mini-tools/backend/sqlintel"
)

// Bind parameters: running a statement that says ":ini" instead of a value.
//
// The editor lets the placeholder be written the way the engine's own
// documentation writes it — ":desde", "$1", "?" — and this file is what
// makes that runnable. Two things happen here, and they are deliberately
// the same code path so they can never disagree about what counts as a
// parameter:
//
//  1. Detection, for the dialog that asks the user for values.
//  2. Rewriting, right before execution: every placeholder becomes the
//     ordinal form its driver actually accepts, and the values are handed
//     over as arguments — never interpolated into the SQL. A value the user
//     typed into a text box is exactly the input SQL injection is made of,
//     so it must not reach the statement as text under any circumstance.
//
// The tokenizer is borrowed from backend/sqlintel rather than written again
// here. It already knows what a bind parameter looks like on all four
// engines and, more importantly, already knows what ISN'T one: anything
// inside a string literal, a comment or a Postgres dollar-quoted body.

// Param is one placeholder the statement declares.
type Param struct {
	// Name is the identifier as written without its sigil: "ini" for
	// ":ini", "1" for "$1". Positional placeholders are named by their
	// order of appearance, so a "?" list becomes "1", "2", "3".
	Name string `json:"name"`
	// Raw is the placeholder exactly as it appears in the SQL, which is
	// what the dialog shows so the user recognises what they typed.
	Raw string `json:"raw"`
	// Positional marks a placeholder that had no name of its own ("?").
	Positional bool `json:"positional,omitempty"`
}

// ParamValue is one value supplied for a placeholder.
type ParamValue struct {
	Name string `json:"name"`
	// Value is always carried as text — it is what a text input produces —
	// and converted according to Type just before binding.
	Value string `json:"value"`
	// Type selects the conversion: "text" (default), "number", "boolean" or
	// "null". Anything else is treated as text, since a value the engine
	// can cast is better than a failed execution.
	Type string `json:"type"`
}

// Parameter type identifiers, shared with the frontend dialog.
const (
	ParamTypeText    = "text"
	ParamTypeNumber  = "number"
	ParamTypeBoolean = "boolean"
	ParamTypeNull    = "null"
)

// ExtractParams returns every placeholder in sqlText, deduplicated by name
// and ordered by first appearance — which is the order the dialog lists
// them in, and the order someone reading their own query expects.
//
// Statements that CREATE a stored program are skipped whole: a trigger body
// is full of ":NEW.col" references that look exactly like parameters and
// are nothing of the sort, and no DDL has ever taken a bind variable.
func ExtractParams(sqlText string, dbType db.DBType) []Param {
	var out []Param
	seen := map[string]bool{}
	// Anonymous "?" placeholders are numbered across the whole script, not
	// per statement, so two statements never both claim "1" and collapse
	// into a single row in the dialog.
	positionalBase := 0

	for _, stmt := range SplitStatements(sqlText) {
		if isStoredProgramDDL(stmt.Text) {
			continue
		}
		for _, t := range scanParamTokens(stmt.Text, dbType, positionalBase) {
			if t.Positional {
				positionalBase++
			}
			if seen[t.Name] {
				continue
			}
			seen[t.Name] = true
			out = append(out, t.Param)
		}
	}
	return out
}

// isStoredProgramDDL reports whether a statement creates a stored program,
// where a colon-prefixed word is part of the language rather than a
// placeholder.
func isStoredProgramDDL(stmt string) bool {
	upper := strings.ToUpper(strings.TrimSpace(skipLeadingNoise(stmt)))
	if !strings.HasPrefix(upper, "CREATE") {
		return false
	}
	rest := strings.TrimSpace(strings.TrimPrefix(upper, "CREATE"))
	rest = strings.TrimSpace(strings.TrimPrefix(rest, "OR REPLACE"))
	for _, kw := range []string{"PROCEDURE", "FUNCTION", "PACKAGE", "TRIGGER", "TYPE", "VIEW"} {
		if strings.HasPrefix(rest, kw) {
			return true
		}
	}
	return false
}

// paramToken is one recognised placeholder with its position in the
// statement's rune slice, so the rewrite can splice replacements in without
// re-scanning. positionalBase, threaded through scanParamTokens, continues
// the "?" numbering from the statements already scanned.
type paramToken struct {
	Param
	start int
	end   int
}

func scanParamTokens(stmt string, dbType db.DBType, positionalBase int) []paramToken {
	text := []rune(stmt)
	tokens := sqlintel.Tokenize(text)

	var out []paramToken
	positional := positionalBase

	for _, t := range tokens {
		if t.Kind != sqlintel.TokenParam {
			continue
		}
		sigil := t.Text[0]
		name := t.Text[1:]

		switch sigil {
		case ':':
			// A bare ":" is the head of PL/SQL's ":=" assignment or of
			// Postgres's "::" cast — never a parameter.
			if name == "" {
				continue
			}
			// "a::integer" lexes as ":" then ":integer"; the second half is
			// the cast's type name, not a placeholder. The only way to tell
			// is to look at what precedes it in the source.
			if t.Start > 0 && text[t.Start-1] == ':' {
				continue
			}
			// Oracle's trigger correlation names. They are the one
			// colon-prefixed construct that survives outside a CREATE
			// TRIGGER (in a WHEN clause, in generated DDL pasted into the
			// editor), so excluding them by name is worth the false
			// negative of someone genuinely naming a parameter "new".
			if strings.EqualFold(name, "new") || strings.EqualFold(name, "old") ||
				strings.EqualFold(name, "parent") {
				continue
			}

		case '$':
			// Postgres numbered placeholders only. A "$" followed by a word
			// is not a placeholder in any of the four engines.
			if name == "" || !isAllDigits(name) {
				continue
			}
			if dbType != db.DBTypePostgres {
				continue
			}

		case '?':
			// SQLite and SQL Server accept the anonymous form. Oracle and
			// Postgres do not, and a stray "?" there is far more likely to
			// be a typo than a parameter.
			if name != "" {
				continue
			}
			if dbType != db.DBTypeSQLite && dbType != db.DBTypeSQLServer {
				continue
			}
			positional++
			out = append(out, paramToken{
				Param: Param{Name: strconv.Itoa(positional), Raw: "?", Positional: true},
				start: t.Start, end: t.End,
			})
			continue

		default:
			// "@name" is deliberately not recognised: on SQL Server it is
			// also how a local variable declared with DECLARE is written,
			// and there is no way to tell the two apart without parsing the
			// whole batch. ":name" works there too and is unambiguous.
			continue
		}

		out = append(out, paramToken{
			Param: Param{Name: name, Raw: t.Text},
			start: t.Start, end: t.End,
		})
	}

	return out
}

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// BindStatement rewrites stmt so every placeholder becomes the ordinal form
// dbType's driver understands, and returns the argument list to pass
// alongside it. A statement with no placeholders comes back untouched with
// a nil argument list, which is exactly what the executor did before this
// existed.
//
// A placeholder used twice gets two ordinals with the same value repeated,
// rather than one ordinal referenced twice. Every driver accepts the
// former; whether it accepts the latter is engine-specific, and there is
// nothing to gain from finding out.
//
// A placeholder with no value supplied is an error, not a silent NULL. The
// dialog always supplies one for every parameter it listed (blank counts as
// supplied), so reaching this means the statement was run through a path
// that never asked — and binding NULL there would turn "you did not answer"
// into a query that runs and quietly matches nothing.
func BindStatement(stmt string, dbType db.DBType, values map[string]ParamValue, positionalBase int) (string, []interface{}, error) {
	if isStoredProgramDDL(stmt) {
		return stmt, nil, nil
	}
	toks := scanParamTokens(stmt, dbType, positionalBase)
	if len(toks) == 0 {
		return stmt, nil, nil
	}

	text := []rune(stmt)
	var b strings.Builder
	args := make([]interface{}, 0, len(toks))
	prev := 0

	for _, t := range toks {
		v, ok := values[t.Name]
		if !ok {
			return "", nil, fmt.Errorf("query: falta el valor del parámetro %s", t.Raw)
		}
		b.WriteString(string(text[prev:t.start]))
		b.WriteString(ordinalPlaceholder(dbType, len(args)+1))
		args = append(args, bindValue(v))
		prev = t.end
	}
	b.WriteString(string(text[prev:]))

	return b.String(), args, nil
}

// ordinalPlaceholder writes the nth placeholder in the syntax dbType's
// driver binds by position — the same forms backend/db/metadata.go's own
// catalog queries already use.
func ordinalPlaceholder(dbType db.DBType, n int) string {
	switch dbType {
	case db.DBTypePostgres:
		return "$" + strconv.Itoa(n)
	case db.DBTypeOracle:
		return ":" + strconv.Itoa(n)
	case db.DBTypeSQLServer:
		return "@p" + strconv.Itoa(n)
	default:
		return "?"
	}
}

// bindValue converts a dialog value into what the driver receives. An
// unrecognised type falls back to text rather than failing: a value the
// engine can cast is better than a refused execution.
func bindValue(v ParamValue) interface{} {
	switch strings.ToLower(strings.TrimSpace(v.Type)) {
	case ParamTypeNull:
		return nil
	case ParamTypeNumber:
		text := strings.TrimSpace(v.Value)
		if text == "" {
			return nil
		}
		if i, err := strconv.ParseInt(text, 10, 64); err == nil {
			return i
		}
		if f, err := strconv.ParseFloat(text, 64); err == nil {
			return f
		}
		// Unparseable: hand the text over and let the engine's own error
		// say what is wrong with it, which is more informative than
		// anything this function could invent.
		return text
	case ParamTypeBoolean:
		return strings.EqualFold(strings.TrimSpace(v.Value), "true")
	default:
		return v.Value
	}
}

// ParamValuesByName indexes a supplied value list for BindStatement.
func ParamValuesByName(values []ParamValue) map[string]ParamValue {
	out := make(map[string]ParamValue, len(values))
	for _, v := range values {
		out[v.Name] = v
	}
	return out
}
