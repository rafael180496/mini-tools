import {useEffect, useRef} from 'react'
import {configureMonacoEnvironment, monaco} from '../../monaco/setup'
import {registerSqlLanguageExtras} from '../../monaco/sqlLanguage'
import {registerSchemaCompletionProvider} from '../../monaco/completionProvider'
import {registerSchemaHoverProvider} from '../../monaco/hoverProvider'

configureMonacoEnvironment()
registerSqlLanguageExtras()
registerSchemaCompletionProvider()
registerSchemaHoverProvider()

interface MonacoSQLEditorProps {
    value: string
    onChange: (value: string) => void
    onMount?: (editor: monaco.editor.IStandaloneCodeEditor) => void
}

// Local (bundled) Monaco, no CDN, no @monaco-editor/react — see
// .claude/rules/technical.md point 6 and frontend/src/monaco/setup.ts.
export default function MonacoSQLEditor({value, onChange, onMount}: MonacoSQLEditorProps) {
    const containerRef = useRef<HTMLDivElement>(null)
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
    const onChangeRef = useRef(onChange)
    onChangeRef.current = onChange

    useEffect(() => {
        if (!containerRef.current) return

        const editor = monaco.editor.create(containerRef.current, {
            value,
            language: 'sql',
            theme: 'vs-dark',
            automaticLayout: true,
            minimap: {enabled: true},
            fontSize: 13,
        })
        editorRef.current = editor

        const sub = editor.onDidChangeModelContent(() => {
            onChangeRef.current(editor.getValue())
        })

        onMount?.(editor)

        return () => {
            sub.dispose()
            editor.dispose()
            editorRef.current = null
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // Keep the editor in sync when `value` changes from outside (switching
    // tabs, opening a file) without fighting the user's own typing.
    useEffect(() => {
        const editor = editorRef.current
        if (editor && editor.getValue() !== value) {
            editor.setValue(value)
        }
    }, [value])

    return <div ref={containerRef} className="h-full w-full" />
}
