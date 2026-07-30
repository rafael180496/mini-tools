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

export type BsonType = 'auto' | 'string' | 'number' | 'boolean' | 'objectId' | 'date' | 'regex' | 'null'

export const BSON_TYPES: {value: BsonType; label: string; hint: string}[] = [
    {value: 'auto', label: 'Auto', hint: 'Deduce el tipo de lo que escribas: 24 hex → ObjectId, dígitos → número, true/false/null tal cual, el resto texto'},
    {value: 'string', label: 'Texto', hint: 'Fuerza texto — necesario cuando el valor parece un número o un ObjectId pero en la base está guardado como string'},
    {value: 'number', label: 'Número', hint: 'Fuerza número. Un número guardado como texto NO coincide con un filtro numérico, y viceversa'},
    {value: 'boolean', label: 'Booleano', hint: 'true o false'},
    {value: 'objectId', label: 'ObjectId', hint: 'Envuelve el valor en ObjectId("…") — obligatorio para filtrar por _id cuando la colección usa ObjectId'},
    {value: 'date', label: 'Fecha', hint: 'Envuelve en ISODate("…"). Aceptá una fecha ISO (2024-01-31 o 2024-01-31T10:00:00Z)'},
    {value: 'regex', label: 'Regex', hint: 'Expresión regular; el valor se usa como patrón'},
    {value: 'null', label: 'Null', hint: 'El valor null literal — distinto de "campo ausente", que se consulta con $exists'},
]

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
    const t = raw.trim()
    if (t === '') return ''

    if (type === 'number' && !NUMBER_RE.test(t)) {
        return 'No es un número: se enviará como texto.'
    }
    if (type === 'objectId' && !OBJECT_ID_RE.test(t)) {
        return 'Un ObjectId son 24 caracteres hexadecimales; se enviará como texto.'
    }
    if (type === 'date' && !ISO_DATE_RE.test(t)) {
        return 'Formato de fecha no reconocido (usá 2024-01-31 o 2024-01-31T10:00:00Z); se enviará como texto.'
    }

    // The most valuable check: the sampled type of the field disagreeing
    // with the type being sent. This is exactly the "returns zero results
    // and you don't know why" case.
    const effective = type === 'auto' ? inferBsonType(t) : type
    if (fieldTypes && fieldTypes.length > 0) {
        const expected = fieldTypes[0]
        if (!typeMatches(effective, expected)) {
            return `En la muestra este campo es ${expected}; estás filtrando como ${effective}. Mongo no convierte tipos: es probable que no coincida nada.`
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
