package mongoquery

import (
	"fmt"
	"strconv"
	"strings"
	"unicode"
)

// toExtJSON converts a lenient mongosh-style value into strict MongoDB
// Extended JSON that bson.UnmarshalExtJSON accepts. It handles the parts of
// JS-object syntax people actually paste from Compass/mongosh: unquoted object
// keys, single-quoted strings, // and /* */ comments, trailing commas, and the
// common constructor helpers (ObjectId, ISODate/Date/new Date, NumberLong,
// NumberInt, NumberDecimal, UUID). It is deliberately a small recursive-descent
// parser, NOT a JS engine — same bounded-scope philosophy as the hand-rolled
// backend/query/splitter.go (see .claude/rules/technical.md point 7). Anything
// it doesn't recognize is a clear error, never a silent mis-parse.
func toExtJSON(src string) (string, error) {
	p := &extjsonParser{s: []rune(src)}
	p.ws()
	if err := p.value(); err != nil {
		return "", err
	}
	p.ws()
	if p.i < len(p.s) {
		return "", fmt.Errorf("texto sobrante después del valor: %q", strings.TrimSpace(string(p.s[p.i:])))
	}
	return p.out.String(), nil
}

type extjsonParser struct {
	s   []rune
	i   int
	out strings.Builder
}

func (p *extjsonParser) peek() rune {
	if p.i < len(p.s) {
		return p.s[p.i]
	}
	return 0
}

// ws skips whitespace plus // line comments and /* */ block comments.
func (p *extjsonParser) ws() {
	for p.i < len(p.s) {
		c := p.s[p.i]
		switch {
		case unicode.IsSpace(c):
			p.i++
		case c == '/' && p.i+1 < len(p.s) && p.s[p.i+1] == '/':
			for p.i < len(p.s) && p.s[p.i] != '\n' {
				p.i++
			}
		case c == '/' && p.i+1 < len(p.s) && p.s[p.i+1] == '*':
			p.i += 2
			for p.i+1 < len(p.s) && !(p.s[p.i] == '*' && p.s[p.i+1] == '/') {
				p.i++
			}
			p.i += 2
		default:
			return
		}
	}
}

func (p *extjsonParser) value() error {
	p.ws()
	if p.i >= len(p.s) {
		return fmt.Errorf("se esperaba un valor pero se llegó al final")
	}
	c := p.s[p.i]
	switch {
	case c == '{':
		return p.object()
	case c == '[':
		return p.array()
	case c == '\'' || c == '"':
		s, err := p.stringLit()
		if err != nil {
			return err
		}
		p.out.WriteString(encodeJSONString(s))
		return nil
	case c == '-' || c == '+' || (c >= '0' && c <= '9') || c == '.':
		return p.number()
	case isIdentStart(c):
		return p.identLike()
	default:
		return fmt.Errorf("carácter inesperado %q", string(c))
	}
}

func (p *extjsonParser) object() error {
	p.i++ // {
	p.out.WriteByte('{')
	p.ws()
	if p.peek() == '}' {
		p.i++
		p.out.WriteByte('}')
		return nil
	}
	for {
		p.ws()
		// key: quoted string or bare identifier (incl. $ operators like $gt).
		var key string
		if c := p.peek(); c == '\'' || c == '"' {
			k, err := p.stringLit()
			if err != nil {
				return err
			}
			key = k
		} else if isIdentStart(c) {
			key = p.readIdent()
		} else {
			return fmt.Errorf("se esperaba una clave, se encontró %q", string(c))
		}
		p.out.WriteString(encodeJSONString(key))

		p.ws()
		if p.peek() != ':' {
			return fmt.Errorf("se esperaba ':' después de la clave %q", key)
		}
		p.i++
		p.out.WriteByte(':')

		if err := p.value(); err != nil {
			return err
		}

		p.ws()
		switch p.peek() {
		case ',':
			p.i++
			p.ws()
			if p.peek() == '}' { // trailing comma
				p.i++
				p.out.WriteByte('}')
				return nil
			}
			p.out.WriteByte(',')
		case '}':
			p.i++
			p.out.WriteByte('}')
			return nil
		default:
			return fmt.Errorf("se esperaba ',' o '}' en el objeto")
		}
	}
}

func (p *extjsonParser) array() error {
	p.i++ // [
	p.out.WriteByte('[')
	p.ws()
	if p.peek() == ']' {
		p.i++
		p.out.WriteByte(']')
		return nil
	}
	for {
		if err := p.value(); err != nil {
			return err
		}
		p.ws()
		switch p.peek() {
		case ',':
			p.i++
			p.ws()
			if p.peek() == ']' { // trailing comma
				p.i++
				p.out.WriteByte(']')
				return nil
			}
			p.out.WriteByte(',')
		case ']':
			p.i++
			p.out.WriteByte(']')
			return nil
		default:
			return fmt.Errorf("se esperaba ',' o ']' en el array")
		}
	}
}

func (p *extjsonParser) number() error {
	start := p.i
	if c := p.peek(); c == '-' || c == '+' {
		p.i++
	}
	for p.i < len(p.s) {
		c := p.s[p.i]
		if (c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-' {
			p.i++
			continue
		}
		break
	}
	lit := string(p.s[start:p.i])
	if _, err := strconv.ParseFloat(lit, 64); err != nil {
		return fmt.Errorf("número inválido %q", lit)
	}
	p.out.WriteString(lit)
	return nil
}

