import {lazy, Suspense, useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent} from 'react'
import ConnectionTree from './sidebar/ConnectionTree'
import SshConnectionTree from './sidebar/SshConnectionTree'
import ConfirmDialog from './ConfirmDialog'
import DDLViewerModal, {type DDLObjectType} from './DDLViewerModal'
import Icon from './Icon'
import PasswordConfirmDialog from './PasswordConfirmDialog'
import RestoreVaultDialog from './RestoreVaultDialog'
import ResultGrid from './results/ResultGrid'
import ResultTabs from './results/ResultTabs'
import ExecutionConsole, {ConsoleLogEntry} from './results/ExecutionConsole'
import ExportMenu from './results/ExportMenu'
import RedisResultView, {RedisCommandResult} from './results/RedisResultView'
import EditorTabs, {EditorTab, TabLanguage} from './editor/EditorTabs'
import CodeMirrorTabbedEditor from './editor/CodeMirrorTabbedEditor'
import RedisBrowserTab from './redis/RedisBrowserTab'
import SshTerminalTab, {closeSshTerminalSession} from './ssh/SshTerminalTab'
import SftpTab from './sftp/SftpTab'
import type {TerminalThemeId} from '../xterm/terminalThemes'
import {
    BackupVault,
    BeginTransaction,
    CancelQuery,
    CancelRedisCommand,
    ClearQueryHistory,
    CommitTransaction,
    CreateFolder,
    DeleteConnection,
    DeleteFolder,
    DeleteQueryHistoryEntry,
    DisconnectConnection,
    ExecuteQuery,
    ExecuteRedisCommand,
    ExplainQuery,
    ExportConnectionConfig,
    ExportSchemaDDL,
    ExportTableDDL,
    GenerateProjectDocs,
    GetSchemaMetadata,
    GetSettings,
    HasOpenTransaction,
    ListConnections,
    ListFolders,
    ListQueryHistory,
    MoveConnectionToFolder,
    OpenSQLFileDialog,
    OpenSQLFilePath,
    RenameFolder,
    ReorderFolder,
    RollbackTransaction,
    SaveSQLFile,
    SaveSQLFileAs,
    SetCollapsedSidebarModules,
    SetEditorHeight,
    SetEditorTheme,
    SetOpenTabs,
    SetRememberMasterKey,
    SetSidebarCollapsed,
    SetSshTerminalTheme,
    SyncSchemaMetadata,
} from '../../wailsjs/go/main/App'
import {EventsOn} from '../../wailsjs/runtime'
import {db, explain, vault} from '../../wailsjs/go/models'
import type {EditorView} from '@codemirror/view'
import {lintSQL} from '../lib/linter'
import {lintRedisCommands} from '../lib/redisLinter'
import type {Theme} from '../hooks/useTheme'

// Lazy: both are only mounted once the user opens them (showDialog /
// showExplain), so they don't need to be in the initial bundle — unlike
// the editor itself, which the workspace needs immediately and can't defer.
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

