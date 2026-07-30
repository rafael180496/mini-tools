// Builds a partial patch from a unified diff: only the hunks — or only the
// LINES — the user picked.
//
// This is the piece that makes "stage this hunk" and "stage these lines"
// possible, and it is also the piece where a mistake corrupts the index
// rather than showing a wrong number. Everything here is written for that:
// the counts in a hunk header must match the body exactly or `git apply`
// rejects the patch, and the offsets between hunks must accumulate or the
// second hunk lands in the wrong place.

export interface PatchLine {
    // kind is the unified-diff prefix: ' ' context, '+' added, '-' removed,
    // '\' the "No newline at end of file" marker.
    kind: ' ' | '+' | '-' | '\\'
    text: string
}

export interface PatchHunk {
    oldStart: number
    oldCount: number
    newStart: number
    newCount: number
    // header is the original @@ line, kept verbatim for display.
    header: string
    lines: PatchLine[]
}

export interface ParsedPatch {
    // headers are everything before the first @@: the diff/index/---/+++
    // lines. Reproduced verbatim, because git needs them to know which file
    // (and which mode/rename) the hunks belong to.
    headers: string[]
    hunks: PatchHunk[]
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

// parsePatch splits git's unified diff into headers and hunks. Anything it
// does not recognise before the first hunk is kept as a header line, so
// rename/mode/binary preambles survive untouched.
export function parsePatch(patch: string): ParsedPatch {
    const out: ParsedPatch = {headers: [], hunks: []}
    if (!patch) return out

    let current: PatchHunk | null = null

    for (const raw of patch.split('\n')) {
        const m = HUNK_RE.exec(raw)
        if (m) {
            current = {
                oldStart: Number(m[1]),
                // An omitted count means 1, per the unified diff format —
                // not 0. Defaulting to 0 would silently produce empty hunks
                // for single-line changes.
                oldCount: m[2] === undefined ? 1 : Number(m[2]),
                newStart: Number(m[3]),
                newCount: m[4] === undefined ? 1 : Number(m[4]),
                header: raw,
                lines: [],
            }
            out.hunks.push(current)
            continue
        }

        if (!current) {
            // Trailing empty line of the split, not a header.
            if (raw !== '' || out.headers.length === 0) out.headers.push(raw)
            continue
        }

        if (raw === '') continue

        const kind = raw[0]
        if (kind === '+' || kind === '-' || kind === ' ' || kind === '\\') {
            current.lines.push({kind: kind as PatchLine['kind'], text: raw.slice(1)})
        }
        // Anything else (a stray line from a malformed patch) is dropped
        // rather than emitted: passing it through would make git reject the
        // whole patch instead of just losing one line nobody selected.
    }

    return out
}

// Selection identifies what to include. A hunk with no entry in
// `lines` is taken whole; an entry restricts it to those line indices.
export interface PatchSelection {
    hunks: Set<number>
    // lines maps hunk index → set of line indices inside that hunk. Only
    // consulted for hunks present in `hunks`.
    lines?: Map<number, Set<number>>
}

// buildPatch emits a patch containing only the selected hunks/lines, ready
// for `git apply`.
//
// Two things make it correct, and both are invisible until they are wrong:
//
//   1. In a partially-selected hunk, an UNSELECTED removal becomes a
//      context line (the line is still there), while an UNSELECTED addition
//      is dropped entirely (it does not exist in either side of this
//      patch). Getting this backwards produces a patch that applies cleanly
//      and deletes the wrong lines.
//   2. Each hunk's newStart is shifted by the net line delta of every hunk
//      emitted BEFORE it. Without that, the second hunk of a file lands at
//      the wrong offset — which git usually catches, but not always.
//
// Returns "" when nothing was selected, which callers treat as a no-op.
export function buildPatch(parsed: ParsedPatch, selection: PatchSelection): string {
    const chosen = parsed.hunks
        .map((hunk, index) => ({hunk, index}))
        .filter(({index}) => selection.hunks.has(index))

    if (chosen.length === 0) return ''

    const out: string[] = [...parsed.headers.filter((h) => h !== '')]
    let offset = 0

    for (const {hunk, index} of chosen) {
        const picked = selection.lines?.get(index)
        const body: string[] = []
        let oldCount = 0
        let newCount = 0

        hunk.lines.forEach((line, lineIndex) => {
            if (line.kind === '\\') {
                // The "no newline" marker belongs to whatever line preceded
                // it and is never counted. Emitted only if that line made it
                // into the output.
                if (body.length > 0) body.push('\\' + line.text)
                return
            }

            const selected = !picked || picked.has(lineIndex)

            if (line.kind === ' ') {
                body.push(' ' + line.text)
                oldCount++
                newCount++
                return
            }

            if (line.kind === '+') {
                if (selected) {
                    body.push('+' + line.text)
                    newCount++
                }
                // Unselected addition: dropped. It exists in neither side of
                // this partial patch.
                return
            }

            // '-'
            if (selected) {
                body.push('-' + line.text)
                oldCount++
            } else {
                // Unselected removal: the line stays, so it is context on
                // BOTH sides.
                body.push(' ' + line.text)
                oldCount++
                newCount++
            }
        })

        // A hunk that ended up with no actual change contributes nothing and
        // would make git reject the patch as empty.
        if (!body.some((l) => l.startsWith('+') || l.startsWith('-'))) continue

        out.push(`@@ -${hunk.oldStart},${oldCount} +${hunk.oldStart + offset},${newCount} @@`)
        out.push(...body)
        offset += newCount - oldCount
    }

    // Nothing survived the per-hunk emptiness check.
    if (!out.some((l) => l.startsWith('@@'))) return ''

    // git apply requires the trailing newline; without it the last line of
    // the patch is silently treated as incomplete.
    return out.join('\n') + '\n'
}

// selectAllHunks is the "stage this whole hunk" selection.
export function selectHunk(index: number): PatchSelection {
    return {hunks: new Set([index])}
}

// selectLines is the "stage exactly these lines" selection. Context lines
// need not be included — they are always emitted.
export function selectLines(hunkIndex: number, lineIndices: number[]): PatchSelection {
    return {hunks: new Set([hunkIndex]), lines: new Map([[hunkIndex, new Set(lineIndices)]])}
}

// isChangeLine reports whether a line can be individually selected. Context
// and the no-newline marker cannot: they are carried along, not chosen.
export function isChangeLine(line: PatchLine): boolean {
    return line.kind === '+' || line.kind === '-'
}

// hunkSummary is the label shown on a hunk's toolbar, e.g. "+3 −1".
export function hunkSummary(hunk: PatchHunk): {added: number; removed: number} {
    let added = 0
    let removed = 0
    for (const l of hunk.lines) {
        if (l.kind === '+') added++
        else if (l.kind === '-') removed++
    }
    return {added, removed}
}

// docLineMap maps each 0-based line of the patch TEXT to the hunk/line it
// belongs to, or null for headers and hunk @@ lines.
//
// This is what turns a mouse selection in the editor into a patch
// selection: the CodeMirror document IS the patch, so a selected document
// line is a patch line — but only if the mapping is derived from the exact
// same text, which is why it re-walks the string instead of trusting the
// parsed structure's ordering.
export function docLineMap(patch: string): (null | {hunk: number; line: number})[] {
    const out: (null | {hunk: number; line: number})[] = []
    let hunk = -1
    let line = -1

    for (const raw of patch.split('\n')) {
        if (HUNK_RE.test(raw)) {
            hunk++
            line = -1
            out.push(null)
            continue
        }
        if (hunk < 0) {
            out.push(null)
            continue
        }
        const kind = raw[0]
        if (kind === '+' || kind === '-' || kind === ' ' || kind === '\\') {
            line++
            out.push({hunk, line})
            continue
        }
        out.push(null)
    }

    return out
}

// selectionFromDocLines turns a set of selected document lines into a patch
// selection, keeping only the lines that are actual changes — selecting a
// block of context should stage nothing, not everything.
export function selectionFromDocLines(
    parsed: ParsedPatch,
    map: (null | {hunk: number; line: number})[],
    docLines: number[],
): PatchSelection {
    const lines = new Map<number, Set<number>>()

    for (const docLine of docLines) {
        const at = map[docLine]
        if (!at) continue
        const patchLine = parsed.hunks[at.hunk]?.lines[at.line]
        if (!patchLine || !isChangeLine(patchLine)) continue
        if (!lines.has(at.hunk)) lines.set(at.hunk, new Set())
        lines.get(at.hunk)!.add(at.line)
    }

    return {hunks: new Set(lines.keys()), lines}
}
