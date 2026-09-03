import {lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode} from 'react'
import ConnectionTree from './sidebar/ConnectionTree'
import DbmsOutputPanel from './results/DbmsOutputPanel'
import SshConnectionTree from './sidebar/SshConnectionTree'
import ConfirmDialog from './ConfirmDialog'
import DDLViewerModal, {type DDLObjectType} from './DDLViewerModal'
import DbTypeIcon, {dbTypeLabel} from './DbTypeIcon'
import Icon from './Icon'
import Select from './Select'
import PasswordConfirmDialog from './PasswordConfirmDialog'
import RestoreVaultDialog from './RestoreVaultDialog'
import ResultGrid from './results/ResultGrid'
import ResultTabs from './results/ResultTabs'
import ExecutionConsole, {ConsoleLogEntry} from './results/ExecutionConsole'
import ExportMenu from './results/ExportMenu'
import {useSqlTarget} from './results/useSqlTarget'
import RedisResultView, {RedisCommandResult} from './results/RedisResultView'
import MongoResultView, {MongoCommandResult} from './results/MongoResultView'
import EditorTabs, {EditorTab, TabLanguage} from './editor/EditorTabs'
import CodeMirrorTabbedEditor from './editor/CodeMirrorTabbedEditor'
import NlPromptBar from './editor/NlPromptBar'
import NotesTree from './notes/NotesTree'
import NoteEditorTab from './notes/NoteEditorTab'
import HttpTree from './http/HttpTree'
import HttpRequestTab from './http/HttpRequestTab'
import NotesGraphView from './notes/NotesGraphView'
import RedisBrowserTab from './redis/RedisBrowserTab'
import MongoBrowserTab from './mongo/MongoBrowserTab'
import MongoFindWizard from './mongo/MongoFindWizard'
import SshTerminalTab, {closeSshTerminalSession} from './ssh/SshTerminalTab'
import SshHybridTab from './ssh/SshHybridTab'
import SftpTab from './sftp/SftpTab'
import type {PaneHost} from './sftp/types'
import GitErrorBoundary from './git/GitErrorBoundary'
import GitRepoTab from './git/GitRepoTab'
import AgentChatHost, {AgentChatButton, type AgentDock} from './agent/AgentChatHost'
import LocalTerminalTab from './terminal/LocalTerminalTab'
import {NO_CONTEXT, type WorkContext} from './agent/workContext'
import GitRepoTree from './git/GitRepoTree'
import type {TerminalThemeId} from '../xterm/terminalThemes'
import {TERMINAL_FONT_MAX, TERMINAL_FONT_MIN} from '../xterm/terminalFont'
import {
    ActiveConnectionIds,
    BackupVault,
    BeginTransaction,
    CancelMongoQuery,
    CancelQuery,
    CancelRedisCommand,
    CommitTransaction,
    CreateFolder,
    DeleteConnection,
    DeleteFolder,
    DetectQueryParams,
    DisconnectConnection,
    ExecuteMongoQuery,
    ExecuteQuery,
    FetchMoreRows,
    SetQueryPageSize,
    ExecuteRedisCommand,
    CheckSQLMutation,
    ExplainQuery,
    ReadSftpFileForEdit,
    WriteSftpFileFromEdit,
    ExportConnectionConfig,
    ExportSchemaDDL,
    GetMongoDefaultDatabase,
    ListMongoCollections,
    ListMongoDatabases,
    GetSchemaIndexStatus,
    GetSchemaMetadata,
    CreateNote,
    GetNote,
    GetSettings,
    SetAgentLayout,
    SetNotesLastOpen,
    HasOpenTransaction,
    ListConnections,
    ListFolders,
    GitMoveRepoToFolder,
    MoveConnectionToFolder,
    OpenSQLFileDialog,
    OpenSQLFilePath,
    PickAutoBackupFolder,
    RenameFolder,
    ReorderFolder,
    RollbackTransaction,
    SaveSQLFile,
    SaveSQLFileAs,
    SetAutoBackupEnabled,
    SetAutoBackupIntervalHours,
    SetAutoSaveEnabled,
    SetAutoSaveIntervalSeconds,
    SetSidebarModule,
    SetSidebarWidth,
    SetEditorHeight,
    SetEditorAppearance,
    SetEditorTheme,
    SetOpenTabs,
    SetRememberMasterKey,
    SetSidebarCollapsed,
    SetLocalShell,
    SetSshTerminalTheme,
    SetTerminalFontSize,
    SyncSchemaMetadata,
} from '../../wailsjs/go/main/App'
import {BrowserOpenURL, EventsOn} from '../../wailsjs/runtime'
import {db, explain, updatecheck, vault} from '../../wailsjs/go/models'
import type {query} from '../../wailsjs/go/models'
import type {ParamDraftMap} from './editor/QueryParamsDialog'
import Sidebar from './sidebar/Sidebar'
import type {SidebarModuleId} from './sidebar/SidebarMasterMenu'
import {DEFAULT_EDITOR_APPEARANCE, editorAppearanceFromSettings, type EditorAppearance} from '../codemirror/editorAppearance'
import type {EditorView} from '@codemirror/view'
import {statementAt} from '../lib/sqlStatementAt'
import {lintSQL} from '../lib/linter'
import {inspectSQL} from '../lib/sqlProductionGuard'
import {lintRedisCommands} from '../lib/redisLinter'
import {lintMongoCommands} from '../lib/mongoLinter'
import {setActiveMongoCollections} from '../codemirror/mongoCollectionsStore'
import type {Theme} from '../hooks/useTheme'

// Lazy: both are only mounted once the user opens them (showDialog /
// showExplain), so they don't need to be in the initial bundle — unlike
// the editor itself, which the workspace needs immediately and can't defer.
const ConnectionDialog = lazy(() => import('./connections/ConnectionDialog'))
const ExplainPlanPanel = lazy(() => import('./explain/ExplainPlanPanel'))
const SchemaPickerDialog = lazy(() => import('./connections/SchemaPickerDialog'))
const SettingsDialog = lazy(() => import('./SettingsDialog'))
const QueryParamsDialog = lazy(() => import('./editor/QueryParamsDialog'))

