import {useEffect, useRef} from 'react'
import {EditorState, Prec} from '@codemirror/state'
import {EditorView, keymap, placeholder} from '@codemirror/view'
import {defaultKeymap, history, historyKeymap} from '@codemirror/commands'
import {syntaxHighlighting, defaultHighlightStyle} from '@codemirror/language'
import {json} from '@codemirror/lang-json'
import {autocompletion, closeBrackets, type CompletionSource} from '@codemirror/autocomplete'
import {MONGO_QUERY_OPERATORS} from '../../lib/mongoFilter'

// A compact single-line Extended-JSON filter editor for the Mongo browser, with
// autocomplete of the collection's field names (from the loaded documents) and
// query operators ($gt/$in/…). Enter applies the filter (never inserts a
// newline); pasted newlines are stripped so it stays one line. Chrome uses the
// app's design-token CSS vars so it adapts to light/dark without a theme prop —
// same approach as JsonEditor.tsx.
interface MongoFilterInputProps {
    value: string
    onChange: (value: string) => void
    onApply: () => void
    // Latest known field paths — read live via a ref so the editor (mounted
    // once) always completes against the current collection's fields.
    fields: string[]
    // Sample values seen per field (mongosh literals), for value-position
    // completion — the Compass-like "suggest the values that exist" behavior.
    valuesByField: Record<string, string[]>
}

const chrome = EditorView.theme({
    '&': {
        backgroundColor: 'var(--color-surface-container-low)',
        color: 'var(--color-on-surface)',
        fontSize: '12px',
        border: '1px solid var(--color-outline-variant)',
        borderRadius: '6px',
    },
    '.cm-content': {fontFamily: "'JetBrains Mono', ui-monospace, monospace", padding: '5px 8px'},
    '.cm-line': {padding: '0'},
    '&.cm-focused': {outline: '1px solid var(--color-primary)'},
    '.cm-scroller': {overflow: 'hidden'},
})

function filterCompletionSource(fieldsRef: {current: string[]}, valuesRef: {current: Record<string, string[]>}): CompletionSource {
    return (ctx) => {
        // $operator anywhere.
        const op = ctx.matchBefore(/\$[\w]*/)
        if (op) {
            return {
                from: op.from,
                options: MONGO_QUERY_OPERATORS.map((o) => ({label: o, type: 'keyword'})),
                validFor: /^\$\w*$/,
            }
        }

        const line = ctx.state.doc.lineAt(ctx.pos)
        const before = ctx.state.sliceDoc(line.from, ctx.pos)

        // Value position: after `"field":` suggest the values seen for that
        // field. The partial is the run of value chars typed so far.
        const valMatch = before.match(/"([\w.]+)"\s*:\s*(\S*)$/)
        if (valMatch) {
            const field = valMatch[1]
            const partial = valMatch[2]
            const vals = valuesRef.current[field] ?? []
            if (vals.length > 0) {
                return {
                    from: ctx.pos - partial.length,
                    options: vals.map((v) => ({label: v, type: 'text'})),
                    // Re-query as they type — value literals contain quotes/parens.
                    validFor: /^\S*$/,
                }
            }
            return null
        }

        const fields = fieldsRef.current
        if (fields.length === 0) return null

        // Key position: an opening quote, or a bare word. Insert `"field": ` so
        // the flow continues straight into the value (which then autocompletes).
        const quoted = ctx.matchBefore(/"[\w.]*/)
        if (quoted) {
            return {
                from: quoted.from,
                options: fields.map((f) => ({label: f, apply: `"${f}": `, type: 'property'})),
                validFor: /^"[\w.]*$/,
            }
        }
        const word = ctx.matchBefore(/[\w.]+/)
        if (word && word.from !== word.to) {
            return {
                from: word.from,
                options: fields.map((f) => ({label: f, apply: `"${f}": `, type: 'property'})),
                validFor: /^[\w.]*$/,
            }
        }
        return null
    }
}

export default function MongoFilterInput({value, onChange, onApply, fields, valuesByField}: MongoFilterInputProps) {
    const containerRef = useRef<HTMLDivElement | null>(null)
    const viewRef = useRef<EditorView | null>(null)
    const onChangeRef = useRef(onChange)
    const onApplyRef = useRef(onApply)
    const fieldsRef = useRef(fields)
    const valuesRef = useRef(valuesByField)
    onChangeRef.current = onChange
    onApplyRef.current = onApply
    fieldsRef.current = fields
    valuesRef.current = valuesByField

    useEffect(() => {
        if (!containerRef.current) return
        const view = new EditorView({
            parent: containerRef.current,
            state: EditorState.create({
                doc: value,
                extensions: [
                    history(),
                    // Enter applies the filter instead of inserting a newline.
                    Prec.highest(
                        keymap.of([
                            {
                                key: 'Enter',
                                run: () => {
                                    onApplyRef.current()
                                    return true
                                },
                            },
                        ]),
                    ),
                    keymap.of([...defaultKeymap, ...historyKeymap]),
                    closeBrackets(),
                    json(),
                    syntaxHighlighting(defaultHighlightStyle),
                    autocompletion({override: [filterCompletionSource(fieldsRef, valuesRef)]}),
                    placeholder('Filtro: { "campo": valor }  — Ctrl+Espacio autocompleta'),
                    chrome,
                    // Keep it single-line: reject a change that would produce
                    // more than one line (e.g. a multi-line paste), so the box
                    // never grows into a textarea.
                    EditorState.transactionFilter.of((tr) => (tr.docChanged && tr.newDoc.lines > 1 ? [] : tr)),
                    EditorView.updateListener.of((u) => {
                        if (u.docChanged) onChangeRef.current(u.state.doc.toString())
                    }),
                ],
            }),
        })
        viewRef.current = view
        return () => {
            view.destroy()
            viewRef.current = null
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // Sync when the value is set from outside (wizard, click-to-filter, clear).
    useEffect(() => {
        const view = viewRef.current
        if (!view) return
        if (view.state.doc.toString() !== value) {
            view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: value}})
        }
    }, [value])

    return <div ref={containerRef} className="min-w-0 flex-1" />
}
