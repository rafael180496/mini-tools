// Parses FT.SEARCH/FT.AGGREGATE's raw RESP2 reply into a dynamic-column
// table. Verified against a real redis-stack-server container (RediSearch
// module) with the app's actual RESP2-pinned client config
// (backend/db/redis_pool.go): FT.SEARCH's shape is
// [total, docId1, [field1, val1, field2, val2, ...], docId2, [...], ...];
// FT.AGGREGATE's is the same but WITHOUT the docId strings — just
// [total, [field1, val1, ...], [field1, val1, ...], ...]. One parser
// covers both shapes: whenever the next element is a string immediately
// followed by an array, it's treated as a (docId, fields) pair; a bare
// array with no preceding docId is treated as a fields-only row.
// NormalizeReply (backend/redisquery/executor.go) already preserves this
// nested structure intact — no backend change needed, only interpreting
// what's already there.
export interface FTResultTable {
    total: number
    columns: string[]
    rows: Record<string, unknown>[]
}

function fieldsArrayToRow(fields: unknown[], columnOrder: string[]): Record<string, unknown> {
    const row: Record<string, unknown> = {}
    for (let i = 0; i + 1 < fields.length; i += 2) {
        const key = String(fields[i])
        row[key] = fields[i + 1]
        if (!columnOrder.includes(key)) columnOrder.push(key)
    }
    return row
}

// Returns null for anything that doesn't look like a valid FT.SEARCH/
// FT.AGGREGATE reply — the caller falls back to the generic array
// renderer in that case rather than guessing wrong.
export function parseFTSearchResult(result: unknown): FTResultTable | null {
    if (!Array.isArray(result) || result.length === 0) return null
    const total = Number(result[0])
    if (!Number.isFinite(total)) return null

    const columnOrder: string[] = []
    const rows: Record<string, unknown>[] = []
    let hasDocColumn = false

    let i = 1
    while (i < result.length) {
        const item = result[i]
        if (Array.isArray(item)) {
            rows.push(fieldsArrayToRow(item, columnOrder))
            i += 1
        } else if (typeof item === 'string' && Array.isArray(result[i + 1])) {
            hasDocColumn = true
            const row = fieldsArrayToRow(result[i + 1] as unknown[], columnOrder)
            row.Doc = item
            rows.push(row)
            i += 2
        } else {
            // Unexpected shape at this position — skip just this element
            // rather than bail entirely, best-effort like the rest of
            // this parser.
            i += 1
        }
    }

    const columns = hasDocColumn ? ['Doc', ...columnOrder] : columnOrder
    return {total, columns, rows}
}
