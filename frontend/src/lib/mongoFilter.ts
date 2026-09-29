// Shared helpers for turning a visual field/operator/value condition list into
// a MongoDB filter written in the editor's lenient mongosh syntax (ObjectId("…"),
// ISODate("…"), unquoted keys). Used by both the find wizard (MongoFindWizard)
// and the browser's filter wizard (MongoFilterWizard).

import {typedLiteral, type BsonType} from './mongoBson'
import {t} from '../i18n'

export interface MongoCondition {
    field: string
    op: string
    value: string
    // valueType is how to render the value (see lib/mongoBson.ts). Optional
    // so the simpler browser filter wizard can keep passing bare conditions;
    // absent means "auto".
    valueType?: BsonType
    // caseInsensitive applies to $regex only, emitting $options: "i".
    caseInsensitive?: boolean
}

// How several conditions combine. Mongo's implicit shape is AND (the keys of
// one object), so OR needs an explicit $or array — which is exactly why a
// builder that only ever emits one object cannot express it.
export type MongoLogic = 'and' | 'or'

export interface MongoOperatorDef {
    value: string
    label: string
    hint: string
    // valueKind drives the input: 'list' takes a comma-separated list,
    // 'bool' takes true/false, 'type' takes a BSON type name, 'number' a
    // count, 'text' is the default.
    valueKind: 'text' | 'list' | 'bool' | 'type' | 'number'
}

// The operator set a real query needs. The previous list stopped at $eq/$ne/
// the comparisons/$in/$regex/$exists, which leaves out negated membership,
// type checks and array predicates — all ordinary in day-to-day Mongo.
//
// Only the value and the input kind live here; the label and hint come from
// the dictionary (t().mongo.operators['$eq']) and are resolved on every call
// to mongoOperators(), so they follow the active language.
const OPERATOR_KINDS: [string, MongoOperatorDef['valueKind']][] = [
    ['$eq', 'text'],
    ['$ne', 'text'],
    ['$gt', 'text'],
    ['$gte', 'text'],
    ['$lt', 'text'],
    ['$lte', 'text'],
    ['$in', 'list'],
    ['$nin', 'list'],
    ['$exists', 'bool'],
    ['$type', 'type'],
    ['$regex', 'text'],
    ['$size', 'number'],
    ['$all', 'list'],
]

export function mongoOperators(): MongoOperatorDef[] {
    const d = t().mongo.operators as Record<string, {label: string; hint: string}>
    return OPERATOR_KINDS.map(([value, valueKind]) => ({value, valueKind, ...d[value]}))
}

// Kept as the plain string list for the browser filter wizard, which renders
// bare operator names.
export const MONGO_FILTER_OPERATORS = OPERATOR_KINDS.map(([value]) => value)

// BSON type names $type accepts, offered as a dropdown so nobody has to
// remember whether it is "objectid" or "objectId" (it is the latter).
export const MONGO_BSON_TYPE_NAMES = [
    'string', 'int', 'long', 'double', 'decimal', 'bool', 'date',
    'objectId', 'array', 'object', 'null', 'binData', 'regex', 'timestamp',
]

// Query/update/aggregation operators offered by the filter input's autocomplete.
export const MONGO_QUERY_OPERATORS = [
    '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin',
    '$and', '$or', '$not', '$nor', '$exists', '$type', '$regex', '$expr', '$elemMatch', '$all', '$size',
]

export function operatorDef(op: string): MongoOperatorDef {
    const all = mongoOperators()
    return all.find((o) => o.value === op) ?? all[0]
}

// fieldKey quotes a field name only when it isn't a plain identifier (dotted
// paths, spaces, $ operators need quoting to be valid JSON keys).
export function fieldKey(field: string): string {
    return /^[A-Za-z_$][\w$]*$/.test(field) ? field : JSON.stringify(field)
}

