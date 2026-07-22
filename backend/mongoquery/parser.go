package mongoquery

import (
	"fmt"
	"strings"
	"unicode"
)

// command is one parsed mongosh statement: db.<collection>.<method>(args...)
// optionally followed by chained cursor calls (.sort(...).limit(...) etc.).
type command struct {
	raw        string
	collection string
	method     string
	args       []string     // raw per-argument source (each convertible via toExtJSON)
	chain      []chainCall
}

type chainCall struct {
	method string
	args   []string
}

// parseStatements parses a whole editor buffer into its individual mongosh
// commands. It does NOT split on newlines/`;` blindly (pretty-printed args span
// many lines); instead it greedily consumes one balanced db.coll.method(...)
// chain at a time, skipping whitespace, // and /* */ comments, and stray `;`
// between statements — robust to multi-line arguments.
func parseStatements(text string) ([]command, error) {
	sc := &scanner{s: []rune(text)}
	var cmds []command
	for {
		sc.skipGaps()
		if sc.eof() {
			break
		}
		cmd, err := sc.parseOne()
		if err != nil {
			return nil, err
		}
		cmds = append(cmds, cmd)
	}
	return cmds, nil
}

type scanner struct {
	s []rune
	i int
}

func (sc *scanner) eof() bool  { return sc.i >= len(sc.s) }
func (sc *scanner) peek() rune {
	if sc.i < len(sc.s) {
		return sc.s[sc.i]
	}
	return 0
}

func (sc *scanner) skipWSComments() {
	for sc.i < len(sc.s) {
		c := sc.s[sc.i]
		switch {
		case unicode.IsSpace(c):
			sc.i++
		case c == '/' && sc.i+1 < len(sc.s) && sc.s[sc.i+1] == '/':
			for sc.i < len(sc.s) && sc.s[sc.i] != '\n' {
				sc.i++
			}
		case c == '/' && sc.i+1 < len(sc.s) && sc.s[sc.i+1] == '*':
			sc.i += 2
			for sc.i+1 < len(sc.s) && !(sc.s[sc.i] == '*' && sc.s[sc.i+1] == '/') {
				sc.i++
			}
			sc.i += 2
		default:
			return
		}
	}
}

// skipGaps skips whitespace, comments, and stray statement separators (`;`).
func (sc *scanner) skipGaps() {
	for {
		sc.skipWSComments()
		if sc.peek() == ';' {
			sc.i++
			continue
		}
		return
	}
}

func (sc *scanner) readIdent() string {
	start := sc.i
	for sc.i < len(sc.s) {
		c := sc.s[sc.i]
		if unicode.IsLetter(c) || unicode.IsDigit(c) || c == '_' || c == '$' {
			sc.i++
			continue
		}
		break
	}
	return string(sc.s[start:sc.i])
}

// readBalanced reads from an opening delimiter to its match, respecting nested
// () [] {} and single/double-quoted strings, and returns the inner content
// (without the outer delimiters).
func (sc *scanner) readBalanced(open, close rune) (string, error) {
	if sc.peek() != open {
		return "", fmt.Errorf("se esperaba %q", string(open))
	}
	start := sc.i + 1
	depth := 0
	var quote rune
	for sc.i < len(sc.s) {
		c := sc.s[sc.i]
		if quote != 0 {
			if c == '\\' {
				sc.i += 2
				continue
			}
			if c == quote {
				quote = 0
			}
			sc.i++
			continue
		}
		switch c {
		case '\'', '"':
			quote = c
		case '(', '[', '{':
			depth++
		case ')', ']', '}':
			depth--
			if depth == 0 {
				inner := string(sc.s[start:sc.i])
				sc.i++
				return inner, nil
			}
		}
		sc.i++
	}
	return "", fmt.Errorf("delimitador %q sin cerrar", string(open))
}

