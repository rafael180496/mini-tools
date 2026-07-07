import {monaco} from './setup'
import {getActiveMetadata} from './metadataStore'
import {analyzeSqlContext, extractCurrentStatement, resolveDotPrefix} from './sqlContext'
import {db} from '../../wailsjs/go/models'

let registered = false

function tableSuggestion(t: db.Table, range: monaco.IRange) {
    return {
        label: t.name,
        kind: monaco.languages.CompletionItemKind.Class,
        insertText: t.name,
        detail: t.schema ? `${t.schema}.${t.name}` : 'tabla',
        range,
    }
}

function columnSuggestion(t: db.Table, c: db.Column, range: monaco.IRange) {
    return {
        label: c.name,
        kind: monaco.languages.CompletionItemKind.Field,
        insertText: c.name,
        detail: `${t.name}.${c.name}: ${c.dataType}${c.nullable ? '' : ' NOT NULL'}`,
        range,
    }
}

function findTable(meta: db.SchemaMetadata, name: string, schema?: string): db.Table | undefined {
    return meta.tables.find(
        (t) => t.name.toLowerCase() === name.toLowerCase() && (!schema || t.schema?.toLowerCase() === schema.toLowerCase()),
    )
}

// Table/column autocomplete from the active connection's cached schema
// metadata (metadataStore.ts) — refreshed by Workspace.tsx on connection
// switch, schema switch, or F5, not re-registered here each time.
//
// Context-aware (sqlContext.ts, best-effort — see its own doc comment for
// why exactness isn't the goal): FROM/JOIN/INTO/UPDATE suggest table names;
// SELECT/WHERE/SET/ON/AND/OR/GROUP·ORDER BY suggest column names scoped to
// whatever tables the current statement's FROM/JOIN actually reference (not
// every table in the schema); "alias." or "table." narrows to just that
// table's columns; "schema." narrows to just that schema's tables. Falls
// back to suggesting everything (the original, pre-context behavior) for
// statement shapes this doesn't specifically recognize (CREATE TABLE, etc.)
// — never suggests less than before, only more precisely when it can.
export function registerSchemaCompletionProvider() {
    if (registered) return
    registered = true

    monaco.languages.registerCompletionItemProvider('sql', {
        triggerCharacters: ['.', ' '],
        provideCompletionItems(model, position) {
            const meta = getActiveMetadata()
            if (!meta) return {suggestions: []}

            const word = model.getWordUntilPosition(position)
            const range = {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endColumn: word.endColumn,
            }

            const absoluteOffset = model.getOffsetAt(position)
            const {text: stmtText, offset: stmtOffset} = extractCurrentStatement(model.getValue(), absoluteOffset)
            const ctx = analyzeSqlContext(stmtText, stmtOffset)

            if (ctx.dotPrefix) {
                const resolved = resolveDotPrefix(ctx.dotPrefix, ctx.tableRefs, meta)
                if (resolved.kind === 'table' && resolved.table) {
                    return {suggestions: resolved.table.columns.map((c) => columnSuggestion(resolved.table!, c, range))}
                }
                if (resolved.kind === 'schema' && resolved.schema) {
                    const tables = meta.tables.filter((t) => t.schema?.toLowerCase() === resolved.schema!.toLowerCase())
                    return {suggestions: tables.map((t) => tableSuggestion(t, range))}
                }
                // Unrecognized prefix (not an alias/table/schema we know) —
                // nothing schema-aware to add, rather than guess wrong.
                return {suggestions: []}
            }

            if (ctx.clause === 'from') {
                return {suggestions: meta.tables.map((t) => tableSuggestion(t, range))}
            }

            if (ctx.clause === 'column') {
                const referenced = ctx.tableRefs
                    .map((r) => findTable(meta, r.table, r.schema))
                    .filter((t): t is db.Table => !!t)
                const scoped = referenced.length > 0 ? referenced : meta.tables
                return {suggestions: scoped.flatMap((t) => t.columns.map((c) => columnSuggestion(t, c, range)))}
            }

            const tableItems = meta.tables.map((t) => tableSuggestion(t, range))
            const columnItems = meta.tables.flatMap((t) => t.columns.map((c) => columnSuggestion(t, c, range)))
            return {suggestions: [...tableItems, ...columnItems]}
        },
    })
}
