// Hand-rolled, best-effort SQL context analysis for the completion provider
// — same philosophy as frontend/src/lib/linter.ts's naive statement
// splitter: this doesn't need to be exact (unlike backend/query/splitter.go),
// a false positive/negative here just means a slightly-off suggestion list,
// not a correctness bug. No quote/comment awareness, no real parser.

import {db} from '../../wailsjs/go/models'

export interface TableRef {
    table: string
    schema?: string
    alias?: string
}

export type Clause = 'from' | 'column' | 'other'

export interface SqlContext {
    clause: Clause
    tableRefs: TableRef[]
    // The identifier immediately before a trailing "." at the cursor, e.g.
    // "u" in "u.na|" — null if the cursor isn't right after "ident.".
    dotPrefix: string | null
}

const FROM_KEYWORDS = ['FROM', 'JOIN', 'INTO', 'UPDATE']
const COLUMN_KEYWORDS = ['SELECT', 'WHERE', 'SET', 'ON', 'AND', 'OR', 'BY']
// Words that can legally follow a table reference but are never actually an
// alias — without this, "FROM users WHERE" would misparse "WHERE" as an
// alias for "users".
const ALIAS_STOPWORDS = new Set([
    'WHERE', 'ON', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS',
    'GROUP', 'ORDER', 'LIMIT', 'SET', 'VALUES', 'AND', 'OR', 'USING', 'NATURAL', 'AS',
])

function lastKeywordIndex(upperText: string, keyword: string): number {
    const re = new RegExp(`\\b${keyword}\\b`, 'g')
    let idx = -1
    let m: RegExpExecArray | null
    while ((m = re.exec(upperText))) idx = m.index
    return idx
}

function hasUnmatchedOpenParen(text: string): boolean {
    let depth = 0
    for (const ch of text) {
        if (ch === '(') depth++
        else if (ch === ')') depth = Math.max(0, depth - 1)
    }
    return depth > 0
}

// Which clause the cursor is in, based on the LAST significant keyword
// before it — e.g. "SELECT * FROM users WHERE |" → the last keyword is
// WHERE → 'column'. A table reference immediately followed by an unmatched
// "(" flips 'from' to 'column' — covers "INSERT INTO t (|" naming columns,
// not re-naming the table.
function detectClause(textBeforeCursor: string): Clause {
    const upper = textBeforeCursor.toUpperCase()
    let lastIdx = -1
    let lastClause: Clause = 'other'

    for (const kw of FROM_KEYWORDS) {
        const idx = lastKeywordIndex(upper, kw)
        if (idx > lastIdx) {
            lastIdx = idx
            lastClause = 'from'
        }
    }
    for (const kw of COLUMN_KEYWORDS) {
        const idx = lastKeywordIndex(upper, kw)
        if (idx > lastIdx) {
            lastIdx = idx
            lastClause = 'column'
        }
    }

    if (lastClause === 'from' && lastIdx >= 0 && hasUnmatchedOpenParen(textBeforeCursor.slice(lastIdx))) {
        return 'column'
    }
    return lastClause
}

// Every FROM/JOIN/INTO/UPDATE table reference in the statement, with its
// optional schema qualifier and alias — scanned across the WHOLE
// statement, not just before the cursor, since "SELECT u.| FROM users u"
// (cursor in the column list) still needs to resolve "u" from later in the
// same statement.
function extractTableRefs(statementText: string): TableRef[] {
    const refs: TableRef[] = []
    const re = /\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)?)(?:\s+(?:AS\s+)?([a-zA-Z_][\w]*))?/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(statementText))) {
        const raw = m[1]
        const parts = raw.split('.')
        const schema = parts.length === 2 ? parts[0] : undefined
        const table = parts.length === 2 ? parts[1] : parts[0]
        let alias: string | undefined = m[2]
        if (alias && ALIAS_STOPWORDS.has(alias.toUpperCase())) alias = undefined
        refs.push({table, schema, alias})
    }
    return refs
}

export function analyzeSqlContext(statementText: string, cursorOffset: number): SqlContext {
    const before = statementText.slice(0, cursorOffset)
    const dotMatch = before.match(/([a-zA-Z_][\w]*)\.[a-zA-Z_]*$/)
    return {
        clause: detectClause(before),
        tableRefs: extractTableRefs(statementText),
        dotPrefix: dotMatch ? dotMatch[1] : null,
    }
}

// Finds the statement (naive split on top-level ";", no quote/comment
// awareness) containing absoluteOffset within fullText, and returns its
// text plus the cursor's offset relative to that statement's own start.
export function extractCurrentStatement(fullText: string, absoluteOffset: number): {text: string; offset: number} {
    let start = 0
    for (let i = 0; i < absoluteOffset && i < fullText.length; i++) {
        if (fullText[i] === ';') start = i + 1
    }
    let end = fullText.indexOf(';', absoluteOffset)
    if (end === -1) end = fullText.length
    return {text: fullText.slice(start, end), offset: absoluteOffset - start}
}

export interface DotResolution {
    kind: 'table' | 'schema' | 'none'
    table?: db.Table
    schema?: string
}

// Resolves "prefix." to either a specific table (via an alias defined in
// this statement, or a direct table-name match) or a schema (suggesting
// its tables) — in that priority order, since an alias always wins over a
// same-named table/schema if both somehow coincide.
export function resolveDotPrefix(prefix: string, tableRefs: TableRef[], meta: db.SchemaMetadata): DotResolution {
    const lower = prefix.toLowerCase()

    const aliasRef = tableRefs.find((r) => r.alias?.toLowerCase() === lower)
    if (aliasRef) {
        const table = meta.tables.find(
            (t) =>
                t.name.toLowerCase() === aliasRef.table.toLowerCase() &&
                (!aliasRef.schema || t.schema?.toLowerCase() === aliasRef.schema.toLowerCase()),
        )
        if (table) return {kind: 'table', table}
    }

    const directTable = meta.tables.find((t) => t.name.toLowerCase() === lower)
    if (directTable) return {kind: 'table', table: directTable}

    if (meta.tables.some((t) => t.schema?.toLowerCase() === lower)) {
        return {kind: 'schema', schema: prefix}
    }

    return {kind: 'none'}
}
