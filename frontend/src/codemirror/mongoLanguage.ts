import {StreamLanguage, LanguageSupport, type StreamParser} from '@codemirror/language'
import {snippetCompletion, type CompletionSource, type CompletionResult} from '@codemirror/autocomplete'
import {hoverTooltip} from '@codemirror/view'
import {getActiveMongoCollections} from './mongoCollectionsStore'

// Hand-written mongosh language for the editor — MongoDB has no official
// CodeMirror language package, so (like redisLanguage.ts for Redis) this
// defines a StreamLanguage tokenizer, a schema/collection-aware
// CompletionSource, and a hoverTooltip. Deliberately NOT a JS engine: it
// tokenizes/completes the db.<collection>.<method>({...}) command surface the
// backend parser (backend/mongoquery) accepts, nothing more. See
// .claude/skills/mini-tools-patterns/SKILL.md's MongoDB section.

interface MongoMethod {
    label: string
    detail: string
    insertText: string
}

// The collection methods the backend executor dispatches (backend/mongoquery
// executor.go). Kept in sync with that switch — a method offered here that the
// backend doesn't handle would just error at run time.
const MONGO_METHODS: MongoMethod[] = [
    {label: 'find', detail: 'Busca documentos que matcheen el filtro', insertText: 'find({ ${1:filtro} })'},
    {label: 'findOne', detail: 'Devuelve el primer documento que matchee', insertText: 'findOne({ ${1:filtro} })'},
    {label: 'aggregate', detail: 'Pipeline de agregación', insertText: 'aggregate([ ${1:etapas} ])'},
    {label: 'countDocuments', detail: 'Cuenta documentos que matcheen el filtro', insertText: 'countDocuments({ ${1:filtro} })'},
    {label: 'estimatedDocumentCount', detail: 'Conteo rápido aproximado de la colección', insertText: 'estimatedDocumentCount()'},
    {label: 'distinct', detail: 'Valores distintos de un campo', insertText: "distinct('${1:campo}')"},
    {label: 'insertOne', detail: 'Inserta un documento', insertText: 'insertOne({ ${1:doc} })'},
    {label: 'insertMany', detail: 'Inserta varios documentos', insertText: 'insertMany([ ${1:docs} ])'},
    {label: 'updateOne', detail: 'Actualiza un documento', insertText: 'updateOne({ ${1:filtro} }, { $set: { ${2:campo}: ${3:valor} } })'},
    {label: 'updateMany', detail: 'Actualiza varios documentos', insertText: 'updateMany({ ${1:filtro} }, { $set: { ${2:campo}: ${3:valor} } })'},
    {label: 'replaceOne', detail: 'Reemplaza un documento completo', insertText: 'replaceOne({ ${1:filtro} }, { ${2:doc} })'},
    {label: 'deleteOne', detail: 'Elimina un documento', insertText: 'deleteOne({ ${1:filtro} })'},
    {label: 'deleteMany', detail: 'Elimina varios documentos', insertText: 'deleteMany({ ${1:filtro} })'},
    {label: 'createIndex', detail: 'Crea un índice', insertText: 'createIndex({ ${1:campo}: 1 })'},
    {label: 'dropIndex', detail: 'Elimina un índice por nombre', insertText: "dropIndex('${1:nombre}')"},
    {label: 'getIndexes', detail: 'Lista los índices de la colección', insertText: 'getIndexes()'},
]

const METHOD_NAMES = new Set(MONGO_METHODS.map((m) => m.label))

// Query/update/aggregation operators, suggested when the token starts with $.
const MONGO_OPERATORS = [
    '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin',
    '$and', '$or', '$not', '$nor', '$exists', '$type', '$regex', '$expr',
    '$set', '$unset', '$inc', '$mul', '$rename', '$push', '$pull', '$addToSet', '$pop',
    '$match', '$group', '$project', '$sort', '$limit', '$skip', '$lookup', '$unwind',
    '$sum', '$avg', '$min', '$max', '$count', '$first', '$last',
]