// identLike handles true/false/null, and constructor helpers (optionally
// prefixed with `new`), producing the corresponding Extended JSON.
func (p *extjsonParser) identLike() error {
	name := p.readIdent()
	switch name {
	case "true", "false", "null":
		p.out.WriteString(name)
		return nil
	case "new":
		p.ws()
		if !isIdentStart(p.peek()) {
			return fmt.Errorf("se esperaba un constructor después de 'new'")
		}
		name = p.readIdent()
	}
	// Must be a helper call: name(...)
	p.ws()
	if p.peek() != '(' {
		return fmt.Errorf("identificador inesperado %q (¿faltan comillas?)", name)
	}
	arg, isString, hadArg, err := p.helperArg()
	if err != nil {
		return err
	}
	return p.emitHelper(name, arg, isString, hadArg)
}

// helperArg reads a single ( string | number ) argument (or none) up to ')'.
func (p *extjsonParser) helperArg() (arg string, isString, hadArg bool, err error) {
	p.i++ // (
	p.ws()
	if p.peek() == ')' {
		p.i++
		return "", false, false, nil
	}
	if c := p.peek(); c == '\'' || c == '"' {
		s, e := p.stringLit()
		if e != nil {
			return "", false, false, e
		}
		arg, isString = s, true
	} else {
		start := p.i
		if c := p.peek(); c == '-' || c == '+' {
			p.i++
		}
		for p.i < len(p.s) {
			c := p.s[p.i]
			if (c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-' {
				p.i++
				continue
			}
			break
		}
		arg = string(p.s[start:p.i])
	}
	p.ws()
	if p.peek() != ')' {
		return "", false, false, fmt.Errorf("se esperaba ')' cerrando el argumento")
	}
	p.i++
	return arg, isString, true, nil
}

func (p *extjsonParser) emitHelper(name, arg string, isString, hadArg bool) error {
	switch name {
	case "ObjectId":
		if !hadArg {
			return fmt.Errorf("ObjectId() requiere un argumento")
		}
		p.out.WriteString(`{"$oid":` + encodeJSONString(arg) + `}`)
	case "ISODate", "Date":
		if !hadArg {
			return fmt.Errorf("%s() requiere un argumento (fecha ISO)", name)
		}
		if isString {
			p.out.WriteString(`{"$date":` + encodeJSONString(arg) + `}`)
		} else {
			p.out.WriteString(`{"$date":{"$numberLong":` + encodeJSONString(arg) + `}}`)
		}
	case "NumberLong":
		if !hadArg {
			return fmt.Errorf("NumberLong() requiere un argumento")
		}
		p.out.WriteString(`{"$numberLong":` + encodeJSONString(arg) + `}`)
	case "NumberDecimal":
		if !hadArg {
			return fmt.Errorf("NumberDecimal() requiere un argumento")
		}
		p.out.WriteString(`{"$numberDecimal":` + encodeJSONString(arg) + `}`)
	case "NumberInt":
		if !hadArg {
			return fmt.Errorf("NumberInt() requiere un argumento")
		}
		if isString {
			p.out.WriteString(arg) // caller wrote digits in quotes; emit bare
		} else {
			p.out.WriteString(arg)
		}
	case "UUID":
		if !hadArg {
			return fmt.Errorf("UUID() requiere un argumento")
		}
		p.out.WriteString(`{"$uuid":` + encodeJSONString(arg) + `}`)
	default:
		return fmt.Errorf("constructor no soportado %q()", name)
	}
	return nil
}

// stringLit reads a single- or double-quoted string and returns its decoded
// value (handling \n \t \" \' \\ \/ \uXXXX escapes).
func (p *extjsonParser) stringLit() (string, error) {
	quote := p.s[p.i]
	p.i++
	var b strings.Builder
	for p.i < len(p.s) {
		c := p.s[p.i]
		if c == quote {
			p.i++
			return b.String(), nil
		}
		if c == '\\' && p.i+1 < len(p.s) {
			p.i++
			e := p.s[p.i]
			switch e {
			case 'n':
				b.WriteByte('\n')
			case 't':
				b.WriteByte('\t')
			case 'r':
				b.WriteByte('\r')
			case 'b':
				b.WriteByte('\b')
			case 'f':
				b.WriteByte('\f')
			case '"', '\'', '\\', '/':
				b.WriteRune(e)
			case 'u':
				if p.i+4 < len(p.s) {
					hex := string(p.s[p.i+1 : p.i+5])
					if n, err := strconv.ParseInt(hex, 16, 32); err == nil {
						b.WriteRune(rune(n))
						p.i += 4
					}
				}
			default:
				b.WriteRune(e)
			}
			p.i++
			continue
		}
		b.WriteRune(c)
		p.i++
	}
	return "", fmt.Errorf("string sin cerrar")
}

func (p *extjsonParser) readIdent() string {
	start := p.i
	for p.i < len(p.s) && isIdentPart(p.s[p.i]) {
		p.i++
	}
	return string(p.s[start:p.i])
}

func isIdentStart(c rune) bool {
	return unicode.IsLetter(c) || c == '_' || c == '$'
}

func isIdentPart(c rune) bool {
	return unicode.IsLetter(c) || unicode.IsDigit(c) || c == '_' || c == '$'
}

// encodeJSONString emits a strict JSON double-quoted string for s.
func encodeJSONString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\t':
			b.WriteString(`\t`)
		case '\r':
			b.WriteString(`\r`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		default:
			if r < 0x20 {
				b.WriteString(fmt.Sprintf(`\u%04x`, r))
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}
