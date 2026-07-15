import {useEffect, useRef, useState} from 'react'
import {EditorState} from '@codemirror/state'
import {EditorView} from '@codemirror/view'
import {basicSetup} from 'codemirror'
import {GetObjectDDL, SaveDDLToFile} from '../../wailsjs/go/main/App'
import {sqlLanguageExtension} from '../codemirror/sqlSchema'
import {resolveEditorTheme} from '../codemirror/themes'
import type {Theme} from '../hooks/useTheme'
import Icon from './Icon'

export type DDLObjectType = 'table' | 'procedure' | 'function' | 'trigger' | 'package'

interface DDLViewerModalProps {
    connId: string
    objectType: DDLObjectType
    schema: string
    name: string
    // Only meaningful for Postgres functions/procedures/triggers — see
    // db.Function's doc comment (backend/db/metadata.go) on why the name
    // alone can't disambiguate an overloaded function.
    oid: number
    // Picks the CodeMirror SQL dialect for syntax highlighting (see
    // sqlSchema.ts's dialectForDbType) — this modal has no connection list
    // of its own, so Workspace.tsx resolves it from ddlViewer.connId and
    // passes it down.
    dbType: string
    editorThemeId: string
    appTheme: Theme
    onClose: () => void
}

// height:100% so CodeMirror fills its flex-1 container instead of
// collapsing to its content's natural (tiny) height — same pattern
// CodeMirrorTabbedEditor.tsx's own baseTheme uses, duplicated locally
// since that one is module-private and this is a small, one-shot,
// read-only view rather than the multi-tab cached-state editor.
const baseTheme = EditorView.theme({
    '&': {height: '100%', fontSize: '12px'},
    '.cm-scroller': {fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace", overflow: 'auto'},
})

const OBJECT_TYPE_LABELS: Record<DDLObjectType, string> = {
    table: 'Tabla',
    procedure: 'Procedure',
    function: 'Function',
    trigger: 'Trigger',
    package: 'Package',
}

const OBJECT_TYPE_ICONS: Record<DDLObjectType, string> = {
    table: 'table_chart',
    procedure: 'terminal',
    function: 'functions',
    trigger: 'bolt',
    package: 'inventory_2',
}

// Modal DDL preview — GetObjectDDL fetches the object's current definition
// straight from the engine (DBMS_METADATA.GET_DDL / pg_get_functiondef /
// pg_get_triggerdef / sqlite_master, see backend/export/ddl_*.go), rendered
// as a read-only CodeMirror view with the same SQL syntax highlighting and
// theme as the main editor tabs (see sqlSchema.ts/themes.ts) instead of
// plain monospace text. "Exportar a archivo" reuses the text already in
// memory (SaveDDLToFile) instead of re-fetching.
export default function DDLViewerModal({connId, objectType, schema, name, oid, dbType, editorThemeId, appTheme, onClose}: DDLViewerModalProps) {
    const [ddl, setDdl] = useState('')
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [copyHint, setCopyHint] = useState('')
    const containerRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)

    useEffect(() => {
        let cancelled = false
        setLoading(true)
        setError('')

        GetObjectDDL(connId, objectType, schema, name, oid)
            .then((text) => {
                if (!cancelled) setDdl(text)
            })
            .catch((err) => {
                if (!cancelled) setError(String(err))
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })

        return () => {
            cancelled = true
        }
    }, [connId, objectType, schema, name, oid])

    // Mounts a single one-shot read-only view once the DDL text is ready —
    // unlike CodeMirrorTabbedEditor's shared-view-many-states setup, this
    // modal only ever shows one document at a time, so recreating the whole
    // view when the DDL/theme changes is simpler and cheap enough here.
    useEffect(() => {
        if (loading || error || !containerRef.current) return
        const view = new EditorView({
            state: EditorState.create({
                doc: ddl,
                extensions: [
                    basicSetup,
                    baseTheme,
                    sqlLanguageExtension(dbType, null),
                    resolveEditorTheme(editorThemeId, appTheme),
                    EditorView.editable.of(false),
                    EditorState.readOnly.of(true),
                    EditorView.lineWrapping,
                ],
            }),
            parent: containerRef.current,
        })
        viewRef.current = view
        return () => {
            view.destroy()
            viewRef.current = null
        }
    }, [ddl, loading, error, dbType, editorThemeId, appTheme])

    async function copyDDL() {
        await navigator.clipboard.writeText(ddl)
        setCopyHint('Copiado')
        setTimeout(() => setCopyHint(''), 1500)
    }

    async function exportDDL() {
        try {
            await SaveDDLToFile(`${name}.sql`, ddl)
        } catch (err) {
            setError(String(err))
        }
    }

    return (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60">
            <div className="flex max-h-[80vh] w-[42rem] flex-col gap-3 overflow-hidden rounded-xl border border-outline-variant bg-surface-container-high p-6 text-on-surface shadow-lg">
                <div className="flex items-center gap-2">
                    <Icon name={OBJECT_TYPE_ICONS[objectType]} size={18} className="shrink-0 text-primary" />
                    <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" title={schema ? `${schema}.${name}` : name}>
                        {schema ? `${schema}.${name}` : name}
                    </h2>
                    <span className="shrink-0 rounded bg-surface-container-highest px-2 py-0.5 text-[11px] uppercase text-on-surface-variant">
                        {OBJECT_TYPE_LABELS[objectType]}
                    </span>
                    <button
                        onClick={onClose}
                        title="Cierra este panel"
                        className="shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="close" size={18} />
                    </button>
                </div>

                {loading && <p className="text-xs text-on-surface-variant">Cargando DDL…</p>}
                {error && <p className="text-xs text-error">{error}</p>}

                {!loading && !error && (
                    <>
                        <div className="flex items-center justify-end gap-2 text-xs text-on-surface-variant">
                            <button
                                onClick={() => void copyDDL()}
                                title="Copia el DDL al portapapeles"
                                className="flex items-center gap-1 rounded px-2 py-1 hover:bg-surface-variant"
                            >
                                <Icon name="content_copy" size={14} />
                                {copyHint || 'Copiar'}
                            </button>
                            <button
                                onClick={() => void exportDDL()}
                                title="Guarda este DDL en un archivo .sql"
                                className="flex items-center gap-1 rounded px-2 py-1 hover:bg-surface-variant"
                            >
                                <Icon name="download" size={14} />
                                Exportar a archivo
                            </button>
                        </div>
                        <div className="flex-1 overflow-hidden rounded-lg border border-outline-variant">
                            <div ref={containerRef} className="h-full w-full" />
                        </div>
                    </>
                )}
            </div>
        </div>
    )
}
