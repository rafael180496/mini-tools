package sqlintel

// Offset conversion between CodeMirror and Go.
//
// CodeMirror positions are JavaScript string indices, i.e. UTF-16 code
// units: every character in the Basic Multilingual Plane counts 1, and
// anything above it (emoji, some CJK extensions) counts 2. Go strings are
// UTF-8 bytes, and this package works in runes (1 per character, always).
// Three different units for the same position.
//
// Nothing in between is allowed to guess: a single accented character in a
// comment ahead of the cursor is enough to make a byte offset wrong, and an
// emoji in a string literal is enough to make a rune offset wrong. The two
// helpers below convert exactly, in both directions, so the frontend can
// keep speaking UTF-16 and the engine can keep speaking runes.
//
// Both are O(offset) scans over a statement-sized string — a few hundred
// characters in practice, far below the IPC round trip they ride on.

// utf16Len is the number of UTF-16 code units a rune occupies.
func utf16Len(r rune) int {
	if r > 0xFFFF {
		return 2
	}
	return 1
}

// RuneOffset converts a UTF-16 code-unit offset (what CodeMirror sends)
// into a rune offset into text. An offset past the end clamps to the end;
// an offset landing in the middle of a surrogate pair rounds down to the
// start of that rune, which is the only sane reading of a position that
// cannot exist in Go.
func RuneOffset(text []rune, utf16Offset int) int {
	if utf16Offset <= 0 {
		return 0
	}
	units := 0
	for i, r := range text {
		if units >= utf16Offset {
			return i
		}
		units += utf16Len(r)
	}
	return len(text)
}

// UTF16Offset converts a rune offset back into the UTF-16 code-unit offset
// CodeMirror expects — used for Response.From, which tells the editor where
// the replacement range starts.
func UTF16Offset(text []rune, runeOffset int) int {
	if runeOffset <= 0 {
		return 0
	}
	if runeOffset > len(text) {
		runeOffset = len(text)
	}
	units := 0
	for i := 0; i < runeOffset; i++ {
		units += utf16Len(text[i])
	}
	return units
}
