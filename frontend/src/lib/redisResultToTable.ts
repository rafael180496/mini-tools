// Flattens a Redis command result (resultKind + result, from
// backend/redisquery.Event) into columns/rows so the existing
// ExportMenu/ExportResult (backend/export's CSV/JSON/XLSX writers) can be
// reused unchanged for Redis output — no backend export changes needed.
// Deliberately generic, not per-command: pairing e.g. HGETALL's flat array
// back into field/value columns would need knowing the command name here,
// which NormalizeReply (backend/redisquery/executor.go) intentionally
// doesn't track — an indexed list is a reasonable, honest default for any
// array-shaped reply.
export function redisResultToTable(resultKind: string | undefined, result: unknown): {columns: string[]; rows: unknown[][]} {
    switch (resultKind) {
        case 'nil':
            return {columns: ['value'], rows: [[null]]}
        case 'array': {
            const items = Array.isArray(result) ? result : []
            return {columns: ['#', 'value'], rows: items.map((v, i) => [i, v])}
        }
        case 'string':
        case 'int':
        case 'float':
        case 'bool':
            return {columns: ['value'], rows: [[result]]}
        default:
            return {columns: [], rows: []}
    }
}
