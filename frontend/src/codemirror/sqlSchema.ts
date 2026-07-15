import {sql, PostgreSQL, SQLite, PLSQL, StandardSQL, type SQLDialect, type SQLNamespace} from '@codemirror/lang-sql'
import {hoverTooltip} from '@codemirror/view'
import type {Extension} from '@codemirror/state'
import type {Completion} from '@codemirror/autocomplete'
import {db} from '../../wailsjs/go/models'

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
// extractTableRefs — kept only for hover's alias resolution (JOIN between
// two same-column-name tables must resolve to the right one). Table/column
// completion itself no longer needs this: @codemirror/lang-sql's own
// schema-aware completion (driven by schemaToNamespace below) already
// handles FROM/JOIN vs. SELECT/WHERE scoping and "alias."/"table." dot
// completion natively.
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

function columnCompletion(t: db.Table, c: db.Column): Completion {
    return {
        label: c.name,
        type: 'field',
        detail: columnDetail(c),
        info: `${t.name}.${c.name}: ${columnDetail(c)}`,
    }
}

// Converts the active connection's cached schema metadata into the
// SQLNamespace shape @codemirror/lang-sql's built-in schema completion
// understands. Every table is reachable both unqualified (bare name, same
// flat-suggestion behavior the old completionProvider.ts had) and nested
// under its schema (for "schema." dot completion) — a table name that
// collides across two schemas only keeps one entry unqualified, an
// accepted edge case of moving from an array to a name-keyed namespace.
export function schemaToNamespace(meta: db.SchemaMetadata | null): SQLNamespace {
    if (!meta) return {}
    const topLevel: Record<string, SQLNamespace> = {}
    const bySchema = new Map<string, Record<string, SQLNamespace>>()

    for (const t of meta.tables) {
        const children = t.columns.map((c) => columnCompletion(t, c))
        const detail = t.schema ? `${t.schema}.${t.name}` : 'tabla'
        const entry: SQLNamespace = {self: {label: t.name, type: 'class', detail}, children}

        topLevel[t.name] = entry
        if (t.schema) {
            if (!bySchema.has(t.schema)) bySchema.set(t.schema, {})
            bySchema.get(t.schema)![t.name] = entry
        }
    }
    for (const [schemaName, tables] of bySchema) {
        topLevel[schemaName] = tables
    }
    return topLevel
}

// SQL language + schema-aware completion for one tab, built fresh from the
// active connection's dbType/metadata. Callers (CodeMirrorTabbedEditor)
// reconfigure the owning Compartment with a new call to this whenever the
// bound connection or its cached metadata changes — no global mutable
// store to keep in sync (see the plan's "Hallazgo clave": Monaco's
// metadataStore.ts/activeDbTypeStore.ts singletons are gone, each tab's
// EditorState just carries its own schema directly).
export function sqlLanguageExtension(dbType: string | null | undefined, meta: db.SchemaMetadata | null): Extension {
    return sql({
        dialect: dialectForDbType(dbType),
        schema: schemaToNamespace(meta),
        upperCaseKeywords: true,
    })
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
