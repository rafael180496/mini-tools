import {useEffect, useRef} from 'react'
import {EditorState} from '@codemirror/state'
import {EditorView, keymap} from '@codemirror/view'
import {defaultKeymap, history, historyKeymap} from '@codemirror/commands'
import {bracketMatching, syntaxHighlighting, HighlightStyle, indentOnInput} from '@codemirror/language'
import {json, jsonParseLinter} from '@codemirror/lang-json'
import {linter, lintGutter} from '@codemirror/lint'
import {tags as t} from '@lezer/highlight'

// A small controlled JSON editor used by the Mongo document panel to edit a
// document with syntax highlighting + live validation (jsonParseLinter marks
// invalid JSON inline). Colors are medium tones that read on both light and
// dark surfaces; the chrome uses the app's design-token CSS vars so it adapts
// to the theme without a theme prop. Not the tabbed SQL editor
// (CodeMirrorTabbedEditor) — that one is multi-tab and SQL-specific.
interface JsonEditorProps {
    value: string
    onChange: (value: string) => void
    onValidityChange?: (valid: boolean) => void
}

const highlight = HighlightStyle.define([
    {tag: t.propertyName, color: '#0369a1'},
    {tag: [t.string, t.special(t.string)], color: '#0a7d3f'},
    {tag: t.number, color: '#b45309'},
    {tag: [t.bool, t.null], color: '#7c3aed'},
    {tag: t.punctuation, color: 'var(--color-on-surface-variant)'},
])

const chrome = EditorView.theme({
    '&': {
        backgroundColor: 'var(--color-surface-container-low)',
        color: 'var(--color-on-surface)',
        fontSize: '12px',
        border: '1px solid var(--color-outline-variant)',
        borderRadius: '6px',
    },
    '.cm-content': {fontFamily: "'JetBrains Mono', ui-monospace, monospace"},
    '.cm-gutters': {backgroundColor: 'transparent', color: 'var(--color-on-surface-variant)', border: 'none'},
    '&.cm-focused': {outline: '2px solid var(--color-primary)'},
    '.cm-activeLine, .cm-activeLineGutter': {backgroundColor: 'transparent'},
})

export default function JsonEditor({value, onChange, onValidityChange}: JsonEditorProps) {
    const containerRef = useRef<HTMLDivElement | null>(null)
    const viewRef = useRef<EditorView | null>(null)
    // Keep the latest callbacks without re-creating the editor on each render.
    const onChangeRef = useRef(onChange)
    const onValidityRef = useRef(onValidityChange)
    onChangeRef.current = onChange
    onValidityRef.current = onValidityChange

    useEffect(() => {
        if (!containerRef.current) return
        const view = new EditorView({
            parent: containerRef.current,
            state: EditorState.create({
                doc: value,
                extensions: [
                    history(),
                    keymap.of([...defaultKeymap, ...historyKeymap]),
                    indentOnInput(),
                    bracketMatching(),
                    json(),
                    syntaxHighlighting(highlight),
                    linter(jsonParseLinter()),
                    lintGutter(),
                    chrome,
                    EditorView.lineWrapping,
                    EditorView.updateListener.of((u) => {
                        if (!u.docChanged) return
                        const text = u.state.doc.toString()
                        onChangeRef.current(text)
                        if (onValidityRef.current) {
                            let valid = true
                            try {
                                JSON.parse(text)
                            } catch {
                                valid = false
                            }
                            onValidityRef.current(valid)
                        }
                    }),
                ],
            }),
        })
        viewRef.current = view
        return () => {
            view.destroy()
            viewRef.current = null
        }
        // Mount once; external value changes are handled below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // Reset the document when the value prop changes from outside (e.g. opening
    // a different document), without clobbering in-progress typing.
    useEffect(() => {
        const view = viewRef.current
        if (!view) return
        if (view.state.doc.toString() !== value) {
            view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: value}})
        }
    }, [value])

    return <div ref={containerRef} className="h-56 overflow-auto" />
}
