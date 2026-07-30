// Package sqlintel is the SQL IntelliSense engine: a fault-tolerant
// tokenizer, cursor scope resolution, an in-memory schema index with fuzzy
// matching, FK-driven JOIN condition resolution, and a per-engine dialect
// catalog — everything the editor needs to answer "what can go here?".
//
// It lives in Go rather than in the frontend so the analysis sits next to
// the metadata that feeds it (backend/db) and stays a single implementation
// across the four relational engines. The frontend's CodeMirror completion
// source is a thin caller (frontend/src/codemirror/sqlIntel.ts).
//
// Hand-rolled on purpose, same reasoning as backend/query/splitter.go and
// .claude/rules/technical.md point 7: no SQL grammar library covers
// Oracle + Postgres + SQLite + SQL Server at once, and completion tolerates
// an approximate parse (a wrong guess degrades a suggestion list, it never
// breaks execution). Everything here is therefore best-effort and MUST NOT
// error out on malformed input — the input is a half-typed statement by
// definition.
//
// The package holds no database handle and never executes SQL: it is fed a
// *db.SchemaMetadata that somebody else already fetched.
package sqlintel

import "strings"

// TokenKind classifies a token well enough for scope resolution. Keywords
// are not distinguished from identifiers here — the tokenizer has no
// dialect knowledge, so "user" is an identifier to it; the clause detector
// in context.go decides what a word means from its position.
type TokenKind int

const (
	// TokenWord is a bare identifier or keyword ([A-Za-z_][A-Za-z0-9_$#]*).
	TokenWord TokenKind = iota
	// TokenQuoted is a delimited identifier: "x", [x] or `x`.
	TokenQuoted
	// TokenString is a string literal, including Postgres dollar-quoting.
	TokenString
	// TokenNumber is a numeric literal.
	TokenNumber
	// TokenPunct is any single punctuation character (. , ( ) ; * = ...).
	TokenPunct
	// TokenComment is a -- line comment or a /* */ block comment.
	TokenComment
	// TokenParam is a bind parameter (:name, :1, $1, ?, @name).
	TokenParam
)

// Token is one lexical unit with its position in the ORIGINAL rune slice.
// Offsets are rune indices, not byte offsets — see offsets.go for why the
// whole package works in runes.
type Token struct {
	Kind  TokenKind
	Text  string // raw source text, delimiters included
	Value string // Text with identifier delimiters stripped; == Text otherwise
	Start int    // rune offset of the first character
	End   int    // rune offset one past the last character
}

// IsWordLike reports whether the token can name a table/column/alias —
// a bare word or a delimited identifier, never a literal or punctuation.
func (t Token) IsWordLike() bool {
	return t.Kind == TokenWord || t.Kind == TokenQuoted
}

// Upper is the token's value folded to upper case, for keyword comparison.
func (t Token) Upper() string { return strings.ToUpper(t.Value) }

// Is reports whether the token is the given (case-insensitive) keyword.
func (t Token) Is(keyword string) bool {
	return t.Kind == TokenWord && strings.EqualFold(t.Value, keyword)
}

