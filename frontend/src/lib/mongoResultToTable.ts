// Flattens a MongoDB result (an array of relaxed-ExtJSON document strings) into
// the {columns, rows} shape ExportMenu expects — same role as
// redisResultToTable.ts, so backend/export's CSV/JSON/XLSX writers are reused
// unchanged. Columns are the union of every document's top-level keys (in first-
// seen order); nested/ExtJSON values are JSON-stringified into their cell.
export function mongoResultToTable(documents: string[]): {columns: string[]; rows: unknown[][]} {
    const parsed: unknown[] = documents.map((d) => {
        try {
            return JSON.parse(d)
        } catch {
            return {__raw: d}
        }
    })

    const columns: string[] = []
    for (const p of parsed) {
        if (p && typeof p === 'object' && !Array.isArray(p)) {
            for (const k of Object.keys(p as Record<string, unknown>)) {
                if (!columns.includes(k)) columns.push(k)
            }
        }
    }

    if (columns.length === 0) {
        return {columns: ['value'], rows: parsed.map((p) => [JSON.stringify(p)])}
    }

    const rows = parsed.map((p) =>
        columns.map((c) => {
            const v = (p as Record<string, unknown>)?.[c]
            if (v === undefined) return null
            if (v === null || typeof v !== 'object') return v
            return JSON.stringify(v)
        }),
    )
    return {columns, rows}
}