// parseOne parses a single db.<collection>.<method>(...)[.chain(...)]* command.
func (sc *scanner) parseOne() (command, error) {
	startRaw := sc.i
	sc.skipWSComments()
	if sc.readIdent() != "db" {
		return command{}, fmt.Errorf("un comando debe empezar con 'db.' (posición %d)", startRaw)
	}
	sc.skipWSComments()

	var collection string
	switch sc.peek() {
	case '[':
		inner, err := sc.readBalanced('[', ']')
		if err != nil {
			return command{}, err
		}
		collection = strings.Trim(strings.TrimSpace(inner), `'"`)
	case '.':
		sc.i++
		sc.skipWSComments()
		ident := sc.readIdent()
		if ident == "" {
			return command{}, fmt.Errorf("se esperaba el nombre de la colección después de 'db.'")
		}
		sc.skipWSComments()
		if sc.peek() == '(' {
			// db.getCollection("name") — the only db-level call supported.
			inner, err := sc.readBalanced('(', ')')
			if err != nil {
				return command{}, err
			}
			if ident != "getCollection" {
				return command{}, fmt.Errorf("db.%s() no soportado; usar db.<colección>.<método>()", ident)
			}
			collection = strings.Trim(strings.TrimSpace(inner), `'"`)
		} else {
			collection = ident
		}
	default:
		return command{}, fmt.Errorf("se esperaba '.' o '[' después de 'db'")
	}
	if collection == "" {
		return command{}, fmt.Errorf("no se pudo determinar la colección")
	}

	// Primary method call.
	sc.skipWSComments()
	if sc.peek() != '.' {
		return command{}, fmt.Errorf("falta el método: db.%s.<método>(...)", collection)
	}
	sc.i++
	method := sc.readIdent()
	if method == "" {
		return command{}, fmt.Errorf("se esperaba un método después de db.%s.", collection)
	}
	sc.skipWSComments()
	inner, err := sc.readBalanced('(', ')')
	if err != nil {
		return command{}, err
	}
	args, err := splitArgs(inner)
	if err != nil {
		return command{}, err
	}

	cmd := command{collection: collection, method: method, args: args}

	// Chained cursor calls: .sort(...).limit(...).skip(...) etc.
	for {
		sc.skipWSComments()
		if sc.peek() != '.' {
			break
		}
		sc.i++
		cm := sc.readIdent()
		if cm == "" {
			return command{}, fmt.Errorf("se esperaba un método encadenado después de '.'")
		}
		sc.skipWSComments()
		var cargs []string
		if sc.peek() == '(' {
			cinner, err := sc.readBalanced('(', ')')
			if err != nil {
				return command{}, err
			}
			if cargs, err = splitArgs(cinner); err != nil {
				return command{}, err
			}
		}
		cmd.chain = append(cmd.chain, chainCall{method: cm, args: cargs})
	}

	cmd.raw = strings.TrimSpace(string(sc.s[startRaw:sc.i]))
	return cmd, nil
}

// splitArgs splits a call's inner content on top-level commas, respecting
// nested () [] {} and strings. Returns nil for an empty/whitespace inner.
func splitArgs(inner string) ([]string, error) {
	if strings.TrimSpace(inner) == "" {
		return nil, nil
	}
	runes := []rune(inner)
	var args []string
	depth := 0
	var quote rune
	start := 0
	for i := 0; i < len(runes); i++ {
		c := runes[i]
		if quote != 0 {
			if c == '\\' {
				i++
				continue
			}
			if c == quote {
				quote = 0
			}
			continue
		}
		switch c {
		case '\'', '"':
			quote = c
		case '(', '[', '{':
			depth++
		case ')', ']', '}':
			depth--
		case ',':
			if depth == 0 {
				args = append(args, strings.TrimSpace(string(runes[start:i])))
				start = i + 1
			}
		}
	}
	if quote != 0 {
		return nil, fmt.Errorf("string sin cerrar en los argumentos")
	}
	args = append(args, strings.TrimSpace(string(runes[start:])))
	return args, nil
}