// Tokenize splits src into tokens, skipping whitespace. It never fails and
// never panics: an unterminated string, comment or delimited identifier
// simply runs to the end of input and is returned as a complete token —
// that is the normal state of a statement being typed, not an error.
//
// Comments ARE returned rather than dropped so callers can tell "the cursor
// is inside a comment" (where no completion should fire) from "the cursor
// is in code"; every other consumer filters them out via Code().
func Tokenize(src []rune) []Token {
	tokens := make([]Token, 0, len(src)/4+8)
	i := 0
	n := len(src)

	for i < n {
		c := src[i]

		switch {
		case isSpace(c):
			i++

		case c == '-' && i+1 < n && src[i+1] == '-':
			start := i
			for i < n && src[i] != '\n' {
				i++
			}
			tokens = append(tokens, mkToken(TokenComment, src, start, i))

		case c == '/' && i+1 < n && src[i+1] == '*':
			start := i
			i += 2
			for i < n && !(src[i] == '*' && i+1 < n && src[i+1] == '/') {
				i++
			}
			if i < n {
				i += 2 // consume the closing */
			}
			tokens = append(tokens, mkToken(TokenComment, src, start, i))

		case c == '\'':
			start := i
			i++
			for i < n {
				if src[i] == '\'' {
					// '' is an escaped quote inside the literal, not the end.
					if i+1 < n && src[i+1] == '\'' {
						i += 2
						continue
					}
					i++
					break
				}
				i++
			}
			tokens = append(tokens, mkToken(TokenString, src, start, i))

		case c == '$' && isDollarQuoteStart(src, i):
			// Postgres $$...$$ / $tag$...$tag$ — the same construct
			// backend/query/splitter.go has to know about, for the same
			// reason: its body is opaque text that must not be tokenized.
			start := i
			tag, bodyStart := readDollarTag(src, i)
			i = bodyStart
			closing := "$" + tag + "$"
			if idx := indexRunes(src, i, closing); idx >= 0 {
				i = idx + len([]rune(closing))
			} else {
				i = n
			}
			tokens = append(tokens, mkToken(TokenString, src, start, i))

		case c == '"' || c == '`':
			closer := c
			start := i
			i++
			for i < n && src[i] != closer {
				i++
			}
			if i < n {
				i++
			}
			tok := mkToken(TokenQuoted, src, start, i)
			tok.Value = trimDelims(tok.Text, string(closer), string(closer))
			tokens = append(tokens, tok)

		case c == '[':
			// SQL Server delimited identifier. Ambiguous with nothing else
			// the other three engines use at statement level, so accepting
			// it unconditionally costs nothing.
			start := i
			i++
			for i < n && src[i] != ']' {
				i++
			}
			if i < n {
				i++
			}
			tok := mkToken(TokenQuoted, src, start, i)
			tok.Value = trimDelims(tok.Text, "[", "]")
			tokens = append(tokens, tok)

		case isDigit(c):
			start := i
			for i < n && (isDigit(src[i]) || src[i] == '.') {
				i++
			}
			tokens = append(tokens, mkToken(TokenNumber, src, start, i))

		case c == ':' || c == '$' || c == '@' || c == '?':
			// Bind parameters across the four engines: Oracle :name/:1,
			// Postgres $1, SQL Server @p1, and the positional ? both SQLite
			// and SQL Server accept. A lone ':' or '@' with no name after it
			// still lexes as a param token — harmless, and it keeps a
			// half-typed ":" from being mistaken for punctuation that would
			// reset the clause state machine.
			start := i
			i++
			for i < n && isWordChar(src[i]) {
				i++
			}
			tokens = append(tokens, mkToken(TokenParam, src, start, i))

		case isWordStart(c):
			start := i
			for i < n && isWordChar(src[i]) {
				i++
			}
			tokens = append(tokens, mkToken(TokenWord, src, start, i))

		default:
			tokens = append(tokens, mkToken(TokenPunct, src, i, i+1))
			i++
		}
	}

	return tokens
}

// Code returns tokens with comments removed — what every analysis pass
// other than "is the cursor inside a comment" actually wants.
func Code(tokens []Token) []Token {
	out := tokens[:0:0]
	for _, t := range tokens {
		if t.Kind != TokenComment {
			out = append(out, t)
		}
	}
	return out
}

// InLiteralOrComment reports whether offset falls inside a string literal
// or a comment, where completion must stay silent. An unterminated literal
// counts: typing inside 'abc| is still inside a string.
func InLiteralOrComment(tokens []Token, offset int) bool {
	for _, t := range tokens {
		if t.Kind != TokenString && t.Kind != TokenComment {
			continue
		}
		if offset > t.Start && offset <= t.End {
			return true
		}
	}
	return false
}

func mkToken(kind TokenKind, src []rune, start, end int) Token {
	text := string(src[start:end])
	return Token{Kind: kind, Text: text, Value: text, Start: start, End: end}
}

func trimDelims(text, open, close string) string {
	text = strings.TrimPrefix(text, open)
	text = strings.TrimSuffix(text, close)
	return text
}

// isDollarQuoteStart reports whether src[i] opens a Postgres dollar-quoted
// string ($$ or $tag$) rather than a $1 bind parameter.
func isDollarQuoteStart(src []rune, i int) bool {
	n := len(src)
	j := i + 1
	for j < n && isWordChar(src[j]) && !isDigit(src[j]) {
		j++
	}
	// $1 (digits) is a parameter; $$ or $tag$ is a quote.
	return j < n && src[j] == '$' && (j == i+1 || !isDigit(src[i+1]))
}

// readDollarTag returns the tag between the opening $…$ and the offset just
// past that opening delimiter.
func readDollarTag(src []rune, i int) (tag string, bodyStart int) {
	n := len(src)
	j := i + 1
	for j < n && src[j] != '$' {
		j++
	}
	if j >= n {
		return "", n
	}
	return string(src[i+1 : j]), j + 1
}

// indexRunes finds needle in src at or after from, returning a rune index.
func indexRunes(src []rune, from int, needle string) int {
	pat := []rune(needle)
	if len(pat) == 0 || from >= len(src) {
		return -1
	}
	for i := from; i+len(pat) <= len(src); i++ {
		match := true
		for j := range pat {
			if src[i+j] != pat[j] {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}

func isSpace(c rune) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' }
func isDigit(c rune) bool { return c >= '0' && c <= '9' }

func isWordStart(c rune) bool {
	return c == '_' || c == '#' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c > 127
}

// isWordChar accepts '$' and '#' mid-identifier: both are legal in Oracle
// object names (SYS$SESSION, X#Y) and neither can start a token that gets
// here, since '$' is handled earlier as a parameter/dollar-quote.
func isWordChar(c rune) bool {
	return isWordStart(c) || isDigit(c) || c == '$'
}