// valueLiteral renders a user-typed value with automatic type inference —
// the "auto" path of lib/mongoBson.ts. Kept as a named export because the
// document panel's "filter by this value" action and the browser's filter
// wizard both use it without a type selector.
export function valueLiteral(raw: string): string {
    return typedLiteral(raw, 'auto')
}

// conditionExpression renders ONE condition as "key: value" (or
// "key: { $op: … }"), or "" when it has no field to attach to.
function conditionExpression(c: MongoCondition): string {
    const f = c.field.trim()
    if (!f) return ''
    const key = fieldKey(f)
    const type = c.valueType ?? 'auto'

    switch (c.op) {
        case '$eq':
            // The implicit form: {campo: valor}. Shorter, what everyone
            // writes by hand, identical in meaning to {$eq: valor}.
            return `${key}: ${typedLiteral(c.value, type)}`

        case '$in':
        case '$nin':
        case '$all': {
            const items = splitList(c.value)
                .map((v) => typedLiteral(v, type))
                .join(', ')
            return `${key}: { ${c.op}: [${items}] }`
        }

        case '$exists':
            return `${key}: { $exists: ${c.value.trim() === 'false' ? 'false' : 'true'} }`

        case '$type':
            return `${key}: { $type: ${JSON.stringify(c.value.trim() || 'string')} }`

        case '$size': {
            const n = c.value.trim()
            return `${key}: { $size: ${/^\d+$/.test(n) ? n : '0'} }`
        }

        case '$regex': {
            // $options must sit alongside $regex in the SAME object; a
            // separate {$options} object is a syntax error in Mongo.
            const opts = c.caseInsensitive ? ', $options: "i"' : ''
            return `${key}: { $regex: ${JSON.stringify(c.value)}${opts} }`
        }

        default:
            return `${key}: { ${c.op}: ${typedLiteral(c.value, type)} }`
    }
}

// splitList parses a comma-separated value list, keeping commas that sit
// inside quotes so a value containing one survives.
function splitList(raw: string): string[] {
    const out: string[] = []
    let current = ''
    let quote: string | null = null
    for (const ch of raw) {
        if (quote) {
            if (ch === quote) quote = null
            else current += ch
            continue
        }
        if (ch === '"' || ch === "'") {
            quote = ch
            continue
        }
        if (ch === ',') {
            out.push(current.trim())
            current = ''
            continue
        }
        current += ch
    }
    if (current.trim() !== '') out.push(current.trim())
    return out.filter((v) => v !== '')
}

// buildFilterObject turns conditions into a filter object string like
// { name: "x", age: { $gt: 30 } } (or {} when empty).
//
// With logic 'or' the conditions are wrapped in $or, because Mongo's implicit
// combination of an object's keys is AND and there is no way to express OR
// without it. AND stays implicit (one flat object) rather than always
// emitting $and: it reads better and is what a person would write — except
// when two conditions target the SAME field, where a flat object would
// silently drop the first one to key collision. That case falls back to $and.
export function buildFilterObject(conditions: MongoCondition[], logic: MongoLogic = 'and'): string {
    const parts = conditions.map(conditionExpression).filter((p) => p !== '')
    if (parts.length === 0) return '{}'
    if (parts.length === 1) return `{ ${parts[0]} }`

    if (logic === 'or') {
        return `{ $or: [${parts.map((p) => `{ ${p} }`).join(', ')}] }`
    }
    if (hasDuplicateFields(conditions)) {
        return `{ $and: [${parts.map((p) => `{ ${p} }`).join(', ')}] }`
    }
    return `{ ${parts.join(', ')} }`
}

// hasDuplicateFields reports whether two conditions name the same field, in
// which case a flat AND object would lose one of them.
function hasDuplicateFields(conditions: MongoCondition[]): boolean {
    const seen = new Set<string>()
    for (const c of conditions) {
        const f = c.field.trim()
        if (!f) continue
        if (seen.has(f)) return true
        seen.add(f)
    }
    return false
}