const mongoStreamParser: StreamParser<null> = {
    token(stream) {
        if (stream.sol() && stream.match(/^\s*\/\/.*$/)) return 'comment'
        if (stream.match(/^\/\*.*?\*\//)) return 'comment'
        if (stream.eatSpace()) return null
        if (stream.match(/^"([^"\\]|\\.)*"/) || stream.match(/^'([^'\\]|\\.)*'/)) return 'string'
        if (stream.match(/^-?\d+(\.\d+)?/)) return 'number'
        if (stream.match(/^\$[A-Za-z][A-Za-z0-9_]*/)) return 'keyword' // $operators
        if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
            const w = stream.current()
            if (w === 'db') return 'keyword'
            if (METHOD_NAMES.has(w)) return 'keyword'
            if (w === 'true' || w === 'false' || w === 'null') return 'atom'
            if (w === 'ObjectId' || w === 'ISODate' || w === 'Date' || w === 'NumberLong' || w === 'NumberDecimal' || w === 'NumberInt' || w === 'UUID' || w === 'new') return 'typeName'
            return 'variableName'
        }
        stream.next()
        return null
    },
}

export const mongoshLanguage = StreamLanguage.define(mongoStreamParser)

const mongoCompletionSource: CompletionSource = (context): CompletionResult | null => {
    // $operator anywhere.
    const dollar = context.matchBefore(/\$[A-Za-z0-9_]*/)
    if (dollar) {
        return {
            from: dollar.from,
            options: MONGO_OPERATORS.map((o) => ({label: o, type: 'keyword'})),
            validFor: /^\$[A-Za-z0-9_]*$/,
        }
    }

    // db.<collection>.<method — suggest methods.
    const methodCtx = context.matchBefore(/db\s*\.\s*[A-Za-z0-9_$]+\s*\.\s*[A-Za-z0-9_]*/)
    if (methodCtx) {
        const word = context.matchBefore(/[A-Za-z0-9_]*/)
        return {
            from: word ? word.from : context.pos,
            options: MONGO_METHODS.map((m) => snippetCompletion(m.insertText, {label: m.label, type: 'method', detail: m.detail})),
            validFor: /^[A-Za-z0-9_]*$/,
        }
    }

    // db.<collection — suggest collection names from the active tab's connection.
    const collCtx = context.matchBefore(/db\s*\.\s*[A-Za-z0-9_$]*/)
    if (collCtx) {
        const word = context.matchBefore(/[A-Za-z0-9_$]*/)
        const cols = getActiveMongoCollections()
        if (cols.length === 0) return null
        return {
            from: word ? word.from : context.pos,
            options: cols.map((c) => ({label: c, type: 'class'})),
            validFor: /^[A-Za-z0-9_$]*$/,
        }
    }

    return null
}

function stripPlaceholders(insertText: string): string {
    return insertText.replace(/\$\{\d+:([^}]*)\}/g, '$1')
}

const mongoHover = hoverTooltip((view, pos) => {
    const {from, to, text} = view.state.doc.lineAt(pos)
    let start = pos
    let end = pos
    while (start > from && /\w/.test(text[start - from - 1])) start--
    while (end < to && /\w/.test(text[end - from])) end++
    if (start === end) return null

    const method = MONGO_METHODS.find((m) => m.label === text.slice(start - from, end - from))
    if (!method) return null

    return {
        pos: start,
        end,
        above: true,
        create() {
            const dom = document.createElement('div')
            dom.style.padding = '6px 8px'
            dom.style.font = '12px var(--font-mono)'
            dom.style.background = 'var(--color-surface-container-high)'
            dom.style.color = 'var(--color-on-surface)'
            dom.style.border = '1px solid var(--color-outline-variant)'
            dom.style.borderRadius = '6px'
            dom.style.maxWidth = '360px'
            dom.style.whiteSpace = 'pre-wrap'
            dom.textContent = `db.<colección>.${stripPlaceholders(method.insertText)}\n${method.detail}`
            return {dom}
        },
    }
})

export function mongosh(): LanguageSupport {
    return new LanguageSupport(mongoshLanguage, [mongoshLanguage.data.of({autocomplete: mongoCompletionSource}), mongoHover])
}
