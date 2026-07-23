// Unified-diff → side-by-side conversion.
//
// The backend returns git's own unified patch (authoritative on renames and
// binary detection), so producing a split view is a layout problem, not a
// diffing problem — there is no second diff algorithm here, just a re-pairing
// of lines git already classified.
//
// This is why the module still needs no @codemirror/merge: that package exists
// to compute a diff between two documents, which is work already done.

export type RowKind = 'context' | 'add' | 'del' | 'hunk' | 'empty'

export interface SplitRow {
    // Line number in the original file, or null for a padding/hunk row.
    leftNo: number | null
    rightNo: number | null
    leftText: string | null
    rightText: string | null
    leftKind: RowKind
    rightKind: RowKind
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

// parseSplitDiff walks the patch and emits aligned rows.
//
// The pairing rule is what makes a modified line read as a modification rather
// than as an unrelated delete plus an unrelated insert: a run of consecutive
// "-" lines followed by a run of "+" lines is zipped index-by-index, and
// whichever run is shorter gets padded with empty rows so both columns stay
// vertically aligned from there on.
export function parseSplitDiff(patch: string): SplitRow[] {
    const rows: SplitRow[] = []
    const lines = patch.split('\n')

    let leftNo = 0
    let rightNo = 0
    // Pending runs, flushed when the run ends.
    let dels: string[] = []
    let adds: string[] = []

    const flush = () => {
        if (dels.length === 0 && adds.length === 0) return
        const n = Math.max(dels.length, adds.length)
        for (let i = 0; i < n; i++) {
            const d = i < dels.length ? dels[i] : null
            const a = i < adds.length ? adds[i] : null
            rows.push({
                leftNo: d !== null ? ++leftNo : null,
                rightNo: a !== null ? ++rightNo : null,
                leftText: d,
                rightText: a,
                leftKind: d !== null ? 'del' : 'empty',
                rightKind: a !== null ? 'add' : 'empty',
            })
        }
        dels = []
        adds = []
    }

    for (const raw of lines) {
        const hunk = HUNK_RE.exec(raw)
        if (hunk) {
            flush()
            // Hunk headers reset both counters to the positions git reports;
            // deriving them instead of trusting the header would drift on any
            // patch generated with a non-default context size.
            leftNo = parseInt(hunk[1], 10) - 1
            rightNo = parseInt(hunk[2], 10) - 1
            rows.push({leftNo: null, rightNo: null, leftText: raw, rightText: raw, leftKind: 'hunk', rightKind: 'hunk'})
            continue
        }

        // File-level headers carry no line content. "---"/"+++" must be tested
        // before the single-character prefixes or they would be read as a
        // deletion and an addition.
        if (
            raw.startsWith('diff ') ||
            raw.startsWith('index ') ||
            raw.startsWith('--- ') ||
            raw.startsWith('+++ ') ||
            raw.startsWith('new file') ||
            raw.startsWith('deleted file') ||
            raw.startsWith('rename ') ||
            raw.startsWith('similarity ') ||
            raw.startsWith('old mode') ||
            raw.startsWith('new mode')
        ) {
            continue
        }

        // "\ No newline at end of file" annotates the previous line rather than
        // being content of its own.
        if (raw.startsWith('\\')) continue

        if (raw.startsWith('-')) {
            dels.push(raw.slice(1))
            continue
        }
        if (raw.startsWith('+')) {
            adds.push(raw.slice(1))
            continue
        }

        // Anything else is context (leading space), including the empty string
        // that a trailing newline produces.
        flush()
        const text = raw.startsWith(' ') ? raw.slice(1) : raw
        rows.push({
            leftNo: ++leftNo,
            rightNo: ++rightNo,
            leftText: text,
            rightText: text,
            leftKind: 'context',
            rightKind: 'context',
        })
    }
    flush()

    // A patch ends with a newline, which the split above turns into one empty
    // trailing context row that is not part of the file.
    while (rows.length > 0) {
        const last = rows[rows.length - 1]
        if (last.leftKind === 'context' && last.leftText === '') rows.pop()
        else break
    }
    return rows
}
