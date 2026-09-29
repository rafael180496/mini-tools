// BSON typing for the visual query builders.
//
// MongoDB does not coerce types in a query: {_id: "507f1f77bcf86cd799439011"}
// matches nothing when _id holds an ObjectId, and {age: "30"} matches nothing
// when age is an int. That silent zero-result is the single most common way
// a hand-written Mongo filter goes wrong, and a visual builder that only
// takes text would reproduce it faithfully.
//
// So every value carries a type. "auto" infers from what was typed — which
// covers the common cases without asking anything of the user — and the
// explicit types are the escape hatch for when inference guesses wrong (a
// numeric string that really IS a string, a date typed as a number).

import {t} from '../i18n'

export type BsonType = 'auto' | 'string' | 'number' | 'boolean' | 'objectId' | 'date' | 'regex' | 'null'

// Labels and hints come from the dictionary (t().mongo.bsonTypes.<value>),
// resolved on every call so they follow the active language.
const BSON_TYPE_VALUES: BsonType[] = ['auto', 'string', 'number', 'boolean', 'objectId', 'date', 'regex', 'null']

export function bsonTypes(): {value: BsonType; label: string; hint: string}[] {
    const d = t().mongo.bsonTypes
    return BSON_TYPE_VALUES.map((value) => ({value, ...d[value]}))
}

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/
const NUMBER_RE = /^-?\d+(\.\d+)?$/
// Accepts a bare date or a full ISO timestamp; anything looser would start
// misreading ordinary strings as dates.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/

// inferBsonType is what "auto" resolves to for a given text. Exported so the
// UI can show the user which type auto picked, rather than leaving them to
// guess why their filter matched nothing.
export function inferBsonType(raw: string): Exclude<BsonType, 'auto'> {
    const t = raw.trim()
    if (t === '' ) return 'string'
    if (t === 'null') return 'null'
    if (t === 'true' || t === 'false') return 'boolean'
    if (NUMBER_RE.test(t)) return 'number'
    if (OBJECT_ID_RE.test(t)) return 'objectId'
    return 'string'
}

// typedLiteral renders a value as the mongosh literal for the chosen type.
// The output goes through the editor's lenient parser (backend/mongoquery/
// extjson.go), so ObjectId()/ISODate() helpers are valid here.
//
// An explicit type is honoured even when the text does not look like it —
// forcing the user's hand is the point of the selector. The one exception
// is a value that cannot be represented at all (a non-numeric string typed
// as a number), which falls back to a quoted string rather than emitting
// something that will not parse.
export function typedLiteral(raw: string, type: BsonType): string {
    const t = raw.trim()
    const resolved = type === 'auto' ? inferBsonType(t) : type

    switch (resolved) {
        case 'null':
            return 'null'
        case 'boolean':
            return t.toLowerCase() === 'false' ? 'false' : 'true'
        case 'number':
            return NUMBER_RE.test(t) ? t : JSON.stringify(t)
        case 'objectId':
            // An invalid ObjectId is quoted instead: ObjectId("no-soy-hex")
            // is a runtime error in mongosh, and a filter that errors is
            // worse than one that returns nothing.
            return OBJECT_ID_RE.test(t) ? `ObjectId("${t}")` : JSON.stringify(t)
        case 'date':
            return ISO_DATE_RE.test(t) ? `ISODate("${t}")` : JSON.stringify(t)
        case 'regex':
            return JSON.stringify(t)
        default:
            return JSON.stringify(t)
    }
}

// typeWarning explains, in one line, why a value might not match anything —
// shown next to the input rather than after the query comes back empty.
export function typeWarning(raw: string, type: BsonType, field: string, fieldTypes?: string[]): string {
    const v = raw.trim()
    if (v === '') return ''

    if (type === 'number' && !NUMBER_RE.test(v)) {
        return t().mongo.typeWarnings.notNumber
    }
    if (type === 'objectId' && !OBJECT_ID_RE.test(v)) {
        return t().mongo.typeWarnings.badObjectId
    }
    if (type === 'date' && !ISO_DATE_RE.test(v)) {
        return t().mongo.typeWarnings.badDate
    }

    // The most valuable check: the sampled type of the field disagreeing
    // with the type being sent. This is exactly the "returns zero results
    // and you don't know why" case.
    const effective = type === 'auto' ? inferBsonType(v) : type
    if (fieldTypes && fieldTypes.length > 0) {
        const expected = fieldTypes[0]
        if (!typeMatches(effective, expected)) {
            return t().mongo.typeWarnings.mismatch({expected, effective})
        }
    }
    return ''
}

// typeMatches compares a builder type against a sampled BSON type name.
function typeMatches(chosen: Exclude<BsonType, 'auto'> | BsonType, sampled: string): boolean {
    switch (chosen) {
        case 'number':
            return sampled === 'int' || sampled === 'long' || sampled === 'double' || sampled === 'decimal'
        case 'string':
            // A regex-ish comparison against a string field is fine, and an
            // array of strings is queried with a plain string too.
            return sampled === 'string' || sampled === 'array'
        case 'objectId':
            return sampled === 'objectId'
        case 'date':
            return sampled === 'date'
        case 'boolean':
            return sampled === 'bool'
        case 'null':
            return true
        case 'regex':
            return sampled === 'string' || sampled === 'array' || sampled === 'regex'
        default:
            return true
    }
}
