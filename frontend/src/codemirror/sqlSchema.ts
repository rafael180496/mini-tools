import {sql, PostgreSQL, SQLite, PLSQL, StandardSQL, type SQLDialect} from '@codemirror/lang-sql'
import {hoverTooltip} from '@codemirror/view'
import type {Extension} from '@codemirror/state'
import type {Completion, CompletionContext, CompletionResult, CompletionSource} from '@codemirror/autocomplete'
import {db} from '../../wailsjs/go/models'
import {sqlSnippetCompletionSource} from './sqlSnippets'

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
// extractTableRefs. Used by both sqlSchemaHover below AND
// schemaAwareCompletionSource further down, for the same FROM/JOIN alias
// resolution in both hover and completion.
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

// Clause the cursor is sitting in, decided by the last relevant keyword
// found scanning backward from the cursor — same idea the retired
// monaco/sqlContext.ts used ("último keyword antes del cursor gana"), ported
// because @codemirror/lang-sql's own schema completion has NONE of this: it
// suggests every top-level schema/table name matching the typed prefix
// REGARDLESS of clause, so "WHERE NIS_|" and "FROM NIS_|" got the exact same
// (noisy) suggestion list — confirmed live against a real Oracle schema with
// dozens of NIS_*-prefixed tables/synonyms burying the one column that
// actually mattered. 'from': right after FROM/JOIN/INTO/UPDATE, a table name
// is expected. 'column': right after SELECT/WHERE/SET/ON/AND/OR/GROUP·ORDER
// BY/HAVING, a column name is expected. 'other': anything else (start of
// statement, after a comma in an ambiguous spot, etc.) — falls back to the
// broadest suggestion so this never offers LESS than before.
type Clause = 'from' | 'column' | 'other'

const FROM_KEYWORDS = new Set(['FROM', 'JOIN', 'INTO', 'UPDATE'])
const COLUMN_KEYWORDS = new Set([
    'SELECT', 'WHERE', 'SET', 'ON', 'AND', 'OR', 'GROUP', 'ORDER', 'HAVING', 'BY',
])

export function detectClause(textBeforeCursor: string): Clause {
    // Scope the scan to the CURRENT statement only — a naive last-";" split
    // (no string/PL-SQL-block awareness, same tolerance the rest of this
    // hand-rolled analysis already accepts — see this function's own doc
    // comment). Without this, typing right after "SELECT 1; |" still saw the
    // PREVIOUS statement's SELECT as "the last keyword" and stayed in
    // 'column' mode instead of 'other' — wrong for both this function's
    // existing callers (table/column completion misbehaving at the start of
    // a later statement in a multi-statement script) and for
    // sqlSnippetCompletionSource (statement snippets never offered there).
    const lastSemi = textBeforeCursor.lastIndexOf(';')
    if (lastSemi !== -1) textBeforeCursor = textBeforeCursor.slice(lastSemi + 1)

    const re = /\b([a-zA-Z_]+)\b/g
    let lastKeyword: string | null = null
    let lastKeywordEnd = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(textBeforeCursor))) {
        const word = m[1].toUpperCase()
        if (FROM_KEYWORDS.has(word) || COLUMN_KEYWORDS.has(word)) {
            lastKeyword = word
            lastKeywordEnd = m.index + m[0].length
        }
    }

    // "INSERT INTO table (col1, col2|" — an unclosed "(" after the table
    // reference means the column list already started; same edge case the
    // retired monaco/sqlContext.ts special-cased ("cae a columnas de users
    // pese a que el último keyword visto fue INTO").
    if (lastKeyword === 'INTO') {
        const afterInto = textBeforeCursor.slice(lastKeywordEnd)
        const opens = (afterInto.match(/\(/g) ?? []).length
        const closes = (afterInto.match(/\)/g) ?? []).length
        if (opens > closes) return 'column'
    }

    if (lastKeyword && FROM_KEYWORDS.has(lastKeyword)) return 'from'
    if (lastKeyword && COLUMN_KEYWORDS.has(lastKeyword)) return 'column'
    return 'other'
}

function tableCompletion(t: db.Table): Completion {
    return {label: t.name, type: 'class', detail: t.schema ? `${t.schema}.${t.name}` : 'tabla'}
}

// Table + schema name suggestions, deduped — used for the 'from'/'other'
// clauses and as the fallback for 'column' when no FROM/JOIN table resolved
// yet (a brand new query with nothing to scope columns to).
function tableAndSchemaCompletions(meta: db.SchemaMetadata): Completion[] {
    const options: Completion[] = []
    const seenTables = new Set<string>()
    for (const t of meta.tables) {
        const key = t.name.toLowerCase()
        if (seenTables.has(key)) continue
        seenTables.add(key)
        options.push(tableCompletion(t))
    }
    const seenSchemas = new Set<string>()
    for (const t of meta.tables) {
        if (!t.schema) continue
        const key = t.schema.toLowerCase()
        if (seenSchemas.has(key)) continue
        seenSchemas.add(key)
        options.push({label: t.schema, type: 'namespace', detail: 'schema'})
    }
    return options
}

// All columns of every table referenced in the current statement's
// FROM/JOIN/INTO/UPDATE clause(s), deduped by name — the actual "detect the
// table you're using, suggest its columns" behavior. Empty if none of the
// parsed refs resolve to a known table.
function referencedColumns(meta: db.SchemaMetadata, refs: TableRef[]): Completion[] {
    const seen = new Set<string>()
    const options: Completion[] = []
    for (const ref of refs) {
        const table = resolveRefTable(ref, meta)
        if (!table) continue
        for (const c of table.columns) {
            const key = c.name.toLowerCase()
            if (seen.has(key)) continue
            seen.add(key)
            options.push(columnCompletion(table, c))
        }
    }
    return options
}

