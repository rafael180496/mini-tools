// Derives an autocomplete model from a page of MongoDB documents: the set of
// field paths (including nested ones, dot-joined like address.city) and the
// sample values seen for each — so the browser's filter box can suggest both
// fields (in key position) and real values (in value position), Compass-style.
// Values are rendered as lenient mongosh literals (ObjectId("…"), quoted
// strings, bare numbers) ready to drop straight into the filter.

export interface MongoFieldModel {
    fields: string[]
    valuesByField: Record<string, string[]>
}

const MAX_DEPTH = 2
const MAX_VALUES = 20

// valueToLiteral renders a parsed (Extended) JSON value as the mongosh literal
// used in a filter — shared with the "filter by this field" click action.
export function valueToLiteral(v: unknown): string {
    if (v === null || v === undefined) return 'null'
    if (typeof v === 'boolean' || typeof v === 'number') return String(v)
    if (typeof v === 'string') return JSON.stringify(v)
    if (typeof v === 'object') {
        const atom = atomLiteral(v as Record<string, unknown>)
        if (atom !== null) return atom
        return JSON.stringify(v)
    }
    return JSON.stringify(v)
}

// atomLiteral returns the mongosh literal for a single-key Extended-JSON wrapper
// (ObjectId/date/number), or null if the object isn't one.
function atomLiteral(obj: Record<string, unknown>): string | null {
    const keys = Object.keys(obj)
    if (keys.length !== 1) return null
    switch (keys[0]) {
        case '$oid':
            return `ObjectId("${obj.$oid}")`
        case '$date': {
            const d = obj.$date
            const inner = typeof d === 'object' && d !== null ? (d as Record<string, unknown>).$numberLong : d
            return `ISODate("${inner}")`
        }
        case '$numberLong':
        case '$numberDecimal':
        case '$numberInt':
            return String(obj[keys[0]])
        default:
            return null
    }
}

// scalarLiteral returns a literal only for values worth suggesting (scalars +
// ObjectId/date atoms) — not plain sub-objects/arrays, which nobody filters by
// exact value in the autocomplete.
function scalarLiteral(v: unknown): string | null {
    if (v === null) return 'null'
    if (typeof v === 'boolean' || typeof v === 'number') return String(v)
    if (typeof v === 'string') return JSON.stringify(v)
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return atomLiteral(v as Record<string, unknown>)
    return null
}

export function deriveFieldModel(docs: string[]): MongoFieldModel {
    const order: string[] = []
    const seen = new Set<string>()
    const valueSets: Record<string, Set<string>> = {}

    const addField = (path: string) => {
        if (!seen.has(path)) {
            seen.add(path)
            order.push(path)
            valueSets[path] = new Set()
        }
    }

    const walk = (obj: unknown, prefix: string, depth: number) => {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return
        // Don't descend into an Extended-JSON atom (it's a value, not a subdoc).
        if (atomLiteral(obj as Record<string, unknown>) !== null) return
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
            const path = prefix ? `${prefix}.${k}` : k
            addField(path)
            const lit = scalarLiteral(v)
            if (lit !== null && valueSets[path].size < MAX_VALUES) valueSets[path].add(lit)
            if (depth < MAX_DEPTH && v && typeof v === 'object' && !Array.isArray(v) && atomLiteral(v as Record<string, unknown>) === null) {
                walk(v, path, depth + 1)
            }
        }
    }

    for (const d of docs) {
        try {
            walk(JSON.parse(d), '', 0)
        } catch {
            // ignore unparseable rows
        }
    }

    const valuesByField: Record<string, string[]> = {}
    for (const p of order) valuesByField[p] = [...valueSets[p]]
    return {fields: order, valuesByField}
}
