// Package redisquery runs redis-cli-style command scripts against a
// RedisPoolManager and streams results back, mirroring backend/query's
// Event/EmitFunc/HistorySink/cancel-registry pattern for SQL — but for
// Redis command results instead of tabular rows. See
// .claude/skills/mini-tools-patterns/SKILL.md's Redis section for the
// architecture rationale (native parallel path, not database/sql).
package redisquery

import "strings"

// SplitCommands splits a block of redis-cli-style text into individual
// commands, one per logical line. Blank lines and lines starting with '#'
// (redis-cli's own comment convention) are skipped. Hand-rolled, no parsing
// library — same "no SQL parsing library" philosophy as
// backend/query/splitter.go (.claude/rules/technical.md point 7), applied
// to Redis's much simpler one-command-per-line shape instead of SQL's
// semicolon-delimited, comment/quote-aware statement splitting.
func SplitCommands(text string) []string {
	var commands []string
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		commands = append(commands, trimmed)
	}
	return commands
}

// TokenizeCommand splits one command line into arguments, honoring single
// and double quotes (redis-cli convention) so a value containing spaces —
// e.g. SET greeting "hello world" — is passed as one argument, not two. An
// unterminated quote simply extends to end of line rather than erroring,
// staying permissive like the project's other hand-rolled parsers
// (frontend/src/lib/linter.ts, connStringParser.ts).
func TokenizeCommand(line string) []string {
	var tokens []string
	var cur strings.Builder
	var quote rune
	hasToken := false

	for _, r := range line {
		switch {
		case quote != 0:
			if r == quote {
				quote = 0
			} else {
				cur.WriteRune(r)
			}
		case r == '\'' || r == '"':
			quote = r
			hasToken = true
		case r == ' ' || r == '\t':
			if hasToken {
				tokens = append(tokens, cur.String())
				cur.Reset()
				hasToken = false
			}
		default:
			cur.WriteRune(r)
			hasToken = true
		}
	}
	if hasToken {
		tokens = append(tokens, cur.String())
	}
	return tokens
}