interface QueryEvent {
    type: 'columns' | 'rows' | 'page' | 'done' | 'cancelled' | 'error'
    statementIndex: number
    totalStatements: number
    sqlText?: string
    columns?: string[]
    rows?: unknown[][]
    rowsAffected?: number
    durationMs?: number
    error?: string
    dbmsOutput?: string[]
    // Aclaración para un evento terminal que no es ni éxito ni error común:
    // hoy, "este statement era un comando de cliente SQL*Plus y se omitió"
    // (ver backend/query/executor.go).
    note?: string
    // Llega en 'done' y 'page': quedan filas sin traer y FetchMoreRows(queryId)
    // entrega la próxima página (ver backend/query/paging.go).
    hasMore?: boolean
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

// Mirrors backend/mongoquery.Event's JSON shape (see runMongoText below).
interface MongoQueryEvent {
    type: 'done' | 'cancelled' | 'error'
    commandIndex: number
    totalCommands: number
    commandText?: string
    documents?: string[]
    summary?: string
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
    note: string
    sourceSql: string
    sortColumn: string | null
    sortDirection: 'asc' | 'desc' | null
    // hasMore: el backend dejó el cursor abierto porque quedan filas (ver
    // backend/query/paging.go). loadingMore: hay un FetchMore en vuelo.
    hasMore: boolean
    loadingMore: boolean
}

// Ceiling for the running console history — see the setConsoleLog cap.
const MAX_CONSOLE_ENTRIES = 500

function emptyResultSet(): ResultSet {
    return {
        columns: [], rows: [], status: 'running', rowsAffected: 0, durationMs: 0, error: '', dbmsOutput: [], note: '',
        sourceSql: '', sortColumn: null, sortDirection: null, hasMore: false, loadingMore: false,
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

function languageForDbType(dbType: string): TabLanguage {
    if (dbType === 'redis') return 'redis-cli'
    if (dbType === 'mongodb') return 'mongosh'
    return 'sql'
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

// Clases de la barra de acciones del editor.
//
// La barra tenía DOS botones rellenos en verde (Ejecutar y Bloque) más uno
// rojo permanente (Cancelar, que casi siempre está deshabilitado) y uno con
// borde y fondo naranja (Explain Analyze). Cuatro botones gritando a la vez
// es lo mismo que ninguno gritando: nada dice cuál es la acción principal, y
// el rojo de un Cancelar que no se puede tocar y el naranja de un botón que
// todavía no hiciste nada mal son alarmas que no corresponden a ningún
// estado real.
//
// Ahora hay UNA acción rellena —Ejecutar— y todo lo demás es plano, con el
// color reservado para cuando significa algo: Cancelar se tiñe de error solo
// mientras hay algo corriendo, y Explain Analyze marca en tertiary la única
// palabra que importa ("ejecuta"), sin caja ni borde alrededor.
const TOOLBAR_BTN = 'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-40'
const TOOLBAR_GHOST = `${TOOLBAR_BTN} text-on-surface-variant hover:bg-surface-variant hover:text-on-surface`

// Botón de la barra de herramientas SIN rótulo: un cuadrado con el ícono
// centrado, y toda la explicación —incluido el atajo de teclado— en el
// tooltip.
//
// Es la forma por defecto de la barra. Con nueve controles, el rótulo al lado
// de cada glifo convertía la fila en un renglón de texto que hay que leer
// entero para encontrar el botón que se busca, y repetía lo que el tooltip ya
// dice completo. El área de 28px es la misma que la de un botón con texto, así
// que sacar la palabra no achica el blanco al que hay que apuntar.
const TOOLBAR_ICON = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-40'
// Mismo botón, pero para un INTERRUPTOR encendido (auto-commit, DBMS_OUTPUT):
// teñido de primary, que es el único estado que hay que poder leer de reojo.
const TOOLBAR_ICON_ON = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary transition-colors hover:bg-primary/25 disabled:opacity-40'

// LIMIT/FETCH syntax differs per engine — spec: "doble click tabla en árbol
// → SELECT * LIMIT 100 auto". Schema-qualified when the table came from a
// non-default Postgres schema, so it resolves correctly regardless of the
// connection's search_path.
function limitQueryFor(dbType: string, table: string, schema?: string): string {
    const qualified = schema ? `${schema}.${table}` : table
    if (dbType === 'oracle') {
        return `SELECT * FROM ${qualified} WHERE ROWNUM <= 100`
    }
    if (dbType === 'sqlserver') {
        return `SELECT TOP 100 * FROM ${qualified}`
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
    // Result of App.tsx's one-per-session CheckForUpdate call — null while
    // still pending or if the check failed/found nothing newer. Passed down
    // instead of checked here because Workspace unmounts on every lock, so
    // "check once" only means once per process if it lives in App.tsx.
    updateInfo: updatecheck.Info | null
    // Tamaño de letra de la interfaz, en porcentaje. Vive en App.tsx (ver
    // useUIFontScale) para que valga también en la pantalla de desbloqueo;
    // acá solo baja hasta el diálogo de Configuración, que es donde se elige.
    uiFontScale: number
    onChangeUIFontScale: (pct: number) => void
}

export default function Workspace({
    theme,
    onToggleTheme,
    onLocked,
    updateInfo,
    uiFontScale,
    onChangeUIFontScale,
}: WorkspaceProps) {
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
    function createFolder(name: string, parentId: string, scope: 'db' | 'ssh' | 'git' | 'note') {
        CreateFolder(name, parentId, scope)
            .then(() => setReloadToken((n) => n + 1))
            .catch((err) => setStatusMessage(String(err)))
    }

    function moveGitRepoToFolder(repoId: string, folderId: string) {
        GitMoveRepoToFolder(repoId, folderId)
            .then(() => {
                setReloadToken((n) => n + 1)
                notifyGitChanged()
            })
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

    // Qué módulo muestra la barra lateral. Uno a la vez: lo elige el menú
    // master (components/sidebar/SidebarMasterMenu.tsx), que reemplazó al
    // acordeón de cuatro módulos apilados.
    const [activeModule, setActiveModule] = useState<SidebarModuleId>('connections')

    function selectSidebarModule(id: SidebarModuleId) {
        setActiveModule(id)
        void SetSidebarModule(id)
    }

    // Coincidencias de la búsqueda global por módulo. Las informa cada árbol
    // (onMatchCount) y las consume el menú master: con un solo módulo a la
    // vista, es lo único que dice que lo que se busca está en otro. Los
    // setters de useState son estables, así que se pasan tal cual y el efecto
    // que los llama no se re-dispara solo.
    const [connectionsMatches, setConnectionsMatches] = useState<number | null>(null)
    const [sshMatches, setSshMatches] = useState<number | null>(null)
    const [gitMatches, setGitMatches] = useState<number | null>(null)
    const [notesMatches, setNotesMatches] = useState<number | null>(null)

    const clearSidebarFilter = useCallback(() => setSidebarFilter(''), [])

    // Token de refresco del árbol de colecciones HTTP: sube cuando algo
    // cambia desde una pestaña (renombrar, cambiar el método) para que la
    // barra lateral no quede mostrando el nombre viejo.
    const [httpToken, setHttpToken] = useState(0)
    const bumpHttp = useCallback(() => setHttpToken((n) => n + 1), [])

    const sidebarModules = useMemo(
        () => [
            {
                id: 'connections' as const,
                icon: 'database',
                label: 'Conexiones',
                hint: 'bases de datos: explorar el esquema y correr consultas',
                matchCount: connectionsMatches,
            },
            {
                id: 'ssh' as const,
                icon: 'terminal',
                label: 'SSH',
                hint: 'servidores remotos: abrir una terminal o transferir archivos',
                matchCount: sshMatches,
            },
            {
                id: 'git' as const,
                icon: 'commit',
                label: 'Git',
                hint: 'repositorios: ver cambios, ramas y trabajar con los agentes',
                matchCount: gitMatches,
            },
            {
                id: 'notes' as const,
                icon: 'description',
                label: 'Notas',
                hint: 'tu base de conocimiento cifrada: runbooks y apuntes',
                matchCount: notesMatches,
            },
            {
                id: 'http' as const,
                icon: 'api',
                label: 'HTTP',
                hint: 'colecciones de peticiones: probar y guardar endpoints',
                // El contador de coincidencias queda en null hasta que el
                // árbol sepa buscar por sí mismo (el filtro ya llega y
                // filtra): mostrar un 0 permanente sobre el ícono diría que
                // no hay nada cuando lo que pasa es que todavía no se contó.
                matchCount: null,
            },
        ],
        [connectionsMatches, sshMatches, gitMatches, notesMatches],
    )

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
        if (dbType === 'redis' || dbType === 'mongodb' || dbType === 'ssh') return
        if (!force && metadataByConn[connId]) return
        setLoadingConnIds((prev) => new Set(prev).add(connId))
        GetSchemaMetadata(connId, force)
            .then((meta) => setMetadataByConn((prev) => ({...prev, [connId]: meta})))
            // Only the EXPLICIT refresh (F5, force=true) surfaces a failure —
            // the auto-load that fires just from selecting/switching a
            // connection must stay silent. Metadata only powers autocomplete;
            // popping the raw DB error into the status bar every single time a
            // connection is picked (e.g. the schema scan is slow or the user
            // lacks catalog privileges) was the recurring "error al seleccionar
            // conexión". A failed auto-load just leaves autocomplete empty; the
            // connection is still fully usable.
            .catch((err) => {
                if (force) setStatusMessage(String(err))
                else console.warn('metadata auto-load falló para', connId, err)
            })
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
    // SQL retenido por una de dos razones, con el mismo diálogo temado que ya
    // usan Redis y Mongo: el linter lo marcó como bloqueante, o la conexión
    // está marcada como Producción y el script trae sentencias destructivas.
    // `risks` vacío = fue el linter; con contenido = fue el entorno.
    const [pendingSqlRun, setPendingSqlRun] = useState<{text: string; title: string; description: string} | null>(null)
    // The statement waiting on its bind values, plus everything needed to
    // run it once they arrive (see runText).
    const [paramPrompt, setParamPrompt] = useState<{
        connection: vault.ConnectionSummary
        sqlText: string
        params: query.Param[]
    } | null>(null)
    // Last values entered, per editor tab, so re-running the same
    // parameterised query does not mean retyping them. A ref rather than
    // state because nothing renders from it until the dialog opens, and
    // deliberately in memory only: these are query arguments, which can be
    // an account number or a document id, and persisting them would put
    // them on disk for a convenience that costs one keystroke to redo.
    const paramDraftsRef = useRef<Map<string, ParamDraftMap>>(new Map())
    // Explain Analyze on a mutating statement: confirmed first, same themed
    // ConfirmDialog pattern as pendingRedisCommandRun. The dialog is the
    // courtesy; the guarantee is that the backend wraps a mutating analyzed
    // run in a transaction it always rolls back.
    const [pendingAnalyzeRun, setPendingAnalyzeRun] = useState<string | null>(null)
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
    // MongoDB's own result stream (backend/mongoquery.Event) — documents, not
    // rows, rendered by MongoResultView. Parallel to redisResults above.
    const [mongoResults, setMongoResults] = useState<MongoCommandResult[]>([])
    // A destructive Mongo command (deleteMany/updateMany with {} filter, drop)
    // needs confirming before it runs (lintMongoCommands) — same themed
    // ConfirmDialog pattern as pendingRedisCommandRun.
    const [pendingMongoCommandRun, setPendingMongoCommandRun] = useState<string | null>(null)
    // The "current database" the mongosh `db` prefix targets, per connection
    // (MongoDB browses many DBs — same per-conn cache idea as activeSchemaByConn).
    // Seeded from the connection's DSN default, updated when a collection is
    // opened from the tree, or via the toolbar db selector.
    const [mongoDbByConn, setMongoDbByConn] = useState<Record<string, string>>({})
    // Last collection the user opened per connection, so the query wizard
    // starts on it instead of on an empty field. Kept apart from
    // mongoDbByConn because a database can be selected without any
    // collection having been opened yet.
    const [mongoCollByConn, setMongoCollByConn] = useState<Record<string, string>>({})
    // Database names per Mongo connection, feeding the toolbar's active-db
    // selector — fetched when the connection becomes the active tab's.
    const [mongoDatabasesByConn, setMongoDatabasesByConn] = useState<Record<string, string[]>>({})
    const [pendingMongoBrowser, setPendingMongoBrowser] = useState<{connId: string; database: string; collection: string; token: number} | null>(null)
    const pendingMongoBrowserTokenRef = useRef(0)
    // Cómo terminó el último backup del vault. Se muestra DENTRO de
    // Configuración, que es de donde se pide — ver backupVault.
    const [backupResult, setBackupResult] = useState<{ok: boolean; text: string} | null>(null)
    const [showBackupPasswordDialog, setShowBackupPasswordDialog] = useState(false)
    const [showRestoreDialog, setShowRestoreDialog] = useState(false)
    const [showSettingsDialog, setShowSettingsDialog] = useState(false)
    const [statusMessage, setStatusMessage] = useState('')

    const [showMongoWizard, setShowMongoWizard] = useState(false)
    // A remote save refused because the file changed on the server. Held
    // here until the user decides, instead of overwriting or discarding.
    const [remoteConflict, setRemoteConflict] = useState<{tabId: string; path: string; connName: string} | null>(null)

    const [showExplain, setShowExplain] = useState(false)
    const [explainPlan, setExplainPlan] = useState<explain.Plan | null>(null)
    const [explainLoading, setExplainLoading] = useState(false)
    const [explainError, setExplainError] = useState('')
    // Surfaced on the tab itself so a critical finding is visible without
    // having to switch to the plan first.
    const explainCriticalCount = (explainPlan?.insights ?? []).filter((i) => i.severity === 'critical').length

    // "Resultados"/"Consola" are tabs sharing one bottom panel — tab-style
    // like EditorTabs above, not docked panels stacked on top of each other.
    // Starts on "results" (what you want right after running a single
    // statement); a multi-statement run auto-switches to "console" instead
    // (see runText) so the per-statement log is what you land on, matching
    // the DataGrip-style console this mirrors.
    //
    // Ya NO hay solapa "Historial". La consola es un log corrido de todo lo
    // ejecutado en la sesión —con el texto completo de cada statement, su
    // duración y su error— así que el historial era la misma información
    // contada dos veces, y la segunda con menos contexto.
    // "explain" only exists while there is a plan to show: it is opened by
    // the Explain buttons and closed with its own X, like a result tab —
    // rather than a fourth panel docked under everything else, which is
    // what it used to be.
    const [activeBottomTab, setActiveBottomTab] = useState<'results' | 'console' | 'dbms' | 'explain'>('results')

    const queryIdRef = useRef<string | null>(null)
    // Unsubscribe fn of the run currently streaming, so starting a new run can
    // tear the old one down. Without this a superseded run's handler stays
    // registered and keeps appending ITS rows into the result state the new run
    // just cleared — the "me muestra el resultado del SQL anterior" bug, which
    // looked intermittent because it only shows when the old run is still
    // streaming (or its terminal event is still in flight) as the new one
    // starts. Every run function below sets it.
    const unsubscribeRef = useRef<(() => void) | null>(null)
    const editorRef = useRef<EditorView | null>(null)
    // Cambió la privacidad de una nota, desde donde sea: el candado del árbol
    // tiene que reflejarlo YA. Un control de privacidad que muestra el estado
    // anterior es peor que no mostrarlo.
    useEffect(() => EventsOn('note:privacy', () => setNotesToken((n) => n + 1)), [])
    // Una nota creada o reescrita por un agente vía MCP cambia sin que la
    // interfaz haya hecho nada: sin este aviso, el árbol la mostraría recién al
    // reabrir la app, que se lee como que no se guardó.
    useEffect(() => EventsOn('note:changed', () => setNotesToken((n) => n + 1)), [])

    // Editores de las notas abiertas, por pestaña. Son vistas de CodeMirror
    // distintas de la del editor SQL, y hay una por nota montada.
    const noteViewsRef = useRef<Map<string, EditorView>>(new Map())
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

    // "Esta pestaña corre SQL": una conexión de base de datos relacional, no
    // SSH, Redis ni MongoDB. Se calcula acá arriba —y no junto al resto de los
    // flags de la fila de contexto— porque también lo necesitan efectos que
    // corren mucho antes, como el que consulta el estado del índice de esquema.
    const isSqlActive =
        !!activeTabConnection &&
        activeTabConnection.dbType !== 'redis' &&
        activeTabConnection.dbType !== 'mongodb' &&
        activeTabConnection.dbType !== 'ssh'

    // Sobre qué está trabajando el chat unificado, derivado de la pestaña
    // activa. Es lo único que ancla una sola conversación a lo que el usuario
    // está mirando: cambiar de pestaña cambia esto, NO la conversación.
    //
    // Un tipo de pestaña que no sabemos describir cae en 'none' en vez de
    // inventarle un contexto — el chat sigue funcionando, solo que sin decir
    // "sobre X" en el encabezado, que es lo honesto.
    const agentContext = useMemo<WorkContext>(() => {
        const t = activeTabData
        if (!t) return NO_CONTEXT
        if (t.kind === 'git-repo' && t.repoId) {
            return {kind: 'git', id: t.repoId, label: t.title.replace(/^Git — /, '')}
        }
        // Una nota abierta es contexto de trabajo como cualquier otro: el chat
        // dice sobre cuál está y `@note:` la puede referenciar por su título.
        if (t.kind === 'note' && t.noteId) {
            return {kind: 'note', id: t.noteId, label: t.title}
        }
        // Una petición HTTP también. Una rápida no tiene ítem: va con id vacío,
        // así que todas las pruebas sueltas comparten una conversación — que es
        // lo correcto, porque no son "sobre" nada guardado.
        if (t.kind === 'http-request') {
            return {kind: 'http', id: t.httpItemId ?? '', label: t.title}
        }
        const conn = t.connId ? connections.find((c) => c.id === t.connId) ?? null : null
        if (!conn) return NO_CONTEXT
        // Una conexión SSH y una de base de datos viven en la misma tabla del
        // vault y se distinguen por dbType — el módulo del chat sale de ahí y
        // no del tipo de pestaña, que para 'remote-file' o 'sftp' diría poco.
        return {kind: conn.dbType === 'ssh' ? 'ssh' : 'db', id: conn.id, label: conn.name}
    }, [activeTabData, connections])

    // Asistente de consultas del editor (Cmd/Ctrl+I). `errorText` distingue
    // los dos modos: vacío es "escribime una consulta", con texto es "esto
    // falló, explicá y corregí". Un solo componente porque son el mismo
    // flujo —pedir, ver la propuesta, aplicarla o descartarla— y lo único que
    // cambia es de dónde sale el pedido.
    const [nlBar, setNlBar] = useState<{errorText?: string} | null>(null)
    // Token que refresca la lista de notas del sidebar cuando una nota se
    // guarda, se crea o se borra desde su pestaña.
    const [notesToken, setNotesToken] = useState(0)
    const [showNotesGraph, setShowNotesGraph] = useState(false)

    // Cambiar de pestaña lo cierra. La barra queda anclada a la conexión y al
    // texto de la pestaña donde se abrió: dejarla abierta al cambiar mostraría
    // una propuesta calculada sobre otra consulta y otro esquema, con el botón
    // Aplicar apuntando al editor equivocado.
    useEffect(() => {
        setNlBar(null)
    }, [activeTabId])

    // Abre una nota en su propia pestaña, o enfoca la que ya la tenía. Una
    // pestaña por nota y no una sola pestaña "Notas": es el modelo del resto de
    // la app —una pestaña por cosa en la que estás trabajando— y permite tener
    // el runbook abierto al lado de la consulta que estás depurando.
    // Abre una petición HTTP en su pestaña, o trae al frente la que ya está
    // abierta. Misma regla que las notas y los repositorios: un ítem = una
    // pestaña, porque dos pestañas del mismo request con estados distintos
    // sin guardar es una forma garantizada de perder trabajo.
    const openHttpRequest = useCallback((item: vault.HTTPItem) => {
        setTabs((prev) => {
            const existing = prev.find((t) => t.kind === 'http-request' && t.httpItemId === item.id)
            if (existing) {
                setActiveTabId(existing.id)
                return prev
            }
            const tab: EditorTab = {
                id: newTabId(),
                title: item.name,
                path: null,
                content: '',
                dirty: false,
                connId: null,
                language: 'sql',
                kind: 'http-request',
                httpItemId: item.id,
            }
            setActiveTabId(tab.id)
            return [...prev, tab]
        })
    }, [])

    // Petición rápida: una pestaña HTTP sin ítem detrás, para probar un
    // endpoint sin crear ni nombrar nada. A diferencia de las demás, acá NO se
    // reutiliza una pestaña existente: dos pruebas sueltas a la vez es
    // exactamente el caso de uso (comparar dos endpoints, o el mismo contra dos
    // entornos), y no hay ítem guardado que dos pestañas puedan pisarse.
    const openHttpScratch = useCallback(() => {
        setTabs((prev) => {
            const tab: EditorTab = {
                id: newTabId(),
                title: 'Petición rápida',
                path: null,
                content: '',
                dirty: false,
                connId: null,
                language: 'sql',
                kind: 'http-request',
            }
            setActiveTabId(tab.id)
            return [...prev, tab]
        })
    }, [])

    // Una petición rápida que se guardó deja de serlo: la pestaña pasa a
    // apuntar al ítem nuevo y toma su nombre.
    const bindHttpTab = useCallback((tabId: string, item: vault.HTTPItem) => {
        setTabs((prev) => prev.map((t) => (t.id === tabId ? {...t, httpItemId: item.id, title: item.name} : t)))
    }, [])

    const openNote = useCallback((noteId: string, title?: string) => {
        setTabs((prev) => {
            const existing = prev.find((t) => t.kind === 'note' && t.noteId === noteId)
            if (existing) {
                setActiveTabId(existing.id)
                return prev
            }
            const tab: EditorTab = {
                id: newTabId(),
                title: title || 'Nota',
                path: null,
                content: '',
                dirty: false,
                connId: null,
                language: 'sql',
                kind: 'note',
                noteId,
            }
            setActiveTabId(tab.id)
            return [...prev, tab]
        })
        void SetNotesLastOpen(noteId).catch(() => {})
    }, [])

    const changeAgentLayout = useCallback((dock: AgentDock, size: number) => {
        setAgentDockState(dock)
        setAgentSizeState(size)
        void SetAgentLayout(dock, size).catch(() => {})
    }, [])

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
    // Los mismos topes que aplica el backend al guardar
    // (vault.SetSidebarWidth): por debajo el árbol no se lee, por encima la
    // barra le come el ancho al editor, que es para lo que se abre la app.
    const SIDEBAR_WIDTH_MIN = 180
    const SIDEBAR_WIDTH_MAX = 640
    // 256px es el w-64 que la barra tenía fijo antes de poder arrastrarse.
    const SIDEBAR_WIDTH_DEFAULT = 256
    // Tamaño de página de resultados (0 = "All"). Se restaura de settings y se
    // persiste al cambiarlo — ver backend/query/paging.go.
    const [pageSize, setPageSize] = useState(500)
    const [gitSyncToken, setGitSyncToken] = useState(0)
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
    // Ancho arrastrado de la barra, mismo trato que el alto del editor: se
    // persiste una vez al soltar, no en cada movimiento del puntero.
    const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_WIDTH_DEFAULT)
    // Apariencia de los editores de código (SQL y archivos de Git). Vive acá
    // y no en cada editor porque es una preferencia de la app, no de una
    // pestaña: se elige una vez en Configuración y la usan los dos.
    const [editorAppearance, setEditorAppearanceState] = useState<EditorAppearance>(DEFAULT_EDITOR_APPEARANCE)
    // Búsqueda única de la barra lateral: la comparten los tres módulos
    // (conexiones, SSH y Git), que antes tenían una caja "Buscar…" cada uno.
    // Vive acá y no en ConnectionTree porque los otros dos módulos se montan
    // como `extraModules` desde este componente.
    const [sidebarFilter, setSidebarFilter] = useState('')
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
    // Shell que abre la terminal local integrada (settings.localShell, un id
    // de backend/localterm: "zsh", "pwsh", "gitbash"…). "" = el que ya usa
    // esta máquina, resuelto en Go en cada apertura — ver
    // vault.Settings.LocalShell para por qué no se materializa un id acá.
    const [localShellId, setLocalShellIdState] = useState('')
    // Cuerpo de fuente de TODAS las terminales (settings.terminalFontSize).
    // 13 es el valor que las terminales tenían hardcodeado antes de que fuera
    // configurable, y el default de la migración 27.
    const [terminalFontSize, setTerminalFontSizeState] = useState(13)
    // "Backup automático" toggle + its two dependent fields — mirrors
    // settings.auto_backup_* (backend/vault/settings_repo.go). The
    // scheduler itself lives in Go (backend/autobackup); this state is only
    // for reflecting/editing it from SettingsDialog.
    const [autoBackupEnabled, setAutoBackupEnabledState] = useState(false)
    const [autoBackupIntervalHours, setAutoBackupIntervalHoursState] = useState(6)
    const [autoBackupPath, setAutoBackupPathState] = useState('')
    const [autoSaveEnabled, setAutoSaveEnabledState] = useState(false)
    const [autoSaveIntervalSeconds, setAutoSaveIntervalSecondsState] = useState(30)
    // Disposición del panel del chat unificado (migración 33). Los defaults
    // son los del vault, repetidos acá porque el primer render ocurre antes de
    // que GetSettings conteste — un panel que arranca en otro lado y salta
    // medio segundo después se lee como un bug.
    const [agentDock, setAgentDockState] = useState<AgentDock>('right')
    const [agentSize, setAgentSizeState] = useState(380)

    useEffect(() => {
        let cancelled = false

        GetSettings()
            .then(async (settings) => {
                if (cancelled) return
                setSidebarCollapsed(!!settings.sidebarCollapsed)
                // 0 = nunca se arrastró, así que manda el default del
                // frontend en vez de un cero que dejaría la barra invisible.
                if (settings.sidebarWidth) {
                    setSidebarWidth(Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, settings.sidebarWidth)))
                }
                if (settings.sidebarModule) setActiveModule(settings.sidebarModule as SidebarModuleId)
                setEditorAppearanceState(editorAppearanceFromSettings(settings.editorAppearance))
                setRememberMasterKeyState(!!settings.rememberMasterKey)
                // 0 es "All", un valor válido — por eso se compara con
                // undefined/null en vez de usar un truthy check.
                if (settings.queryPageSize !== undefined && settings.queryPageSize !== null) {
                    setPageSize(settings.queryPageSize)
                }
                if (settings.editorTheme) {
                    setEditorThemeIdState(settings.editorTheme)
                }
                if (settings.sshTerminalTheme) {
                    setTerminalThemeIdState(settings.sshTerminalTheme)
                }
                // "" es un valor válido (= automático), así que se asigna
                // siempre en vez de detrás de un truthy check.
                setLocalShellIdState(settings.localShell ?? '')
                if (settings.terminalFontSize) setTerminalFontSizeState(settings.terminalFontSize)
                if (settings.editorHeight) {
                    setEditorHeightState(Math.min(EDITOR_HEIGHT_MAX, Math.max(EDITOR_HEIGHT_MIN, settings.editorHeight)))
                }
                setAutoBackupEnabledState(!!settings.autoBackupEnabled)
                setAutoBackupIntervalHoursState(settings.autoBackupIntervalHours || 6)
                setAutoBackupPathState(settings.autoBackupPath || '')
                setAutoSaveEnabledState(!!settings.autoSaveEnabled)
                setAutoSaveIntervalSecondsState(settings.autoSaveIntervalSeconds || 30)
                if (settings.agentDock) setAgentDockState(settings.agentDock as AgentDock)
                if (settings.agentSize) setAgentSizeState(settings.agentSize)
                // La última nota abierta se reabre. Se guarda solo el ID: el
                // contenido se lee del vault ahora, que es lo único correcto si
                // la nota cambió mientras tanto — mismo criterio que las
                // pestañas de archivo del módulo Git.
                //
                // Una nota borrada entre dos arranques simplemente no se abre:
                // GetNote falla y la pestaña no se crea, en vez de dejar una
                // pestaña rota que hay que cerrar a mano.
                if (settings.notesLastOpen) {
                    GetNote(settings.notesLastOpen)
                        .then((n) => openNote(settings.notesLastOpen, n.title))
                        .catch(() => {})
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

    // Un solo guardado para todo el grupo: el diálogo cambia un campo por
    // vez, pero mandar el objeto entero deja el vault siempre consistente y
    // ahorra seis bindings que podrían desincronizarse entre sí.
    function changeEditorAppearance(next: EditorAppearance) {
        setEditorAppearanceState(next)
        void SetEditorAppearance(next)
    }

    function changeTerminalTheme(id: TerminalThemeId) {
        setTerminalThemeIdState(id)
        void SetSshTerminalTheme(id)
    }

    // Cambiar el shell reinicia las terminales locales abiertas (ver
    // LocalTerminalPanel): no existe cambiarle el intérprete a un proceso que
    // ya está corriendo, así que la única forma de que la preferencia se
    // aplique es levantar una shell nueva.
    function changeLocalShell(id: string) {
        setLocalShellIdState(id)
        void SetLocalShell(id)
    }

    // Se acota acá además de en Go: el backend corrige el valor al guardar,
    // pero si el estado local se saliera del rango la UI mostraría un tamaño
    // que no es el que quedó guardado.
    function changeTerminalFontSize(px: number) {
        const clamped = Math.max(TERMINAL_FONT_MIN, Math.min(px, TERMINAL_FONT_MAX))
        setTerminalFontSizeState(clamped)
        void SetTerminalFontSize(clamped)
    }

    async function toggleAutoBackup(checked: boolean) {
        if (checked && !autoBackupPath) {
            // Turning it on without a folder chosen would leave the
            // scheduler silently inactive (see autobackup.Scheduler.Reconfigure
            // treating an empty path as "not configured") — ask for the
            // folder first instead of a toggle that reads "on" but does nothing.
            try {
                const dir = await PickAutoBackupFolder()
                if (!dir) return // cancelled the picker — don't turn it on
                setAutoBackupPathState(dir)
            } catch (err) {
                setStatusMessage(String(err))
                return
            }
        }
        try {
            await SetAutoBackupEnabled(checked)
            setAutoBackupEnabledState(checked)
        } catch (err) {
            setStatusMessage(String(err))
        }
    }

    function changeAutoBackupInterval(hours: number) {
        setAutoBackupIntervalHoursState(hours)
        void SetAutoBackupIntervalHours(hours).catch((err) => setStatusMessage(String(err)))
    }

    function toggleAutoSave(checked: boolean) {
        setAutoSaveEnabledState(checked)
        void SetAutoSaveEnabled(checked).catch((err) => setStatusMessage(String(err)))
    }

    function changeAutoSaveInterval(seconds: number) {
        setAutoSaveIntervalSecondsState(seconds)
        void SetAutoSaveIntervalSeconds(seconds).catch((err) => setStatusMessage(String(err)))
    }

    // Auto-save timer: while enabled, periodically write every dirty tab that
    // already has a file path back to disk (scratch tabs with no path are
    // skipped — SaveSQLFileAs would pop a native dialog, wrong on a timer).
    // Reads tabsRef so the interval callback always sees the current tabs
    // without re-subscribing on every keystroke.
    useEffect(() => {
        if (!autoSaveEnabled) return
        const id = setInterval(() => {
            const dirtyWithPath = tabsRef.current.filter((t) => t.dirty && t.path && t.kind === 'editor')
            if (dirtyWithPath.length === 0) return
            for (const t of dirtyWithPath) {
                SaveSQLFile(t.path as string, t.content)
                    .then(() => {
                        setTabs((prev) => prev.map((x) => (x.id === t.id && x.content === t.content ? {...x, dirty: false} : x)))
                    })
                    .catch(() => {
                        // Best-effort: a failed auto-save shouldn't nag; the
                        // manual Ctrl+S surfaces errors. Leave the tab dirty.
                    })
            }
        }, Math.max(5, autoSaveIntervalSeconds) * 1000)
        return () => clearInterval(id)
    }, [autoSaveEnabled, autoSaveIntervalSeconds])

    async function pickAutoBackupFolder() {
        try {
            const dir = await PickAutoBackupFolder()
            if (dir) setAutoBackupPathState(dir)
        } catch (err) {
            setStatusMessage(String(err))
        }
    }

    // Adónde lleva el aviso de versión nueva.
    //
    // **Al archivo, no al repositorio.** Antes abría la portada del repo y
    // dejaba al usuario buscando entre releases y adjuntos cuál era el suyo;
    // ahora updatecheck ya resolvió el .dmg o el .exe de ESTE sistema y el
    // clic lo descarga. Sin archivo —en Linux, que no se empaqueta, o si el
    // release no trae adjuntos— cae a la página del release, que siempre lleva
    // a algún lado.
    function openRepo() {
        const url = updateInfo?.downloadUrl || updateInfo?.releaseUrl
        if (url) BrowserOpenURL(url)
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

    // Arrastrar el borde derecho de la barra lateral. Misma mecánica que
    // startEditorResize —listeners en window, persistir una sola vez al
    // soltar— porque es el mismo problema: mousemove dispara decenas de
    // veces por segundo y la escritura al vault no tiene por qué seguirle el
    // ritmo al puntero, solo registrar dónde se detuvo.
    const sidebarResizingRef = useRef(false)
    function startSidebarResize(e: ReactMouseEvent) {
        e.preventDefault()
        sidebarResizingRef.current = true
        const startX = e.clientX
        const startWidth = sidebarWidth
        const clamp = (px: number) => Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, px))

        function onMove(moveEvent: MouseEvent) {
            if (!sidebarResizingRef.current) return
            setSidebarWidth(clamp(startWidth + (moveEvent.clientX - startX)))
        }
        function onUp(upEvent: MouseEvent) {
            sidebarResizingRef.current = false
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
            void SetSidebarWidth(clamp(startWidth + (upEvent.clientX - startX)))
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
        // Un error (clave equivocada, permiso denegado) NO se atrapa acá a
        // propósito: PasswordConfirmDialog lo muestra adentro suyo y se queda
        // abierto para reintentar. Atraparlo lo cerraría como si hubiera
        // salido bien.
        const dest = await BackupVault(password)
        setBackupResult(
            dest
                ? {ok: true, text: `Backup guardado en ${dest}`}
                : {ok: false, text: 'No se guardó ningún backup: se cerró el diálogo sin elegir dónde.'},
        )
        // Vuelve a Configuración, que es de donde salió el pedido y donde se
        // cuenta cómo terminó. El backup se pide desde ahí, se confirma en un
        // modal aparte y termina en un diálogo del sistema operativo: sin esto,
        // el usuario queda parado en la pantalla que estaba mirando antes de
        // todo eso, sin nada que le diga si el archivo se escribió.
        setShowSettingsDialog(true)
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

    // Seed the active Mongo connection's "current database" from its DSN default
    // (if any), so the editor's `db` prefix targets something sensible before
    // the user expands a database in the tree. Only fetched once per connection.
    useEffect(() => {
        const conn = activeTabConnection
        if (!conn || conn.dbType !== 'mongodb') return
        const currentDb = mongoDbByConn[conn.id]
        if (!currentDb) {
            GetMongoDefaultDatabase(conn.id)
                .then((defaultDb) => {
                    if (!defaultDb) return
                    setMongoDbByConn((prev) => (prev[conn.id] ? prev : {...prev, [conn.id]: defaultDb}))
                    // Load the default database's collections so autocomplete +
                    // the find wizard are usable right away, not only after the
                    // user picks a database from the toolbar or the tree.
                    ListMongoCollections(conn.id, defaultDb, false)
                        .then((cols) => setActiveMongoCollections((cols ?? []).map((c) => c.name)))
                        .catch(() => {})
                })
                .catch(() => {})
        } else {
            ListMongoCollections(conn.id, currentDb, false)
                .then((cols) => setActiveMongoCollections((cols ?? []).map((c) => c.name)))
                .catch(() => {})
        }
        // Populate the toolbar's database selector for this connection.
        if (!mongoDatabasesByConn[conn.id]) {
            ListMongoDatabases(conn.id)
                .then((dbs) => setMongoDatabasesByConn((prev) => ({...prev, [conn.id]: (dbs ?? []).map((d) => d.name)})))
                .catch(() => {})
        }
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

    // Estado del índice de autocompletado de la conexión activa.
    //
    // Existe por un motivo puntual: cuando la lectura del catálogo FALLA
    // (permisos, conexión caída, un esquema que el usuario no puede leer) el
    // editor seguía autocompletando palabras clave y nada más, sin decir una
    // palabra. Desde afuera eso es indistinguible de "el autocompletado está
    // roto", que es exactamente el reporte que llegó. Un índice sano no
    // muestra nada — la fila de contexto ya está bastante poblada.
    const [indexError, setIndexError] = useState<string | null>(null)
    // Solo las conexiones SQL tienen índice de esquema. Antes se preguntaba por
    // CUALQUIER conexión vinculada a la pestaña activa, y una pestaña SFTP o una
    // terminal están vinculadas a una conexión SSH: el backend contestaba
    // "error" —nunca hubo índice que construir— y la fila de contexto mostraba
    // «Autocompletado sin esquema» sobre un explorador de archivos, avisando de
    // un problema que no existe. Con null acá el efecto no consulta nada y el
    // aviso se apaga solo.
    const editorConnId = isSqlActive ? activeTabConnection?.id ?? null : null
    useEffect(() => {
        let alive = true
        setIndexError(null)
        if (!editorConnId) return

        const read = () => {
            GetSchemaIndexStatus(editorConnId)
                .then((st) => {
                    if (!alive) return
                    setIndexError(st?.state === 'error' ? st.error || 'no se pudo leer el catálogo' : null)
                })
                .catch(() => {})
        }
        read()
        // El backend avisa cuándo termina cada extracción; sin esto el aviso
        // quedaría congelado en lo que valía al abrir la pestaña.
        const off = EventsOn('sqlintel:index', (st: {connId?: string}) => {
            if (st?.connId === editorConnId) read()
        })
        return () => {
            alive = false
            off()
        }
    }, [editorConnId])

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

    // runWithParams is the original runText body: it assumes the bind
    // values are already decided. runText below is what callers use — it
    // asks for them first when the statement declares any.
    const runWithParams = useCallback(
        (connection: vault.ConnectionSummary, sqlText: string, params: query.ParamValue[]) => {
            if (running || !sqlText.trim()) return

            // Drop any subscription still live from a previous run before
            // claiming the state — see unsubscribeRef.
            unsubscribeRef.current?.()

            const queryId = newQueryId()
            queryIdRef.current = queryId
            setRunning(true)
            setRunProgress(null)
            setResultSets([])
            setActiveResultTab(0)

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
                // Second line of defence behind the teardown above: a late
                // event from a superseded run must never touch the current
                // run's state.
                if (queryIdRef.current !== queryId) return

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
                        case 'page':
                            // Página adicional entregada por FetchMore: solo
                            // actualiza el contador y si quedan más.
                            cur.rowsAffected = event.rowsAffected ?? cur.rowsAffected
                            cur.hasMore = !!event.hasMore
                            cur.loadingMore = false
                            break
                        case 'done':
                            cur.status = 'done'
                            cur.hasMore = !!event.hasMore
                            cur.rowsAffected = event.rowsAffected ?? 0
                            cur.durationMs = event.durationMs ?? 0
                            cur.dbmsOutput = event.dbmsOutput ?? []
                            cur.note = event.note ?? ''
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

                if (event.type === 'page' || event.type === 'done' || event.type === 'error' || event.type === 'cancelled') {
                    // 'page' = una tanda extra traída por "Cargar 500 más";
                    // se loguea como 'done' para que la consola muestre el
                    // acumulado, igual que el Output de DataGrip.
                    const terminalStatus = event.type === 'page' ? 'done' : event.type
                    const newEntry: ConsoleLogEntry = {
                        index: event.statementIndex,
                        total: event.totalStatements,
                        sqlText: event.sqlText ?? '',
                        status: terminalStatus,
                        hasColumns: seenColumns.has(event.statementIndex),
                        rowsAffected: event.rowsAffected ?? 0,
                        durationMs: event.durationMs ?? 0,
                        error: event.error ?? '',
                        dbmsOutput: event.dbmsOutput ?? [],
                        note: event.note ?? '',
                        timestamp: Date.now(),
                    }
                    // The console is a running history now (it is no longer
                    // cleared per run), so it needs a ceiling: a long session
                    // running thousands of statements would otherwise grow
                    // without bound. Keeps the most recent entries, like any
                    // output pane; "Limpiar consola" empties it on demand.
                    setConsoleLog((prev) => {
                        const next = [...prev, newEntry]
                        return next.length > MAX_CONSOLE_ENTRIES ? next.slice(-MAX_CONSOLE_ENTRIES) : next
                    })
                }

                // La última página cierra la suscripción que se mantuvo viva
                // para paginar (ver el `if (!event.hasMore)` de abajo).
                if (event.type === 'page' && !event.hasMore) unsubscribe()

                if (
                    event.type === 'cancelled' ||
                    ((event.type === 'done' || event.type === 'error') && event.statementIndex === event.totalStatements - 1)
                ) {
                    setRunning(false)
                    setRunProgress(null)
                    // Solo se corta la suscripción si NO quedan páginas: las
                    // que entrega FetchMore llegan por este mismo queryId, y
                    // desuscribirse acá dejaba el botón "Cargar más" colgado en
                    // "Cargando…" porque nadie recibía las filas.
                    if (!event.hasMore) unsubscribe()
                }
            })

            unsubscribeRef.current = unsubscribe

            ExecuteQuery(connection.id, queryId, sqlText, dbmsOutputEnabled, params).catch((err) => {
                if (queryIdRef.current !== queryId) return
                setResultSets([{...emptyResultSet(), status: 'error', error: String(err)}])
                setRunning(false)
                setRunProgress(null)
                unsubscribe()
            })
        },
        [running, dbmsOutputEnabled, activeBottomTab],
    )

    // runText is what every "run this SQL" path calls. It asks Go whether
    // the text declares bind placeholders and, if it does, opens the dialog
    // instead of executing — the values then come back through
    // paramPrompt's onRun. With no placeholders it is the plain run it
    // always was, and costs one extra (local, in-process) call.
    const runText = useCallback(
        (connection: vault.ConnectionSummary, sqlText: string) => {
            if (running || !sqlText.trim()) return
            void (async () => {
                let params: query.Param[] = []
                try {
                    params = await DetectQueryParams(connection.id, sqlText)
                } catch {
                    // Detection is a convenience, never a gate: if it fails
                    // the statement still runs, and the engine's own error
                    // about an unbound variable is a perfectly good message.
                    params = []
                }
                if (params.length > 0) {
                    setParamPrompt({connection, sqlText, params})
                    return
                }
                runWithParams(connection, sqlText, [])
            })()
        },
        [running, runWithParams],
    )

    // Redis counterpart of runText — same client-generated queryId +
    // EventsOn-before-invoking contract (see ExecuteRedisCommand's doc
    // comment), but streams backend/redisquery.Event (one entry per
    // command) into redisResults instead of columns/rows into resultSets.
    const runRedisText = useCallback(
        (connection: vault.ConnectionSummary, commandText: string) => {
            if (running || !commandText.trim()) return

            unsubscribeRef.current?.()

            const queryId = newQueryId()
            queryIdRef.current = queryId
            setRunning(true)
            setRunProgress(null)
            setRedisResults([])

            const unsubscribe = EventsOn(queryId, (event: RedisQueryEvent) => {
                if (queryIdRef.current !== queryId) return
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
                }
            })

            unsubscribeRef.current = unsubscribe

            ExecuteRedisCommand(connection.id, queryId, commandText).catch((err) => {
                setRedisResults([{commandText, status: 'error', durationMs: 0, error: String(err)}])
                setRunning(false)
                setRunProgress(null)
                unsubscribe()
            })
        },
        [running, activeBottomTab],
    )

    // MongoDB counterpart of runText/runRedisText — streams
    // backend/mongoquery.Event (one entry per command) into mongoResults. The
    // active database (the mongosh `db` target) is passed explicitly since a
    // Mongo connection browses many databases.
    const runMongoText = useCallback(
        (connection: vault.ConnectionSummary, commandText: string) => {
            if (running || !commandText.trim()) return

            const database = mongoDbByConn[connection.id] ?? ''
            if (!database) {
                setStatusMessage('Elegí una base de datos en el árbol lateral antes de ejecutar comandos MongoDB')
                return
            }

            unsubscribeRef.current?.()

            const queryId = newQueryId()
            queryIdRef.current = queryId
            setRunning(true)
            setRunProgress(null)
            setMongoResults([])

            const unsubscribe = EventsOn(queryId, (event: MongoQueryEvent) => {
                if (queryIdRef.current !== queryId) return
                setRunProgress({current: event.commandIndex + 1, total: event.totalCommands})
                setMongoResults((prev) => {
                    const next = [...prev]
                    while (next.length <= event.commandIndex) {
                        next.push({commandText: '', status: 'running'})
                    }
                    next[event.commandIndex] = {
                        commandText: event.commandText ?? next[event.commandIndex].commandText,
                        status: event.type,
                        documents: event.documents,
                        summary: event.summary,
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
                }
            })

            unsubscribeRef.current = unsubscribe

            ExecuteMongoQuery(connection.id, queryId, database, commandText).catch((err) => {
                setMongoResults([{commandText, status: 'error', error: String(err)}])
                setRunning(false)
                setRunProgress(null)
                unsubscribe()
            })
        },
        [running, activeBottomTab, mongoDbByConn],
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
            // window.confirm(), see .claude/rules/conventions.md). El camino
            // SQL de más abajo usaba window.confirm() y ya no: quedó con el
            // mismo diálogo temado al sumarle el guard de producción.
            const warnings = lintRedisCommands(text).filter((w) => w.blocking)
            if (warnings.length > 0) {
                setPendingRedisCommandRun(text)
                return
            }
            runRedisText(activeTabConnection, text)
            return
        }

        if (activeTabConnection.dbType === 'mongodb') {
            const warnings = lintMongoCommands(text).filter((w) => w.blocking)
            if (warnings.length > 0) {
                setPendingMongoCommandRun(text)
                return
            }
            runMongoText(activeTabConnection, text)
            return
        }

        // Dos preguntas distintas, en orden de gravedad.
        //
        // La del entorno va primero: que el script esté bien escrito no lo hace
        // menos irreversible contra producción. Es el equivalente de lo que la
        // terminal SSH ya hacía con una conexión marcada como Producción — en
        // las bases la marca existía pero no hacía nada, así que un DROP contra
        // producción salía tan rápido como contra la copia local.
        if (activeTabConnection.environment === 'prod') {
            const risks = inspectSQL(text)
            if (risks.length > 0) {
                const detail = risks
                    .slice(0, 5)
                    .map((r) => `• ${r.label}: ${r.detail}\n  ${r.statement.split('\n')[0]}`)
                    .join('\n\n')
                const extra = risks.length > 5 ? `\n\n…y ${risks.length - 5} sentencia(s) más.` : ''
                setPendingSqlRun({
                    text,
                    title: `Estás en PRODUCCIÓN — ${activeTabConnection.name}`,
                    description: `Este script modifica datos o estructura en una conexión marcada como Producción:\n\n${detail}${extra}`,
                })
                return
            }
        }

        // La del linter: cosas mal escritas, en cualquier base. Antes usaba
        // window.confirm(), prohibido por .claude/rules/conventions.md — dentro
        // del webview no se percibe como un diálogo de la app y ya causó dos
        // confusiones reales ("no me deja ejecutar").
        const warnings = lintSQL(text).filter((w) => w.blocking)
        if (warnings.length > 0) {
            setPendingSqlRun({
                text,
                title: 'Advertencias antes de ejecutar',
                description: warnings.map((w) => `Línea ${w.startLineNumber}: ${w.message}`).join('\n'),
            })
            return
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

    // Explain is free: it only asks the planner, nothing runs. Explain
    // Analyze really executes the statement, so a script that writes gets a
    // confirmation first — asked of Go rather than a local regex, because
    // "-- delete this" and "SELECT 'DELETE'" are not deletes and a
    // "WITH x AS (…) DELETE …" is one.
    // Qué se explica: lo seleccionado, o la sentencia donde está el cursor.
    //
    // **Antes iba el archivo entero**, y eso estaba mal de dos maneras: una
    // pestaña de trabajo tiene diez consultas y lo que se está mirando es una,
    // y el planner devuelve el plan de la ÚLTIMA sentencia del texto — así que
    // el plan que se leía ni siquiera era el de la consulta bajo el cursor.
    function explainTargetSQL(): string {
        const full = activeTabData?.content ?? ''
        const view = editorRef.current
        if (!view) return full
        const {from, to, empty} = view.state.selection.main
        if (!empty) return view.state.sliceDoc(from, to)
        return statementAt(view.state.doc.toString(), from).text.trim() || full
    }

    async function runExplain(analyze: boolean) {
        if (!activeTabConnection) return
        const text = explainTargetSQL()
        if (!text.trim()) return

        if (analyze) {
            let mutating = false
            try {
                mutating = await CheckSQLMutation(text)
            } catch {
                // Unreachable in practice (the vault is unlocked to get
                // here), but if the check itself fails, confirm rather than
                // assume the script is read-only.
                mutating = true
            }
            if (mutating) {
                setPendingAnalyzeRun(text)
                return
            }
        }

        await executeExplain(text, analyze)
    }

    async function executeExplain(text: string, analyze: boolean) {
        if (!activeTabConnection) return
        setShowExplain(true)
        setActiveBottomTab('explain')
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

    function selectBottomTab(tab: 'results' | 'console' | 'dbms' | 'explain') {
        setActiveBottomTab(tab)
    }

    // Closing the plan tab drops the plan with it: keeping a stale plan
    // around invisibly would make the tab reappear with old data the next
    // time something switched to it.
    function closeExplain() {
        setShowExplain(false)
        setExplainPlan(null)
        setExplainError('')
        setActiveBottomTab('results')
    }

    function cancelQuery() {
        if (!queryIdRef.current) return
        if (activeTabConnection?.dbType === 'redis') {
            void CancelRedisCommand(queryIdRef.current)
        } else if (activeTabConnection?.dbType === 'mongodb') {
            void CancelMongoQuery(queryIdRef.current)
        } else {
            void CancelQuery(queryIdRef.current)
        }
    }

    // Sort re-issues the query wrapped in ORDER BY instead of sorting
    // client-side (spec: "no ordenar en cliente un dataset parcial"). The
    // wrapped query becomes the new (single-statement) run, so other result
    // tabs from the original script are replaced — same trade-off as any
    // other re-run.
    // Pide la próxima página al cursor que el backend dejó abierto. Las filas
    // llegan por los mismos eventos del run original (mismo queryId), así que
    // se agregan a la pestaña ya abierta — ver backend/query/paging.go.
    function fetchMoreRows() {
        const queryId = queryIdRef.current
        if (!queryId) return
        setResultSets((prev) => {
            const next = [...prev]
            if (next[activeResultTab]) {
                next[activeResultTab] = {...next[activeResultTab], loadingMore: true}
            }
            return next
        })
        FetchMoreRows(queryId).catch((err) => {
            setResultSets((prev) => {
                const next = [...prev]
                if (next[activeResultTab]) {
                    next[activeResultTab] = {...next[activeResultTab], loadingMore: false, error: String(err)}
                }
                return next
            })
        })
    }

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

    // Sets the editor's current database for a Mongo connection (the mongosh
    // `db` target) — called from the toolbar's Base selector and when a
    // database is expanded in the tree. Also loads that database's collections
    // into the completion store so the editor autocomplete AND the find wizard
    // "activate" for it immediately (the toolbar selector otherwise wouldn't
    // populate collections — only expanding the tree did).
    function selectMongoDatabase(connId: string, database: string) {
        setMongoDbByConn((prev) => ({...prev, [connId]: database}))
        if (activeTabConnection?.id === connId && database) {
            ListMongoCollections(connId, database, false)
                .then((cols) => setActiveMongoCollections((cols ?? []).map((c) => c.name)))
                .catch(() => {})
        }
    }

    // Opens (or focuses) a connection's Mongo Browser tab without pre-selecting
    // a collection — the user picks one from the tab's own tree. Reached by
    // double-clicking a Mongo connection row (parallel to openRedisBrowser).
    function openMongoBrowser(conn: vault.ConnectionSummary) {
        const existing = tabs.find((t) => t.kind === 'mongo-browser' && t.connId === conn.id)
        if (existing) {
            setActiveTabId(existing.id)
            return
        }
        const tab: EditorTab = {
            id: newTabId(),
            title: 'MongoDB Browser',
            path: null,
            content: '',
            dirty: false,
            connId: conn.id,
            language: 'mongosh',
            kind: 'mongo-browser',
        }
        setTabs((prev) => [...prev, tab])
        setActiveTabId(tab.id)
    }

    // Double-clicking a collection in the tree: mark its database active and
    // open/focus the connection's Mongo Browser tab, selecting that collection
    // (pendingMongoBrowser + token, same pattern as pendingBrowserKey for Redis).
    function openMongoCollection(connId: string, database: string, collection: string) {
        setMongoDbByConn((prev) => ({...prev, [connId]: database}))
        setMongoCollByConn((prev) => ({...prev, [connId]: collection}))
        const token = ++pendingMongoBrowserTokenRef.current
        setPendingMongoBrowser({connId, database, collection, token})

        const existing = tabs.find((t) => t.kind === 'mongo-browser' && t.connId === connId)
        if (existing) {
            setActiveTabId(existing.id)
            return
        }
        const tab: EditorTab = {
            id: newTabId(),
            title: 'MongoDB Browser',
            path: null,
            content: '',
            dirty: false,
            connId,
            language: 'mongosh',
            kind: 'mongo-browser',
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
    // Which DB/Redis/Mongo connections have an open pool. Unlike SSH there is
    // no event to subscribe to: a pool is opened lazily by whatever needs it
    // first (a query, a metadata scan, the key tree), so the truth lives in the
    // backend's pool managers and is re-read after the actions that can change
    // it (selecting a connection, disconnecting, deleting, reloading).
    const [liveDbConnIds, setLiveDbConnIds] = useState<Set<string>>(new Set())
    function refreshLiveConnections() {
        ActiveConnectionIds()
            .then((ids) => setLiveDbConnIds(new Set(ids ?? [])))
            .catch(() => {
                // A failure here only means the dot and the disconnect button
                // are missing for a moment; it must not surface as an error.
            })
    }
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
    // Abre una terminal del SISTEMA OPERATIVO en una pestaña.
    //
    // A diferencia de las de SSH no se deduplica por conexión sino por
    // INTÉRPRETE: dos terminales de zsh son dos ventanas de trabajo legítimas
    // —una compilando, otra mirando un log— y forzar una sola convertiría la
    // acción en un interruptor. Lo que sí se reusa es el id de sesión mientras
    // la pestaña viva, que es lo que mantiene la shell y su directorio.
    function openLocalTerminal(shellId: string, shellLabel: string) {
        const tab: EditorTab = {
            id: newTabId(),
            title: `Terminal — ${shellLabel}`,
            path: null,
            content: '',
            dirty: false,
            connId: null,
            language: 'sql',
            kind: 'local-terminal',
            shellId,
            shellLabel,
        }
        setTabs((prev) => [...prev, tab])
        setActiveTabId(tab.id)
    }

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

    // Opens (or focuses) the combined terminal + files tab for a host.
    //
    // A THIRD way to open the same two components, never a replacement:
    // openSshTerminal and openSftp above are untouched, so anyone who
    // prefers the separate tabs keeps them exactly as they were.
    function openSshHybrid(conn: vault.ConnectionSummary) {
        const existing = tabs.find((t) => t.kind === 'ssh-hybrid' && t.connId === conn.id)
        if (existing) {
            setActiveTabId(existing.id)
            return
        }
        const tab: EditorTab = {
            id: newTabId(),
            title: `Sesión — ${conn.name}`,
            path: null,
            content: '',
            dirty: false,
            connId: conn.id,
            language: 'sql',
            kind: 'ssh-hybrid',
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

    // Opens (or focuses) a repository's Git tab. Same dedupe-or-focus shape as
    // openSshTerminal/openSftp, keyed on repoId instead of connId — a
    // repository is registered in vault.git_repos, not vault.connections.
    // Bumped after any Git mutation (checkout, commit, fetch…) from either the
    // sidebar module or a repo tab. Everything Git-related reloads off it, so a
    // checkout done in one place is reflected in the other without either
    // component knowing the other exists.
    function notifyGitChanged() {
        setGitSyncToken((n) => n + 1)
    }

    function openGitRepo(repo: vault.GitRepo) {
        const existing = tabs.find((t) => t.kind === 'git-repo' && t.repoId === repo.id)
        if (existing) {
            setActiveTabId(existing.id)
            return
        }
        const tab: EditorTab = {
            id: newTabId(),
            title: `Git — ${repo.name}`,
            path: null,
            content: '',
            dirty: false,
            connId: null,
            // language is a placeholder here, same as the ssh-terminal and
            // sftp kinds — this tab has no CodeMirror document of its own.
            language: 'sql',
            kind: 'git-repo',
            repoId: repo.id,
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
            refreshLiveConnections()
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
            refreshLiveConnections()
            setReloadToken((n) => n + 1)
            if (selected?.id === connId) setSelected(null)
            setTabs((prev) => prev.map((t) => (t.connId === connId ? {...t, connId: null} : t)))
            setStatusMessage('Conexión eliminada')
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

        // A remote file saves over SFTP, never to the user's disk. It is a
        // separate branch rather than a smarter `path` because conflating
        // the two would make Ctrl+S write a server file locally.
        if (tab.kind === 'remote-file' && tab.remote) {
            await saveRemoteTab(tab, tab.remote.modTimeUnix)
            return
        }

        try {
            if (tab.path) {
                await SaveSQLFile(tab.path, tab.content)
                setTabs((prev) => prev.map((t) => (t.id === tab.id ? {...t, dirty: false} : t)))
            } else {
                const dest = await SaveSQLFileAs(`${tab.title}.sql`, tab.content)
                if (dest) {
                    setTabs((prev) =>
                        prev.map((t) => (t.id === tab.id ? {...t, path: dest, title: fileTitle(dest), dirty: false} : t)),
                    )
                }
            }
        } catch (err) {
            setStatusMessage(String(err))
        }
    }

    // saveRemoteTab uploads an edited server file. expectedMtime is what the
    // editor loaded; passing 0 is the deliberate "overwrite anyway" the
    // conflict dialog sends after telling the user.
    async function saveRemoteTab(tab: EditorTab, expectedMtime: number) {
        if (!tab.remote) return
        try {
            const newMtime = await WriteSftpFileFromEdit(tab.remote.sessionId, tab.remote.path, tab.content, expectedMtime)
            setTabs((prev) =>
                prev.map((t) =>
                    t.id === tab.id && t.remote ? {...t, dirty: false, remote: {...t.remote, modTimeUnix: newMtime}} : t,
                ),
            )
            setStatusMessage(`Guardado ${tab.remote.path} en ${tab.remote.connName}`)
        } catch (err) {
            const message = String(err)
            if (message.includes('cambió en el servidor')) {
                // Never overwrite silently: somebody else's change would
                // disappear with nobody noticing.
                setRemoteConflict({tabId: tab.id, path: tab.remote.path, connName: tab.remote.connName})
                return
            }
            setStatusMessage(message)
        }
    }

    // openRemoteFile loads a server file into its own editor tab, or focuses
    // the tab already editing it — reopening would silently discard unsaved
    // edits.
    async function openRemoteFile(host: PaneHost, path: string) {
        if (host.kind !== 'remote') return

        const existing = tabsRef.current.find(
            (t) => t.kind === 'remote-file' && t.remote?.sessionId === host.sessionId && t.remote?.path === path,
        )
        if (existing) {
            setActiveTabId(existing.id)
            return
        }

        try {
            const file = await ReadSftpFileForEdit(host.sessionId, path)
            if (file.binary) {
                setStatusMessage(`"${path}" es un archivo binario — no se puede editar como texto.`)
                return
            }
            if (file.tooLarge) {
                setStatusMessage(`"${path}" es demasiado grande para abrirlo en el editor.`)
                return
            }

            const tab: EditorTab = {
                id: newTabId(),
                title: path.split('/').pop() || path,
                path: null,
                content: file.content,
                dirty: false,
                connId: host.connId,
                language: 'sql',
                kind: 'remote-file',
                remote: {sessionId: host.sessionId, path, connName: host.connName, modTimeUnix: file.modTimeUnix},
            }
            setTabs((prev) => [...prev, tab])
            setActiveTabId(tab.id)
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
            } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') {
                // Asistente de consultas. Solo con una conexión vinculada:
                // sin ella no hay motor cuyo dialecto usar ni esquema que
                // pasarle, y la respuesta sería SQL genérico que puede no
                // correr en ningún lado.
                if (!activeTabConnection) return
                e.preventDefault()
                setNlBar({})
            } else if (e.key === 'F5') {
                e.preventDefault()
                refreshMetadata()
            }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeTabConnection])

    // Re-read which pools are open after anything that could have opened one.
    // Selecting a connection or switching the active tab's binding is what
    // triggers the lazy open, and reloadToken covers create/import.
    useEffect(refreshLiveConnections, [selected, activeTabConnection, reloadToken])

    const activeResult = resultSets[activeResultTab]
    // Contra qué tabla escriben el INSERT y el UPDATE que genera la grilla.
    // Se resuelve acá, una vez, y baja a la barra de exporte y a la grilla:
    // las dos generan la misma sentencia y tienen que nombrar la misma tabla.
    const sqlTarget = useSqlTarget(activeTabConnection?.id, activeResult?.sourceSql, activeTabConnection?.dbType)
    // La salida de DBMS_OUTPUT de TODO el script, no la del resultset que
    // estés mirando: un script con varios bloques PL/SQL escribe desde todos, y
    // atarla a la pestaña de resultados activa hacía que la salida apareciera y
    // desapareciera según en qué grilla estuvieras parado. Se concatena en el
    // orden en que se ejecutaron los statements, que es el orden en que se
    // imprimieron las líneas.
    const dbmsOutputLines = useMemo(() => resultSets.flatMap((r) => r.dbmsOutput ?? []), [resultSets])

    // La pestaña DBMS_OUTPUT solo existe mientras haya salida, así que una
    // ejecución que no genera ninguna la hace desaparecer — y dejaría la vista
    // parada en una pestaña que ya no está en la tira, mostrando un panel
    // vacío sin nada resaltado arriba. Se vuelve a Resultados, que es donde
    // está lo que esa ejecución sí produjo.
    useEffect(() => {
        if (dbmsOutputLines.length === 0 && activeBottomTab === 'dbms') setActiveBottomTab('results')
    }, [dbmsOutputLines.length, activeBottomTab])
    // Una nota no tiene barra de contexto de conexión: ver isNoteTabActive.
    const isRedisActive = activeTabConnection?.dbType === 'redis'
    const isMongoActive = activeTabConnection?.dbType === 'mongodb'
    const isBrowserTabActive = activeTabData?.kind === 'redis-browser' || activeTabData?.kind === 'mongo-browser'
    const isSshTerminalTabActive = activeTabData?.kind === 'ssh-terminal'
    // Una terminal local ocupa el panel entero, igual que las demás pestañas
    // que no son el editor SQL: sin barra de acciones, sin editor y sin panel
    // de resultados. Sin este flag la pestaña abría con el editor vacío
    // detrás, la barra "Sin conexión" arriba y la grilla "Sin resultados"
    // abajo, dejando la terminal aplastada en el medio.
    const isLocalTerminalTabActive = activeTabData?.kind === 'local-terminal'
    const isSftpTabActive = activeTabData?.kind === 'sftp'
    const isHybridTabActive = activeTabData?.kind === 'ssh-hybrid'
    const isGitTabActive = activeTabData?.kind === 'git-repo'
    const isNoteTabActive = activeTabData?.kind === 'note'
    // Una petición HTTP ocupa todo el cuerpo, igual que Git o una nota: sin
    // esta bandera en las guardas de abajo, el editor SQL y su barra de
    // acciones se seguirían dibujando encima.
    const isHttpTabActive = activeTabData?.kind === 'http-request'
    // Una nota no es una consulta: no tiene conexión, ni esquema, ni botón de
    // ejecutar. La barra de herramientas del editor SQL entera se oculta —
    // dejarla visible decía "Sin conexión" sobre un documento de texto, que es
    // una advertencia sobre un problema que no existe.
    // A remote file is edited in the same CodeMirror as everything else, but
    // it has nothing to run — so the results panel below would sit there
    // permanently empty. The editor takes the whole height instead.
    const isRemoteFileActive = activeTabData?.kind === 'remote-file'
    // Barra compacta: los botones quedan solo con su ícono. Las etiquetas son
    // lo que más ancho ocupa, y el `title` de cada botón —que ya explicaba
    // qué hace y con qué atajo— sigue estando, así que no se pierde nada que
    // no estuviera a un hover de distancia.
    const compactToolbar = editorAppearance.toolbar === 'compact'

    // El ÁREA DE CONSULTA: el editor SQL con su barra de acciones y su panel
    // de resultados abajo. Todo lo demás —un explorador de claves, una
    // terminal, un repositorio, una nota, una petición HTTP— ocupa la pestaña
    // entera y no tiene nada que ejecutar.
    //
    // Estaba escrito tres veces como la misma cadena de nueve negaciones. Una
    // sola constante evita que las tres se desincronicen al agregar una clase
    // de pestaña, que es exactamente el bug que deja media interfaz de una
    // pestaña nueva mostrándose donde no corresponde.
    const isQueryArea =
        !isBrowserTabActive &&
        !isSshTerminalTabActive &&
        !isLocalTerminalTabActive &&
        !isSftpTabActive &&
        !isGitTabActive &&
        !isRemoteFileActive &&
        !isHybridTabActive &&
        !isNoteTabActive &&
        !isHttpTabActive

    return (
        <div className="flex h-full w-full overflow-hidden bg-background font-sans text-on-background">
            <Sidebar
                modules={sidebarModules}
                activeModule={activeModule}
                onSelectModule={selectSidebarModule}
                collapsed={sidebarCollapsed}
                onToggleCollapsed={toggleSidebarCollapsed}
                filter={sidebarFilter}
                onFilterChange={setSidebarFilter}
                width={sidebarWidth}
                onStartResize={startSidebarResize}
                updateAvailable={updateInfo?.available ? updateInfo.latest : null}
                updateDownloadName={updateInfo?.available ? updateInfo.assetName || null : null}
                onOpenRepo={openRepo}
                theme={theme}
                onToggleTheme={onToggleTheme}
                onOpenSettings={() => setShowSettingsDialog(true)}
                bodies={{
                    http: (
                        <HttpTree
                            filter={sidebarFilter}
                            activeItemId={activeTabData?.httpItemId ?? null}
                            onOpenRequest={openHttpRequest}
                            refreshToken={httpToken}
                            onChanged={bumpHttp}
                            onOpenNote={(id) => openNote(id)}
                            onNewScratch={openHttpScratch}
                        />
                    ),
                    connections: (
                        <ConnectionTree
                selectedId={selected?.id ?? null}
                liveConnIds={liveDbConnIds}
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
                onOpenMongoCollection={openMongoCollection}
                onSelectMongoDatabase={selectMongoDatabase}
                onOpenMongoBrowser={openMongoBrowser}
                onOpenRedisBrowser={openRedisBrowser}
                activeTabConnectionId={activeTabConnection?.id ?? null}
                onExportConnectionConfig={(connId) => void exportConnectionConfig(connId)}
                onExportSchemaDDL={() => void exportSchemaDDL()}
                onDisconnect={(connId) => void disconnectConnection(connId)}
                onDeleteConnection={(connId) => void deleteConnection(connId)}
                onConfigureSchemas={setSchemaPickerConn}
                folders={folders}
                onCreateFolder={(name, parentId) => createFolder(name, parentId, 'db')}
                onRenameFolder={renameFolder}
                onDeleteFolder={deleteFolder}
                onReorderFolder={reorderFolder}
                onMoveConnectionToFolder={moveConnectionToFolder}
                filter={sidebarFilter}
                onMatchCount={setConnectionsMatches}
            />
                    ),
                    ssh: (
                        <SshConnectionTree
                        onNewConnection={() => setConnectionDialog('new-ssh')}
                        onEditConnection={(conn) => setConnectionDialog(conn.id)}
                        onOpenSshTerminal={openSshTerminal}
                        onOpenLocalTerminal={openLocalTerminal}
                        onOpenSftp={openSftp}
                        onOpenSshHybrid={openSshHybrid}
                        activeTabConnectionId={activeTabConnection?.id ?? null}
                        onExportConnectionConfig={(connId) => void exportConnectionConfig(connId)}
                        liveConnIds={liveSshConnIds}
                        onDisconnect={(connId) => void disconnectConnection(connId)}
                        onDeleteConnection={(connId) => void deleteConnection(connId)}
                        reloadToken={reloadToken}
                        folders={folders}
                        onCreateFolder={(name, parentId) => createFolder(name, parentId, 'ssh')}
                        onRenameFolder={renameFolder}
                        onDeleteFolder={deleteFolder}
                        onReorderFolder={reorderFolder}
                        onMoveConnectionToFolder={moveConnectionToFolder}
                        filter={sidebarFilter}
                        onMatchCount={setSshMatches}
                    />
                    ),
                    git: (
                        <GitErrorBoundary label="sidebar Git">
                            <GitRepoTree
                        onOpenRepo={openGitRepo}
                        activeTabRepoId={activeTabData?.repoId ?? null}
                        reloadToken={reloadToken}
                        syncToken={gitSyncToken}
                        onChanged={notifyGitChanged}
                        folders={folders}
                        onCreateFolder={(name, parentId) => createFolder(name, parentId, 'git')}
                        onRenameFolder={renameFolder}
                        onDeleteFolder={deleteFolder}
                        onReorderFolder={reorderFolder}
                        onMoveRepoToFolder={moveGitRepoToFolder}
                        filter={sidebarFilter}
                        onMatchCount={setGitMatches}
                    />
                        </GitErrorBoundary>
                    ),
                    notes: (
                        <NotesTree
                        activeNoteId={activeTabData?.noteId ?? null}
                        onOpenNote={(id) => openNote(id)}
                        onCreated={(id) => {
                            setNotesToken((n) => n + 1)
                            openNote(id)
                        }}
                        reloadToken={notesToken}
                        onOpenGraph={() => setShowNotesGraph(true)}
                        folders={folders}
                        onCreateFolder={(name, parentId) => createFolder(name, parentId, 'note')}
                        onRenameFolder={renameFolder}
                        onDeleteFolder={deleteFolder}
                        onChanged={() => setNotesToken((n) => n + 1)}
                        filter={sidebarFilter}
                        onClearFilter={clearSidebarFilter}
                        onMatchCount={setNotesMatches}
                    />
                    ),
                }}
            />

            {showNotesGraph && (
                <NotesGraphView
                    activeNoteId={activeTabData?.noteId ?? null}
                    onOpenNote={(id) => openNote(id)}
                    onClose={() => setShowNotesGraph(false)}
                />
            )}

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

            {/* El chat unificado envuelve la columna principal en vez de
                montarse adentro de un módulo: es UNO SOLO para toda la app
                (ver components/agent/AgentChatHost.tsx) y su panel comparte el
                ancho con lo que estés mirando, sea el editor SQL, una terminal
                SSH o un repositorio. Los children son exactamente lo que antes
                era la columna principal — el anfitrión aporta su mismo
                contenedor flex. */}
            <AgentChatHost
                context={agentContext}
                // La consulta que estás editando viaja como contexto adjunto:
                // sin esto, "optimizá esta consulta" no tiene ninguna consulta.
                // Solo para pestañas de editor — un browser de Redis o una
                // terminal no tienen texto que adjuntar.
                working={
                    activeTabData?.kind === 'editor' && activeTabData.content.trim()
                        ? {
                              label: 'Consulta del editor',
                              text: activeTabData.content,
                              language: activeTabData.language === 'sql' ? 'sql' : '',
                          }
                        : null
                }
                dock={agentDock}
                size={agentSize}
                onLayoutChange={changeAgentLayout}
                // Mandar un bloque de código de la respuesta a donde estás
                // trabajando. Solo si hay dónde: en una terminal o un browser
                // de Redis el botón no aparece, en vez de aparecer y no hacer
                // nada.
                onInsertText={
                    isNoteTabActive || activeTabData?.kind === 'editor'
                        ? (text) => {
                              const view = isNoteTabActive
                                  ? noteViewsRef.current.get(activeTabId ?? '')
                                  : editorRef.current
                              if (!view) return
                              view.dispatch(view.state.replaceSelection(text.endsWith('\n') ? text : text + '\n'))
                              view.focus()
                          }
                        : null
                }
                insertLabel={
                    isNoteTabActive
                        ? 'Inserta el bloque en la nota, donde está el cursor'
                        : 'Inserta el bloque en el editor, donde está el cursor — no pisa lo que ya escribiste'
                }
            >
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
                        actions row below so neither crowds the other.
                        Deliberately FLAT: plain text and ghost controls, no
                        pill/chip per cluster and no label before a value that
                        already names itself (it used to read "Pestaña
                        vinculada a: X", "Schema: X", "Base: X" inside three
                        separate grey capsules — three levels of chrome around
                        four words). Whitespace separates the clusters; the
                        long explanation each label used to carry lives in the
                        `title` of the thing it described.
                        The ONE exception is an open transaction: that keeps a
                        tinted chip, because it is the only state in this row
                        with pending consequences and it has to catch the eye.
                        Commit/Rollback are mounted only in that state instead
                        of sitting permanently disabled next to the
                        auto-commit switch — a disabled button that is dead
                        99% of the time is pure noise, and its absence already
                        says "no hay nada que confirmar". */}
                    {/* Toda esta fila desaparece en una nota: una nota no tiene
                        conexión, ni esquema, ni auto-commit. Dejarla visible
                        mostraba "Sin conexión" sobre un documento de texto —
                        una advertencia sobre un problema que no existe. */}
                    {/* Lo mismo vale para una terminal local: no tiene conexión
                        que mostrar, y "Sin conexión" sobre la shell de tu propia
                        máquina es una advertencia sobre un problema inexistente. */}
                    {/* La FILA DE CONTEXTO que estaba acá —conexión, esquema,
                        auto-commit, DBMS_OUTPUT y el botón del agente— se mudó
                        al PIE de la pestaña (buscar «BARRA DE ESTADO» al final
                        de este archivo). Dos motivos:

                        - Es estado, no acción. Arriba competía por atención con
                          los botones que sí se aprietan seguido (Ejecutar,
                          Bloque), y empujaba el editor 30px hacia abajo con
                          información que se consulta de reojo. El pie es donde
                          un cliente de base de datos de escritorio pone
                          exactamente esto.
                        - Dejaba el editor con dos barras arriba y ninguna
                          abajo, y el pie del panel de resultados ya existía
                          para decir cómo terminó lo último que corrió. Ahora
                          las dos cosas viven en la misma barra: contra qué
                          corre esta pestaña, y qué pasó la última vez. */}

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
                        now. The old "Regenerar CLAUDE.md" button was removed
                        outright (unused in practice) and the automatic
                        CLAUDE.md generation on open/save was later removed too
                        — the app no longer writes CLAUDE.md/.claude/ into a
                        project directory on its own (it kept recreating files
                        the user had deleted). Hidden entirely for
                        redis-browser/ssh-terminal tabs — none of these
                        (save a .sql file, run a query) apply to either
                        (their `content`/`path` fields are unused
                        placeholders, see EditorTab's doc comment). The
                        context row above stays visible either way —
                        connection status and Settings/theme are still
                        meaningful regardless of which tab kind is active. */}
                    {/* UNA SOLA BARRA. A la izquierda lo que se aprieta
                        —guardar, ejecutar, explicar, refrescar—; a la derecha
                        contra qué corre esta pestaña —esquema y conexión— y el
                        chat. Antes eran dos filas apiladas: una de acciones y
                        otra de contexto, 60px de barras sobre el editor para
                        decir cosas que caben holgadas en una.

                        **Solo íconos, con la explicación en el tooltip.** El
                        rótulo al lado de cada glifo repetía lo que el tooltip
                        ya dice completo, y con nueve botones convertía la barra
                        en un renglón de texto que hay que leer entero para
                        encontrar el que se busca. La única que conserva su
                        nombre es Ejecutar, la acción que se aprieta veinte
                        veces por sesión y la única rellena de la barra. En modo
                        «Compacta» (Configuración → Apariencia) tampoco ella lo
                        lleva.

                        Lo que NO se pierde al sacar los rótulos: el atajo de
                        teclado, que ahora lo dice el tooltip de cada botón, y
                        la advertencia de Explain Analyze, que pasó a ser el
                        color del ícono (el único tertiary de la barra) porque
                        una palabra suelta al lado de un glifo dejaba de decir
                        qué es lo que ejecuta.

                        La barra sigue existiendo aunque no haya nada que
                        ejecutar —un explorador de Redis, SFTP, un archivo
                        remoto— con el cluster de acciones apagado: ahí el dato
                        que importa es a qué servidor está atada la pestaña.

                        **Se va entera** en una nota, una terminal local, una
                        petición HTTP y un repositorio, que no tienen ni
                        conexión ni esquema ("Sin conexión" sobre un documento
                        de texto es una advertencia sobre un problema que no
                        existe) — y también en una terminal SSH o una híbrida.
                        Ahí, con las acciones apagadas y el chat mudado a la
                        fila de la propia terminal, quedaba un renglón de
                        ventana entero para escribir el nombre del servidor, en
                        la punta opuesta a donde está el prompt. Ese dato —el
                        servidor, si sigue conectado y con qué entorno está
                        marcado— pasó al PIE de la terminal (ver
                        components/ssh/SshTerminalTab.tsx), que es donde termina
                        la salida del comando y donde ya está mirando quien se
                        lo pregunta. */}
                    {!isNoteTabActive && !isLocalTerminalTabActive && !isHttpTabActive && !isGitTabActive && !isSshTerminalTabActive && !isHybridTabActive && (
                    <div className="flex flex-wrap items-center gap-1 border-t border-outline-variant px-2 py-1.5">
                        {editorAppearance.toolbar !== 'hidden' && isQueryArea && (
                            <>
                                <button
                                    onClick={() => void saveActiveTab()}
                                    title="Guardar la pestaña en disco (Ctrl+S). Si es una pestaña nueva, te pide dónde guardarla"
                                    className={TOOLBAR_ICON}
                                >
                                    <Icon name="save" size={16} />
                                </button>

                                <Divider />

                                {/* La única acción rellena de la barra, y la
                                    única con nombre. Es la que se aprieta
                                    veinte veces por sesión; el resto son
                                    utilidades que se usan de a ratos. */}
                                <button
                                    onClick={runSelectionOrLine}
                                    disabled={!activeTabConnection || running}
                                    title="Ejecutar lo seleccionado, o la sentencia donde está el cursor si no hay selección (Ctrl+Enter)"
                                    className={`${TOOLBAR_BTN} bg-secondary-container font-semibold text-on-secondary-container hover:opacity-90`}
                                >
                                    <Icon name="play_arrow" size={16} filled />
                                    {!compactToolbar && 'Ejecutar'}
                                </button>
                                <button
                                    onClick={runFullScript}
                                    disabled={!activeTabConnection || running}
                                    title="Ejecutar TODOS los statements del editor en orden, uno por uno (Ctrl+Shift+Enter)"
                                    className={TOOLBAR_ICON}
                                >
                                    <Icon name="playlist_play" size={16} />
                                </button>
                                {/* Rojo solo mientras hay algo que cancelar. Un
                                    botón de alarma permanentemente encendido y
                                    permanentemente deshabilitado enseña a
                                    ignorar el color justo antes de que haga
                                    falta. */}
                                <button
                                    onClick={cancelQuery}
                                    disabled={!running}
                                    title={running ? 'Interrumpir la consulta que está corriendo ahora mismo' : 'Cancelar: deshabilitado, no hay ninguna consulta corriendo'}
                                    className={running ? `${TOOLBAR_BTN} bg-error-container text-on-error-container hover:opacity-90` : TOOLBAR_ICON}
                                >
                                    <Icon name="stop" size={16} filled />
                                </button>

                                {isSqlActive && (
                                    <>
                                        <Divider />

                                        <button
                                            onClick={() => void runExplain(false)}
                                            disabled={!activeTabConnection}
                                            title="Explain: muestra el plan de ejecución SIN correr nada. Explica lo que tengas seleccionado; sin selección, la sentencia donde está el cursor — no el archivo entero"
                                            className={TOOLBAR_ICON}
                                        >
                                            <Icon name="query_stats" size={16} />
                                        </button>
                                        {/* La diferencia con Explain es que
                                            este SÍ corre la consulta, y eso hay
                                            que decirlo. Lo dice el color del
                                            ícono —el único tertiary de la
                                            barra— más el tooltip, que abre con
                                            la advertencia en vez de terminar
                                            con ella. */}
                                        <button
                                            onClick={() => void runExplain(true)}
                                            disabled={!activeTabConnection}
                                            title="Explain Analyze — EJECUTA la consulta de verdad contra la base y muestra el plan con filas y tiempos reales. Corre lo seleccionado; sin selección, la sentencia donde está el cursor. Si modifica datos se pide confirmación y la ejecución va en una transacción que se revierte"
                                            className={`${TOOLBAR_ICON} hover:bg-tertiary/10`}
                                        >
                                            <Icon name="analytics" size={16} className="text-tertiary" />
                                        </button>

                                        <Divider />

                                        <button
                                            onClick={refreshMetadata}
                                            disabled={!activeTabConnection}
                                            title="Refrescar el catálogo: vuelve a leer tablas y columnas de la base (F5) — usalo si acabás de crear o alterar una tabla"
                                            className={TOOLBAR_ICON}
                                        >
                                            <Icon name="refresh" size={16} />
                                        </button>
                                    </>
                                )}
                            </>
                        )}

                        {/* Interruptores de la sesión. Van con las acciones
                            —son un clic, no un dato— pero después del divisor:
                            no se aprietan en el mismo gesto que Ejecutar. */}
                        {isSqlActive && (
                            <>
                                <Divider />
                                {/* Transacción abierta: el único estado de la
                                    barra que conserva rótulo y fondo teñido. Es
                                    el que tiene consecuencias pendientes —hay
                                    cambios sin confirmar— y tiene que
                                    interrumpir la lectura, no integrarse a
                                    ella. Commit y Rollback se montan solo en
                                    ese estado: un botón deshabilitado el 99 %
                                    del tiempo es ruido, y su ausencia ya dice
                                    que no hay nada que confirmar. */}
                                {txOpen ? (
                                    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-tertiary-container py-0.5 pl-2 pr-1 text-xs text-on-tertiary-container">
                                        <Icon name="warning" size={13} />
                                        <span className="font-medium">Transacción abierta</span>
                                        <button
                                            onClick={() => void commitTransaction()}
                                            disabled={txBusy}
                                            title="Commit: confirma de forma permanente todos los cambios (INSERT/UPDATE/DELETE) hechos desde que se abrió la transacción, y vuelve a auto-commit"
                                            className="flex h-5 w-5 items-center justify-center rounded-full bg-secondary-container text-on-secondary-container hover:opacity-90 disabled:opacity-40"
                                        >
                                            <Icon name="check_circle" size={13} />
                                        </button>
                                        <button
                                            onClick={() => void rollbackTransaction()}
                                            disabled={txBusy}
                                            title="Rollback: descarta todos los cambios pendientes de la transacción, vuelve al estado previo a abrirla y reactiva el auto-commit"
                                            className="flex h-5 w-5 items-center justify-center rounded-full bg-error-container text-on-error-container hover:opacity-90 disabled:opacity-40"
                                        >
                                            <Icon name="undo" size={13} />
                                        </button>
                                    </span>
                                ) : (
                                    <button
                                        onClick={() => void beginTransaction()}
                                        disabled={txBusy}
                                        title="Auto-commit activo: cada statement se aplica solo apenas termina. Clic para pasar a transacción manual — a partir de ahí los cambios quedan pendientes hasta que hagas Commit o Rollback"
                                        className={TOOLBAR_ICON_ON}
                                    >
                                        <Icon name="bolt" size={16} filled />
                                    </button>
                                )}
                            </>
                        )}

                        {isSqlActive && activeTabConnection?.dbType === 'oracle' && (
                            <button
                                onClick={() => setDbmsOutputEnabled(!dbmsOutputEnabled)}
                                title={
                                    dbmsOutputEnabled
                                        ? 'DBMS_OUTPUT activado: se captura el log de DBMS_OUTPUT.PUT_LINE de cada bloque PL/SQL y aparece en su propia solapa. Clic para desactivarlo — en un script con muchos bloques ahorra los round-trips de ENABLE/GET_LINE'
                                        : 'DBMS_OUTPUT desactivado: los PUT_LINE de tus bloques PL/SQL no se leen ni se muestran. Clic para capturarlos'
                                }
                                className={dbmsOutputEnabled ? TOOLBAR_ICON_ON : TOOLBAR_ICON}
                            >
                                <Icon name="wysiwyg" size={16} />
                            </button>
                        )}

                        {/* Cargando el catálogo: solo el ícono girando. Es un
                            estado que dura segundos y no vale un rótulo que
                            corra de lugar a todo lo que tiene al lado. */}
                        {isSqlActive && editorMetadataLoading && (
                            <span
                                className="flex h-7 w-7 shrink-0 items-center justify-center"
                                title="Leyendo tablas, columnas y rutinas de la conexión para el autocompletado del editor"
                            >
                                <span
                                    aria-hidden
                                    className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-t-transparent border-primary"
                                />
                            </span>
                        )}
                        {isSqlActive && !editorMetadataLoading && indexError && (
                            <span
                                className="flex h-7 w-7 shrink-0 items-center justify-center text-error"
                                title={`El editor no pudo leer el catálogo de esta conexión, así que el autocompletado solo ofrece palabras clave y funciones — sin tablas ni columnas. Motivo: ${indexError}. Suele ser permisos sobre el diccionario de datos o una conexión que se cayó; reconectar vuelve a intentarlo.`}
                            >
                                <Icon name="warning" size={16} />
                            </span>
                        )}

                        <div className="flex-1" />

                        {/* De acá a la derecha, CONTRA QUÉ corre la pestaña.
                            Conserva texto porque son valores, no estados: el
                            esquema y el nombre de la conexión son el dato. */}
                        {isSqlActive && !editorMetadataLoading && editorSchemas.length > 0 && (
                            <Select
                                value={editorActiveSchema ?? ''}
                                options={editorSchemas.map((sch) => ({value: sch, label: sch, icon: <Icon name="schema" size={14} />}))}
                                onChange={(v) =>
                                    activeTabConnection && setActiveSchemaByConn((prev) => ({...prev, [activeTabConnection.id]: v}))
                                }
                                size="sm"
                                variant="ghost"
                                ariaLabel="Schema activo"
                                title="Schema activo de esta conexión: acota el autocompletado del editor y es el que se asume cuando escribís una tabla sin prefijo"
                                className="max-w-44"
                            />
                        )}

                        {isMongoActive && activeTabConnection && (
                            <span className="inline-flex items-center gap-1 whitespace-nowrap">
                                <Select
                                    value={mongoDbByConn[activeTabConnection.id] ?? ''}
                                    options={(mongoDatabasesByConn[activeTabConnection.id] ?? []).map((dbName) => ({
                                        value: dbName,
                                        label: dbName,
                                        icon: <Icon name="database" size={14} />,
                                    }))}
                                    onChange={(v) => selectMongoDatabase(activeTabConnection.id, v)}
                                    placeholder="elegí una base"
                                    size="sm"
                                    variant="ghost"
                                    ariaLabel="Base de datos activa de MongoDB"
                                    title="Base de datos a la que apunta `db` en el editor mongosh — cambiarla acá reapunta todos los comandos de esta pestaña"
                                    className="max-w-44"
                                />
                                <button
                                    onClick={() => setShowMongoWizard(true)}
                                    disabled={!mongoDbByConn[activeTabConnection.id]}
                                    title={
                                        mongoDbByConn[activeTabConnection.id]
                                            ? 'Asistente de consulta: armá un find() visualmente (colección, condiciones, orden, límite) — se abre en una pestaña de editor y se ejecuta'
                                            : 'Asistente de consulta: elegí primero una base de datos, el asistente necesita saber sobre qué colecciones armar el find()'
                                    }
                                    className={TOOLBAR_ICON}
                                >
                                    <Icon name="auto_awesome" size={16} />
                                </button>
                            </span>
                        )}

                        {/* El estado de una terminal SSH ya no se dibuja
                            acá: esta barra no existe en esa pestaña, y su
                            propio pie lo dice mejor —con la sesión real
                            delante, no con el registro global de terminales
                            vivas. */}
                        <span
                            className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap px-1 text-xs text-on-surface-variant"
                            title={
                                activeTabConnection
                                    ? `Esta pestaña ejecuta contra la conexión "${activeTabConnection.name}" (${dbTypeLabel(activeTabConnection.dbType)}). Para cambiarla, usá el selector que está a la izquierda del título de la pestaña.`
                                    : 'Esta pestaña no está vinculada a ninguna conexión, así que todavía no puede ejecutar nada. Vinculala con el ícono que está a la izquierda del título de la pestaña.'
                            }
                        >
                            <span
                                aria-hidden
                                className={`h-1.5 w-1.5 shrink-0 rounded-full ${activeTabConnection ? 'bg-secondary' : 'bg-outline'}`}
                            />
                            {/* El logo del motor y no un ícono genérico de
                                base: con ocho pestañas abiertas es lo que dice
                                de un vistazo si esta corre contra Oracle o
                                contra la réplica de Postgres. */}
                            {activeTabConnection && <DbTypeIcon dbType={activeTabConnection.dbType} size={13} />}
                            <span className={`truncate ${activeTabConnection ? 'text-on-surface' : ''}`}>
                                {activeTabConnection ? activeTabConnection.name : 'Sin conexión'}
                            </span>
                        </span>

                        {/* Punto de entrada GENÉRICO al chat: sirve desde
                            cualquier módulo justamente porque no sabe de
                            ninguno. Solo ícono, como el resto de la barra: la
                            palabra «Agente» la dice el tooltip.

                            **En una terminal SSH no se dibuja acá**: esa
                            pestaña tiene su propia fila —Historial, Analizar
                            error, Snippets, Tema— y el chat vive ahí, al lado
                            de «Analizar error», que le habla al mismo agente.
                            Dos botones idénticos en la misma pantalla, uno en
                            cada punta, son dos preguntas sobre cuál hace qué.
                            Vale también para la pestaña híbrida, que monta esa
                            misma terminal adentro. */}
                        {!isSshTerminalTabActive && !isHybridTabActive && (
                            <>
                                <Divider />
                                <AgentChatButton compact />
                            </>
                        )}
                    </div>
                    )}
                </div>

                <div
                    className="relative min-w-0 border-b border-outline-variant"
                    style={{
                        height: isRemoteFileActive ? '100%' : editorHeight,
                        display: isBrowserTabActive || isSshTerminalTabActive || isLocalTerminalTabActive || isSftpTabActive || isGitTabActive || isHybridTabActive || isNoteTabActive || isHttpTabActive ? 'none' : undefined,
                    }}
                >
                    {/* Asistente de consultas: flota SOBRE el editor en vez de
                        empujarlo. Abrirlo no puede mover el texto que uno está
                        mirando — y menos cuando lo que va a proponer es un
                        cambio sobre ese mismo texto. */}
                    {nlBar && activeTabConnection && (
                        <NlPromptBar
                            connId={activeTabConnection.id}
                            connName={activeTabConnection.name}
                            dbType={activeTabConnection.dbType}
                            currentSql={activeTabData?.content ?? ''}
                            errorText={nlBar.errorText}
                            onApply={(code) => updateActiveTabContent(code)}
                            onClose={() => setNlBar(null)}
                        />
                    )}
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
                        connId={activeTabConnection?.id ?? null}
                        schemaMetadata={filteredEditorMetadata}
                        editorThemeId={editorThemeId}
                        appearance={editorAppearance}
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

                {/* MongoDB Browser tabs — same never-unmount-just-hide
                    treatment as Redis Browser above. */}
                {tabs
                    .filter((t) => t.kind === 'mongo-browser' && t.connId)
                    .map((t) => (
                        <div
                            key={t.id}
                            className="flex min-h-0 flex-1 overflow-hidden"
                            style={{display: activeTabId === t.id ? undefined : 'none'}}
                        >
                            <MongoBrowserTab
                                connId={t.connId as string}
                                initialDatabase={pendingMongoBrowser?.connId === t.connId ? pendingMongoBrowser.database : undefined}
                                initialCollection={pendingMongoBrowser?.connId === t.connId ? pendingMongoBrowser.collection : undefined}
                                initialToken={pendingMongoBrowser?.token}
                                onSelectCollection={(database, collection) => {
                                    const id = t.connId as string
                                    setMongoDbByConn((prev) => ({...prev, [id]: database}))
                                    setMongoCollByConn((prev) => ({...prev, [id]: collection}))
                                }}
                                onOpenWizard={() => setShowMongoWizard(true)}
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
                                connName={connections.find((c) => c.id === t.connId)?.name ?? t.title}
                                theme={theme}
                                terminalThemeId={terminalThemeId}
                                onChangeTerminalTheme={changeTerminalTheme}
                                terminalFontSize={terminalFontSize}
                                onConnectedChange={(connected) => setSshConnected(t.connId as string, connected)}
                            />
                        </div>
                    ))}

                {/* Terminales locales. Mismo trato de "nunca desmontar, solo
                    esconder" que las de SSH: adentro hay un proceso del sistema
                    operativo con su directorio y su scrollback, y desmontarlo al
                    cambiar de pestaña sería matarlo. */}
                {tabs
                    .filter((t) => t.kind === 'local-terminal')
                    .map((t) => (
                        <div
                            key={t.id}
                            className="flex min-h-0 flex-1 overflow-hidden"
                            style={{display: activeTabId === t.id ? undefined : 'none'}}
                        >
                            <LocalTerminalTab
                                sessionId={`local-tab-${t.id}`}
                                shellId={t.shellId ?? ''}
                                shellLabel={t.shellLabel ?? ''}
                                theme={theme}
                                terminalThemeId={terminalThemeId}
                                onChangeTerminalTheme={changeTerminalTheme}
                                terminalFontSize={terminalFontSize}
                                visible={activeTabId === t.id}
                            />
                        </div>
                    ))}

                {/* Combined terminal + files. Same never-unmount treatment:
                    the shell inside must survive switching tabs. */}
                {tabs
                    .filter((t) => t.kind === 'ssh-hybrid' && t.connId)
                    .map((t) => (
                        <div
                            key={t.id}
                            className="flex min-h-0 flex-1 overflow-hidden"
                            style={{display: activeTabId === t.id ? undefined : 'none'}}
                        >
                            <SshHybridTab
                                connId={t.connId as string}
                                connName={connections.find((c) => c.id === t.connId)?.name ?? ''}
                                connections={connections.filter((c) => c.dbType === 'ssh')}
                                theme={theme}
                                terminalThemeId={terminalThemeId}
                                onChangeTerminalTheme={changeTerminalTheme}
                                terminalFontSize={terminalFontSize}
                                onConnectedChange={(connected) => setSshConnected(t.connId as string, connected)}
                                onOpenRemoteFile={(host, path) => void openRemoteFile(host, path)}
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
                                onOpenRemoteFile={(host, path) => void openRemoteFile(host, path)}
                            />
                        </div>
                    ))}

                {/* Same never-unmount-just-hide treatment as the tabs above:
                    a Git tab holds a selected commit, a selected file, the
                    scroll position of a long history, and a CodeMirror diff
                    view — remounting on every tab switch would throw all of
                    that away and re-run four git invocations. */}
                {tabs
                    .filter((t) => t.kind === 'git-repo' && t.repoId)
                    .map((t) => (
                        <div
                            key={t.id}
                            className="flex min-h-0 flex-1 overflow-hidden"
                            style={{display: activeTabId === t.id ? undefined : 'none'}}
                        >
                            <GitErrorBoundary label={t.title}>
                                <GitRepoTab
                                    repoId={t.repoId as string}
                                    repoName={t.title.replace(/^Git — /, '')}
                                    editorThemeId={editorThemeId}
                                    appearance={editorAppearance}
                                    appTheme={theme}
                                    terminalThemeId={terminalThemeId}
                                    onChangeTerminalTheme={changeTerminalTheme}
                                    terminalFontSize={terminalFontSize}
                                    onChangeTerminalFontSize={changeTerminalFontSize}
                                    localShellId={localShellId}
                                    syncToken={gitSyncToken}
                                    onChanged={notifyGitChanged}
                                    active={activeTabId === t.id}
                                />
                            </GitErrorBoundary>
                        </div>
                    ))}

                {/* Las peticiones HTTP también quedan montadas y ocultas:
                    una pestaña guarda el cuerpo a medio escribir, la
                    respuesta recibida y el historial cargado — desmontarla al
                    cambiar de pestaña tiraría las tres cosas y obligaría a
                    volver a mandar la petición para recuperarlas. */}
                {tabs
                    .filter((t) => t.kind === 'http-request')
                    .map((t) => (
                        <div
                            key={t.id}
                            className="flex w-full min-w-0 flex-1 overflow-hidden"
                            style={{display: activeTabId === t.id ? undefined : 'none'}}
                        >
                            <HttpRequestTab
                                itemId={t.httpItemId ?? null}
                                editorThemeId={editorThemeId}
                                appTheme={theme}
                                appearance={editorAppearance}
                                onChanged={bumpHttp}
                                onSaved={(item) => bindHttpTab(t.id, item)}
                                active={activeTabId === t.id}
                            />
                        </div>
                    ))}

                {/* Cada nota abierta queda montada y se oculta con CSS,
                    mismo criterio que las pestañas de Git y los browsers:
                    desmontarla perdería el historial de deshacer del editor y
                    el estado de la vista previa cada vez que se cambia de
                    pestaña y se vuelve. */}
                {tabs
                    .filter((t) => t.kind === 'note' && t.noteId)
                    .map((t) => (
                        <div
                            key={t.id}
                            className="flex w-full min-w-0 flex-1 overflow-hidden"
                            style={{display: activeTabId === t.id ? undefined : 'none'}}
                        >
                            <NoteEditorTab
                                noteId={t.noteId as string}
                                editorThemeId={editorThemeId}
                                appTheme={theme}
                                onOpenNote={(id) => openNote(id)}
                                onCreateNote={(title) => {
                                    void CreateNote(title, '')
                                        .then((id) => {
                                            setNotesToken((n) => n + 1)
                                            openNote(id, title)
                                        })
                                        .catch(() => {})
                                }}
                                onClosed={() => closeTab(t.id)}
                                onViewReady={(view) => {
                                    // Solo la nota ACTIVA queda apuntada: con
                                    // varias abiertas, la última en montarse
                                    // no es necesariamente la que se está
                                    // mirando, y el chat insertaría en la
                                    // equivocada.
                                    if (view) noteViewsRef.current.set(t.id, view)
                                    else noteViewsRef.current.delete(t.id)
                                }}
                                onChanged={(title) => {
                                    setNotesToken((n) => n + 1)
                                    if (title) {
                                        setTabs((prev) =>
                                            prev.map((x) => (x.id === t.id ? {...x, title} : x)),
                                        )
                                    }
                                }}
                            />
                        </div>
                    ))}

                {/* The bottom panel belongs to the SQL editor. A remote-file or
                    hybrid-session tab has nothing to run, so it would sit there
                    permanently empty while stealing height from the terminal
                    and the file drawer, which is exactly the space they need. */}
                {isQueryArea && (
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
                                title="Resultado de la última ejecución: la grilla de filas devueltas"
                                className={`flex items-center gap-1.5 rounded-t-xs px-3 py-1 text-xs ${
                                    activeBottomTab === 'results'
                                        ? 'bg-surface text-on-surface'
                                        : 'text-on-surface-variant hover:text-on-surface'
                                }`}
                            >
                                <Icon name="table_chart" size={14} className="opacity-70" />
                                Resultados
                            </button>
                            {!isRedisActive && !isMongoActive && (
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
                            {/* DBMS_OUTPUT es una pestaña y no un cajón al pie
                                de "Resultados": un bloque PL/SQL de proceso no
                                devuelve resultset, así que su salida quedaba
                                apretada en 128px debajo de una grilla vacía
                                enorme. Como pestaña recibe el panel entero, y
                                sigue el mismo estándar que Consola — solo
                                aparece cuando hay algo que mostrar, y avisa
                                desde el título cuánto hay. */}
                            {dbmsOutputLines.length > 0 && (
                                <button
                                    onClick={() => selectBottomTab('dbms')}
                                    title={`Salida de DBMS_OUTPUT.PUT_LINE del último bloque PL/SQL ejecutado — ${dbmsOutputLines.length} ${dbmsOutputLines.length === 1 ? 'línea' : 'líneas'}, con filtro y copiado`}
                                    className={`flex items-center gap-1.5 rounded-t-xs px-3 py-1 text-xs ${
                                        activeBottomTab === 'dbms'
                                            ? 'bg-surface text-on-surface'
                                            : 'text-on-surface-variant hover:text-on-surface'
                                    }`}
                                >
                                    <Icon name="wysiwyg" size={14} className="opacity-70" />
                                    DBMS_OUTPUT
                                    <span className="rounded-full bg-primary/15 px-1.5 font-mono text-ui-10 tabular-nums text-primary">
                                        {dbmsOutputLines.length}
                                    </span>
                                </button>
                            )}
                            {showExplain && (
                                <button
                                    onClick={() => selectBottomTab('explain')}
                                    title="Plan de ejecución de la última consulta explicada, con métricas y diagnóstico. Se cierra con la X, como una pestaña de resultados."
                                    className={`flex items-center gap-1.5 rounded-t-xs py-1 pl-3 pr-1.5 text-xs ${
                                        activeBottomTab === 'explain'
                                            ? 'bg-surface text-on-surface'
                                            : 'text-on-surface-variant hover:text-on-surface'
                                    }`}
                                >
                                    <Icon name="query_stats" size={14} className="opacity-70" />
                                    {explainPlan?.analyzed ? 'Explain Analyze' : 'Explain'}
                                    {explainCriticalCount > 0 && (
                                        <span
                                            className="rounded-full bg-error/20 px-1 text-ui-9 font-semibold text-error"
                                            title={`${explainCriticalCount} problema(s) crítico(s) detectado(s) en el plan`}
                                        >
                                            {explainCriticalCount}
                                        </span>
                                    )}
                                    <span
                                        role="button"
                                        tabIndex={-1}
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            closeExplain()
                                        }}
                                        title="Cierra el plan de ejecución"
                                        className="ml-0.5 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                                    >
                                        <Icon name="close" size={12} />
                                    </span>
                                </button>
                            )}
                        </div>

                        {activeBottomTab === 'results' ? (
                    isRedisActive ? (
                        <RedisResultView results={redisResults} />
                    ) : isMongoActive ? (
                        <MongoResultView results={mongoResults} />
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
                                    sqlTarget={sqlTarget}
                                />
                            </div>

                            <ResultGrid
                                columns={activeResult?.columns ?? []}
                                rows={activeResult?.rows ?? []}
                                sortColumn={activeResult?.sortColumn}
                                sortDirection={activeResult?.sortDirection}
                                onSort={sortActiveResult}
                                sqlTarget={sqlTarget}
                                // Con la conexión y la consulta que produjo
                                // estas filas, la grilla puede editar: el
                                // backend decide si salen de una sola tabla con
                                // clave primaria y escribe el UPDATE.
                                connId={activeTabConnection?.id}
                                sqlText={activeResult?.sourceSql}
                            />

                            {/* Barra de paginación, estilo DataGrip: el backend
                                entrega la primera página y deja el cursor
                                abierto si quedan filas (ver paging.go). */}
                            {activeResult && activeResult.rows.length > 0 && (
                                <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-outline-variant bg-surface-container-low px-2 py-1 text-ui-11 text-on-surface-variant">
                                    <span>
                                        Mostrando <span className="font-mono text-on-surface">{activeResult.rows.length.toLocaleString()}</span>
                                        {activeResult.hasMore ? '+' : ''} filas
                                    </span>

                                    {activeResult.hasMore && !activeResult.loadingMore && (
                                        <button
                                            onClick={fetchMoreRows}
                                            title="Traer las próximas filas del mismo resultado — no vuelve a ejecutar la consulta, sigue leyendo el cursor abierto"
                                            className="rounded bg-surface-variant px-2 py-0.5 text-on-surface-variant hover:bg-surface-container-highest"
                                        >
                                            Cargar {pageSize === 0 ? 'todo' : pageSize.toLocaleString()} más
                                        </button>
                                    )}
                                    {activeResult.loadingMore && (
                                        <>
                                            <span className="flex items-center gap-1 text-primary">
                                                <span aria-hidden className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-t-transparent border-primary" />
                                                Cargando más…
                                            </span>
                                            <button
                                                onClick={cancelQuery}
                                                title="Cancelar la carga de esta página — las filas ya traídas se conservan"
                                                className="rounded bg-error-container px-2 py-0.5 text-on-error-container hover:opacity-90"
                                            >
                                                Cancelar
                                            </button>
                                        </>
                                    )}
                                    {!activeResult.hasMore && <span className="opacity-70">— resultado completo</span>}

                                    <label className="ml-auto flex items-center gap-1" title="Cuántas filas trae cada página. 'Todas' desactiva la paginación — cuidado con tablas grandes. Se guarda como preferencia.">
                                        Filas por página
                                        <select
                                            value={pageSize}
                                            onChange={(e) => {
                                                const n = Number(e.target.value)
                                                setPageSize(n)
                                                void SetQueryPageSize(n).catch(() => {})
                                            }}
                                            className="rounded border-none bg-surface-container-highest px-1 py-0.5 text-ui-11 text-on-surface outline-none focus:ring-1 focus:ring-primary"
                                        >
                                            {[10, 100, 250, 500, 1000, 5000].map((n) => (
                                                <option key={n} value={n}>
                                                    {n.toLocaleString()}
                                                </option>
                                            ))}
                                            <option value={0}>Todas</option>
                                        </select>
                                    </label>
                                </div>
                            )}

                        </>
                    )
                ) : activeBottomTab === 'console' ? (
                    <ExecutionConsole entries={consoleLog} running={running} onClear={() => setConsoleLog([])} />
                ) : activeBottomTab === 'dbms' ? (
                    <DbmsOutputPanel lines={dbmsOutputLines} />
                ) : activeBottomTab === 'explain' ? (
                    <Suspense fallback={null}>
                        <ExplainPlanPanel
                            plan={explainPlan}
                            loading={explainLoading}
                            error={explainError}
                            connId={activeTabConnection?.id ?? null}
                            connName={activeTabConnection?.name}
                        />
                    </Suspense>
                ) : null}

                {/* Pie del PANEL DE RESULTADOS: cómo terminó lo último que se
                    ejecutó. Vive pegado a la grilla que describe —no en la
                    barra de herramientas de arriba— porque es la respuesta a
                    lo que se está mirando ahí abajo. */}
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
                        <>
                            <span className="min-w-0 flex-1 truncate text-error" title={activeResult.error}>
                                {activeResult.error}
                            </span>
                            {/* El error del motor trae adentro más información
                                que cualquier resumen (`ORA-00942`, un SQLSTATE),
                                y con el esquema al lado suele alcanzar para
                                decir qué está mal. Va acá, pegado al error, y
                                no en un menú: es donde uno está mirando cuando
                                le pasa. */}
                            {activeTabConnection && (
                                <button
                                    onClick={() => setNlBar({errorText: activeResult.error})}
                                    title="Le pasa al agente el error, la consulta y el esquema de las tablas que menciona, y propone la versión corregida. No la ejecuta: la aplicás vos."
                                    className="flex shrink-0 items-center gap-1 rounded bg-error-container px-2 py-0.5 text-ui-11 text-on-error-container hover:opacity-90"
                                >
                                    <Icon name="healing" size={12} />
                                    Explicar y corregir
                                </button>
                            )}
                        </>
                    )}
                    {statusMessage && (
                        <span className="min-w-0 flex-1 truncate" title={statusMessage}>
                            {statusMessage}
                        </span>
                    )}
                </div>
                    </>
                )}
            </AgentChatHost>

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
                        editorAppearance={editorAppearance}
                        onChangeEditorAppearance={changeEditorAppearance}
                        uiFontScale={uiFontScale}
                        onChangeUIFontScale={onChangeUIFontScale}
                        terminalThemeId={terminalThemeId}
                        onChangeTerminalThemeId={changeTerminalTheme}
                        terminalFontSize={terminalFontSize}
                        onChangeTerminalFontSize={changeTerminalFontSize}
                        localShellId={localShellId}
                        onChangeLocalShellId={changeLocalShell}
                        backupResult={backupResult}
                        onBackupVault={() => {
                            // El resultado anterior se limpia al pedir uno
                            // nuevo: dejar el «guardado en …» de hace un rato
                            // mientras corre otro backup es peor que no mostrar
                            // nada, porque no se distingue de la respuesta a
                            // este pedido.
                            setBackupResult(null)
                            setShowSettingsDialog(false)
                            setShowBackupPasswordDialog(true)
                        }}
                        onRestoreVault={() => {
                            setShowSettingsDialog(false)
                            setShowRestoreDialog(true)
                        }}
                        autoBackupEnabled={autoBackupEnabled}
                        onToggleAutoBackup={(checked) => void toggleAutoBackup(checked)}
                        autoBackupIntervalHours={autoBackupIntervalHours}
                        onChangeAutoBackupInterval={changeAutoBackupInterval}
                        autoBackupPath={autoBackupPath}
                        onPickAutoBackupFolder={() => void pickAutoBackupFolder()}
                        autoSaveEnabled={autoSaveEnabled}
                        onToggleAutoSave={toggleAutoSave}
                        autoSaveIntervalSeconds={autoSaveIntervalSeconds}
                        onChangeAutoSaveInterval={changeAutoSaveInterval}
                        updateInfo={updateInfo}
                        onOpenRepo={openRepo}
                        onClose={() => {
                            setShowSettingsDialog(false)
                            // Cerrar Configuración da el aviso por leído: al
                            // volver a abrirla, un «guardado en …» de la semana
                            // pasada se leería como que el backup se acaba de
                            // hacer.
                            setBackupResult(null)
                        }}
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
            {pendingAnalyzeRun && activeTabConnection && (
                <ConfirmDialog
                    title="Explain Analyze ejecuta la consulta"
                    description="Este script modifica datos o estructura (INSERT/UPDATE/DELETE/DDL). EXPLAIN ANALYZE lo ejecuta de verdad para poder medirlo. Se correrá dentro de una transacción que se revierte al terminar, así que no deberían quedar cambios aplicados — pero los disparadores, secuencias y efectos fuera de la transacción sí ocurren."
                    confirmLabel="Ejecutar y medir"
                    danger
                    onConfirm={() => void executeExplain(pendingAnalyzeRun, true)}
                    onClose={() => setPendingAnalyzeRun(null)}
                />
            )}
            {pendingSqlRun && activeTabConnection && (
                <ConfirmDialog
                    title={pendingSqlRun.title}
                    description={pendingSqlRun.description}
                    confirmLabel="Ejecutar igual"
                    danger
                    onConfirm={() => runText(activeTabConnection, pendingSqlRun.text)}
                    onClose={() => setPendingSqlRun(null)}
                />
            )}
            {paramPrompt && (
                <Suspense fallback={null}>
                    <QueryParamsDialog
                        params={paramPrompt.params}
                        initial={paramDraftsRef.current.get(activeTabIdRef.current) ?? {}}
                        onClose={() => setParamPrompt(null)}
                        onRun={(drafts) => {
                            paramDraftsRef.current.set(activeTabIdRef.current, drafts)
                            const {connection, sqlText} = paramPrompt
                            setParamPrompt(null)
                            runWithParams(
                                connection,
                                sqlText,
                                Object.entries(drafts).map(([name, draft]) => ({
                                    name,
                                    value: draft.value,
                                    type: draft.type,
                                })),
                            )
                        }}
                    />
                </Suspense>
            )}
            {pendingMongoCommandRun && activeTabConnection && (
                <ConfirmDialog
                    title="Comando destructivo"
                    description="Este script incluye un deleteMany/updateMany con filtro vacío o un drop(), que afecta o elimina datos de forma irreversible. ¿Ejecutar de todas formas?"
                    confirmLabel="Ejecutar"
                    danger
                    onConfirm={() => runMongoText(activeTabConnection, pendingMongoCommandRun)}
                    onClose={() => setPendingMongoCommandRun(null)}
                />
            )}
            {remoteConflict && (
                <ConfirmDialog
                    title="El archivo cambió en el servidor"
                    description={`"${remoteConflict.path}" fue modificado en ${remoteConflict.connName} desde que lo abriste. Si continuás, tus cambios reemplazan los que están ahora en el servidor y esos se pierden. Cancelá si preferís volver a abrirlo y comparar primero.`}
                    confirmLabel="Sobrescribir igual"
                    danger
                    onConfirm={() => {
                        const tab = tabsRef.current.find((t) => t.id === remoteConflict.tabId)
                        // mtime 0 = saltear la comprobación, a propósito.
                        if (tab) void saveRemoteTab(tab, 0)
                    }}
                    onClose={() => setRemoteConflict(null)}
                />
            )}

            {showMongoWizard && (
                <MongoFindWizard
                    connId={activeTabConnection?.id}
                    database={activeTabConnection ? mongoDbByConn[activeTabConnection.id] : undefined}
                    initialCollection={activeTabConnection ? mongoCollByConn[activeTabConnection.id] : undefined}
                    onClose={() => setShowMongoWizard(false)}
                    onGenerate={(query, run) => {
                        setShowMongoWizard(false)
                        const conn = activeTabConnection
                        if (!conn) return
                        // If the active tab is a mongosh editor bound to this
                        // connection, insert into it. Otherwise (a MongoDB
                        // Browser tab, or an editor bound elsewhere), open a
                        // fresh mongosh editor tab with the generated query — so
                        // the wizard works from the browser too, not only the
                        // editor.
                        if (activeTabData?.kind === 'editor' && activeTabData.connId === conn.id && editorRef.current) {
                            editorRef.current.dispatch(editorRef.current.state.replaceSelection(query + '\n'))
                            editorRef.current.focus()
                        } else {
                            const tab: EditorTab = {
                                id: newTabId(),
                                title: 'Consulta Mongo',
                                path: null,
                                content: query + '\n',
                                dirty: false,
                                connId: conn.id,
                                language: 'mongosh',
                                kind: 'editor',
                            }
                            setTabs((prev) => [...prev, tab])
                            setActiveTabId(tab.id)
                        }
                        if (run) runMongoText(conn, query)
                    }}
                />
            )}
        </div>
    )
}
