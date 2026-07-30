// SQL language setup for the editor: dialect selection and the hover
// tooltip.
//
// Completion is NOT here — it moved to backend/sqlintel and is wired in
// sqlIntel.ts. What this file used to own (a clause detector, an alias
// parser feeding completion, a per-dialect function list and a snippet
// list) now has a single implementation in Go, shared by all four engines
// and able to see foreign keys, usage frequency and subquery scope that a
// regex pass over the buffer could not.
//
// The hover stayed on this side: it needs no analysis the completion engine
// does, it answers from the metadata the editor already holds as a prop,
// and routing a mouse-hover through the bridge would buy nothing.

import {sql, PostgreSQL, SQLite, PLSQL, MSSQL, StandardSQL, type SQLDialect} from '@codemirror/lang-sql'
import {hoverTooltip} from '@codemirror/view'
import type {Extension} from '@codemirror/state'
import {db} from '../../wailsjs/go/models'
import {sqlIntelCompletionSource, sqlInlineSuggestions} from './sqlIntel'

// Real dialects from @codemirror/lang-sql instead of a hand-rolled keyword
// list per engine (see the retired frontend/src/monaco/sqlLanguage.ts) —
// PLSQL is the library's actual Oracle PL/SQL dialect (Q-quoting, %TYPE,
// etc.), a strictly better fit than the old ORACLE_FUNCTIONS array.
export function dialectForDbType(dbType: string | null | undefined): SQLDialect {
    switch (dbType) {
        case 'postgres':
            return PostgreSQL
        case 'sqlite':
            return SQLite
        case 'oracle':
            return PLSQL
        case 'sqlserver':
            return MSSQL
        default:
            return StandardSQL
    }
}

interface TableRef {
    table: string
    schema?: string
    alias?: string
}

// Same regex/stopword approach as the retired monaco/sqlContext.ts's
// extractTableRefs, now used ONLY by sqlSchemaHover below — completion
// stopped sharing it when scope resolution moved to backend/sqlintel, which
// resolves aliases from a real token stream instead of a regex. The regex
// survives here because hover asks a much smaller question (which table
// does the word under the mouse belong to) and does not need a parse.
const ALIAS_STOPWORDS = new Set([
    'WHERE', 'ON', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS',
    'GROUP', 'ORDER', 'LIMIT', 'SET', 'VALUES', 'AND', 'OR', 'USING', 'NATURAL', 'AS',
])

function extractTableRefs(text: string): TableRef[] {
    const refs: TableRef[] = []
    const re = /\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)?)(?:\s+(?:AS\s+)?([a-zA-Z_][\w]*))?/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
        const parts = m[1].split('.')
        const schema = parts.length === 2 ? parts[0] : undefined
        const table = parts.length === 2 ? parts[1] : parts[0]
        let alias: string | undefined = m[2]
        if (alias && ALIAS_STOPWORDS.has(alias.toUpperCase())) alias = undefined
        refs.push({table, schema, alias})
    }
    return refs
}

function findTable(meta: db.SchemaMetadata, name: string, schema?: string): db.Table | undefined {
    return meta.tables.find(
        (t) => t.name.toLowerCase() === name.toLowerCase() && (!schema || t.schema?.toLowerCase() === schema.toLowerCase()),
    )
}

function resolveRefTable(ref: TableRef, meta: db.SchemaMetadata): db.Table | undefined {
    return findTable(meta, ref.table, ref.schema)
}

function columnDetail(c: db.Column): string {
    return `${c.dataType}${c.nullable ? '' : ' NOT NULL'}`
}

