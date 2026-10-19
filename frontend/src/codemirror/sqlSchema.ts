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
import {autocompletion} from '@codemirror/autocomplete'
import {Decoration, EditorView, hoverTooltip, type DecorationSet} from '@codemirror/view'
import {StateEffect, StateField, type Extension} from '@codemirror/state'
import {db} from '../../wailsjs/go/models'
import {sqlIntelCompletionSource, sqlInlineSuggestions, sqlCompletionTheme, sqlCompletionFooter, sqlCompletionKeys} from './sqlIntel'
import {sqlSignatureHelp} from './sqlSignature'
import {sqlFormatKeymap} from './sqlFormat'

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
        // Applied even to an unbound tab: lang-sql's own keyword completion
        // still opens a popup there, and it should look like the rest of the
        // app rather than like CodeMirror's default.
        sqlCompletionTheme,
        sqlCompletionFooter(),
        // Tab elige del popup (y reemplaza el resto de la palabra).
        sqlCompletionKeys,
        // Formatear (⌥⌘L / Ctrl+Alt+L) no necesita conexión: es solo texto.
        sqlFormatKeymap,
    ]
    if (!connId) return base

    return [
        ...base,
        // The single completion source, answered by backend/sqlintel. It is
        // an `override` rather than one more entry in the dialect's language
        // data: the engine already offers the dialect's keywords, and
        // lang-sql's own keyword source stayed alongside it, so every
        // keyword showed up twice — once per source, with a different icon.
        // `override` replaces the language's sources; `autocompletion()` in
        // basicSetup passes no config, so the two do not conflict.
        autocompletion({override: [sqlIntelCompletionSource(connId, dbType)]}),
        // Grey inline prediction (a FK join condition, or the rest of an
        // unambiguous name) accepted with Tab.
        sqlInlineSuggestions(connId, dbType),
        // Parameter info for the call under the cursor. It takes over
        // exactly where completion stops being useful — once the opening
        // parenthesis is in, the question is no longer "which routine?" but
        // "what goes in this argument?".
        sqlSignatureHelp(connId, dbType),
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
                // Sin borde ni fondo propios: el marco es el del tooltip
                // (editorChrome.ts).
                dom.style.padding = '6px 8px'
                dom.style.font = '12px var(--font-mono)'
                dom.style.color = 'var(--color-on-surface)'
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

// --- Ir a la definición (Ctrl/Cmd+clic) ------------------------------------

// Lo que se puede abrir en el visor de DDL. Es el mismo conjunto que
// DDLObjectType (components/DDLViewerModal.tsx), repetido acá para que el
// módulo del editor no dependa de un componente.
export interface SchemaObjectRef {
    objectType: 'table' | 'procedure' | 'function' | 'package'
    schema: string
    name: string
    oid: number
}

function eqi(a: string | undefined, b: string | undefined): boolean {
    return (a ?? '').toLowerCase() === (b ?? '').toLowerCase()
}

// resolveObjectAt lee el identificador bajo pos —con lo que tenga calificado
// a la izquierda: "alias.", "ESQUEMA.", "PKG."— y lo busca en la metadata.
// Devuelve también el rango a subrayar.
function resolveObjectAt(
    meta: db.SchemaMetadata,
    doc: string,
    pos: number,
): {ref: SchemaObjectRef; from: number; to: number} | null {
    const isWord = (c: string | undefined) => !!c && /[\w$#]/.test(c)
    let start = pos
    let end = pos
    while (start > 0 && isWord(doc[start - 1])) start--
    while (end < doc.length && isWord(doc[end])) end++
    if (start === end) return null
    const word = doc.slice(start, end)

    // Calificador inmediato a la izquierda ("x." + palabra).
    let qualifier: string | undefined
    if (doc[start - 1] === '.') {
        let q = start - 1
        while (q > 0 && isWord(doc[q - 1])) q--
        qualifier = doc.slice(q, start - 1) || undefined
    }
    // Lo que sigue: "PKG" en "PKG.miembro" es el package, no un miembro.
    const followedByDot = doc[end] === '.'

    const tableRef = (t: db.Table): SchemaObjectRef => ({objectType: 'table', schema: t.schema ?? '', name: t.name, oid: 0})

    if (qualifier) {
        // alias.columna o tabla.columna: la palabra es una columna; se abre la
        // tabla a la que pertenece.
        const refs = extractTableRefs(doc)
        const viaAlias = refs.find((r) => eqi(r.alias, qualifier) || (!r.alias && eqi(r.table, qualifier)))
        if (viaAlias) {
            const t = resolveRefTable(viaAlias, meta)
            if (t) return {ref: tableRef(t), from: start, to: end}
        }
        // ESQUEMA.tabla
        const t = findTable(meta, word, qualifier)
        if (t) return {ref: tableRef(t), from: start, to: end}
        // PKG.miembro → el package.
        const pkg = meta.packages?.find((p) => eqi(p.name, qualifier))
        if (pkg) return {ref: {objectType: 'package', schema: pkg.schema ?? '', name: pkg.name, oid: 0}, from: start, to: end}
    }

    const schema = qualifier
    // Sin calificador, un alias ("FROM clientes c" … clic en "c") lleva a su
    // tabla.
    if (!qualifier) {
        const aliasRef = extractTableRefs(doc).find((r) => eqi(r.alias, word))
        if (aliasRef) {
            const t = resolveRefTable(aliasRef, meta)
            if (t) return {ref: tableRef(t), from: start, to: end}
        }
    }
    // La tabla antes que el código: en un texto SQL un nombre suelto es casi
    // siempre una tabla, y un procedimiento homónimo se abre calificándolo.
    const t = findTable(meta, word, schema)
    if (t && !followedByDot) return {ref: tableRef(t), from: start, to: end}
    const proc = meta.procedures?.find((p) => eqi(p.name, word) && (!schema || eqi(p.schema, schema)))
    if (proc && !followedByDot) return {ref: {objectType: 'procedure', schema: proc.schema ?? '', name: proc.name, oid: proc.oid ?? 0}, from: start, to: end}
    const fn = meta.functions?.find((f) => eqi(f.name, word) && (!schema || eqi(f.schema, schema)))
    if (fn && !followedByDot) return {ref: {objectType: 'function', schema: fn.schema ?? '', name: fn.name, oid: fn.oid ?? 0}, from: start, to: end}
    const pkg = meta.packages?.find((p) => eqi(p.name, word) && (!schema || eqi(p.schema, schema)))
    if (pkg) return {ref: {objectType: 'package', schema: pkg.schema ?? '', name: pkg.name, oid: 0}, from: start, to: end}
    return null
}

const setGoLink = StateEffect.define<{from: number; to: number} | null>()

const goLinkField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(deco, tr) {
        for (const e of tr.effects) {
            if (e.is(setGoLink)) {
                return e.value ? Decoration.set([Decoration.mark({class: 'cm-sql-golink'}).range(e.value.from, e.value.to)]) : Decoration.none
            }
        }
        return tr.docChanged ? Decoration.none : deco.map(tr.changes)
    },
    provide: (f) => EditorView.decorations.from(f),
})

