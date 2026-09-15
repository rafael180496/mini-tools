import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {Compartment, EditorState} from '@codemirror/state'
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

function formatSize(text: string): string {
    const bytes = new TextEncoder().encode(text).length
    if (bytes < 1024) return `${bytes} B`
    return `${(bytes / 1024).toFixed(1)} KB`
}

// Modal DDL preview — GetObjectDDL fetches the object's current definition
// straight from the engine (DBMS_METADATA.GET_DDL / pg_get_functiondef /
// pg_get_triggerdef / sqlite_master, see backend/export/ddl_*.go), rendered
// as a read-only CodeMirror view with the same SQL syntax highlighting and
// theme as the main editor tabs (see sqlSchema.ts/themes.ts) instead of
// plain monospace text. "Exportar a archivo" reuses the text already in
// memory (SaveDDLToFile) instead of re-fetching.
//
// Se dibuja en un portal sobre <body>, igual que PasswordConfirmDialog. No es
// cosmético: Workspace.tsx monta este modal ANTES del panel de resultados en
// su JSX, y la cabecera de la grilla es `sticky z-10` — con el modal también
// en z-10 y en el mismo contexto de apilado, a igual z gana el que va después
// en el DOM, así que la fila de cabecera se dibujaba ENCIMA del DDL (las
// filas, que no están posicionadas, sí quedaban detrás: por eso tapaba una
// franja y no todo). El portal lo saca de ahí y z-50 lo pone sobre las capas
// flotantes de la app (chat z-20, panel HTTP z-30, menús z-40/z-50).
export default function DDLViewerModal({connId, objectType, schema, name, oid, dbType, editorThemeId, appTheme, onClose}: DDLViewerModalProps) {
    const [ddl, setDdl] = useState('')
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [copyHint, setCopyHint] = useState(false)
    const [wrap, setWrap] = useState(true)
    const [reloadToken, setReloadToken] = useState(0)
    const containerRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)
    // Compartment y no una recreación de la vista: cambiar el ajuste de línea
    // recreando el EditorView perdería la posición de scroll y cerraría el
    // panel de búsqueda justo cuando se está leyendo una línea larga.
    const wrapField = useMemo(() => new Compartment(), [])
    // La vista se recrea si cambia el tema o el DDL, y el estado del
    // compartimento se va con ella: sin este ref volvería a montarse con el
    // ajuste puesto mientras el botón sigue diciendo que está quitado.
    const wrapRef = useRef(wrap)
    wrapRef.current = wrap

    const qualified = schema ? `${schema}.${name}` : name

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
    }, [connId, objectType, schema, name, oid, reloadToken])

    // Escape cierra. Se mira `defaultPrevented` porque el panel de búsqueda de
    // CodeMirror (Ctrl+F, viene en basicSetup) también usa Escape para
    // cerrarse: sin esto, buscar dentro del DDL y salir de la búsqueda cerraría
    // el modal entero de paso.
    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if (e.key === 'Escape' && !e.defaultPrevented) onClose()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [onClose])

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
                    // null connId: highlighting only. This viewer is
                    // read-only, so schema completion and ghost text would
                    // be bridge traffic with nowhere to land.
                    sqlLanguageExtension(dbType, null),
                    resolveEditorTheme(editorThemeId, appTheme),
                    EditorView.editable.of(false),
                    EditorState.readOnly.of(true),
                    wrapField.of(wrapRef.current ? EditorView.lineWrapping : []),
                ],
            }),
            parent: containerRef.current,
        })
        viewRef.current = view
        // Con el foco puesto andan de entrada el Ctrl+F y las flechas/PgDn: si
        // el foco se queda afuera, el DDL solo se recorre con la rueda.
        view.focus()
        return () => {
            view.destroy()
            viewRef.current = null
        }
        // `wrap` queda fuera a propósito — lo aplica el efecto de abajo sobre
        // la vista ya montada.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ddl, loading, error, dbType, editorThemeId, appTheme, wrapField])

    useEffect(() => {
        viewRef.current?.dispatch({effects: wrapField.reconfigure(wrap ? EditorView.lineWrapping : [])})
    }, [wrap, wrapField])

    const copyDDL = useCallback(async () => {
        await navigator.clipboard.writeText(ddl)
        setCopyHint(true)
        setTimeout(() => setCopyHint(false), 1500)
    }, [ddl])

    async function exportDDL() {
        try {
            await SaveDDLToFile(`${name}.sql`, ddl)
        } catch (err) {
            setError(String(err))
        }
    }

    const lineCount = ddl ? ddl.split('\n').length : 0

    return createPortal(
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
            // mousedown y comparando el target: con onClick, seleccionar texto
            // adentro del DDL y soltar el botón afuera cerraba el modal.
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) onClose()
            }}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={`DDL de ${qualified}`}
                className="flex h-[85vh] w-[min(68rem,94vw)] flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface-container-high text-on-surface shadow-lg"
            >
                <div className="flex items-center gap-2 border-b border-outline-variant px-4 py-3">
                    <Icon name={OBJECT_TYPE_ICONS[objectType]} size={18} className="shrink-0 text-primary" />
                    <h2 className="min-w-0 truncate text-sm font-semibold" title={qualified}>
                        {qualified}
                    </h2>
                    <span className="shrink-0 rounded bg-surface-container-highest px-2 py-0.5 text-ui-11 uppercase text-on-surface-variant">
                        {OBJECT_TYPE_LABELS[objectType]}
                    </span>

                    <div className="flex-1" />

                    {!loading && !error && (
                        <>
                            <button
                                onClick={() => setWrap((w) => !w)}
                                title={
                                    wrap
                                        ? 'Cortar las líneas largas donde terminan — se recorren con scroll horizontal'
                                        : 'Ajustar las líneas largas al ancho del panel'
                                }
                                className={`flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs hover:bg-surface-variant ${
                                    wrap ? 'bg-surface-variant text-on-surface' : 'text-on-surface-variant'
                                }`}
                            >
                                <Icon name="wrap_text" size={14} />
                                Ajustar
                            </button>
                            <button
                                onClick={() => void copyDDL()}
                                title="Copia el DDL al portapapeles"
                                className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                            >
                                <Icon name={copyHint ? 'check' : 'content_copy'} size={14} className={copyHint ? 'text-secondary' : ''} />
                                {copyHint ? 'Copiado' : 'Copiar'}
                            </button>
                            <button
                                onClick={() => void exportDDL()}
                                title="Guarda este DDL en un archivo .sql"
                                className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                            >
                                <Icon name="download" size={14} />
                                Exportar
                            </button>
                            <span className="mx-1 h-4 w-px shrink-0 bg-outline-variant" />
                        </>
                    )}

                    <button
                        onClick={onClose}
                        title="Cierra este panel (Esc)"
                        className="shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="close" size={18} />
                    </button>
                </div>

                {loading && (
                    <div className="flex flex-1 items-center justify-center gap-2 text-xs text-on-surface-variant">
                        <span aria-hidden className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-t-transparent border-primary" />
                        Cargando DDL…
                    </div>
                )}

                {!loading && error && (
                    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                        <Icon name="warning" size={22} className="text-error" />
                        <p className="max-w-xl text-xs text-error">{error}</p>
                        <button
                            onClick={() => setReloadToken((n) => n + 1)}
                            title="Vuelve a pedirle el DDL al motor"
                            className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-on-primary hover:opacity-90"
                        >
                            <Icon name="refresh" size={14} />
                            Reintentar
                        </button>
                    </div>
                )}

                {!loading && !error && (
                    <>
                        {/* min-h-0: sin eso el hijo flex no puede achicarse por
                            debajo de su contenido y el DDL largo desbordaba el
                            modal en vez de scrollear adentro del panel. */}
                        <div className="min-h-0 flex-1 overflow-hidden bg-surface-container-lowest">
                            <div ref={containerRef} className="h-full w-full" />
                        </div>
                        <div className="flex shrink-0 items-center gap-3 border-t border-outline-variant px-4 py-1.5 text-ui-11 text-on-surface-variant">
                            <span>{lineCount.toLocaleString('es')} líneas</span>
                            <span>·</span>
                            <span>{formatSize(ddl)}</span>
                            <div className="flex-1" />
                            <span className="flex items-center gap-1">
                                <Icon name="search" size={13} />
                                Ctrl+F busca dentro del DDL
                            </span>
                        </div>
                    </>
                )}
            </div>
        </div>,
        document.body,
    )
}
