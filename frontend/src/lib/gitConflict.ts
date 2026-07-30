// Parses a file carrying git's conflict markers into blocks, and writes the
// resolved file back out.
//
// The round trip has to be lossless for the parts nobody touched: everything
// outside a conflict block is reproduced byte for byte, because "resolve one
// conflict" must never rewrite the rest of the file. That is also why this
// works on the raw text instead of on `git show :2:`/`:3:` — the file on
// disk already includes whatever the user edited by hand before opening the
// resolver, and throwing that away would be its own kind of data loss.

export interface ConflictBlock {
    kind: 'conflict'
    // ours is the current branch's side. In a MERGE that is the branch you
    // are on; in a REBASE it is the upstream you are replaying onto, which
    // is the opposite of what most people expect — the UI says so rather
    // than making the user remember.
    ours: string[]
    // base is the common ancestor, present only with merge.conflictStyle
    // set to diff3/zdiff3. Empty otherwise, which is the default.
    base: string[]
    theirs: string[]
    // Labels as git wrote them on the marker lines (branch names, commit
    // subjects), reproduced so the panes are named the way git named them.
    oursLabel: string
    theirsLabel: string
    // resolution is what to emit. 'unresolved' keeps the markers, which is
    // what makes an unfinished file still valid to save and reopen.
    resolution: 'unresolved' | 'ours' | 'theirs' | 'both' | 'custom'
    // custom holds the manually edited result when resolution is 'custom'.
    custom: string[]
}

export interface TextBlock {
    kind: 'text'
    lines: string[]
}

export type FileBlock = TextBlock | ConflictBlock

const OURS_RE = /^<{7}\s?(.*)$/
const BASE_RE = /^\|{7}\s?(.*)$/
const SEP_RE = /^={7}\s*$/
const THEIRS_RE = /^>{7}\s?(.*)$/

// parseConflicts splits the file. A malformed or truncated conflict (a
// marker with no closing one) is emitted as plain text rather than as a
// half-parsed block: showing it as-is lets the user fix it by hand, while
// guessing at it could silently drop lines.
export function parseConflicts(content: string): FileBlock[] {
    const lines = content.split('\n')
    const blocks: FileBlock[] = []
    let text: string[] = []
    let i = 0

    const flushText = () => {
        if (text.length > 0) {
            blocks.push({kind: 'text', lines: text})
            text = []
        }
    }

    while (i < lines.length) {
        const start = OURS_RE.exec(lines[i])
        if (!start) {
            text.push(lines[i])
            i++
            continue
        }

        // Scan forward for the rest of the markers. If any is missing the
        // whole run is not a conflict.
        let j = i + 1
        const ours: string[] = []
        const base: string[] = []
        const theirs: string[] = []
        let sawBase = false
        let sawSep = false
        let closed = false
        let theirsLabel = ''

        for (; j < lines.length; j++) {
            const line = lines[j]

            const baseMatch = BASE_RE.exec(line)
            if (baseMatch && !sawSep) {
                sawBase = true
                continue
            }
            if (SEP_RE.test(line)) {
                sawSep = true
                continue
            }
            const end = THEIRS_RE.exec(line)
            if (end) {
                theirsLabel = end[1]
                closed = true
                break
            }

            if (!sawSep && sawBase) base.push(line)
            else if (!sawSep) ours.push(line)
            else theirs.push(line)
        }

        if (!closed || !sawSep) {
            // Not a well-formed conflict — keep it verbatim.
            text.push(lines[i])
            i++
            continue
        }

        flushText()
        blocks.push({
            kind: 'conflict',
            ours,
            base,
            theirs,
            oursLabel: start[1],
            theirsLabel,
            resolution: 'unresolved',
            custom: [],
        })
        i = j + 1
    }

    flushText()
    return blocks
}

// renderResolved emits the file. An unresolved block keeps its markers
// exactly as git wrote them, so saving a partially-resolved file leaves it
// in a state git still recognises as conflicted rather than one that looks
// finished but is not.
export function renderResolved(blocks: FileBlock[]): string {
    const out: string[] = []

    for (const block of blocks) {
        if (block.kind === 'text') {
            out.push(...block.lines)
            continue
        }

        switch (block.resolution) {
            case 'ours':
                out.push(...block.ours)
                break
            case 'theirs':
                out.push(...block.theirs)
                break
            case 'both':
                // Ours first, then theirs — the order git itself would
                // produce, and the one people mean by "keep both".
                out.push(...block.ours, ...block.theirs)
                break
            case 'custom':
                out.push(...block.custom)
                break
            default:
                out.push(`<<<<<<< ${block.oursLabel}`)
                out.push(...block.ours)
                if (block.base.length > 0) {
                    out.push('||||||| base')
                    out.push(...block.base)
                }
                out.push('=======')
                out.push(...block.theirs)
                out.push(`>>>>>>> ${block.theirsLabel}`)
        }
    }

    return out.join('\n')
}

export function conflictCount(blocks: FileBlock[]): number {
    return blocks.filter((b) => b.kind === 'conflict').length
}

export function resolvedCount(blocks: FileBlock[]): number {
    return blocks.filter((b) => b.kind === 'conflict' && b.resolution !== 'unresolved').length
}

// isFullyResolved is what gates "mark as resolved": a file with any marker
// left would be staged in a state git considers broken, and the mistake only
// surfaces at the next build.
export function isFullyResolved(blocks: FileBlock[]): boolean {
    const total = conflictCount(blocks)
    return total > 0 && resolvedCount(blocks) === total
}