// Mirrors backend/redisquery.Event's JSON shape (see runRedisText below).
interface RedisQueryEvent {
    type: 'done' | 'cancelled' | 'error'
    commandIndex: number
    totalCommands: number
    commandText?: string
    resultKind?: string
    result?: unknown
    durationMs?: number
    error?: string
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

// ConsoleLogEntry itself is defined (and exported) by ExecutionConsole.tsx —
// same pattern as RedisCommandResult/RedisResultView.tsx: the component that
// renders a type owns its definition, Workspace.tsx just imports it.

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

function languageForDbType(dbType: string): TabLanguage {
    return dbType === 'redis' ? 'redis-cli' : 'sql'
}

function newScratchTab(): EditorTab {
    return {id: newTabId(), title: 'Query sin título', path: null, content: 'SELECT 1', dirty: false, connId: null, language: 'sql', kind: 'editor'}
}

// Vertical separator between button clusters in the toolbar — purely
// visual, no state, so it lives outside the component like the other
// helpers here.
function Divider() {
    return <div className="mx-0.5 h-4 w-px shrink-0 bg-outline-variant" />
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

function defaultSchema(schemas: string[]): string {
    return schemas.includes('public') ? 'public' : schemas[0]
}

// Every distinct schema name across tables AND the scanned procedures/
// functions/triggers/packages — scanning tables alone would silently hide
// a schema that contains only routines (e.g. a Postgres "utils" schema
// with functions but no tables of its own), falling it back into the flat/
// ungrouped tree view (see ConnectionTree.tsx) instead of its own group.
function schemasOf(meta: db.SchemaMetadata | null): string[] {
    if (!meta) return []
    const names = [
        ...meta.tables.map((t) => t.schema),
        ...(meta.procedures ?? []).map((p) => p.schema),
        ...(meta.functions ?? []).map((f) => f.schema),
        ...(meta.triggers ?? []).map((t) => t.schema),
        ...(meta.packages ?? []).map((p) => p.schema),
    ]
    return Array.from(new Set(names.filter((s): s is string => !!s))).sort()
}

interface WorkspaceProps {
    theme: Theme
    onToggleTheme: () => void
    // Called after a successful "Restaurar backup" (see
    // RestoreVaultBackupOverExisting) — the restored vault's password is
    // whatever the backup was encrypted with, not whatever unlocked this
    // session, so App.tsx must send the user back through UnlockScreen
    // instead of pretending this session is still validly unlocked.
    onLocked: () => void
}

export default function Workspace({theme, onToggleTheme, onLocked}: WorkspaceProps) {
    // `selected` is ONLY the sidebar's own navigation state — which
    // connection's table/key tree is expanded there. It is deliberately
    // never synced with the active editor tab in either direction (a
    // confirmed decision): binding a tab to a connection is always an
    // explicit act via EditorTabs' own per-tab selector, never a side
    // effect of browsing the sidebar. See .claude/skills/mini-tools-patterns/SKILL.md.
    const [selected, setSelected] = useState<vault.ConnectionSummary | null>(null)
    // 'new' opens the dialog empty (create); any other string is a
    // connection id to edit; null keeps it closed.
    const [connectionDialog, setConnectionDialog] = useState<'new' | string | null>(null)
    const [schemaPickerConn, setSchemaPickerConn] = useState<vault.ConnectionSummary | null>(null)
    // Which procedure/function/trigger/package's DDL is currently shown in
    // the modal (see SchemaObjectsList.tsx/DDLViewerModal.tsx) — null when
    // closed.
    const [ddlViewer, setDdlViewer] = useState<{connId: string; objectType: DDLObjectType; schema: string; name: string; oid: number} | null>(
        null,
    )
    const [reloadToken, setReloadToken] = useState(0)

    // Every saved connection, fetched here (in addition to ConnectionTree's
    // own internal copy) so EditorTabs' per-tab selector and
    // activeTabConnection below can resolve a tab's connId to a full
    // ConnectionSummary without threading state through the sidebar tree.
    const [connections, setConnections] = useState<vault.ConnectionSummary[]>([])
    useEffect(() => {
        ListConnections().then(setConnections).catch(() => {})
    }, [reloadToken])

    // Folder tree for organizing saved connections (backend/vault/folders_repo.go)
    // — same reloadToken as connections, since creating/renaming/deleting a
    // folder or moving a connection into one should refresh both together.
    const [folders, setFolders] = useState<vault.Folder[]>([])
    useEffect(() => {
        ListFolders().then(setFolders).catch(() => {})
    }, [reloadToken])

    // scope keeps SSH connections' folder tree entirely independent of DB
    // connections' (vault.Folder.Scope, schema_migrations version 12) —
    // ConnectionTree.tsx and SshConnectionTree.tsx each wire this with
    // their own fixed scope below, never let the user pick it.
    function createFolder(name: string, parentId: string, scope: 'db' | 'ssh') {
        CreateFolder(name, parentId, scope)
            .then(() => setReloadToken((n) => n + 1))
            .catch((err) => setStatusMessage(String(err)))
    }

    function renameFolder(id: string, name: string) {
        RenameFolder(id, name)
            .then(() => setReloadToken((n) => n + 1))
            .catch((err) => setStatusMessage(String(err)))
    }

    function deleteFolder(id: string) {
        DeleteFolder(id)
            .then(() => setReloadToken((n) => n + 1))
            .catch((err) => setStatusMessage(String(err)))
    }

    function reorderFolder(id: string, direction: 'up' | 'down') {
        ReorderFolder(id, direction)
            .then(() => setReloadToken((n) => n + 1))
            .catch((err) => setStatusMessage(String(err)))
    }

    function moveConnectionToFolder(connId: string, folderId: string) {
        MoveConnectionToFolder(connId, folderId)
            .then(() => setReloadToken((n) => n + 1))
            .catch((err) => setStatusMessage(String(err)))
    }

    // Which sidebar module ids ("connections", more later) are collapsed to
    // an accordion header — distinct from sidebarCollapsed below, which is
    // the whole-sidebar icon-only rail toggle.
    const [collapsedModules, setCollapsedModules] = useState<Set<string>>(new Set())

    function toggleModuleCollapsed(moduleId: string) {
        setCollapsedModules((prev) => {
            const next = new Set(prev)
            if (next.has(moduleId)) next.delete(moduleId)
            else next.add(moduleId)
            void SetCollapsedSidebarModules(Array.from(next))
            return next
        })
    }

    // Schema metadata cached per connection id — shared by the sidebar tree
    // (keyed on `selected`) and the editor's autocomplete/toolbar (keyed on
    // `activeTabConnection`), which are independent now and may or may not
    // be the same connection at any given moment.
    const [metadataByConn, setMetadataByConn] = useState<Record<string, db.SchemaMetadata>>({})
    const [loadingConnIds, setLoadingConnIds] = useState<Set<string>>(new Set())
    // Which schema is "active" (autocomplete narrowing, CLAUDE.md scope, the
    // sidebar's expanded schema node), remembered per connection id for the
    // same reason as metadataByConn.
    const [activeSchemaByConn, setActiveSchemaByConn] = useState<Record<string, string>>({})

    function ensureMetadata(connId: string, dbType: string, force: boolean) {
        if (dbType === 'redis' || dbType === 'ssh') return
        if (!force && metadataByConn[connId]) return
        setLoadingConnIds((prev) => new Set(prev).add(connId))
        GetSchemaMetadata(connId, force)
            .then((meta) => setMetadataByConn((prev) => ({...prev, [connId]: meta})))
            .catch((err) => setStatusMessage(String(err)))
            .finally(() =>
                setLoadingConnIds((prev) => {
                    const next = new Set(prev)
                    next.delete(connId)
                    return next
                }),
            )
    }

    // Auto-commit off for `activeTabConnection` — while true, Commit/Rollback
    // are the only way back to auto-commit (see backend
    // Executor.BeginTransaction's doc comment for why this can't just be a
    // client-side flag: it mirrors a real reserved connection on the
    // backend).
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
    // One entry per statement of the last SQL run (see ConsoleLogEntry) —
    // built alongside resultSets in runText's EventsOn handler, rendered by
    // ExecutionConsole under the "Consola" bottom tab.
    const [consoleLog, setConsoleLog] = useState<ConsoleLogEntry[]>([])
    // Redis's own result stream (backend/redisquery.Event) — a command's
    // result isn't tabular (columns/rows), so it doesn't fit ResultSet; see
    // RedisResultView's transcript-style rendering instead of ResultTabs.
    const [redisResults, setRedisResults] = useState<RedisCommandResult[]>([])
    // A FLUSHALL/FLUSHDB in the script needs confirming before it runs (see
    // lintRedisCommands) — a themed ConfirmDialog, never window.confirm()
    // (see .claude/rules/conventions.md), holding the script text until the
    // user confirms or cancels.
    const [pendingRedisCommandRun, setPendingRedisCommandRun] = useState<string | null>(null)
    // A double-click on a key in the sidebar's inline RedisKeyTree (via
    // ConnectionTree's onOpenRedisKey) opens/focuses that connection's
    // Redis Browser tab with this key pre-selected in the detail panel —
    // see openRedisKeyDetail and RedisBrowserTab's initialKey/
    // initialKeyToken props below. token forces the effect that consumes
    // this to re-fire even when key is unchanged (double-clicking the same
    // key again, or double-clicking a different key while that tab is
    // already the active one).
    const [pendingBrowserKey, setPendingBrowserKey] = useState<{connId: string; key: string; token: number} | null>(null)
    const pendingBrowserKeyTokenRef = useRef(0)
    const [backupMessage, setBackupMessage] = useState('')
    const [showBackupPasswordDialog, setShowBackupPasswordDialog] = useState(false)
    const [showRestoreDialog, setShowRestoreDialog] = useState(false)
    const [showSettingsDialog, setShowSettingsDialog] = useState(false)
    const [statusMessage, setStatusMessage] = useState('')

    const [showExplain, setShowExplain] = useState(false)
    const [explainPlan, setExplainPlan] = useState<explain.Plan | null>(null)
    const [explainLoading, setExplainLoading] = useState(false)
    const [explainError, setExplainError] = useState('')

    // "Resultados"/"Consola"/"Historial" are tabs sharing one bottom panel —
    // tab-style like EditorTabs above, not docked panels stacked on top of
    // each other. Starts on "results" (what you want right after running a
    // single statement); a multi-statement run auto-switches to "console"
    // instead (see runText) so the per-statement log is what you land on,
    // matching the DataGrip-style console this mirrors. Switching to
    // "history" is what triggers its first load.
    const [activeBottomTab, setActiveBottomTab] = useState<'results' | 'console' | 'history'>('results')
    const [historyEntries, setHistoryEntries] = useState<vault.HistoryEntry[]>([])
    const [historyLoading, setHistoryLoading] = useState(false)
    const [historyError, setHistoryError] = useState('')

    const queryIdRef = useRef<string | null>(null)
    const editorRef = useRef<EditorView | null>(null)
    const tabsRef = useRef(tabs)
    tabsRef.current = tabs
    const activeTabIdRef = useRef(activeTabId)
    activeTabIdRef.current = activeTabId
    const pendingSortRef = useRef<{column: string; direction: 'asc' | 'desc'} | null>(null)

    const activeTabData = tabs.find((t) => t.id === activeTabId) ?? tabs[0]
    // The connection the ACTIVE TAB is bound to — this, not `selected`,
    // drives everything about running queries/commands and the toolbar's
    // engine-specific controls. null when the tab has no connection linked
    // yet, or when a previously-linked connection no longer exists (deleted
    // while the app was closed) — both cases resolve to the same "unbound"
    // state with no special-casing needed.
    const activeTabConnection = activeTabData?.connId ? connections.find((c) => c.id === activeTabData.connId) ?? null : null

    function updateActiveTabContent(content: string) {
        setTabs((prev) => prev.map((t) => (t.id === activeTabIdRef.current ? {...t, content, dirty: true} : t)))
    }

    function changeTabConnection(tabId: string, connId: string | null) {
        setTabs((prev) =>
            prev.map((t) => {
                if (t.id !== tabId) return t
                if (!connId) return {...t, connId: null}
                const conn = connections.find((c) => c.id === connId)
                return {...t, connId, language: conn ? languageForDbType(conn.dbType) : t.language}
            }),
        )
    }

    function changeTabLanguage(tabId: string, language: TabLanguage) {
        // Only meaningful while unbound — EditorTabs' own selector already
        // disables this control once a connection is linked, this is just
        // the defense-in-depth backstop.
        setTabs((prev) => prev.map((t) => (t.id === tabId && !t.connId ? {...t, language} : t)))
    }

    // Session restore: reopen whatever tabs were open last time (path +
    // connection/language binding), and warn (once) about any that were
    // deleted from disk since. Guards against the persist-effect below
    // firing with the initial scratch tab BEFORE this has had a chance to
    // run — see hasRestoredRef.
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
    // CodeMirror color theme id (frontend/src/codemirror/themes.ts's
    // registry) — "auto" (the default) follows the app-wide dark/light
    // `theme` prop instead of a fixed preset, resolved inside
    // CodeMirrorTabbedEditor via resolveEditorTheme.
    const [editorThemeId, setEditorThemeIdState] = useState('auto')
    // xterm.js color theme id (frontend/src/xterm/terminalThemes.ts's
    // registry) — same "auto follows theme" convention as editorThemeId
    // above, just for the SSH terminal. One global setting shared by every
    // open terminal tab (see SshTerminalTab.tsx's terminalThemeId prop).
    const [terminalThemeId, setTerminalThemeIdState] = useState('auto')

    useEffect(() => {
        let cancelled = false

        GetSettings()
            .then(async (settings) => {
                if (cancelled) return
                setSidebarCollapsed(!!settings.sidebarCollapsed)
                setRememberMasterKeyState(!!settings.rememberMasterKey)
                if (settings.editorTheme) {
                    setEditorThemeIdState(settings.editorTheme)
                }
                if (settings.sshTerminalTheme) {
                    setTerminalThemeIdState(settings.sshTerminalTheme)
                }
                if (settings.collapsedSidebarModules) {
                    setCollapsedModules(new Set(settings.collapsedSidebarModules))
                }
                if (settings.editorHeight) {
                    setEditorHeightState(Math.min(EDITOR_HEIGHT_MAX, Math.max(EDITOR_HEIGHT_MIN, settings.editorHeight)))
                }

                const infos = settings.openTabs ?? []
                if (infos.length === 0) return

                const restored: EditorTab[] = []
                const deleted: string[] = []
                for (const info of infos) {
                    // Redis Browser tabs have no file — nothing to open,
                    // just reopen the tab itself against the same
                    // connection (RedisKeyTree/RedisKeyDetailPanel show
                    // their own error state if that connection is gone).
                    if (info.kind === 'redis-browser') {
                        if (info.connId) {
                            restored.push({
                                id: newTabId(),
                                title: 'Redis Browser',
                                path: null,
                                content: '',
                                dirty: false,
                                connId: info.connId,
                                language: 'redis-cli',
                                kind: 'redis-browser',
                            })
                        }
                        continue
                    }
                    try {
                        const file = await OpenSQLFilePath(info.path)
                        if (file) {
                            restored.push({
                                id: newTabId(),
                                title: fileTitle(file.path),
                                path: file.path,
                                content: file.content,
                                dirty: false,
                                connId: info.connId || null,
                                language: (info.language as TabLanguage) || 'sql',
                                kind: 'editor',
                            })
                        }
                    } catch {
                        deleted.push(info.path)
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
                    void SetOpenTabs(
                        restored.map(
                            (t) =>
                                new vault.OpenTabInfo({
                                    path: t.path ?? '',
                                    connId: t.connId ?? '',
                                    language: t.language,
                                    kind: t.kind === 'redis-browser' ? 'redis-browser' : '',
                                }),
                        ),
                    )
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

    function changeEditorTheme(id: string) {
        setEditorThemeIdState(id)
        void SetEditorTheme(id)
    }

    function changeTerminalTheme(id: TerminalThemeId) {
        setTerminalThemeIdState(id)
        void SetSshTerminalTheme(id)
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

    // Persist the current set of open tabs (path + connection/language
    // binding) whenever any of that changes — but NOT on every keystroke,
    // which would also change `tabs`' reference via updateActiveTabContent.
    // Keying on path+connId+language+kind per tab (not the whole tabs
    // array) keeps this from firing on content-only changes.
    const openTabsKey = tabs.map((t) => `${t.path ?? ''}|${t.connId ?? ''}|${t.language}|${t.kind}`).join(' ')
    useEffect(() => {
        if (!hasRestoredRef.current) return
        // A plain editor tab only persists once it has a path (unsaved
        // scratch queries were never restorable); a redis-browser tab has
        // no path at all but is restorable via connId alone, so it
        // qualifies too.
        const infos = tabs
            .filter((t) => !!t.path || t.kind === 'redis-browser')
            .map(
                (t) =>
                    new vault.OpenTabInfo({
                        path: t.path ?? '',
                        connId: t.connId ?? '',
                        language: t.language,
                        kind: t.kind === 'redis-browser' ? 'redis-browser' : '',
                    }),
            )
        void SetOpenTabs(infos)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [openTabsKey])

    // BackupVault re-verifies the master password server-side before
    // writing anything — see backend/vault/store.go's VerifyPassword doc
    // comment. showBackupPasswordDialog gates the confirm modal that
    // collects it; the actual file-save dialog only opens after that
    // succeeds (inside BackupVault itself).
    async function backupVault(password: string) {
        const dest = await BackupVault(password)
        setBackupMessage(dest ? `Backup guardado en ${dest}` : '')
    }

    // Fetch (and cache) schema metadata for the sidebar's expanded
    // connection and for the active tab's bound connection independently —
    // they may be different connections, or the same one (cache hit either
    // way).
    useEffect(() => {
        if (selected) ensureMetadata(selected.id, selected.dbType, false)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selected?.id])

    useEffect(() => {
        if (activeTabConnection) ensureMetadata(activeTabConnection.id, activeTabConnection.dbType, false)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeTabConnection?.id])

    const sidebarMetadata = selected ? metadataByConn[selected.id] ?? null : null
    const sidebarMetadataLoading = selected ? loadingConnIds.has(selected.id) : false
    const sidebarSchemas = schemasOf(sidebarMetadata)
    const sidebarActiveSchema = selected ? activeSchemaByConn[selected.id] ?? null : null

    const editorMetadata = activeTabConnection ? metadataByConn[activeTabConnection.id] ?? null : null
    const editorMetadataLoading = activeTabConnection ? loadingConnIds.has(activeTabConnection.id) : false
    const editorSchemas = schemasOf(editorMetadata)
    const editorActiveSchema = activeTabConnection ? activeSchemaByConn[activeTabConnection.id] ?? null : null

    // Keep the active schema valid as metadata changes (new connection, F5):
    // preserve it if it still exists, default to "public" if present,
    // otherwise the first schema alphabetically. Runs independently for the
    // sidebar's connection and the editor's, same reasoning as the two
    // ensureMetadata effects above.
    useEffect(() => {
        if (!selected || sidebarSchemas.length === 0) return
        setActiveSchemaByConn((prev) => {
            if (prev[selected.id] && sidebarSchemas.includes(prev[selected.id])) return prev
            return {...prev, [selected.id]: defaultSchema(sidebarSchemas)}
        })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selected?.id, sidebarMetadata])

    useEffect(() => {
        if (!activeTabConnection || editorSchemas.length === 0) return
        setActiveSchemaByConn((prev) => {
            if (prev[activeTabConnection.id] && editorSchemas.includes(prev[activeTabConnection.id])) return prev
            return {...prev, [activeTabConnection.id]: defaultSchema(editorSchemas)}
        })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeTabConnection?.id, editorMetadata])

    // The editor's autocomplete/hover only ever see the active tab's
    // connection's active schema's tables — "el console debe indicar en qué
    // BD/schema quiero que esté trabajando" — not the whole multi-schema
    // catalog at once (that's still the full fetch from GetSchemaMetadata;
    // this only narrows what's *shown*). Passed directly as a prop to
    // CodeMirrorTabbedEditor, which reconfigures its own per-tab schema
    // Compartment — no global mutable store to push into (see that
    // component's module doc comment for why, now that each tab carries
    // its own CodeMirror EditorState).
    const filteredEditorMetadata: db.SchemaMetadata | null =
        editorMetadata && editorActiveSchema
            ? new db.SchemaMetadata({tables: editorMetadata.tables.filter((t) => t.schema === editorActiveSchema)})
            : editorMetadata

    // Keep the history tab showing the active tab connection's own history
    // instead of the previous one's, if it's the active bottom tab — only
    // fetches when it's actually the one showing.
    useEffect(() => {
        if (activeBottomTab === 'history') loadHistory()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeTabConnection?.id])

    // Re-sync the auto-commit UI with the backend's actual state — the
    // reserved connection lives in the Go executor, not in this component,
    // so trust it rather than assuming local state survived a reconnect.
    useEffect(() => {
        if (!activeTabConnection) {
            setTxOpen(false)
            return
        }
        HasOpenTransaction(activeTabConnection.id)
            .then(setTxOpen)
            .catch(() => setTxOpen(false))
    }, [activeTabConnection?.id])

    async function beginTransaction() {
        if (!activeTabConnection) return
        setTxBusy(true)
        try {
            await BeginTransaction(activeTabConnection.id)
            setTxOpen(true)
            setStatusMessage('Transacción abierta — auto-commit desactivado')
        } catch (err) {
            setStatusMessage(String(err))
        } finally {
            setTxBusy(false)
        }
    }

    async function commitTransaction() {
        if (!activeTabConnection) return
        setTxBusy(true)
        try {
            await CommitTransaction(activeTabConnection.id)
            setTxOpen(false)
            setStatusMessage('Commit hecho — auto-commit activado')
        } catch (err) {
            setStatusMessage(String(err))
        } finally {
            setTxBusy(false)
        }
    }

    async function rollbackTransaction() {
        if (!activeTabConnection) return
        setTxBusy(true)
        try {
            await RollbackTransaction(activeTabConnection.id)
            setTxOpen(false)
            setStatusMessage('Rollback hecho — auto-commit activado')
        } catch (err) {
            setStatusMessage(String(err))
        } finally {
            setTxBusy(false)
        }
    }

    function refreshMetadata() {
        if (!activeTabConnection) return
        setStatusMessage('Actualizando metadata…')
        ensureMetadata(activeTabConnection.id, activeTabConnection.dbType, true)
    }

    // Per-schema sync (the icon next to a schema node in ConnectionTree) —
    // only refreshes that one schema instead of the whole connection like
    // refreshMetadata/F5 does, so the other already-cached schemas aren't
    // re-scanned every time.
    async function syncSchema(connId: string, schema: string) {
        try {
            const meta = await SyncSchemaMetadata(connId, schema)
            setMetadataByConn((prev) => ({...prev, [connId]: meta}))
        } catch (err) {
            setStatusMessage(String(err))
        }
    }

    const runText = useCallback(
        (connection: vault.ConnectionSummary, sqlText: string) => {
            if (running || !sqlText.trim()) return

            const queryId = newQueryId()
            queryIdRef.current = queryId
            setRunning(true)
            setRunProgress(null)
            setResultSets([])
            setActiveResultTab(0)
            setConsoleLog([])

            // Per-run scratch state, captured by this closure (a fresh Set/
            // flag every time runText is called, never shared across runs).
            // seenColumns tracks which statement indices got a "columns"
            // event, so the console log entry built below can tell a
            // SELECT-like statement ("N filas obtenidas") apart from a DDL/
            // exec/PL-SQL block ("completado") without re-deriving it from
            // resultSets (whose updater must stay a pure reducer).
            const seenColumns = new Set<number>()
            let switchedToConsole = false

            const unsubscribe = EventsOn(queryId, (event: QueryEvent) => {
                setRunProgress({current: event.statementIndex + 1, total: event.totalStatements})

                // A multi-statement script lands on "Consola" instead of
                // "Resultados" — see activeBottomTab's doc comment. Decided
                // once, off the very first event of this run.
                if (!switchedToConsole) {
                    switchedToConsole = true
                    if (event.totalStatements > 1) setActiveBottomTab('console')
                }

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
                            seenColumns.add(event.statementIndex)
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

                if (event.type === 'done' || event.type === 'error' || event.type === 'cancelled') {
                    const terminalStatus = event.type
                    const newEntry: ConsoleLogEntry = {
                        index: event.statementIndex,
                        total: event.totalStatements,
                        sqlText: event.sqlText ?? '',
                        status: terminalStatus,
                        hasColumns: seenColumns.has(event.statementIndex),
                        rowsAffected: event.rowsAffected ?? 0,
                        durationMs: event.durationMs ?? 0,
                        error: event.error ?? '',
                        timestamp: Date.now(),
                    }
                    setConsoleLog((prev) => [...prev, newEntry])
                }

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

            ExecuteQuery(connection.id, queryId, sqlText, dbmsOutputEnabled).catch((err) => {
                setResultSets([{...emptyResultSet(), status: 'error', error: String(err)}])
                setRunning(false)
                setRunProgress(null)
                unsubscribe()
            })
        },
        [running, dbmsOutputEnabled, activeBottomTab],
    )

    // Redis counterpart of runText — same client-generated queryId +
    // EventsOn-before-invoking contract (see ExecuteRedisCommand's doc
    // comment), but streams backend/redisquery.Event (one entry per
    // command) into redisResults instead of columns/rows into resultSets.
    const runRedisText = useCallback(
        (connection: vault.ConnectionSummary, commandText: string) => {
            if (running || !commandText.trim()) return

            const queryId = newQueryId()
            queryIdRef.current = queryId
            setRunning(true)
            setRunProgress(null)
            setRedisResults([])

            const unsubscribe = EventsOn(queryId, (event: RedisQueryEvent) => {
                setRunProgress({current: event.commandIndex + 1, total: event.totalCommands})
                setRedisResults((prev) => {
                    const next = [...prev]
                    while (next.length <= event.commandIndex) {
                        next.push({commandText: '', status: 'running', durationMs: 0, error: ''})
                    }
                    next[event.commandIndex] = {
                        commandText: event.commandText ?? next[event.commandIndex].commandText,
                        status: event.type,
                        resultKind: event.resultKind,
                        result: event.result,
                        durationMs: event.durationMs ?? 0,
                        error: event.error ?? '',
                    }
                    return next
                })

                if (
                    event.type === 'cancelled' ||
                    ((event.type === 'done' || event.type === 'error') && event.commandIndex === event.totalCommands - 1)
                ) {
                    setRunning(false)
                    setRunProgress(null)
                    unsubscribe()
                    if (activeBottomTab === 'history') loadHistory()
                }
            })

            ExecuteRedisCommand(connection.id, queryId, commandText).catch((err) => {
                setRedisResults([{commandText, status: 'error', durationMs: 0, error: String(err)}])
                setRunning(false)
                setRunProgress(null)
                unsubscribe()
            })
        },
        [running, activeBottomTab],
    )

    // Spec: "linter básico... warning antes de ejecutar". Only for
    // user-initiated runs (selection/line, full block) — not for
    // auto-generated queries (double-click LIMIT, sort-by-column requery),
    // which would otherwise pop this dialog on every double-click. Only
    // `blocking` warnings (UPDATE/DELETE without WHERE — genuinely
    // destructive) actually stop execution; non-blocking ones (SELECT *) are
    // still shown as an editor marker by MonacoTabbedEditor.tsx but never
    // prevent running a plain read query.
    function confirmAndRun(text: string) {
        if (!activeTabConnection) {
            setStatusMessage('Vinculá esta pestaña a una conexión antes de ejecutar (ícono a la izquierda del título)')
            return
        }

        if (activeTabConnection.dbType === 'redis') {
            // FLUSHALL/FLUSHDB block via a themed ConfirmDialog (never
            // window.confirm(), see .claude/rules/conventions.md) instead
            // of the SQL branch's inline window.confirm() below — that one
            // is pre-existing code, left as-is rather than touched as a
            // drive-by fix outside this task's scope.
            const warnings = lintRedisCommands(text).filter((w) => w.blocking)
            if (warnings.length > 0) {
                setPendingRedisCommandRun(text)
                return
            }
            runRedisText(activeTabConnection, text)
            return
        }

        const warnings = lintSQL(text).filter((w) => w.blocking)
        if (warnings.length > 0) {
            const message = warnings.map((w) => `Línea ${w.startLineNumber}: ${w.message}`).join('\n')
            if (!window.confirm(`Advertencias antes de ejecutar:\n\n${message}\n\n¿Ejecutar de todas formas?`)) {
                return
            }
        }
        runText(activeTabConnection, text)
    }

    function runSelectionOrLine() {
        const view = editorRef.current
        if (!view) return
        const {from, to, empty} = view.state.selection.main

        let text = ''
        if (!empty) {
            text = view.state.sliceDoc(from, to)
        } else {
            text = view.state.doc.lineAt(from).text
        }
        confirmAndRun(text)
    }

    function runFullScript() {
        confirmAndRun(activeTabData?.content ?? '')
    }

    async function runExplain(analyze: boolean) {
        if (!activeTabConnection) return
        const text = activeTabData?.content ?? ''
        if (!text.trim()) return

        setShowExplain(true)
        setExplainLoading(true)
        setExplainError('')
        try {
            const plan = await ExplainQuery(activeTabConnection.id, text, analyze)
            setExplainPlan(plan)
        } catch (err) {
            setExplainError(String(err))
        } finally {
            setExplainLoading(false)
        }
    }

    function loadHistory() {
        if (!activeTabConnection) return
        setHistoryLoading(true)
        setHistoryError('')
        ListQueryHistory(activeTabConnection.id, 200)
            .then(setHistoryEntries)
            .catch((err) => setHistoryError(String(err)))
            .finally(() => setHistoryLoading(false))
    }

    function selectBottomTab(tab: 'results' | 'console' | 'history') {
        if (tab === 'history' && activeBottomTab !== 'history') loadHistory()
        setActiveBottomTab(tab)
    }

    async function clearHistory() {
        if (!activeTabConnection) return
        try {
            await ClearQueryHistory(activeTabConnection.id)
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
        if (!queryIdRef.current) return
        if (activeTabConnection?.dbType === 'redis') {
            void CancelRedisCommand(queryIdRef.current)
        } else {
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
        if (!rs || !rs.sourceSql || running || !activeTabConnection) return

        const nextDirection: 'asc' | 'desc' = rs.sortColumn === column && rs.sortDirection === 'asc' ? 'desc' : 'asc'
        const stripped = rs.sourceSql.trim().replace(/;+\s*$/, '')
        const wrapped = `SELECT * FROM (${stripped}) AS mt_sort ORDER BY "${column}" ${nextDirection.toUpperCase()}`

        pendingSortRef.current = {column, direction: nextDirection}
        runText(activeTabConnection, wrapped)
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

    // Double-clicking a table in the sidebar tree always runs against
    // `selected` (the connection whose tree is expanded there), matching
    // the sidebar's own scope — never the active tab's possibly-different
    // binding. If the active tab is ALREADY bound to that same connection,
    // reuse it (matches the old single-connection behavior exactly);
    // otherwise open a new tab bound to it, rather than silently hijacking
    // whatever the user had open in a different pestaña.
    function openTableQuery(table: string, schema?: string) {
        if (!selected) return
        const q = limitQueryFor(selected.dbType, table, schema)
        if (activeTabData?.connId === selected.id) {
            updateActiveTabContent(q)
        } else {
            const tab: EditorTab = {
                id: newTabId(),
                title: 'Query sin título',
                path: null,
                content: q,
                dirty: false,
                connId: selected.id,
                language: languageForDbType(selected.dbType),
                kind: 'editor',
            }
            setTabs((prev) => [...prev, tab])
            setActiveTabId(tab.id)
        }
        runText(selected, q)
    }

    // Opens conn's Redis Browser tab (full-tab key list + editable detail
    // panel, see RedisBrowserTab.tsx) — or focuses it if already open,
    // never duplicates one per connection. Reached from ConnectionTree's
    // dedicated "Abrir en pestaña" button on a Redis connection row.
    function openRedisBrowser(conn: vault.ConnectionSummary) {
        const existing = tabs.find((t) => t.kind === 'redis-browser' && t.connId === conn.id)
        if (existing) {
            setActiveTabId(existing.id)
            return
        }
        const tab: EditorTab = {
            id: newTabId(),
            title: 'Redis Browser',
            path: null,
            content: '',
            dirty: false,
            connId: conn.id,
            language: 'redis-cli',
            kind: 'redis-browser',
        }
        setTabs((prev) => [...prev, tab])
        setActiveTabId(tab.id)
    }

    // Which SSH connIds currently have a live remote session — reported by
    // SshTerminalTab.tsx's onConnectedChange, since a session can drop
    // server-side at any time, not just when the user closes the tab. Drives
    // the real connected/disconnected indicator in the context row below
    // (see isSshTerminalTabActive's usage further down), instead of the
    // generic "is a connection bound to this tab" dot every other tab kind
    // uses.
    const [liveSshConnIds, setLiveSshConnIds] = useState<Set<string>>(new Set())
    function setSshConnected(connId: string, connected: boolean) {
        setLiveSshConnIds((prev) => {
            const next = new Set(prev)
            if (connected) next.add(connId)
            else next.delete(connId)
            return next
        })
    }

    // Opens conn's SSH terminal tab — or focuses it if already open, never
    // duplicates one per connection. Same dedup contract as
    // openRedisBrowser above, reached from ConnectionTree's dedicated
    // "Abrir en pestaña" button on an SSH connection row. language is set
    // to 'sql' purely as a placeholder — SshTerminalTab never reads it,
    // same "unused field" treatment redis-browser tabs give `content`.
    function openSshTerminal(conn: vault.ConnectionSummary) {
        const existing = tabs.find((t) => t.kind === 'ssh-terminal' && t.connId === conn.id)
        if (existing) {
            setActiveTabId(existing.id)
            return
        }
        const tab: EditorTab = {
            id: newTabId(),
            title: `Terminal — ${conn.name}`,
            path: null,
            content: '',
            dirty: false,
            connId: conn.id,
            language: 'sql',
            kind: 'ssh-terminal',
        }
        setTabs((prev) => [...prev, tab])
        setActiveTabId(tab.id)
    }

    // Opens (or focuses) the dual-pane SFTP explorer for a host. One tab per
    // connId, same dedupe as openSshTerminal — the launched host seeds one
    // pane (the other starts Local), but either pane can be switched to any
    // host afterwards, so a single tab already covers remote↔remote too.
    function openSftp(conn: vault.ConnectionSummary) {
        const existing = tabs.find((t) => t.kind === 'sftp' && t.connId === conn.id)
        if (existing) {
            setActiveTabId(existing.id)
            return
        }
        const tab: EditorTab = {
            id: newTabId(),
            title: `SFTP — ${conn.name}`,
            path: null,
            content: '',
            dirty: false,
            connId: conn.id,
            language: 'sql',
            kind: 'sftp',
        }
        setTabs((prev) => [...prev, tab])
        setActiveTabId(tab.id)
    }

    // Double-clicking a key in the sidebar's inline RedisKeyTree used to
    // open a read-only modal (RedisValueInspector) — now it opens/focuses
    // that connection's Redis Browser tab with the key pre-selected in the
    // (editable) detail panel instead, see pendingBrowserKey above.
    function openRedisKeyDetail(connId: string, key: string) {
        const conn = connections.find((c) => c.id === connId)
        if (!conn) return
        pendingBrowserKeyTokenRef.current += 1
        setPendingBrowserKey({connId, key, token: pendingBrowserKeyTokenRef.current})
        openRedisBrowser(conn)
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
    // deleting it) — if it's the sidebar's selected one, also clears that so
    // the tree stops showing a stale table list. Reconnecting just means
    // selecting it again. Tabs bound to this connection are untouched — a
    // disconnect is not a delete, the binding (and the pool, lazily) comes
    // back on the next run.
    async function disconnectConnection(connId: string) {
        try {
            await DisconnectConnection(connId)
            if (selected?.id === connId) {
                setSelected(null)
            }
            setStatusMessage('Desconectado')
        } catch (err) {
            setStatusMessage(String(err))
        }
    }

    // Deletes the saved connection permanently. Any editor tab bound to it
    // loses ONLY the binding (connId → null) — its path/content/dirty state
    // is never touched, matching the "eliminar conexión no borra el
    // archivo" requirement. The tab falls back to showing as unbound, same
    // as if the user had never linked it.
    async function deleteConnection(connId: string) {
        try {
            await DeleteConnection(connId)
            setReloadToken((n) => n + 1)
            if (selected?.id === connId) setSelected(null)
            setTabs((prev) => prev.map((t) => (t.connId === connId ? {...t, connId: null} : t)))
            setStatusMessage('Conexión eliminada')
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
            // Fixed bug: this used to hardcode 'public' regardless of which
            // schema was actually expanded/active in the sidebar tree —
            // sidebarActiveSchema is the real value (falls back to
            // 'public' only when nothing is active yet, same default the
            // hardcode used to be).
            const dest = await ExportSchemaDDL(selected.id, sidebarActiveSchema || 'public')
            setStatusMessage(dest ? `DDL del schema exportado a ${dest}` : '')
        } catch (err) {
            setStatusMessage(String(err))
        }
    }

    // Best-effort: a project-docs generation failure should never block
    // opening/saving a file, so errors are swallowed here. Scoped to the
    // ACTIVE TAB's connection — CLAUDE.md documents whatever database the
    // file you're editing is meant to run against.
    function generateProjectDocsFor(path: string) {
        if (!activeTabConnection) return
        const dir = dirName(path)
        GenerateProjectDocs(dir, activeTabConnection.id, editorActiveSchema ?? '')
            .then((wrote) => {
                if (wrote) {
                    setStatusMessage(
                        editorActiveSchema
                            ? `CLAUDE.md generado en ${dir} (esquema ${editorActiveSchema})`
                            : `CLAUDE.md generado en ${dir}`,
                    )
                }
            })
            .catch(() => {})
    }

    function openTabForFile(path: string, content: string) {
        setTabs((prev) => {
            const existing = prev.find((t) => t.path === path)
            if (existing) {
                setActiveTabId(existing.id)
                return prev.map((t) => (t.id === existing.id ? {...t, content, dirty: false} : t))
            }
            const tab: EditorTab = {id: newTabId(), title: fileTitle(path), path, content, dirty: false, connId: null, language: 'sql', kind: 'editor'}
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
    // on openTabsKey (above) picks up the new order automatically, same as
    // it already does for opening/closing tabs.
    function reorderTabs(next: EditorTab[]) {
        setTabs(next)
    }

    function closeTab(id: string) {
        setTabs((prev) => {
            // Closing a redis-browser/ssh-terminal tab disconnects its
            // underlying connection — never leave a live SSH shell or an
            // open Redis pool behind just because the tab is gone. Doesn't
            // touch the saved connection itself, same as the sidebar's own
            // "Desconectar" — reconnecting just means reopening the tab.
            const closing = prev.find((t) => t.id === id)
            if (closing?.kind === 'ssh-terminal' && closing.connId) {
                closeSshTerminalSession(closing.connId)
            }
            if (closing?.kind === 'redis-browser' && closing.connId) {
                void DisconnectConnection(closing.connId)
            }
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
    }, [activeTabConnection])

    const activeResult = resultSets[activeResultTab]
    const isSqlActive = !!activeTabConnection && activeTabConnection.dbType !== 'redis' && activeTabConnection.dbType !== 'ssh'
    const isRedisActive = activeTabConnection?.dbType === 'redis'
    const isBrowserTabActive = activeTabData?.kind === 'redis-browser'
    const isSshTerminalTabActive = activeTabData?.kind === 'ssh-terminal'
    const isSftpTabActive = activeTabData?.kind === 'sftp'

    return (
        <div className="flex h-screen w-screen overflow-hidden bg-background font-sans text-on-background">
            <ConnectionTree
                selectedId={selected?.id ?? null}
                onSelect={setSelected}
                onNewConnection={() => setConnectionDialog('new')}
                onEditConnection={(conn) => setConnectionDialog(conn.id)}
                reloadToken={reloadToken}
                metadata={sidebarMetadata}
                schemas={sidebarSchemas}
                activeSchema={sidebarActiveSchema}
                onSelectSchema={(schema) => selected && setActiveSchemaByConn((prev) => ({...prev, [selected.id]: schema}))}
                onSyncSchema={syncSchema}
                metadataLoading={sidebarMetadataLoading}
                onOpenTable={openTableQuery}
                onOpenObjectDDL={(connId, params) => setDdlViewer({connId, ...params})}
                onOpenRedisKey={openRedisKeyDetail}
                onOpenRedisBrowser={openRedisBrowser}
                activeTabConnectionId={activeTabConnection?.id ?? null}
                onExportConnectionConfig={(connId) => void exportConnectionConfig(connId)}
                onExportTableDDL={(table, schema) => void exportTableDDL(table, schema)}
                onExportSchemaDDL={() => void exportSchemaDDL()}
                onDisconnect={(connId) => void disconnectConnection(connId)}
                onDeleteConnection={(connId) => void deleteConnection(connId)}
                onConfigureSchemas={setSchemaPickerConn}
                collapsed={sidebarCollapsed}
                onToggleCollapsed={toggleSidebarCollapsed}
                folders={folders}
                moduleCollapsed={collapsedModules.has('connections')}
                onToggleModuleCollapsed={() => toggleModuleCollapsed('connections')}
                onCreateFolder={(name, parentId) => createFolder(name, parentId, 'db')}
                onRenameFolder={renameFolder}
                onDeleteFolder={deleteFolder}
                onReorderFolder={reorderFolder}
                onMoveConnectionToFolder={moveConnectionToFolder}
                extraModules={
                    <SshConnectionTree
                        onNewConnection={() => setConnectionDialog('new-ssh')}
                        onEditConnection={(conn) => setConnectionDialog(conn.id)}
                        onOpenSshTerminal={openSshTerminal}
                        onOpenSftp={openSftp}
                        activeTabConnectionId={activeTabConnection?.id ?? null}
                        onExportConnectionConfig={(connId) => void exportConnectionConfig(connId)}
                        onDisconnect={(connId) => void disconnectConnection(connId)}
                        onDeleteConnection={(connId) => void deleteConnection(connId)}
                        reloadToken={reloadToken}
                        moduleCollapsed={collapsedModules.has('ssh-connections')}
                        onToggleModuleCollapsed={() => toggleModuleCollapsed('ssh-connections')}
                        folders={folders}
                        onCreateFolder={(name, parentId) => createFolder(name, parentId, 'ssh')}
                        onRenameFolder={renameFolder}
                        onDeleteFolder={deleteFolder}
                        onReorderFolder={reorderFolder}
                        onMoveConnectionToFolder={moveConnectionToFolder}
                    />
                }
            />

            {ddlViewer && (
                <DDLViewerModal
                    connId={ddlViewer.connId}
                    objectType={ddlViewer.objectType}
                    schema={ddlViewer.schema}
                    name={ddlViewer.name}
                    oid={ddlViewer.oid}
                    dbType={connections.find((c) => c.id === ddlViewer.connId)?.dbType ?? ''}
                    editorThemeId={editorThemeId}
                    appTheme={theme}
                    onClose={() => setDdlViewer(null)}
                />
            )}

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
                {/* Tab strip goes FIRST, above the toolbar — its position
                    must stay fixed regardless of which tab is active. The
                    toolbar below it grows/shrinks (isSqlActive/
                    isBrowserTabActive/isSshTerminalTabActive show or hide
                    whole rows of buttons depending on the active tab's
                    connection), and used to sit ABOVE the tab strip: every
                    connection bind/unbind that changed the toolbar's height
                    (flex-wrap kicking in as buttons appeared) visibly shoved
                    the tabs up/down with it. Real bug, reported live. */}
                <EditorTabs
                    tabs={tabs}
                    activeId={activeTabId}
                    connections={connections}
                    onSelect={setActiveTabId}
                    onClose={closeTab}
                    onNew={newTab}
                    onReorder={reorderTabs}
                    onChangeTabConnection={changeTabConnection}
                    onChangeTabLanguage={changeTabLanguage}
                    onOpenFile={() => void openFileDialog()}
                    onOpenRecentFile={(path) => void openRecentFile(path)}
                />

                <div className="flex flex-col border-b border-outline-variant bg-surface">
                    {/* Context row: which connection/schema/transaction state
                        the ACTIVE TAB is bound to. Kept separate from the
                        actions row below so neither crowds the other. Each
                        cluster (connection, schema, transaction, DBMS_OUTPUT)
                        is its own pill/chip instead of one flat run of
                        same-weight text+controls — makes the transaction
                        cluster in particular easy to spot at a glance
                        (tinted when a transaction is actually open, the
                        state that most needs to catch your eye). */}
                    <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-surface-container-high px-2.5 py-1 text-xs text-on-surface-variant">
                            {isSshTerminalTabActive && activeTabConnection ? (
                                <>
                                    <span
                                        className={`h-2 w-2 shrink-0 rounded-full ${
                                            liveSshConnIds.has(activeTabConnection.id) ? 'bg-secondary' : 'bg-error'
                                        }`}
                                    />
                                    {activeTabConnection.name} —{' '}
                                    {liveSshConnIds.has(activeTabConnection.id) ? 'conectado' : 'desconectado'}
                                </>
                            ) : (
                                <>
                                    <span
                                        className={`h-2 w-2 shrink-0 rounded-full ${activeTabConnection ? 'bg-secondary' : 'bg-outline'}`}
                                    />
                                    {activeTabConnection
                                        ? `Pestaña vinculada a: ${activeTabConnection.name}`
                                        : 'Pestaña sin conexión — vincularla con el ícono a la izquierda del título'}
                                </>
                            )}
                        </span>

                        {activeTabConnection && editorMetadataLoading && (
                            <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-surface-container-high px-2.5 py-1 text-xs text-on-surface-variant">
                                <span
                                    aria-hidden
                                    className="h-3 w-3 animate-spin rounded-full border-2 border-t-transparent border-primary"
                                />
                                Cargando esquema…
                            </span>
                        )}

                        {!editorMetadataLoading && editorSchemas.length > 0 && (
                            <label className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-surface-container-high py-1 pl-2.5 pr-1.5 text-xs text-on-surface-variant">
                                Schema:
                                <select
                                    value={editorActiveSchema ?? ''}
                                    onChange={(e) =>
                                        activeTabConnection &&
                                        setActiveSchemaByConn((prev) => ({...prev, [activeTabConnection.id]: e.target.value}))
                                    }
                                    className="rounded border-none bg-surface-container-highest px-1.5 py-0.5 text-xs text-on-surface outline-none"
                                >
                                    {editorSchemas.map((s) => (
                                        <option key={s} value={s}>
                                            {s}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        )}

                        {isSqlActive && (
                            <div
                                className={`inline-flex items-center gap-2 whitespace-nowrap rounded-full py-1 pl-2.5 pr-1.5 ${
                                    txOpen ? 'bg-tertiary-container' : 'bg-surface-container-high'
                                }`}
                            >
                                <label
                                    className={`flex items-center gap-1.5 text-xs ${txOpen ? 'text-on-tertiary-container' : 'text-on-surface-variant'}`}
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
                                    className="flex items-center gap-1 rounded-full bg-secondary-container px-2 py-0.5 text-xs font-medium text-on-secondary-container hover:opacity-90 disabled:opacity-40"
                                >
                                    <Icon name="check_circle" size={14} />
                                    Commit
                                </button>
                                <button
                                    onClick={() => void rollbackTransaction()}
                                    disabled={!txOpen || txBusy}
                                    title="Descarta todos los cambios pendientes de la transacción actual y vuelve al estado antes de abrirla"
                                    className="flex items-center gap-1 rounded-full bg-error-container px-2 py-0.5 text-xs font-medium text-on-error-container hover:opacity-90 disabled:opacity-40"
                                >
                                    <Icon name="undo" size={14} />
                                    Rollback
                                </button>
                                {txOpen && (
                                    <span className="flex items-center gap-1 whitespace-nowrap text-xs font-medium text-on-tertiary-container">
                                        <Icon name="warning" size={14} />
                                        Transacción abierta
                                    </span>
                                )}
                            </div>
                        )}

                        {isSqlActive && activeTabConnection?.dbType === 'oracle' && (
                            <label
                                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-surface-container-high px-2.5 py-1 text-xs text-on-surface-variant"
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

                    {/* Actions row: save, then the primary run cluster
                        (visually heavier — bg-secondary-container/
                        bg-error-container — so Ejecutar/Bloque/Cancelar
                        read as the main thing this row is for), then
                        diagnostic/schema utilities — grouped with dividers
                        so the eye can parse clusters instead of one long run
                        of same-looking buttons. "Abrir"/"Recientes" live in
                        the tab strip above instead (EditorTabs.tsx) — they
                        open/reopen a FILE, a global action, not something
                        scoped to whichever tab happens to be active right
                        now. "Regenerar CLAUDE.md" was removed outright
                        (unused in practice) — CLAUDE.md still generates
                        automatically on open/save, see
                        generateProjectDocsFor. Hidden entirely for
                        redis-browser/ssh-terminal tabs — none of these
                        (save a .sql file, run a query) apply to either
                        (their `content`/`path` fields are unused
                        placeholders, see EditorTab's doc comment). The
                        context row above stays visible either way —
                        connection status and Settings/theme are still
                        meaningful regardless of which tab kind is active. */}
                    {!isBrowserTabActive && !isSshTerminalTabActive && !isSftpTabActive && (
                    <div className="flex flex-wrap items-center gap-1 border-t border-outline-variant px-2 py-2">
                        <button
                            onClick={() => void saveActiveTab()}
                            title="Guarda el contenido de la pestaña activa en disco (atajo: Ctrl+S). Si es una pestaña nueva, te pide dónde guardarla"
                            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-on-surface-variant transition-colors hover:bg-surface-variant"
                        >
                            <Icon name="save" size={16} />
                            Guardar
                            <span className="font-normal opacity-60">Ctrl+S</span>
                        </button>

                        <Divider />

                        <button
                            onClick={runSelectionOrLine}
                            disabled={!activeTabConnection || running}
                            title="Ejecuta el texto seleccionado, o si no hay selección, la línea donde está el cursor (atajo: Ctrl+Enter)"
                            className="flex items-center gap-1.5 rounded-md bg-secondary-container px-3 py-1.5 text-xs font-semibold text-on-secondary-container transition-colors hover:opacity-90 disabled:opacity-50"
                        >
                            <Icon name="play_arrow" size={16} filled />
                            Ejecutar
                            <span className="font-normal opacity-60">Ctrl+Enter</span>
                        </button>
                        <button
                            onClick={runFullScript}
                            disabled={!activeTabConnection || running}
                            title="Ejecuta todos los statements del editor en orden, uno por uno (atajo: Ctrl+Shift+Enter)"
                            className="flex items-center gap-1.5 rounded-md bg-secondary-container px-3 py-1.5 text-xs font-medium text-on-secondary-container transition-colors hover:opacity-90 disabled:opacity-50"
                        >
                            <Icon name="playlist_play" size={16} />
                            Bloque
                            <span className="font-normal opacity-60">Ctrl+Shift+Enter</span>
                        </button>
                        <button
                            onClick={cancelQuery}
                            disabled={!running}
                            title="Interrumpe la consulta que está corriendo ahora mismo"
                            className="flex items-center gap-1.5 rounded-md bg-error-container px-3 py-1.5 text-xs font-medium text-on-error-container transition-colors hover:opacity-90 disabled:opacity-40"
                        >
                            <Icon name="stop" size={16} filled />
                            Cancelar
                        </button>
                        {isSqlActive && (
                            <>
                                <Divider />

                                <button
                                    onClick={() => void runExplain(false)}
                                    disabled={!activeTabConnection}
                                    title="Muestra el plan de ejecución del query (EXPLAIN) sin correrlo — útil para diagnosticar lentitud sin afectar datos"
                                    className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-on-surface-variant transition-colors hover:bg-surface-variant disabled:opacity-50"
                                >
                                    <Icon name="query_stats" size={16} />
                                    Explain
                                </button>
                                <button
                                    onClick={() => void runExplain(true)}
                                    disabled={!activeTabConnection}
                                    title="Ejecuta el query de verdad y muestra el plan con tiempos reales (EXPLAIN ANALYZE) — a diferencia de Explain, sí corre el query"
                                    className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-on-surface-variant transition-colors hover:bg-surface-variant disabled:opacity-50"
                                >
                                    <Icon name="analytics" size={16} />
                                    Explain Analyze
                                </button>

                                <Divider />

                                <button
                                    onClick={refreshMetadata}
                                    disabled={!activeTabConnection}
                                    title="Vuelve a leer las tablas y columnas de la base de datos (atajo: F5) — usalo si acabás de crear/alterar una tabla"
                                    className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-on-surface-variant transition-colors hover:bg-surface-variant disabled:opacity-50"
                                >
                                    <Icon name="refresh" size={16} />
                                    Refrescar
                                    <span className="font-normal opacity-60">F5</span>
                                </button>
                            </>
                        )}
                    </div>
                    )}
                </div>

                <div
                    className="min-w-0 border-b border-outline-variant"
                    style={{height: editorHeight, display: isBrowserTabActive || isSshTerminalTabActive || isSftpTabActive ? 'none' : undefined}}
                >
                    {/* Always mounted, even behind a Redis Browser tab —
                        CodeMirrorTabbedEditor caches every other open
                        tab's EditorState/undo history in a ref that only
                        survives while it stays mounted. Unmounting it
                        conditionally would lose that state the moment the
                        user switches back from a browser tab. */}
                    <CodeMirrorTabbedEditor
                        tabs={tabs}
                        activeTabId={activeTabId}
                        onChangeContent={(tabId, content) =>
                            setTabs((prev) => prev.map((t) => (t.id === tabId ? {...t, content, dirty: true} : t)))
                        }
                        onMount={(view) => {
                            editorRef.current = view
                        }}
                        dbType={activeTabConnection?.dbType ?? null}
                        schemaMetadata={filteredEditorMetadata}
                        editorThemeId={editorThemeId}
                        appTheme={theme}
                    />
                </div>

                {/* Every open Redis Browser tab stays mounted (hidden via
                    CSS unless active), same "never unmount, just hide"
                    principle as CodeMirrorTabbedEditor above — otherwise
                    switching to another tab and back would lose the
                    selected key / checked keys / any in-progress inline
                    edit every single time. At most one tab per connId
                    exists (see openRedisBrowser's dedupe), so
                    pendingBrowserKey never targets more than one of these. */}
                {tabs
                    .filter((t) => t.kind === 'redis-browser' && t.connId)
                    .map((t) => (
                        <div
                            key={t.id}
                            className="flex min-h-0 flex-1 overflow-hidden"
                            style={{display: activeTabId === t.id ? undefined : 'none'}}
                        >
                            <RedisBrowserTab
                                connId={t.connId as string}
                                initialKey={pendingBrowserKey?.connId === t.connId ? pendingBrowserKey.key : undefined}
                                initialKeyToken={pendingBrowserKey?.token}
                            />
                        </div>
                    ))}

                {/* Same "never unmount, just hide" treatment as Redis
                    Browser tabs above — each open terminal keeps its own
                    xterm.js Terminal instance (and the live remote shell
                    behind it) alive while its tab isn't focused, so
                    scrollback/cursor state survives switching away and back.
                    At most one tab per connId exists (see openSshTerminal's
                    dedupe). */}
                {tabs
                    .filter((t) => t.kind === 'ssh-terminal' && t.connId)
                    .map((t) => (
                        <div
                            key={t.id}
                            className="flex min-h-0 flex-1 overflow-hidden"
                            style={{display: activeTabId === t.id ? undefined : 'none'}}
                        >
                            <SshTerminalTab
                                connId={t.connId as string}
                                theme={theme}
                                terminalThemeId={terminalThemeId}
                                onChangeTerminalTheme={changeTerminalTheme}
                                onConnectedChange={(connected) => setSshConnected(t.connId as string, connected)}
                            />
                        </div>
                    ))}

                {/* Same "never unmount, just hide" treatment as the SSH
                    terminal / Redis Browser tabs above — each SFTP explorer
                    keeps its two browse sessions and any in-flight transfers
                    alive while its tab isn't focused. Its own unmount cleanup
                    (when the tab is closed) tears down the sessions and cancels
                    transfers, so there is no closeTab branch to add here. */}
                {tabs
                    .filter((t) => t.kind === 'sftp' && t.connId)
                    .map((t) => (
                        <div
                            key={t.id}
                            className="flex min-h-0 flex-1 overflow-hidden"
                            style={{display: activeTabId === t.id ? undefined : 'none'}}
                        >
                            <SftpTab
                                tabId={t.id}
                                initialConnId={t.connId as string}
                                connections={connections.filter((c) => c.dbType === 'ssh')}
                            />
                        </div>
                    ))}

                {!isBrowserTabActive && !isSshTerminalTabActive && !isSftpTabActive && (
                    <>
                        {/* Drag handle: resizes the editor pane against the
                            results grid below. Persisted on mouseup, see
                            startEditorResize. */}
                        <div
                            onMouseDown={startEditorResize}
                            title="Arrastrar para cambiar el alto del editor — el tamaño queda guardado"
                            className="group flex h-1.5 shrink-0 cursor-row-resize items-center justify-center bg-surface-container-low hover:bg-primary/30"
                        >
                            <div className="h-0.5 w-8 rounded-full bg-outline-variant group-hover:bg-primary" />
                        </div>

                        {/* "Resultados"/"Consola"/"Historial" — tabs sharing
                            this bottom panel, same visual pattern as
                            EditorTabs above, instead of docked panels
                            stacked on top of each other. "Consola" is SQL-
                            only (redisqueries already get their own
                            transcript-style view, RedisResultView) — hidden
                            for a Redis-bound tab instead of always shown but
                            perpetually empty. */}
                        <div className="flex items-center gap-1 border-b border-outline-variant bg-surface-container px-2 pt-1">
                            <button
                                onClick={() => selectBottomTab('results')}
                                title="Resultado de la última ejecución — el ícono de terminal indica que algún statement generó DBMS_OUTPUT (PL/SQL Oracle), aunque estés viendo otra pestaña"
                                className={`flex items-center gap-1.5 rounded-t-xs px-3 py-1 text-xs ${
                                    activeBottomTab === 'results'
                                        ? 'bg-surface text-on-surface'
                                        : 'text-on-surface-variant hover:text-on-surface'
                                }`}
                            >
                                <Icon name="table_chart" size={14} className="opacity-70" />
                                Resultados
                                {resultSets.some((r) => r.dbmsOutput.length > 0) && (
                                    <Icon name="terminal" size={14} className="text-primary" filled />
                                )}
                            </button>
                            {!isRedisActive && (
                                <button
                                    onClick={() => selectBottomTab('console')}
                                    title="Consola de ejecución: cada statement del último script corrido, con su texto completo y si terminó OK (con duración) o con error — como el output de un cliente SQL de escritorio"
                                    className={`flex items-center gap-1.5 rounded-t-xs px-3 py-1 text-xs ${
                                        activeBottomTab === 'console'
                                            ? 'bg-surface text-on-surface'
                                            : 'text-on-surface-variant hover:text-on-surface'
                                    }`}
                                >
                                    <Icon name="terminal" size={14} className="opacity-70" />
                                    Consola
                                    {consoleLog.some((e) => e.status === 'error') && (
                                        <Icon name="error" size={14} className="text-error" filled />
                                    )}
                                </button>
                            )}
                            <button
                                onClick={() => selectBottomTab('history')}
                                title="Historial de ejecuciones de la conexión vinculada a esta pestaña — SQL/comando exacto enviado, estado y mensaje de error completo por cada uno"
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
                    isRedisActive ? (
                        <RedisResultView results={redisResults} />
                    ) : (
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
                                    tableNameHint={activeTabConnection?.name}
                                />
                            </div>

                            <ResultGrid
                                columns={activeResult?.columns ?? []}
                                rows={activeResult?.rows ?? []}
                                sortColumn={activeResult?.sortColumn}
                                sortDirection={activeResult?.sortDirection}
                                onSort={sortActiveResult}
                                tableNameHint={activeTabConnection?.name}
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
                    )
                ) : activeBottomTab === 'console' ? (
                    <ExecutionConsole entries={consoleLog} running={running} onClear={() => setConsoleLog([])} />
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
                    {!isRedisActive && activeResult?.status === 'done' && (
                        <span className="shrink-0">
                            {activeResult.rowsAffected} filas · {activeResult.durationMs}ms
                        </span>
                    )}
                    {!isRedisActive && activeResult?.status === 'cancelled' && (
                        <span className="shrink-0 text-tertiary">Cancelada</span>
                    )}
                    {!isRedisActive && activeResult?.status === 'error' && (
                        <span className="min-w-0 flex-1 truncate text-error" title={activeResult.error}>
                            {activeResult.error}
                        </span>
                    )}
                </div>
                    </>
                )}
            </div>

            {connectionDialog && (
                <Suspense fallback={null}>
                    <ConnectionDialog
                        editingId={connectionDialog === 'new' || connectionDialog === 'new-ssh' ? null : connectionDialog}
                        initialDbType={connectionDialog === 'new-ssh' ? 'ssh' : undefined}
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
                        editorThemeId={editorThemeId}
                        onChangeEditorThemeId={changeEditorTheme}
                        onBackupVault={() => {
                            setShowSettingsDialog(false)
                            setShowBackupPasswordDialog(true)
                        }}
                        onRestoreVault={() => {
                            setShowSettingsDialog(false)
                            setShowRestoreDialog(true)
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

            {showRestoreDialog && (
                <RestoreVaultDialog onRestored={onLocked} onClose={() => setShowRestoreDialog(false)} />
            )}

            {pendingRedisCommandRun && activeTabConnection && (
                <ConfirmDialog
                    title="Comando destructivo"
                    description="Este script incluye FLUSHALL/FLUSHDB, que borra datos de Redis de forma irreversible. ¿Ejecutar de todas formas?"
                    confirmLabel="Ejecutar"
                    danger
                    onConfirm={() => runRedisText(activeTabConnection, pendingRedisCommandRun)}
                    onClose={() => setPendingRedisCommandRun(null)}
                />
            )}
        </div>
    )
}
