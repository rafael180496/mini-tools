import {useEffect, useRef} from 'react'
import {EditorState} from '@codemirror/state'
import {EditorView, keymap, lineNumbers, placeholder as placeholderExt, highlightActiveLine} from '@codemirror/view'
import {defaultKeymap, history, historyKeymap, indentWithTab} from '@codemirror/commands'
import {bracketMatching, HighlightStyle, indentOnInput, StreamLanguage, syntaxHighlighting} from '@codemirror/language'
import {shell} from '@codemirror/legacy-modes/mode/shell'
import {tags as t} from '@lezer/highlight'

// Editor de script de shell para crear y editar snippets.
//
// Era un <textarea>: un script de diez líneas con `$VAR`, comillas y un `if`
// se leía como un bloque gris, y un Tab se llevaba el foco fuera del campo en
// vez de indentar. Mismo planteo que JsonEditor —chico, controlado, colores de
// tono medio que se leen sobre superficie clara y oscura, y el marco sale de
// los tokens del tema—, pero con el modo shell de legacy-modes.
interface ShellScriptEditorProps {
    value: string
    onChange: (value: string) => void
    // Ctrl/Cmd+Enter guarda y Esc cancela sin salir del editor: con el foco
    // adentro, ir a buscar los botones con el mouse corta el trabajo.
    onSubmit?: () => void
    onCancel?: () => void
    placeholder?: string
    autoFocus?: boolean
}

const highlight = HighlightStyle.define([
    {tag: t.keyword, color: '#7c3aed', fontWeight: '600'},
    {tag: [t.string, t.special(t.string)], color: '#0a7d3f'},
    {tag: t.comment, color: 'var(--color-on-surface-variant)', fontStyle: 'italic'},
    {tag: [t.special(t.variableName), t.definition(t.variableName)], color: '#0369a1'},
    {tag: t.standard(t.variableName), color: '#b45309'},
    {tag: t.attributeName, color: '#be185d'},
    {tag: t.number, color: '#b45309'},
    {tag: t.operator, color: 'var(--color-on-surface-variant)'},
])

const chrome = EditorView.theme({
    '&': {
        backgroundColor: 'var(--color-surface-container-low)',
        color: 'var(--color-on-surface)',
        fontSize: '12px',
        border: '1px solid var(--color-outline-variant)',
        borderRadius: '8px',
        minHeight: '120px',
        maxHeight: '45vh',
    },
    '.cm-scroller': {fontFamily: "'JetBrains Mono', ui-monospace, monospace", lineHeight: '1.5'},
    '.cm-content': {caretColor: 'var(--color-primary)'},
    '.cm-cursor': {borderLeftColor: 'var(--color-primary)'},
    '.cm-gutters': {backgroundColor: 'transparent', color: 'var(--color-on-surface-variant)', border: 'none', opacity: '0.6'},
    '&.cm-focused': {outline: 'none', borderColor: 'var(--color-primary)'},
    '.cm-activeLine': {backgroundColor: 'color-mix(in srgb, var(--color-primary) 6%, transparent)'},
    '.cm-activeLineGutter': {backgroundColor: 'transparent'},
    '.cm-placeholder': {color: 'var(--color-on-surface-variant)', opacity: '0.6'},
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
        backgroundColor: 'color-mix(in srgb, var(--color-primary) 25%, transparent)',
    },
})

export default function ShellScriptEditor({value, onChange, onSubmit, onCancel, placeholder, autoFocus}: ShellScriptEditorProps) {
    const containerRef = useRef<HTMLDivElement | null>(null)
    const viewRef = useRef<EditorView | null>(null)
    const onChangeRef = useRef(onChange)
    const onSubmitRef = useRef(onSubmit)
    const onCancelRef = useRef(onCancel)
    onChangeRef.current = onChange
    onSubmitRef.current = onSubmit
    onCancelRef.current = onCancel

    useEffect(() => {
        if (!containerRef.current) return
        const view = new EditorView({
            parent: containerRef.current,
            state: EditorState.create({
                doc: value,
                extensions: [
                    lineNumbers(),
                    history(),
                    highlightActiveLine(),
                    indentOnInput(),
                    bracketMatching(),
                    StreamLanguage.define(shell),
                    syntaxHighlighting(highlight),
                    keymap.of([
                        {
                            key: 'Mod-Enter',
                            run: () => {
                                onSubmitRef.current?.()
                                return true
                            },
                        },
                        {
                            key: 'Escape',
                            run: () => {
                                if (!onCancelRef.current) return false
                                onCancelRef.current()
                                return true
                            },
                        },
                        indentWithTab,
                        ...defaultKeymap,
                        ...historyKeymap,
                    ]),
                    EditorState.tabSize.of(4),
                    placeholder ? placeholderExt(placeholder) : [],
                    chrome,
                    EditorView.updateListener.of((u) => {
                        if (u.docChanged) onChangeRef.current(u.state.doc.toString())
                    }),
                ],
            }),
        })
        viewRef.current = view
        if (autoFocus) view.focus()
        return () => {
            view.destroy()
            viewRef.current = null
        }
        // Se monta una vez; los cambios externos de `value` se aplican abajo.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // Abrir otro snippet para editar cambia `value` desde afuera: se reemplaza
    // el documento sin pisar lo que se está tecleando (en ese caso ya son iguales).
    useEffect(() => {
        const view = viewRef.current
        if (!view) return
        if (view.state.doc.toString() !== value) {
            view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: value}})
        }
    }, [value])

    return <div ref={containerRef} className="flex min-h-0 flex-col [&_.cm-editor]:flex-1" />
}
