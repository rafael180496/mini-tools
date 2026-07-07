import {lazy, Suspense, useCallback, useEffect, useRef, useState} from 'react'
import ConnectionTree from './sidebar/ConnectionTree'
import ResultGrid from './results/ResultGrid'
import ResultTabs from './results/ResultTabs'
import ExportMenu from './results/ExportMenu'
import EditorTabs, {EditorTab} from './editor/EditorTabs'
import MonacoSQLEditor from './editor/MonacoSQLEditor'
import RecentFilesMenu from './editor/RecentFilesMenu'
import {
    BackupVault,
    BeginTransaction,
    CancelQuery,
    CommitTransaction,
    DisconnectConnection,
    ExecuteQuery,
    ExplainQuery,
    ExportConnectionConfig,
    ExportSchemaDDL,
    ExportTableDDL,
    GenerateProjectDocs,
    GetSchemaMetadata,
    GetSettings,
    HasOpenTransaction,
    OpenSQLFileDialog,
    OpenSQLFilePath,
    RegenerateProjectDocs,
    RollbackTransaction,
    SaveSQLFile,
    SaveSQLFileAs,
    SetOpenTabs,
} from '../../wailsjs/go/main/App'
import {EventsOn} from '../../wailsjs/runtime'
import {db, explain, vault} from '../../wailsjs/go/models'
import {setActiveMetadata} from '../monaco/metadataStore'
import {monaco} from '../monaco/setup'
import {lintSQL} from '../lib/linter'
import type {Theme} from '../hooks/useTheme'

// Lazy: both are only mounted once the user opens them (showDialog /
// showExplain), so they don't need to be in the initial bundle — unlike
// Monaco, which the editor needs immediately and can't defer.
const ConnectionDialog = lazy(() => import('./connections/ConnectionDialog'))
const ExplainPlanPanel = lazy(() => import('./explain/ExplainPlanPanel'))
const SchemaPickerDialog = lazy(() => import('./connections/SchemaPickerDialog'))

interface QueryEvent {
    type: 'columns' | 'rows' | 'done' | 'cancelled' | 'error'
    statementIndex: number
    totalStatements: number
    sqlText?: string
    columns?: string[]
    rows?: unknown[][]
    rowsAffected?: number
    durationMs?: number
    error?: string
    dbmsOutput?: string[]
}

interface ResultSet {
    columns: string[]
    rows: unknown[][]
    status: 'running' | 'done' | 'error' | 'cancelled'
    rowsAffected: number
    durationMs: number
    error: string
    dbmsOutput: string[]
    sourceSql: string
    sortColumn: string | null
    sortDirection: 'asc' | 'desc' | null
}

function emptyResultSet(): ResultSet {
    return {
        columns: [], rows: [], status: 'running', rowsAffected: 0, durationMs: 0, error: '', dbmsOutput: [],
        sourceSql: '', sortColumn: null, sortDirection: null,
    }
}

