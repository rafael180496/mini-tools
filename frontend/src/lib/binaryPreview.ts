// Detects when a Redis string value isn't safe to render as plain text —
// e.g. a Sidekiq/Resque uniqueness-lock key or a marshaled object stored as
// raw bytes. By the time a value reaches the frontend it's already gone
// through Go's json.Marshal on the backend, which replaces any invalid
// UTF-8 byte with the Unicode replacement character (U+FFFD) — so this
// can't recover the exact original bytes, only detect that SOMETHING
// non-printable is in there and avoid rendering a confusing "tofu" box
// (the browser's missing-glyph placeholder) in its place.
//
// Deliberately checks char codes numerically instead of a regex character
// class with \u escapes — a real gotcha already hit once in this codebase
// (see .claude/skills/mini-tools-patterns/SKILL.md): an escape sequence
// meant as literal text ended up written as a raw control byte in the
// source file instead, which broke `grep`/text tooling on that file.
// Numeric comparisons have no escape sequences to get mangled.
const REPLACEMENT_CHAR_CODE = 0xfffd

function isControlOrReplacementChar(code: number): boolean {
    if (code === REPLACEMENT_CHAR_CODE) return true
    if (code === 9 || code === 10 || code === 13) return false // tab/LF/CR are fine
    if (code < 32) return true
    return false
}

export function looksBinary(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
        if (isControlOrReplacementChar(s.charCodeAt(i))) return true
    }
    return false
}
