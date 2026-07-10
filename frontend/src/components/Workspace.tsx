import {lazy, Suspense, useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent} from 'react'
import ConnectionTree from './sidebar/ConnectionTree'
import Icon from './Icon'
import PasswordConfirmDialog from './PasswordConfirmDialog'
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
    ClearQueryHistory,
    CommitTransaction,
    DeleteQueryHistoryEntry,
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
    ListQueryHistory,
    OpenSQLFileDialog,
    OpenSQLFilePath,
    RegenerateProjectDocs,
    RollbackTransaction,
    SaveSQLFile,
    SaveSQLFileAs,
    SetEditorHeight,
    SetOpenTabs,
    SetRememberMasterKey,
    SetSidebarCollapsed,
    SyncSchemaMetadata,
} from '../../wailsjs/go/main/App'
import {EventsOn} from '../../wailsjs/runtime'
import {db, explain, vault} from '../../wailsjs/go/models'
import {setActiveMetadata} from '../monaco/metadataStore'
import {setActiveDbType} from '../monaco/activeDbTypeStore'
import {monaco} from '../monaco/setup'
import {lintSQL} from '../lib/linter'
import type {Theme} from '../hooks/useTheme'

// Lazy: both are only mounted once the user opens them (showDialog /
// showExplain), so they don't need to be in the initial bundle — unlike
// Monaco, which the editor needs immediately and can't defer.
const ConnectionDialog = lazy(() => import('./connections/ConnectionDialog'))
const ExplainPlanPanel = lazy(() => import('./explain/ExplainPlanPanel'))
const SchemaPickerDialog = lazy(() => import('./connections/SchemaPickerDialog'))
const HistoryPanel = lazy(() => import('./HistoryPanel'))
const SettingsDialog = lazy(() => import('./SettingsDialog'))

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
    return <div className="mx-0.5 h-4 w-px shrink-0 bg-outline-variant" />
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
    const [metadataLoading, setMetadataLoading] = useState(false)
    const [activeSchema, setActiveSchema] = useState<string | null>(null)
    // Auto-commit off for `selected` — while true, Commit/Rollback are the
    // only way back to auto-commit (see backend Executor.BeginTransaction's
    // doc comment for why this can't just be a client-side flag: it mirrors
    // a real reserved connection on the backend).
    const [txOpen, setTxOpen] = useState(false)
    const [txBusy, setTxBusy] = useState(false)
    // Toolbar toggle for capturing DBMS_OUTPUT on Oracle PL/SQL blocks
    // (ENABLE + GET_LINE round trips) — on by default, matching the
    // behavior before this toggle existed. Off skips those extra round
    // trips entirely, useful for a big multi-statement script (like an
    // idempotent init.sql) full of blocks whose output isn't needed.
    const [dbmsOutputEnabled, setDbmsOutputEnabled] = useState(true)

    const [tabs, setTabs] = useState<EditorTab[]>(() => [newScratchTab()])
    const [activeTabId, setActiveTabId] = useState(() => tabs[0].id)

    const [running, setRunning] = useState(false)
    // Statement progress while `running` — "N/M" for a multi-statement
    // script, null before the first "columns" event of a run arrives.
    const [runProgress, setRunProgress] = useState<{current: number; total: number} | null>(null)
    const [resultSets, setResultSets] = useState<ResultSet[]>([])
    const [activeResultTab, setActiveResultTab] = useState(0)
    const [backupMessage, setBackupMessage] = useState('')
    const [showBackupPasswordDialog, setShowBackupPasswordDialog] = useState(false)
    const [showSettingsDialog, setShowSettingsDialog] = useState(false)
    const [statusMessage, setStatusMessage] = useState('')
    const [regeneratingDocs, setRegeneratingDocs] = useState(false)

    const [showExplain, setShowExplain] = useState(false)
    const [explainPlan, setExplainPlan] = useState<explain.Plan | null>(null)
    const [explainLoading, setExplainLoading] = useState(false)
    const [explainError, setExplainError] = useState('')

    // "Resultados"/"Historial" are tabs sharing one bottom panel — tab-style
    // like EditorTabs above, not two docked panels stacked on top of each
    // other. Starts on "results" (what you want right after running
    // something); switching to "history" is what triggers the first load.
    const [activeBottomTab, setActiveBottomTab] = useState<'results' | 'history'>('results')
    const [historyEntries, setHistoryEntries] = useState<vault.HistoryEntry[]>([])
    const [historyLoading, setHistoryLoading] = useState(false)
    const [historyError, setHistoryError] = useState('')

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

    // Workspace layout — sidebar icon-only rail toggle and the editor
    // pane's height, both persisted to the vault (SetSidebarCollapsed/
    // SetEditorHeight) so they survive a relaunch, same idea as open tabs
    // above. EDITOR_HEIGHT_DEFAULT matches the old fixed h-64 Tailwind
    // class (256px) and backend/vault/settings_repo.go's column default.
    const EDITOR_HEIGHT_DEFAULT = 256
    const EDITOR_HEIGHT_MIN = 120
    const EDITOR_HEIGHT_MAX = 900
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
    const [editorHeight, setEditorHeightState] = useState(EDITOR_HEIGHT_DEFAULT)
    // "Recordar clave" toggle — whether the vault auto-unlocks from the OS
    // keychain on the next launch (see TryAutoUnlock in App.tsx). Read here
    // just to reflect the persisted state in the checkbox; the actual
    // secret never passes through the frontend.
    const [rememberMasterKey, setRememberMasterKeyState] = useState(false)

    useEffect(() => {
        let cancelled = false

        GetSettings()
            .then(async (settings) => {
                if (cancelled) return
                setSidebarCollapsed(!!settings.sidebarCollapsed)
                setRememberMasterKeyState(!!settings.rememberMasterKey)
                if (settings.editorHeight) {
                    setEditorHeightState(Math.min(EDITOR_HEIGHT_MAX, Math.max(EDITOR_HEIGHT_MIN, settings.editorHeight)))
                }

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

    function toggleSidebarCollapsed() {
        setSidebarCollapsed((prev) => {
            const next = !prev
            void SetSidebarCollapsed(next)
            return next
        })
    }

    async function toggleRememberMasterKey(checked: boolean) {
        try {
            await SetRememberMasterKey(checked)
            setRememberMasterKeyState(checked)
        } catch (err) {
            setStatusMessage(String(err))
        }
    }

    // Drag-to-resize the editor pane against the results grid below it.
    // Only persists once on mouseup (not on every mousemove) — dragging can
    // fire dozens of events per second, and the vault write doesn't need to
    // keep up with the pointer, just reflect where it ended up.
    const resizingRef = useRef(false)
    function startEditorResize(e: ReactMouseEvent) {
        e.preventDefault()
        resizingRef.current = true
        const startY = e.clientY
        const startHeight = editorHeight

        function onMove(moveEvent: MouseEvent) {
            if (!resizingRef.current) return
            const next = Math.min(EDITOR_HEIGHT_MAX, Math.max(EDITOR_HEIGHT_MIN, startHeight + (moveEvent.clientY - startY)))
            setEditorHeightState(next)
        }
        function onUp(upEvent: MouseEvent) {
            resizingRef.current = false
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
            const finalHeight = Math.min(EDITOR_HEIGHT_MAX, Math.max(EDITOR_HEIGHT_MIN, startHeight + (upEvent.clientY - startY)))
            void SetEditorHeight(finalHeight)
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
    }

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

    // BackupVault re-verifies the master password server-side before
    // writing anything — see backend/vault/store.go's VerifyPassword doc
    // comment. showBackupPasswordDialog gates the confirm modal that
    // collects it; the actual file-save dialog only opens after that
    // succeeds (inside BackupVault itself).
    async function backupVault(password: string) {
        const dest = await BackupVault(password)
        setBackupMessage(dest ? `Backup guardado en ${dest}` : '')
    }

    // Fetch (and cache) schema metadata whenever the selected connection
    // changes, so autocomplete/hover/the sidebar tree have data as soon as
    // possible.
    useEffect(() => {
        if (!selected) {
            setMetadata(null)
            setMetadataLoading(false)
            return
        }
        setMetadataLoading(true)
        setMetadata(null)
        GetSchemaMetadata(selected.id, false)
            .then((meta) => setMetadata(meta))
            .catch((err) => setStatusMessage(String(err)))
            .finally(() => setMetadataLoading(false))
    }, [selected])

    // Keep the history tab showing the newly-selected connection's own
    // history instead of the previous connection's, if it's the active tab
    // — only fetches when it's actually the one showing.
    useEffect(() => {
        if (activeBottomTab === 'history') loadHistory()
        // eslint-disable-next-line react-hooks/exhaustive-deps
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
        setMetadataLoading(true)
        setStatusMessage('Actualizando metadata…')
        GetSchemaMetadata(selected.id, true)
            .then((meta) => {
                setMetadata(meta)
                setStatusMessage('Metadata actualizada')
            })
            .catch((err) => setStatusMessage(String(err)))
            .finally(() => setMetadataLoading(false))
    }

    // Per-schema sync (the icon next to a schema node in ConnectionTree) —
    // only refreshes that one schema instead of the whole connection like
    // refreshMetadata/F5 does, so the other already-cached schemas aren't
    // re-scanned every time.
    async function syncSchema(connId: string, schema: string) {
        try {
            const meta = await SyncSchemaMetadata(connId, schema)
            if (connId === selected?.id) setMetadata(meta)
        } catch (err) {
            setStatusMessage(String(err))
        }
    }

    // Postgres and Oracle connections can span multiple schemas/owners
    // (table.schema is populated for both when the connection has one or
    // more schemas selected via SchemaPickerDialog — see
    // backend/db/metadata.go). A connection with no schema restriction
    // saved keeps falling back to its unqualified default scan
    // (USER_* for Oracle, every non-system schema for Postgres), where
    // table.schema is empty for Oracle specifically, so `schemas` comes
    // back empty and everything below just falls through unfiltered,
    // unchanged from before this feature existed.
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

    // Drives sqlLanguage.ts's per-engine snippet/keyword filtering — same
    // mutable-holder pattern as setActiveMetadata above, since that
    // provider is also registered once, globally, outside the React tree.
    useEffect(() => {
        setActiveDbType(selected?.dbType ?? null)
    }, [selected])

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
                    // History is recorded backend-side before this terminal
                    // event is emitted (see executor.go), so the row for
                    // what just ran is guaranteed to already exist here.
                    if (activeBottomTab === 'history') loadHistory()
                }
            })

            ExecuteQuery(selected.id, queryId, sqlText, dbmsOutputEnabled).catch((err) => {
                setResultSets([{...emptyResultSet(), status: 'error', error: String(err)}])
                setRunning(false)
                setRunProgress(null)
                unsubscribe()
            })
        },
        [selected, running, dbmsOutputEnabled, activeBottomTab],
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

    function loadHistory() {
        if (!selected) return
        setHistoryLoading(true)
        setHistoryError('')
        ListQueryHistory(selected.id, 200)
            .then(setHistoryEntries)
            .catch((err) => setHistoryError(String(err)))
            .finally(() => setHistoryLoading(false))
    }

    function selectBottomTab(tab: 'results' | 'history') {
        if (tab === 'history' && activeBottomTab !== 'history') loadHistory()
        setActiveBottomTab(tab)
    }

    async function clearHistory() {
        if (!selected) return
        try {
            await ClearQueryHistory(selected.id)
            setHistoryEntries([])
        } catch (err) {
            setHistoryError(String(err))
        }
    }

    async function deleteHistoryEntry(id: string) {
        try {
            await DeleteQueryHistoryEntry(id)
            setHistoryEntries((prev) => prev.filter((e) => e.id !== id))
        } catch (err) {
            setHistoryError(String(err))
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

    // Closing a result tab only hides it from resultSets — it never touches
    // an in-flight run (the statement already finished by the time its tab
    // exists) nor cancels/reissues anything, unlike sortActiveResult above.
    function closeResultTab(i: number) {
        setResultSets((prev) => prev.filter((_, idx) => idx !== i))
        setActiveResultTab((prev) => {
            if (i > prev) return prev
            return Math.max(0, prev - 1)
        })
    }

    function closeAllResultTabs() {
        setResultSets([])
        setActiveResultTab(0)
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

    // Drag-and-drop reorder from EditorTabs — the persistence effect keyed
    // on openTabPathsKey (below) picks up the new order automatically,
    // same as it already does for opening/closing tabs.
    function reorderTabs(next: EditorTab[]) {
        setTabs(next)
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
        <div className="flex h-screen w-screen overflow-hidden bg-background font-sans text-on-background">
            <ConnectionTree
                selectedId={selected?.id ?? null}
                onSelect={setSelected}
                onNewConnection={() => setConnectionDialog('new')}
                onEditConnection={(conn) => setConnectionDialog(conn.id)}
                reloadToken={reloadToken}
                metadata={metadata}
                schemas={schemas}
                activeSchema={activeSchema}
                onSelectSchema={setActiveSchema}
                onSyncSchema={syncSchema}
                metadataLoading={metadataLoading}
                onOpenTable={openTableQuery}
                onExportConnectionConfig={(connId) => void exportConnectionConfig(connId)}
                onExportTableDDL={(table, schema) => void exportTableDDL(table, schema)}
                onExportSchemaDDL={() => void exportSchemaDDL()}
                onDisconnect={(connId) => void disconnectConnection(connId)}
                onConfigureSchemas={setSchemaPickerConn}
                collapsed={sidebarCollapsed}
                onToggleCollapsed={toggleSidebarCollapsed}
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
                    <div className="flex w-96 flex-col gap-3 rounded-xl border border-outline-variant bg-surface-container-high p-6 text-on-surface shadow-lg">
                        <h2 className="flex items-center gap-2 text-lg font-semibold">
                            <Icon name="warning" className="text-tertiary" />
                            Archivos no encontrados
                        </h2>
                        <p className="text-xs text-on-surface-variant">
                            Estos archivos estaban abiertos la última vez pero ya no existen en disco — no se van a volver a
                            abrir automáticamente:
                        </p>
                        <ul className="max-h-40 overflow-y-auto rounded-lg border border-outline-variant bg-surface-container-lowest p-2 font-mono text-xs text-on-surface-variant">
                            {deletedPaths.map((p) => (
                                <li key={p} className="truncate">
                                    {p}
                                </li>
                            ))}
                        </ul>
                        <div className="mt-2 flex justify-end">
                            <button
                                onClick={() => setDeletedPaths([])}
                                title="Cierra este aviso — las pestañas de archivos que ya no existen en disco quedan como pestañas sin guardar"
                                className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-on-primary hover:opacity-90"
                            >
                                Entendido
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <div className="flex flex-col border-b border-outline-variant bg-surface">
                    {/* Context row: which connection/schema/transaction state
                        this workspace is currently pointed at. Kept
                        separate from the actions row below so neither
                        crowds the other. */}
                    <div className="flex flex-wrap items-center gap-3 px-3 py-1.5">
                        <span className="flex items-center gap-1.5 whitespace-nowrap text-xs text-on-surface-variant">
                            <span className={`h-2 w-2 rounded-full ${selected ? 'bg-secondary' : 'bg-outline'}`} />
                            {selected ? `Conectado a: ${selected.name}` : 'Selecciona una conexión'}
                        </span>

                        {selected && metadataLoading && (
                            <span className="flex items-center gap-1.5 whitespace-nowrap text-xs text-on-surface-variant">
                                <span
                                    aria-hidden
                                    className="h-3 w-3 animate-spin rounded-full border-2 border-t-transparent border-primary"
                                />
                                Cargando esquema…
                            </span>
                        )}

                        {!metadataLoading && schemas.length > 0 && (
                            <label className="flex items-center gap-1 text-xs text-on-surface-variant">
                                Schema:
                                <select
                                    value={activeSchema ?? ''}
                                    onChange={(e) => setActiveSchema(e.target.value)}
                                    className="rounded border-none bg-surface-container-highest px-1.5 py-0.5 text-xs text-on-surface outline-none"
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
                                    className="flex items-center gap-1.5 text-xs text-on-surface-variant"
                                    title="Desactivar: los statements quedan pendientes hasta Commit/Rollback en vez de aplicarse solos"
                                >
                                    <input
                                        type="checkbox"
                                        checked={!txOpen}
                                        disabled={txBusy || txOpen}
                                        onChange={() => void beginTransaction()}
                                        className="accent-primary"
                                    />
                                    Auto-commit
                                </label>
                                <button
                                    onClick={() => void commitTransaction()}
                                    disabled={!txOpen || txBusy}
                                    title="Confirma de forma permanente todos los cambios (INSERT/UPDATE/DELETE) hechos desde que se abrió la transacción actual"
                                    className="flex items-center gap-1 rounded bg-secondary-container px-2 py-0.5 text-xs font-medium text-on-secondary-container hover:opacity-90 disabled:opacity-40"
                                >
                                    <Icon name="check_circle" size={14} />
                                    Commit
                                </button>
                                <button
                                    onClick={() => void rollbackTransaction()}
                                    disabled={!txOpen || txBusy}
                                    title="Descarta todos los cambios pendientes de la transacción actual y vuelve al estado antes de abrirla"
                                    className="flex items-center gap-1 rounded bg-error-container px-2 py-0.5 text-xs font-medium text-on-error-container hover:opacity-90 disabled:opacity-40"
                                >
                                    <Icon name="undo" size={14} />
                                    Rollback
                                </button>
                                {txOpen && (
                                    <span className="flex items-center gap-1 whitespace-nowrap text-xs text-tertiary">
                                        <Icon name="warning" size={14} />
                                        Transacción abierta
                                    </span>
                                )}
                                {selected.dbType === 'oracle' && (
                                    <>
                                        <Divider />
                                        <label
                                            className="flex items-center gap-1.5 text-xs text-on-surface-variant"
                                            title="Captura el log de DBMS_OUTPUT.PUT_LINE de cada bloque PL/SQL que se ejecute — desactivalo en un script grande con muchos bloques si no necesitás ver la salida, ahorra los round-trips de ENABLE/GET_LINE por bloque"
                                        >
                                            <input
                                                type="checkbox"
                                                checked={dbmsOutputEnabled}
                                                onChange={(e) => setDbmsOutputEnabled(e.target.checked)}
                                                className="accent-primary"
                                            />
                                            DBMS_OUTPUT
                                        </label>
                                    </>
                                )}
                            </>
                        )}

                        {(statusMessage || backupMessage) && (
                            <span
                                className="min-w-0 flex-1 truncate text-xs text-on-surface-variant"
                                title={statusMessage || backupMessage}
                            >
                                {statusMessage || backupMessage}
                            </span>
                        )}

                        <div className="flex-1" />

                        <button
                            onClick={() => setShowSettingsDialog(true)}
                            title="Configuración: backup del vault y si recordar la clave maestra en este equipo"
                            className="rounded-full p-1.5 text-on-surface-variant hover:bg-surface-variant"
                        >
                            <Icon name="settings" size={18} />
                        </button>
                        <button
                            onClick={onToggleTheme}
                            title="Cambiar tema"
                            className="rounded-full p-1.5 text-on-surface-variant hover:bg-surface-variant"
                        >
                            <Icon name={theme === 'dark' ? 'light_mode' : 'dark_mode'} size={18} />
                        </button>
                    </div>

                    {/* Actions row: file ops, then query ops, then
                        schema/vault utilities — grouped with dividers so
                        the eye can parse clusters instead of one long run
                        of same-looking buttons. */}
                    <div className="flex flex-wrap items-center gap-1 border-t border-outline-variant px-2 py-1.5">
                        <button
                            onClick={() => void openFileDialog()}
                            title="Abre un archivo .sql desde tu disco en una nueva pestaña del editor"
                            className="flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium text-on-surface-variant hover:bg-surface-variant"
                        >
                            <Icon name="folder_open" size={16} />
                            Abrir
                        </button>
                        <RecentFilesMenu onOpen={(path) => void openRecentFile(path)} />
                        <button
                            onClick={() => void saveActiveTab()}
                            title="Guarda el contenido de la pestaña activa en disco (atajo: Ctrl+S). Si es una pestaña nueva, te pide dónde guardarla"
                            className="flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium text-on-surface-variant hover:bg-surface-variant"
                        >
                            <Icon name="save" size={16} />
                            Guardar (Ctrl+S)
                        </button>
                        <button
                            onClick={() => void regenerateProjectDocs()}
                            disabled={!selected || !activeTabData?.path || regeneratingDocs}
                            title="Sobrescribe CLAUDE.md y .claude/ en la carpeta del archivo abierto con el schema y las tablas de la conexión actual (o solo el esquema seleccionado arriba, si hay uno). Útil si la base de datos cambió desde la última vez."
                            className="flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium text-on-surface-variant hover:bg-surface-variant disabled:opacity-50"
                        >
                            <Icon name="auto_awesome" size={16} />
                            {regeneratingDocs ? 'Regenerando…' : 'Regenerar CLAUDE.md'}
                        </button>

                        <Divider />

                        <button
                            onClick={runSelectionOrLine}
                            disabled={!selected || running}
                            title="Ejecuta el texto seleccionado, o si no hay selección, la línea donde está el cursor (atajo: Ctrl+Enter)"
                            className="flex items-center gap-1.5 rounded bg-secondary-container px-3 py-1 text-xs font-medium text-on-secondary-container hover:opacity-90 disabled:opacity-50"
                        >
                            <Icon name="play_arrow" size={16} filled />
                            Ejecutar (Ctrl+Enter)
                        </button>
                        <button
                            onClick={runFullScript}
                            disabled={!selected || running}
                            title="Ejecuta todos los statements del editor en orden, uno por uno (atajo: Ctrl+Shift+Enter)"
                            className="flex items-center gap-1.5 rounded bg-secondary-container px-3 py-1 text-xs font-medium text-on-secondary-container hover:opacity-90 disabled:opacity-50"
                        >
                            <Icon name="playlist_play" size={16} />
                            Bloque (Ctrl+Shift+Enter)
                        </button>
                        <button
                            onClick={cancelQuery}
                            disabled={!running}
                            title="Interrumpe la consulta que está corriendo ahora mismo"
                            className="flex items-center gap-1.5 rounded bg-error-container px-3 py-1 text-xs font-medium text-on-error-container hover:opacity-90 disabled:opacity-50"
                        >
                            <Icon name="stop" size={16} filled />
                            Cancelar
                        </button>
                        <button
                            onClick={() => void runExplain(false)}
                            disabled={!selected}
                            title="Muestra el plan de ejecución del query (EXPLAIN) sin correrlo — útil para diagnosticar lentitud sin afectar datos"
                            className="flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium text-on-surface-variant hover:bg-surface-variant disabled:opacity-50"
                        >
                            <Icon name="query_stats" size={16} />
                            Explain
                        </button>
                        <button
                            onClick={() => void runExplain(true)}
                            disabled={!selected}
                            title="Ejecuta el query de verdad y muestra el plan con tiempos reales (EXPLAIN ANALYZE) — a diferencia de Explain, sí corre el query"
                            className="flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium text-on-surface-variant hover:bg-surface-variant disabled:opacity-50"
                        >
                            <Icon name="analytics" size={16} />
                            Explain Analyze
                        </button>

                        <Divider />

                        <button
                            onClick={refreshMetadata}
                            disabled={!selected}
                            title="Vuelve a leer las tablas y columnas de la base de datos (atajo: F5) — usalo si acabás de crear/alterar una tabla"
                            className="flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium text-on-surface-variant hover:bg-surface-variant disabled:opacity-50"
                        >
                            <Icon name="refresh" size={16} />
                            Refrescar (F5)
                        </button>
                    </div>
                </div>

                <EditorTabs
                    tabs={tabs}
                    activeId={activeTabId}
                    onSelect={setActiveTabId}
                    onClose={closeTab}
                    onNew={newTab}
                    onReorder={reorderTabs}
                />

                <div className="min-w-0 border-b border-outline-variant" style={{height: editorHeight}}>
                    <MonacoSQLEditor
                        value={activeTabData?.content ?? ''}
                        onChange={updateActiveTabContent}
                        onMount={(editor) => {
                            editorRef.current = editor
                        }}
                    />
                </div>

                {/* Drag handle: resizes the editor pane against the results
                    grid below. Persisted on mouseup, see startEditorResize. */}
                <div
                    onMouseDown={startEditorResize}
                    title="Arrastrar para cambiar el alto del editor — el tamaño queda guardado"
                    className="group flex h-1.5 shrink-0 cursor-row-resize items-center justify-center bg-surface-container-low hover:bg-primary/30"
                >
                    <div className="h-0.5 w-8 rounded-full bg-outline-variant group-hover:bg-primary" />
                </div>

                {/* "Resultados"/"Historial" — tabs sharing this bottom
                    panel, same visual pattern as EditorTabs above, instead
                    of two docked panels stacked on top of each other. */}
                <div className="flex items-center gap-1 border-b border-outline-variant bg-surface-container px-2 pt-1">
                    <button
                        onClick={() => selectBottomTab('results')}
                        title="Resultado de la última ejecución"
                        className={`flex items-center gap-1.5 rounded-t-xs px-3 py-1 text-xs ${
                            activeBottomTab === 'results'
                                ? 'bg-surface text-on-surface'
                                : 'text-on-surface-variant hover:text-on-surface'
                        }`}
                    >
                        <Icon name="table_chart" size={14} className="opacity-70" />
                        Resultados
                    </button>
                    <button
                        onClick={() => selectBottomTab('history')}
                        title="Historial de ejecuciones de esta conexión — SQL exacto enviado, estado y mensaje de error completo por cada statement corrido"
                        className={`flex items-center gap-1.5 rounded-t-xs px-3 py-1 text-xs ${
                            activeBottomTab === 'history'
                                ? 'bg-surface text-on-surface'
                                : 'text-on-surface-variant hover:text-on-surface'
                        }`}
                    >
                        <Icon name="history" size={14} className="opacity-70" />
                        Historial
                    </button>
                </div>

                {activeBottomTab === 'results' ? (
                    <>
                        <ResultTabs
                            count={resultSets.length}
                            active={activeResultTab}
                            onSelect={setActiveResultTab}
                            onClose={closeResultTab}
                            onCloseAll={closeAllResultTabs}
                            statuses={resultSets.map((r) => r.status)}
                        />

                        <div className="flex items-center gap-2 border-b border-outline-variant bg-surface-container px-2 py-1">
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
                            tableNameHint={selected?.name}
                        />

                        {activeResult && activeResult.dbmsOutput.length > 0 && (
                            <div className="border-t border-outline-variant bg-surface-container-lowest">
                                <div className="flex items-center gap-1.5 px-2 pt-1 text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">
                                    <Icon name="terminal" size={12} />
                                    DBMS_OUTPUT
                                </div>
                                <pre className="max-h-32 overflow-y-auto p-2 font-mono text-xs text-on-surface-variant">
                                    {activeResult.dbmsOutput.join('\n')}
                                </pre>
                            </div>
                        )}
                    </>
                ) : (
                    <Suspense fallback={null}>
                        <HistoryPanel
                            entries={historyEntries}
                            loading={historyLoading}
                            error={historyError}
                            onRefresh={loadHistory}
                            onClear={() => void clearHistory()}
                            onDeleteEntry={(id) => void deleteHistoryEntry(id)}
                        />
                    </Suspense>
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

                <div className="flex min-w-0 items-center gap-4 border-t border-outline-variant bg-surface-container-low px-3 py-1 text-xs text-on-surface-variant">
                    {running && (
                        <span className="flex shrink-0 items-center gap-2">
                            <span
                                aria-hidden
                                className="h-3 w-3 animate-spin rounded-full border-2 border-t-transparent border-primary"
                            />
                            {runProgress && runProgress.total > 1
                                ? `Ejecutando ${runProgress.current}/${runProgress.total}…`
                                : 'Ejecutando…'}
                        </span>
                    )}
                    {activeResult?.status === 'done' && (
                        <span className="shrink-0">
                            {activeResult.rowsAffected} filas · {activeResult.durationMs}ms
                        </span>
                    )}
                    {activeResult?.status === 'cancelled' && <span className="shrink-0 text-tertiary">Cancelada</span>}
                    {activeResult?.status === 'error' && (
                        <span className="min-w-0 flex-1 truncate text-error" title={activeResult.error}>
                            {activeResult.error}
                        </span>
                    )}
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

            {showSettingsDialog && (
                <Suspense fallback={null}>
                    <SettingsDialog
                        rememberMasterKey={rememberMasterKey}
                        onToggleRememberMasterKey={(checked) => void toggleRememberMasterKey(checked)}
                        onBackupVault={() => {
                            setShowSettingsDialog(false)
                            setShowBackupPasswordDialog(true)
                        }}
                        onClose={() => setShowSettingsDialog(false)}
                    />
                </Suspense>
            )}

            {showBackupPasswordDialog && (
                <PasswordConfirmDialog
                    title="Confirmar backup del vault"
                    description="El backup incluye tus conexiones cifradas y puede terminar en otra máquina — reingresá tu clave maestra para confirmar. Sin ella, el backup no sirve de nada aunque alguien lo copie."
                    confirmLabel="Guardar backup"
                    onConfirm={backupVault}
                    onClose={() => setShowBackupPasswordDialog(false)}
                />
            )}
        </div>
    )
}