// queryID is generated client-side and subscribed to before ExecuteQuery is
// called, so there's no race with the backend's first emitted event — see
// .claude/skills/mini-tools-patterns/SKILL.md.
function newQueryId() {
    return `q_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

function newTabId() {
    return `t_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

function fileTitle(path: string) {
    return path.split(/[/\\]/).pop() ?? path
}

// No Node `path` module in the Vite/browser context, so this mirrors
// fileTitle's manual split-by-separator approach.
function dirName(path: string) {
    const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    return idx === -1 ? path : path.slice(0, idx)
}

// Vertical separator between button clusters in the toolbar — purely
// visual, no state, so it lives outside the component like the other
// helpers here.
function Divider() {
    return <div className="mx-0.5 h-4 w-px shrink-0 bg-neutral-200 dark:bg-neutral-800" />
}

function newScratchTab(): EditorTab {
    return {id: newTabId(), title: 'Query sin título', path: null, content: 'SELECT 1', dirty: false}
}

// LIMIT/FETCH syntax differs per engine — spec: "doble click tabla en árbol
// → SELECT * LIMIT 100 auto". Schema-qualified when the table came from a
// non-default Postgres schema, so it resolves correctly regardless of the
// connection's search_path.
function limitQueryFor(dbType: string, table: string, schema?: string): string {
    const qualified = schema ? `${schema}.${table}` : table
    if (dbType === 'oracle') {
        return `SELECT * FROM ${qualified} WHERE ROWNUM <= 100`
    }
    return `SELECT * FROM ${qualified} LIMIT 100`
}

interface WorkspaceProps {
    theme: Theme
    onToggleTheme: () => void
}

export default function Workspace({theme, onToggleTheme}: WorkspaceProps) {
    const [selected, setSelected] = useState<vault.ConnectionSummary | null>(null)
    // 'new' opens the dialog empty (create); any other string is a
    // connection id to edit; null keeps it closed.
    const [connectionDialog, setConnectionDialog] = useState<'new' | string | null>(null)
    const [schemaPickerConn, setSchemaPickerConn] = useState<vault.ConnectionSummary | null>(null)
    const [reloadToken, setReloadToken] = useState(0)
    const [metadata, setMetadata] = useState<db.SchemaMetadata | null>(null)
    const [activeSchema, setActiveSchema] = useState<string | null>(null)
    // Auto-commit off for `selected` — while true, Commit/Rollback are the
    // only way back to auto-commit (see backend Executor.BeginTransaction's
    // doc comment for why this can't just be a client-side flag: it mirrors
    // a real reserved connection on the backend).
    const [txOpen, setTxOpen] = useState(false)
    const [txBusy, setTxBusy] = useState(false)

    const [tabs, setTabs] = useState<EditorTab[]>(() => [newScratchTab()])
    const [activeTabId, setActiveTabId] = useState(() => tabs[0].id)

    const [running, setRunning] = useState(false)
    // Statement progress while `running` — "N/M" for a multi-statement
    // script, null before the first "columns" event of a run arrives.
    const [runProgress, setRunProgress] = useState<{current: number; total: number} | null>(null)
    const [resultSets, setResultSets] = useState<ResultSet[]>([])
    const [activeResultTab, setActiveResultTab] = useState(0)
    const [backupMessage, setBackupMessage] = useState('')
    const [statusMessage, setStatusMessage] = useState('')
    const [regeneratingDocs, setRegeneratingDocs] = useState(false)

    const [showExplain, setShowExplain] = useState(false)
    const [explainPlan, setExplainPlan] = useState<explain.Plan | null>(null)
    const [explainLoading, setExplainLoading] = useState(false)
    const [explainError, setExplainError] = useState('')

    const queryIdRef = useRef<string | null>(null)
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
    const tabsRef = useRef(tabs)
    tabsRef.current = tabs
    const activeTabIdRef = useRef(activeTabId)
    activeTabIdRef.current = activeTabId
    const pendingSortRef = useRef<{column: string; direction: 'asc' | 'desc'} | null>(null)

    const activeTabData = tabs.find((t) => t.id === activeTabId) ?? tabs[0]

    function updateActiveTabContent(content: string) {
        setTabs((prev) => prev.map((t) => (t.id === activeTabIdRef.current ? {...t, content, dirty: true} : t)))
    }

    // Session restore: reopen whatever tabs were open last time, and warn
    // (once) about any that were deleted from disk since. Guards against
    // the persist-effect below firing with the initial scratch tab BEFORE
    // this has had a chance to run — see hasRestoredRef.
    const [deletedPaths, setDeletedPaths] = useState<string[]>([])
    const hasRestoredRef = useRef(false)

    useEffect(() => {
        let cancelled = false

        GetSettings()
            .then(async (settings) => {
                const paths = settings.openTabs ?? []
                if (paths.length === 0) return

                const restored: EditorTab[] = []
                const deleted: string[] = []
                for (const path of paths) {
                    try {
                        const file = await OpenSQLFilePath(path)
                        if (file) {
                            restored.push({id: newTabId(), title: fileTitle(file.path), path: file.path, content: file.content, dirty: false})
                        }
                    } catch {
                        deleted.push(path)
                    }
                }
                if (cancelled) return

                if (restored.length > 0) {
                    setTabs(restored)
                    setActiveTabId(restored[0].id)
                }
                if (deleted.length > 0) {
                    setDeletedPaths(deleted)
                    // Persist the cleaned-up list right away so these
                    // don't get flagged again next launch.
                    void SetOpenTabs(restored.map((t) => t.path).filter((p): p is string => !!p))
                }
            })
            .catch(() => {})
            .finally(() => {
                if (!cancelled) hasRestoredRef.current = true
            })

        return () => {
            cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // Persist the current set of open tab paths whenever it changes (open,
    // close, or a tab gains a path via Save/Save As) — but NOT on every
    // keystroke, which would also change `tabs`' reference via
    // updateActiveTabContent. Keying on just the ordered path list (not the
    // whole tabs array) keeps this from firing on content-only changes.
    const openTabPathsKey = tabs.map((t) => t.path ?? '').join(' ')
    useEffect(() => {
        if (!hasRestoredRef.current) return
        const paths = tabs.map((t) => t.path).filter((p): p is string => !!p)
        void SetOpenTabs(paths)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [openTabPathsKey])

    async function backupVault() {
        setBackupMessage('Guardando backup…')
        try {
            const dest = await BackupVault()
            setBackupMessage(dest ? `Backup guardado en ${dest}` : '')
        } catch (err) {
            setBackupMessage(`Error: ${String(err)}`)
        }
    }

    // Fetch (and cache) schema metadata whenever the selected connection
    // changes, so autocomplete/hover/the sidebar tree have data as soon as
    // possible.
    useEffect(() => {
        if (!selected) {
            setMetadata(null)
            return
        }
        GetSchemaMetadata(selected.id, false)
            .then((meta) => setMetadata(meta))
            .catch((err) => setStatusMessage(String(err)))
    }, [selected])

    // Re-sync the auto-commit UI with the backend's actual state — the
    // reserved connection lives in the Go executor, not in this component,
    // so trust it rather than assuming local state survived a reconnect.
    useEffect(() => {
        if (!selected) {
            setTxOpen(false)
            return
        }
        HasOpenTransaction(selected.id)
            .then(setTxOpen)
            .catch(() => setTxOpen(false))
    }, [selected])

    async function beginTransaction() {
        if (!selected) return
        setTxBusy(true)
        try {
            await BeginTransaction(selected.id)
            setTxOpen(true)
            setStatusMessage('Transacción abierta — auto-commit desactivado')
        } catch (err) {
            setStatusMessage(String(err))
        } finally {
            setTxBusy(false)
        }
    }

    async function commitTransaction() {
        if (!selected) return
        setTxBusy(true)
        try {
            await CommitTransaction(selected.id)
            setTxOpen(false)
            setStatusMessage('Commit hecho — auto-commit activado')
        } catch (err) {
            setStatusMessage(String(err))
        } finally {
            setTxBusy(false)
        }
    }

    async function rollbackTransaction() {
        if (!selected) return
        setTxBusy(true)
        try {
            await RollbackTransaction(selected.id)
            setTxOpen(false)
            setStatusMessage('Rollback hecho — auto-commit activado')
        } catch (err) {
            setStatusMessage(String(err))
        } finally {
            setTxBusy(false)
        }
    }

    function refreshMetadata() {
        if (!selected) return
        setStatusMessage('Actualizando metadata…')
        GetSchemaMetadata(selected.id, true)
            .then((meta) => {
                setMetadata(meta)
                setStatusMessage('Metadata actualizada')
            })
            .catch((err) => setStatusMessage(String(err)))
    }

    // Postgres connections span multiple schemas (table.schema is populated
    // — see backend/db/metadata.go); Oracle's USER_* views are implicitly
    // scoped to one schema (table.schema is always empty), so `schemas`
    // comes back empty there and everything below just falls through
    // unfiltered, unchanged from before this feature existed.
    const schemas = metadata
        ? Array.from(new Set(metadata.tables.map((t) => t.schema).filter((s): s is string => !!s))).sort()
        : []

    // Keep the active schema valid as metadata changes (new connection,
    // F5): preserve it if it still exists, default to "public" if present,
    // otherwise the first schema alphabetically.
    useEffect(() => {
        if (schemas.length === 0) {
            setActiveSchema(null)
            return
        }
        setActiveSchema((prev) => {
            if (prev && schemas.includes(prev)) return prev
            return schemas.includes('public') ? 'public' : schemas[0]
        })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [metadata])

    // The sidebar tree and Monaco's autocomplete/hover both only see the
    // active schema's tables — "el console debe indicar en qué BD/schema
    // quiero que esté trabajando" — not the whole multi-schema catalog at
    // once (that's still the full fetch from GetSchemaMetadata; this only
    // narrows what's *shown*, see Fase 3 for narrowing what's *fetched*).
    const filteredMetadata: db.SchemaMetadata | null =
        metadata && activeSchema
            ? new db.SchemaMetadata({tables: metadata.tables.filter((t) => t.schema === activeSchema)})
            : metadata

    useEffect(() => {
        setActiveMetadata(filteredMetadata)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filteredMetadata])

    const runText = useCallback(
        (sqlText: string) => {
            if (!selected || running || !sqlText.trim()) return

            const queryId = newQueryId()
            queryIdRef.current = queryId
            setRunning(true)
            setRunProgress(null)
            setResultSets([])
            setActiveResultTab(0)

            const unsubscribe = EventsOn(queryId, (event: QueryEvent) => {
                setRunProgress({current: event.statementIndex + 1, total: event.totalStatements})
                setResultSets((prev) => {
                    const next = [...prev]
                    while (next.length <= event.statementIndex) {
                        next.push(emptyResultSet())
                    }
                    const cur = {...next[event.statementIndex]}

                    switch (event.type) {
                        case 'columns':
                            cur.columns = event.columns ?? []
                            cur.sourceSql = event.sqlText ?? ''
                            if (pendingSortRef.current) {
                                cur.sortColumn = pendingSortRef.current.column
                                cur.sortDirection = pendingSortRef.current.direction
                                pendingSortRef.current = null
                            }
                            break
                        case 'rows':
                            cur.rows = [...cur.rows, ...(event.rows ?? [])]
                            break
                        case 'done':
                            cur.status = 'done'
                            cur.rowsAffected = event.rowsAffected ?? 0
                            cur.durationMs = event.durationMs ?? 0
                            cur.dbmsOutput = event.dbmsOutput ?? []
                            break
                        case 'cancelled':
                            cur.status = 'cancelled'
                            break
                        case 'error':
                            cur.status = 'error'
                            cur.error = event.error ?? 'Error desconocido'
                            break
                    }

                    next[event.statementIndex] = cur
                    return next
                })

                if (
                    event.type === 'cancelled' ||
                    ((event.type === 'done' || event.type === 'error') && event.statementIndex === event.totalStatements - 1)
                ) {
                    setRunning(false)
                    setRunProgress(null)
                    unsubscribe()
                }
            })

            ExecuteQuery(selected.id, queryId, sqlText).catch((err) => {
                setResultSets([{...emptyResultSet(), status: 'error', error: String(err)}])
                setRunning(false)
                setRunProgress(null)
                unsubscribe()
            })
        },
        [selected, running],
    )

    // Spec: "linter básico... warning antes de ejecutar". Only for
    // user-initiated runs (selection/line, full block) — not for
    // auto-generated queries (double-click LIMIT, sort-by-column requery),
    // which would otherwise pop this dialog on every double-click. Only
    // `blocking` warnings (UPDATE/DELETE without WHERE — genuinely
    // destructive) actually stop execution; non-blocking ones (SELECT *) are
    // still shown as an editor marker by MonacoSQLEditor.tsx but never
    // prevent running a plain read query.
    function confirmAndRun(sqlText: string) {
        const warnings = lintSQL(sqlText).filter((w) => w.blocking)
        if (warnings.length > 0) {
            const message = warnings.map((w) => `Línea ${w.startLineNumber}: ${w.message}`).join('\n')
            if (!window.confirm(`Advertencias antes de ejecutar:\n\n${message}\n\n¿Ejecutar de todas formas?`)) {
                return
            }
        }
        runText(sqlText)
    }

    function runSelectionOrLine() {
        const editor = editorRef.current
        if (!editor) return
        const selection = editor.getSelection()
        const model = editor.getModel()
        if (!model) return

        let text = ''
        if (selection && !selection.isEmpty()) {
            text = model.getValueInRange(selection)
        } else {
            const line = selection?.positionLineNumber ?? 1
            text = model.getLineContent(line)
        }
        confirmAndRun(text)
    }

    function runFullScript() {
        confirmAndRun(activeTabData?.content ?? '')
    }

    async function runExplain(analyze: boolean) {
        if (!selected) return
        const text = activeTabData?.content ?? ''
        if (!text.trim()) return

        setShowExplain(true)
        setExplainLoading(true)
        setExplainError('')
        try {
            const plan = await ExplainQuery(selected.id, text, analyze)
            setExplainPlan(plan)
        } catch (err) {
            setExplainError(String(err))
        } finally {
            setExplainLoading(false)
        }
    }

    function cancelQuery() {
        if (queryIdRef.current) {
            void CancelQuery(queryIdRef.current)
        }
    }

    // Sort re-issues the query wrapped in ORDER BY instead of sorting
    // client-side (spec: "no ordenar en cliente un dataset parcial"). The
    // wrapped query becomes the new (single-statement) run, so other result
    // tabs from the original script are replaced — same trade-off as any
    // other re-run.
    function sortActiveResult(column: string) {
        const rs = resultSets[activeResultTab]
        if (!rs || !rs.sourceSql || running) return

        const nextDirection: 'asc' | 'desc' = rs.sortColumn === column && rs.sortDirection === 'asc' ? 'desc' : 'asc'
        const stripped = rs.sourceSql.trim().replace(/;+\s*$/, '')
        const wrapped = `SELECT * FROM (${stripped}) AS mt_sort ORDER BY "${column}" ${nextDirection.toUpperCase()}`

        pendingSortRef.current = {column, direction: nextDirection}
        runText(wrapped)
    }

    function openTableQuery(table: string, schema?: string) {
        if (!selected) return
        const q = limitQueryFor(selected.dbType, table, schema)
        updateActiveTabContent(q)
        runText(q)
    }

    async function exportConnectionConfig(connId: string) {
        try {
            const dest = await ExportConnectionConfig(connId)
            setStatusMessage(dest ? `Config exportada a ${dest}` : '')
        } catch (err) {
            setStatusMessage(String(err))
        }
    }

    // Closes the pool without touching the saved connection (unlike
    // deleting it) — if it's the active one, also clears the workspace's
    // notion of "connected to X" so autocomplete/metadata don't keep
    // pointing at a closed pool. Reconnecting just means selecting it again.
    async function disconnectConnection(connId: string) {
        try {
            await DisconnectConnection(connId)
            if (selected?.id === connId) {
                setSelected(null)
                setMetadata(null)
            }
            setStatusMessage('Desconectado')
        } catch (err) {
            setStatusMessage(String(err))
        }
    }

    async function exportTableDDL(table: string, schema?: string) {
        if (!selected) return
        try {
            // "public" only matters for Postgres (SQLite/Oracle ignore the
            // schema param) — table.schema from metadata is the real value
            // when available, this is just the fallback for engines/tables
            // that don't report one.
            const dest = await ExportTableDDL(selected.id, schema || 'public', table)
            setStatusMessage(dest ? `DDL exportado a ${dest}` : '')
        } catch (err) {
            setStatusMessage(String(err))
        }
    }

    async function exportSchemaDDL() {
        if (!selected) return
        try {
            const dest = await ExportSchemaDDL(selected.id, 'public')
            setStatusMessage(dest ? `DDL del schema exportado a ${dest}` : '')
        } catch (err) {
            setStatusMessage(String(err))
        }
    }

    // Best-effort: a project-docs generation failure should never block
    // opening/saving a file, so errors are swallowed here.
    function generateProjectDocsFor(path: string) {
        if (!selected) return
        const dir = dirName(path)
        GenerateProjectDocs(dir, selected.id, activeSchema ?? '')
            .then((wrote) => {
                if (wrote) {
                    setStatusMessage(
                        activeSchema
                            ? `CLAUDE.md generado en ${dir} (esquema ${activeSchema})`
                            : `CLAUDE.md generado en ${dir}`,
                    )
                }
            })
            .catch(() => {})
    }

    // Explicit "Regenerar" action — always overwrites, so it asks for
    // confirmation first since it's destructive to any manual edits the
    // user might have made to the previously generated files.
    async function regenerateProjectDocs() {
        if (!selected || !activeTabData?.path) return
        const dir = dirName(activeTabData.path)
        const scopeDesc = activeSchema ? `el esquema "${activeSchema}"` : 'todos los esquemas configurados'
        const confirmed = window.confirm(
            `Esto sobrescribe CLAUDE.md y .claude/ en ${dir} con la metadata de "${selected.name}" (${scopeDesc}). ¿Continuar?`,
        )
        if (!confirmed) return

        setRegeneratingDocs(true)
        try {
            await RegenerateProjectDocs(dir, selected.id, activeSchema ?? '')
            setStatusMessage(
                activeSchema
                    ? `CLAUDE.md regenerado en ${dir} (esquema ${activeSchema})`
                    : `CLAUDE.md regenerado en ${dir}`,
            )
        } catch (err) {
            setStatusMessage(String(err))
        } finally {
            setRegeneratingDocs(false)
        }
    }

    function openTabForFile(path: string, content: string) {
        setTabs((prev) => {
            const existing = prev.find((t) => t.path === path)
            if (existing) {
                setActiveTabId(existing.id)
                return prev.map((t) => (t.id === existing.id ? {...t, content, dirty: false} : t))
            }
            const tab: EditorTab = {id: newTabId(), title: fileTitle(path), path, content, dirty: false}
            setActiveTabId(tab.id)
            return [...prev, tab]
        })
        generateProjectDocsFor(path)
    }

    async function openFileDialog() {
        try {
            const file = await OpenSQLFileDialog()
            if (file) openTabForFile(file.path, file.content)
        } catch (err) {
            setStatusMessage(String(err))
        }
    }

    async function openRecentFile(path: string) {
        try {
            const file = await OpenSQLFilePath(path)
            if (file) openTabForFile(file.path, file.content)
        } catch (err) {
            setStatusMessage(String(err))
        }
    }

    async function saveActiveTab() {
        const tab = tabsRef.current.find((t) => t.id === activeTabIdRef.current)
        if (!tab) return

        try {
            if (tab.path) {
                await SaveSQLFile(tab.path, tab.content)
                setTabs((prev) => prev.map((t) => (t.id === tab.id ? {...t, dirty: false} : t)))
                generateProjectDocsFor(tab.path)
            } else {
                const dest = await SaveSQLFileAs(`${tab.title}.sql`, tab.content)
                if (dest) {
                    setTabs((prev) =>
                        prev.map((t) => (t.id === tab.id ? {...t, path: dest, title: fileTitle(dest), dirty: false} : t)),
                    )
                    generateProjectDocsFor(dest)
                }
            }
        } catch (err) {
            setStatusMessage(String(err))
        }
    }

    function newTab() {
        const tab = newScratchTab()
        setTabs((prev) => [...prev, tab])
        setActiveTabId(tab.id)
    }

    function closeTab(id: string) {
        setTabs((prev) => {
            const next = prev.filter((t) => t.id !== id)
            if (next.length === 0) {
                const fresh = newScratchTab()
                setActiveTabId(fresh.id)
                return [fresh]
            }
            if (activeTabIdRef.current === id) {
                setActiveTabId(next[next.length - 1].id)
            }
            return next
        })
    }

    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && e.shiftKey) {
                e.preventDefault()
                runFullScript()
            } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault()
                runSelectionOrLine()
            } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                e.preventDefault()
                void saveActiveTab()
            } else if (e.key === 'F5') {
                e.preventDefault()
                refreshMetadata()
            }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [runText, selected])

    const activeResult = resultSets[activeResultTab]

    return (
        <div className="flex h-screen w-screen bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100">
            <ConnectionTree
                selectedId={selected?.id ?? null}
                onSelect={setSelected}
                onNewConnection={() => setConnectionDialog('new')}
                onEditConnection={(conn) => setConnectionDialog(conn.id)}
                reloadToken={reloadToken}
                metadata={filteredMetadata}
                onOpenTable={openTableQuery}
                onExportConnectionConfig={(connId) => void exportConnectionConfig(connId)}
                onExportTableDDL={(table, schema) => void exportTableDDL(table, schema)}
                onDisconnect={(connId) => void disconnectConnection(connId)}
                onConfigureSchemas={setSchemaPickerConn}
            />

            {schemaPickerConn && (
                <Suspense fallback={null}>
                    <SchemaPickerDialog
                        connId={schemaPickerConn.id}
                        currentSchemas={schemaPickerConn.metadataSchemas ?? []}
                        onClose={() => setSchemaPickerConn(null)}
                        onSaved={() => {
                            setSchemaPickerConn(null)
                            setReloadToken((n) => n + 1)
                            if (schemaPickerConn.id === selected?.id) refreshMetadata()
                        }}
                    />
                </Suspense>
            )}

            {deletedPaths.length > 0 && (
                <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60">
                    <div className="flex w-96 flex-col gap-3 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900 p-6 text-neutral-900 dark:text-neutral-100">
                        <h2 className="text-lg font-semibold">Archivos no encontrados</h2>
                        <p className="text-xs text-neutral-600 dark:text-neutral-400">
                            Estos archivos estaban abiertos la última vez pero ya no existen en disco — no se van a volver a
                            abrir automáticamente:
                        </p>
                        <ul className="max-h-40 overflow-y-auto rounded border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 p-2 text-xs text-neutral-600 dark:text-neutral-400">
                            {deletedPaths.map((p) => (
                                <li key={p} className="truncate font-mono">
                                    {p}
                                </li>
                            ))}
                        </ul>
                        <div className="mt-2 flex justify-end">
                            <button
                                onClick={() => setDeletedPaths([])}
                                title="Cierra este aviso — las pestañas de archivos que ya no existen en disco quedan como pestañas sin guardar"
                                className="rounded bg-neutral-900 dark:bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-100 dark:text-neutral-900"
                            >
                                Entendido
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <div className="flex flex-1 flex-col">
                <div className="flex flex-col border-b border-neutral-200 dark:border-neutral-800">
                    {/* Context row: which connection/schema/transaction state
                        this workspace is currently pointed at. Kept
                        separate from the actions row below so neither
                        crowds the other. */}
                    <div className="flex flex-wrap items-center gap-3 px-2 py-1.5">
                        <span className="whitespace-nowrap text-xs text-neutral-500">
                            {selected ? `Conectado a: ${selected.name}` : 'Selecciona una conexión'}
                        </span>

                        {schemas.length > 0 && (
                            <label className="flex items-center gap-1 text-xs text-neutral-500">
                                Schema:
                                <select
                                    value={activeSchema ?? ''}
                                    onChange={(e) => setActiveSchema(e.target.value)}
                                    className="rounded border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900 px-1 py-0.5 text-xs text-neutral-800 dark:text-neutral-200 outline-none"
                                >
                                    {schemas.map((s) => (
                                        <option key={s} value={s}>
                                            {s}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        )}

                        {selected && (
                            <>
                                <Divider />
                                <label
                                    className="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-400"
                                    title="Desactivar: los statements quedan pendientes hasta Commit/Rollback en vez de aplicarse solos"
                                >
                                    <input
                                        type="checkbox"
                                        checked={!txOpen}
                                        disabled={txBusy || txOpen}
                                        onChange={() => void beginTransaction()}
                                    />
                                    Auto-commit
                                </label>
                                <button
                                    onClick={() => void commitTransaction()}
                                    disabled={!txOpen || txBusy}
                                    title="Confirma de forma permanente todos los cambios (INSERT/UPDATE/DELETE) hechos desde que se abrió la transacción actual"
                                    className="rounded bg-emerald-700 px-2 py-0.5 text-xs font-medium text-neutral-50 hover:bg-emerald-600 disabled:opacity-40"
                                >
                                    Commit
                                </button>
                                <button
                                    onClick={() => void rollbackTransaction()}
                                    disabled={!txOpen || txBusy}
                                    title="Descarta todos los cambios pendientes de la transacción actual y vuelve al estado antes de abrirla"
                                    className="rounded bg-red-800 px-2 py-0.5 text-xs font-medium text-neutral-50 hover:bg-red-700 disabled:opacity-40"
                                >
                                    Rollback
                                </button>
                                {txOpen && (
                                    <span className="whitespace-nowrap text-xs text-amber-600 dark:text-amber-400">
                                        Transacción abierta
                                    </span>
                                )}
                            </>
                        )}

                        {(statusMessage || backupMessage) && (
                            <span className="truncate text-xs text-neutral-500">{statusMessage || backupMessage}</span>
                        )}

                        <div className="flex-1" />

                        <button
                            onClick={onToggleTheme}
                            title="Cambiar tema"
                            className="rounded bg-neutral-200 dark:bg-neutral-800 px-2 py-1 text-xs font-medium hover:bg-neutral-300 dark:hover:bg-neutral-700"
                        >
                            {theme === 'dark' ? '☀' : '🌙'}
                        </button>
                    </div>

                    {/* Actions row: file ops, then query ops, then
                        schema/vault utilities — grouped with dividers so
                        the eye can parse clusters instead of one long run
                        of same-looking buttons. */}
                    <div className="flex flex-wrap items-center gap-1.5 border-t border-neutral-200 dark:border-neutral-800 px-2 py-1.5">
                        <button
                            onClick={() => void openFileDialog()}
                            title="Abre un archivo .sql desde tu disco en una nueva pestaña del editor"
                            className="rounded bg-neutral-200 dark:bg-neutral-800 px-3 py-1 text-xs font-medium hover:bg-neutral-300 dark:hover:bg-neutral-700"
                        >
                            Abrir
                        </button>
                        <RecentFilesMenu onOpen={(path) => void openRecentFile(path)} />
                        <button
                            onClick={() => void saveActiveTab()}
                            title="Guarda el contenido de la pestaña activa en disco (atajo: Ctrl+S). Si es una pestaña nueva, te pide dónde guardarla"
                            className="rounded bg-neutral-200 dark:bg-neutral-800 px-3 py-1 text-xs font-medium hover:bg-neutral-300 dark:hover:bg-neutral-700"
                        >
                            Guardar (Ctrl+S)
                        </button>
                        <button
                            onClick={() => void regenerateProjectDocs()}
                            disabled={!selected || !activeTabData?.path || regeneratingDocs}
                            title="Sobrescribe CLAUDE.md y .claude/ en la carpeta del archivo abierto con el schema y las tablas de la conexión actual (o solo el esquema seleccionado arriba, si hay uno). Útil si la base de datos cambió desde la última vez."
                            className="rounded bg-neutral-200 dark:bg-neutral-800 px-3 py-1 text-xs font-medium hover:bg-neutral-300 dark:hover:bg-neutral-700 disabled:opacity-50"
                        >
                            {regeneratingDocs ? 'Regenerando…' : 'Regenerar CLAUDE.md'}
                        </button>

                        <Divider />

                        <button
                            onClick={runSelectionOrLine}
                            disabled={!selected || running}
                            title="Ejecuta el texto seleccionado, o si no hay selección, la línea donde está el cursor (atajo: Ctrl+Enter)"
                            className="rounded bg-emerald-700 px-3 py-1 text-xs font-medium hover:bg-emerald-600 disabled:opacity-50"
                        >
                            Ejecutar (Ctrl+Enter)
                        </button>
                        <button
                            onClick={runFullScript}
                            disabled={!selected || running}
                            title="Ejecuta todos los statements del editor en orden, uno por uno (atajo: Ctrl+Shift+Enter)"
                            className="rounded bg-emerald-800 px-3 py-1 text-xs font-medium hover:bg-emerald-700 disabled:opacity-50"
                        >
                            Bloque (Ctrl+Shift+Enter)
                        </button>
                        <button
                            onClick={cancelQuery}
                            disabled={!running}
                            title="Interrumpe la consulta que está corriendo ahora mismo"
                            className="rounded bg-red-800 px-3 py-1 text-xs font-medium hover:bg-red-700 disabled:opacity-50"
                        >
                            Cancelar
                        </button>
                        <button
                            onClick={() => void runExplain(false)}
                            disabled={!selected}
                            title="Muestra el plan de ejecución del query (EXPLAIN) sin correrlo — útil para diagnosticar lentitud sin afectar datos"
                            className="rounded bg-neutral-200 dark:bg-neutral-800 px-3 py-1 text-xs font-medium hover:bg-neutral-300 dark:hover:bg-neutral-700 disabled:opacity-50"
                        >
                            Explain
                        </button>
                        <button
                            onClick={() => void runExplain(true)}
                            disabled={!selected}
                            title="Ejecuta el query de verdad y muestra el plan con tiempos reales (EXPLAIN ANALYZE) — a diferencia de Explain, sí corre el query"
                            className="rounded bg-neutral-200 dark:bg-neutral-800 px-3 py-1 text-xs font-medium hover:bg-neutral-300 dark:hover:bg-neutral-700 disabled:opacity-50"
                        >
                            Explain Analyze
                        </button>

                        <Divider />

                        <button
                            onClick={refreshMetadata}
                            disabled={!selected}
                            title="Vuelve a leer las tablas y columnas de la base de datos (atajo: F5) — usalo si acabás de crear/alterar una tabla"
                            className="rounded bg-neutral-200 dark:bg-neutral-800 px-3 py-1 text-xs font-medium hover:bg-neutral-300 dark:hover:bg-neutral-700 disabled:opacity-50"
                        >
                            Refrescar (F5)
                        </button>
                        <button
                            onClick={() => void exportSchemaDDL()}
                            disabled={!selected}
                            title="Exporta a un archivo el DDL (CREATE TABLE, etc.) del schema actual"
                            className="rounded bg-neutral-200 dark:bg-neutral-800 px-3 py-1 text-xs font-medium hover:bg-neutral-300 dark:hover:bg-neutral-700 disabled:opacity-50"
                        >
                            DDL schema
                        </button>
                        <button
                            onClick={() => void backupVault()}
                            title="Copia el archivo del vault (donde se guardan tus conexiones cifradas) a otra ubicación, por si necesitás restaurarlo después"
                            className="rounded bg-neutral-200 dark:bg-neutral-800 px-3 py-1 text-xs font-medium hover:bg-neutral-300 dark:hover:bg-neutral-700"
                        >
                            Backup vault
                        </button>
                    </div>
                </div>

                <EditorTabs tabs={tabs} activeId={activeTabId} onSelect={setActiveTabId} onClose={closeTab} onNew={newTab} />

                <div className="h-64 border-b border-neutral-200 dark:border-neutral-800">
                    <MonacoSQLEditor
                        value={activeTabData?.content ?? ''}
                        onChange={updateActiveTabContent}
                        onMount={(editor) => {
                            editorRef.current = editor
                        }}
                    />
                </div>

                <ResultTabs
                    count={resultSets.length}
                    active={activeResultTab}
                    onSelect={setActiveResultTab}
                    statuses={resultSets.map((r) => r.status)}
                />

                <div className="flex items-center gap-2 border-b border-neutral-200 dark:border-neutral-800 px-2 py-1">
                    <ExportMenu
                        columns={activeResult?.columns ?? []}
                        rows={activeResult?.rows ?? []}
                        tableNameHint={selected?.name}
                    />
                </div>

                <ResultGrid
                    columns={activeResult?.columns ?? []}
                    rows={activeResult?.rows ?? []}
                    sortColumn={activeResult?.sortColumn}
                    sortDirection={activeResult?.sortDirection}
                    onSort={sortActiveResult}
                />

                {activeResult && activeResult.dbmsOutput.length > 0 && (
                    <pre className="max-h-32 overflow-y-auto border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 p-2 text-xs text-neutral-600 dark:text-neutral-400">
                        {activeResult.dbmsOutput.join('\n')}
                    </pre>
                )}

                {showExplain && (
                    <Suspense fallback={null}>
                        <ExplainPlanPanel
                            plan={explainPlan}
                            loading={explainLoading}
                            error={explainError}
                            onClose={() => setShowExplain(false)}
                        />
                    </Suspense>
                )}

                <div className="flex items-center gap-4 border-t border-neutral-200 dark:border-neutral-800 px-3 py-1 text-xs text-neutral-500">
                    {running && (
                        <span className="flex items-center gap-2">
                            <span
                                aria-hidden
                                className="h-3 w-3 animate-spin rounded-full border-2 border-t-transparent border-neutral-400 dark:border-neutral-600"
                            />
                            {runProgress && runProgress.total > 1
                                ? `Ejecutando ${runProgress.current}/${runProgress.total}…`
                                : 'Ejecutando…'}
                        </span>
                    )}
                    {activeResult?.status === 'done' && (
                        <span>
                            {activeResult.rowsAffected} filas · {activeResult.durationMs}ms
                        </span>
                    )}
                    {activeResult?.status === 'cancelled' && <span className="text-amber-600 dark:text-amber-400">Cancelada</span>}
                    {activeResult?.status === 'error' && <span className="text-red-600 dark:text-red-400">{activeResult.error}</span>}
                </div>
            </div>

            {connectionDialog && (
                <Suspense fallback={null}>
                    <ConnectionDialog
                        editingId={connectionDialog === 'new' ? null : connectionDialog}
                        onClose={() => setConnectionDialog(null)}
                        onSaved={() => {
                            setConnectionDialog(null)
                            setReloadToken((n) => n + 1)
                        }}
                    />
                </Suspense>
            )}
        </div>
    )
}