// Every column of every known table, deduped — the safety-net fallback for
// a 'column' clause when no FROM/JOIN reference resolved to anything (e.g.
// "SELECT |" typed before any FROM exists in the document at all). Matches
// the retired monaco/completionProvider.ts's own fallback ("nunca sugiere
// menos que el comportamiento anterior").
function allColumns(meta: db.SchemaMetadata): Completion[] {
    const seen = new Set<string>()
    const options: Completion[] = []
    for (const t of meta.tables) {
        for (const c of t.columns) {
            const key = c.name.toLowerCase()
            if (seen.has(key)) continue
            seen.add(key)
            options.push(columnCompletion(t, c))
        }
    }
    return options
}

// THE schema-aware completion source — replaces @codemirror/lang-sql's own
// entirely (sql() below is called WITHOUT a `schema`, so its
// schemaCompletion() contributes nothing at all: see completeFromSchema's
// source, schemaCompletion returns `[]` when config.schema is falsy — no
// second source is left around to reintroduce the noise this exists to
// remove). Handles all three completion shapes a SQL editor needs:
//   1. Dot-qualified ("alias."/"table."/"schema.") — resolves the prefix via
//      the same FROM/JOIN alias tracking extractTableRefs already does for
//      hover, or a schema name, and suggests ONLY that scope's columns/tables.
//   2. Bare, clause 'from' — table + schema names (what FROM/JOIN/INTO/
//      UPDATE always wanted, unaffected by this rewrite).
//   3. Bare, clause 'column' — ONLY the columns of tables referenced by the
//      statement's FROM/JOIN, no unrelated tables/synonyms mixed in — this
//      is the actual fix. Falls back to every table's columns if no
//      reference resolved yet, and to table+schema names for clause 'other'.
function schemaAwareCompletionSource(meta: db.SchemaMetadata | null): CompletionSource {
    return (context: CompletionContext): CompletionResult | null => {
        if (!meta) return null

        const dotMatch = context.matchBefore(/([a-zA-Z_]\w*)\.(\w*)$/)
        if (dotMatch) {
            const parsed = /([a-zA-Z_]\w*)\.(\w*)$/.exec(dotMatch.text)
            if (!parsed) return null
            const [, prefix, partial] = parsed
            const from = dotMatch.to - partial.length

            const schemaTables = meta.tables.filter((t) => t.schema?.toLowerCase() === prefix.toLowerCase())
            if (schemaTables.length > 0) {
                return {from, options: schemaTables.map(tableCompletion), validFor: /^\w*$/}
            }

            const refs = extractTableRefs(context.state.doc.toString())
            const ref = refs.find(
                (r) => (r.alias && r.alias.toLowerCase() === prefix.toLowerCase()) || (!r.alias && r.table.toLowerCase() === prefix.toLowerCase()),
            )
            const table = ref ? resolveRefTable(ref, meta) : findTable(meta, prefix)
            if (!table) return null
            return {from, options: table.columns.map((c) => columnCompletion(table, c)), validFor: /^\w*$/}
        }

        const word = context.matchBefore(/\w*/)
        if (!word) return null
        if (word.from === word.to && !context.explicit) return null

        const clause = detectClause(context.state.sliceDoc(0, word.from))

        if (clause === 'column') {
            const refs = extractTableRefs(context.state.doc.toString())
            const options = refs.length > 0 ? referencedColumns(meta, refs) : []
            const finalOptions = options.length > 0 ? options : allColumns(meta)
            if (finalOptions.length === 0) return null
            return {from: word.from, options: finalOptions, validFor: /^\w*$/}
        }

        const options = tableAndSchemaCompletions(meta)
        if (options.length === 0) return null
        return {from: word.from, options, validFor: /^\w*$/}
    }
}

// SQL language + schema-aware completion for one tab, built fresh from the
// active connection's dbType/metadata. Callers (CodeMirrorTabbedEditor)
// reconfigure the owning Compartment with a new call to this whenever the
// bound connection or its cached metadata changes — no global mutable
// store to keep in sync (see the plan's "Hallazgo clave": Monaco's
// metadataStore.ts/activeDbTypeStore.ts singletons are gone, each tab's
// EditorState just carries its own schema directly).
export function sqlLanguageExtension(dbType: string | null | undefined, meta: db.SchemaMetadata | null): Extension {
    const dialect = dialectForDbType(dbType)
    return [
        // No `schema` passed here on purpose — see schemaAwareCompletionSource's
        // doc comment above. sql() still wires up its own keyword completion
        // regardless (keywordCompletionSource, unaffected by this).
        sql({dialect, upperCaseKeywords: true}),
        dialect.language.data.of({autocomplete: schemaAwareCompletionSource(meta)}),
        // A separate `autocomplete` entry, not merged into the same source
        // function above — CodeMirror queries every source registered on the
        // language data and merges their results, same additive pattern
        // Redis's own completion source already relies on for command vs.
        // key suggestions. Generic statement snippets ("ins" → full INSERT
        // skeleton, etc.), see sqlSnippets.ts.
        dialect.language.data.of({autocomplete: sqlSnippetCompletionSource(dbType)}),
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