// SQL language + IntelliSense for one tab, built fresh from the connection
// the tab is bound to. Callers (CodeMirrorTabbedEditor) reconfigure the
// owning Compartment with a new call to this whenever that binding changes
// — no global mutable store to keep in sync, each tab's EditorState just
// carries its own dialect and connection id directly.
//
// connId is what makes completion schema-aware: it is the key the Go engine
// looks its compiled index up under. Pass null for a read-only viewer (the
// DDL modal), which gets syntax highlighting and nothing else — no
// completion source, no ghost text, no bridge traffic.
export function sqlLanguageExtension(dbType: string | null | undefined, connId: string | null): Extension {
    const dialect = dialectForDbType(dbType)
    const base: Extension[] = [
        // No `schema` passed here on purpose: lang-sql's schemaCompletion
        // returns [] when config.schema is falsy, so the library registers
        // no schema-based source at all and cannot reintroduce the
        // clause-blind suggestions this engine exists to replace. Its
        // keyword completion and its highlighting are unaffected.
        sql({dialect, upperCaseKeywords: true}),
    ]
    if (!connId) return base

    return [
        ...base,
        // The single schema-aware source, answered by backend/sqlintel.
        // Registered on the dialect's language data the same additive way
        // Redis's own source is; lang-sql's keyword source stays alongside
        // it, and CodeMirror merges the two result sets.
        dialect.language.data.of({autocomplete: sqlIntelCompletionSource(connId, dbType)}),
        // Grey inline prediction (a FK join condition, or the rest of an
        // unambiguous name) accepted with Tab.
        sqlInlineSuggestions(connId, dbType),
    ]
}

// Hover tooltip for a table/column under the cursor — port of the retired
// monaco/hoverProvider.ts, same alias-aware resolution (a JOIN between two
// tables sharing a column name resolves to whichever one the cursor's
// alias/table prefix actually points at, not just the first metadata
// match). Built with `meta` fixed at construction time, same reconfigure-
// on-change contract as sqlLanguageExtension above.
export function sqlSchemaHover(meta: db.SchemaMetadata | null): Extension {
    return hoverTooltip((view, pos) => {
        if (!meta) return null

        const line = view.state.doc.lineAt(pos)
        const text = line.text
        const rel = pos - line.from
        let start = rel
        let end = rel
        while (start > 0 && /\w/.test(text[start - 1])) start--
        while (end < text.length && /\w/.test(text[end])) end++
        if (start === end) return null
        const word = text.slice(start, end)

        const refs = extractTableRefs(view.state.doc.toString())

        let table: db.Table | undefined
        let column: db.Column | undefined

        const before = view.state.sliceDoc(0, line.from + start)
        const dotMatch = before.match(/([a-zA-Z_]\w*)\.$/)
        if (dotMatch) {
            const prefix = dotMatch[1]
            const ref = refs.find(
                (r) => (r.alias && r.alias.toLowerCase() === prefix.toLowerCase()) || (!r.alias && r.table.toLowerCase() === prefix.toLowerCase()),
            )
            table = ref ? resolveRefTable(ref, meta) : findTable(meta, prefix)
            if (table) column = table.columns.find((c) => c.name.toLowerCase() === word.toLowerCase())
        }

        if (!table && !column) {
            const referenced = refs.map((r) => resolveRefTable(r, meta)).filter((t): t is db.Table => !!t)
            const seen = new Set<db.Table>()
            for (const t of [...referenced, ...meta.tables]) {
                if (seen.has(t)) continue
                seen.add(t)
                if (t.name.toLowerCase() === word.toLowerCase()) {
                    table = t
                    break
                }
                const col = t.columns.find((c) => c.name.toLowerCase() === word.toLowerCase())
                if (col) {
                    table = t
                    column = col
                    break
                }
            }
        }

        if (!table) return null

        return {
            pos: line.from + start,
            end: line.from + end,
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

                if (column) {
                    const fk = table!.foreignKeys.find((f) => f.column === column!.name)
                    const lines = [`${table!.name}.${column.name}`, columnDetail(column)]
                    if (column.isPrimaryKey) lines.push('PRIMARY KEY')
                    if (fk) lines.push(`FK → ${fk.referencedTable}.${fk.referencedColumn}`)
                    dom.textContent = lines.join('\n')
                } else {
                    dom.textContent = `${table!.name} (tabla)\n${table!.columns.length} columnas`
                }

                return {dom}
            },
        }
    })
}
