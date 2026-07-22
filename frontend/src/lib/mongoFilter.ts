// Shared helpers for turning a visual field/operator/value condition list into
// a MongoDB filter written in the editor's lenient mongosh syntax (24-hex
// values become ObjectId("…"), etc.). Used by both the find wizard
// (MongoFindWizard) and the browser's filter wizard (MongoFilterWizard).

export interface MongoCondition {
    field: string
    op: string
    value: string
}

export const MONGO_FILTER_OPERATORS = ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$regex', '$exists']

// Query/update/aggregation operators offered by the filter input's autocomplete.
export const MONGO_QUERY_OPERATORS = [
    '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin',
    '$and', '$or', '$not', '$nor', '$exists', '$type', '$regex', '$expr', '$elemMatch', '$all', '$size',
]

// fieldKey quotes a field name only when it isn't a plain identifier (dotted
// paths, spaces, $ operators need quoting to be valid JSON keys).
export function fieldKey(field: string): string {
    return /^[A-Za-z_$][\w$]*$/.test(field) ? field : JSON.stringify(field)
}

// valueLiteral renders a user-typed value into the lenient mongosh syntax: a
// 24-hex string becomes ObjectId("…"), plain numbers/true/false/null stay bare,
// everything else is a quoted string.
export function valueLiteral(raw: string): string {
    const t = raw.trim()
    if (t === '') return '""'
    if (t === 'true' || t === 'false' || t === 'null') return t
    if (/^-?\d+(\.\d+)?$/.test(t)) return t
    if (/^[0-9a-fA-F]{24}$/.test(t)) return `ObjectId("${t}")`
    return JSON.stringify(t)
}

// buildFilterObject turns conditions into a filter object string like
// { name: "x", age: { $gt: 30 } } (or {} when empty).
export function buildFilterObject(conditions: MongoCondition[]): string {
    const parts: string[] = []
    for (const c of conditions) {
        const f = c.field.trim()
        if (!f) continue
        const key = fieldKey(f)
        if (c.op === '$eq') {
            parts.push(`${key}: ${valueLiteral(c.value)}`)
        } else if (c.op === '$in') {
            const items = c.value.split(',').map((v) => valueLiteral(v)).join(', ')
            parts.push(`${key}: { $in: [${items}] }`)
        } else if (c.op === '$exists') {
            parts.push(`${key}: { $exists: ${c.value.trim() === 'false' ? 'false' : 'true'} }`)
        } else if (c.op === '$regex') {
            parts.push(`${key}: { $regex: ${JSON.stringify(c.value)} }`)
        } else {
            parts.push(`${key}: { ${c.op}: ${valueLiteral(c.value)} }`)
        }
    }
    return parts.length > 0 ? `{ ${parts.join(', ')} }` : '{}'
}