const goLinkTheme = EditorView.baseTheme({
    '.cm-sql-golink': {
        textDecoration: 'underline',
        textDecorationColor: 'var(--color-primary)',
        textUnderlineOffset: '2px',
        cursor: 'pointer',
    },
})

// En macOS el modificador es Cmd: Ctrl+clic ahí es el menú contextual.
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const modHeld = (e: MouseEvent | KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey)

// sqlGoToObject: Ctrl+clic (Cmd+clic en macOS) sobre una tabla, un alias, un
// procedimiento, una función o un package abre su DDL — el "Go to
// declaration" de DataGrip. Mientras se mantiene la tecla, el nombre que se
// puede abrir se subraya: así se sabe ANTES de hacer clic si va a pasar algo.
//
// Sobre una palabra que no resuelve a nada el clic sigue su camino normal
// (en CodeMirror, Mod+clic agrega un cursor), así que no se pierde nada.
export function sqlGoToObject(meta: db.SchemaMetadata | null, open: (ref: SchemaObjectRef) => void): Extension {
    if (!meta) return []
    const underline = (view: EditorView, e: MouseEvent | null) => {
        const current = view.state.field(goLinkField).size > 0
        if (!e || !modHeld(e)) {
            if (current) view.dispatch({effects: setGoLink.of(null)})
            return
        }
        const pos = view.posAtCoords({x: e.clientX, y: e.clientY})
        const hit = pos === null ? null : resolveObjectAt(meta, view.state.doc.toString(), pos)
        if (!hit && !current) return
        view.dispatch({effects: setGoLink.of(hit ? {from: hit.from, to: hit.to} : null)})
    }
    let lastMove: MouseEvent | null = null
    return [
        goLinkField,
        goLinkTheme,
        EditorView.domEventHandlers({
            mousedown(e, view) {
                if (e.button !== 0 || !modHeld(e)) return false
                const pos = view.posAtCoords({x: e.clientX, y: e.clientY})
                if (pos === null) return false
                const hit = resolveObjectAt(meta, view.state.doc.toString(), pos)
                if (!hit) return false
                e.preventDefault()
                view.dispatch({effects: setGoLink.of(null)})
                open(hit.ref)
                return true
            },
            mousemove(e, view) {
                lastMove = e
                underline(view, e)
                return false
            },
            mouseleave(_e, view) {
                lastMove = null
                underline(view, null)
                return false
            },
            keydown(e, view) {
                if (lastMove && (e.key === 'Meta' || e.key === 'Control')) {
                    underline(view, new MouseEvent('mousemove', {clientX: lastMove.clientX, clientY: lastMove.clientY, metaKey: e.metaKey, ctrlKey: e.ctrlKey}))
                }
                return false
            },
            keyup(e, view) {
                if (e.key === 'Meta' || e.key === 'Control') underline(view, null)
                return false
            },
        }),
    ]
}
