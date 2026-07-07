import {useCallback, useEffect, useRef, useState} from 'react'
import ConnectionTree from './sidebar/ConnectionTree'
import ConnectionDialog from './connections/ConnectionDialog'
import ResultGrid from './results/ResultGrid'
import ResultTabs from './results/ResultTabs'
import ExportMenu from './results/ExportMenu'
import EditorTabs, {EditorTab} from './editor/EditorTabs'
import MonacoSQLEditor from './editor/MonacoSQLEditor'
import RecentFilesMenu from './editor/RecentFilesMenu'
import ExplainPlanPanel from './explain/ExplainPlanPanel'
import {
    BackupVault,
    CancelQuery,
    ExecuteQuery,
    ExplainQuery,
    ExportConnectionConfig,
    ExportSchemaDDL,
    ExportTableDDL,
    GetSchemaMetadata,
    OpenSQLFileDialog,
    OpenSQLFilePath,
    SaveSQLFile,
    SaveSQLFileAs,
} from '../../wailsjs/go/main/App'
import {EventsOn} from '../../wailsjs/runtime'
import {db, explain, vault} from '../../wailsjs/go/models'
import {setActiveMetadata} from '../monaco/metadataStore'
import {monaco} from '../monaco/setup'
import {lintSQL} from '../lib/linter'

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

function newScratchTab(): EditorTab {
    return {id: newTabId(), title: 'Query sin título', path: null, content: 'SELECT 1', dirty: false}
}

// LIMIT/FETCH syntax differs per engine — spec: "doble click tabla en árbol
// → SELECT * LIMIT 100 auto".
function limitQueryFor(dbType: string, table: string): string {
    if (dbType === 'oracle') {
        return `SELECT * FROM ${table} WHERE ROWNUM <= 100`
    }
    return `SELECT * FROM ${table} LIMIT 100`
}

export default function Workspace() {
    const [selected, setSelected] = useState<vault.ConnectionSummary | null>(null)
    const [showDialog, setShowDialog] = useState(false)
    const [reloadToken, setReloadToken] = useState(0)
    const [metadata, setMetadata] = useState<db.SchemaMetadata | null>(null)

    const [tabs, setTabs] = useState<EditorTab[]>(() => [newScratchTab()])
    const [activeTabId, setActiveTabId] = useState(() => tabs[0].id)

    const [running, setRunning] = useState(false)
    const [resultSets, setResultSets] = useState<ResultSet[]>([])
    const [activeResultTab, setActiveResultTab] = useState(0)
    const [backupMessage, setBackupMessage] = useState('')
    const [statusMessage, setStatusMessage] = useState('')

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
            setActiveMetadata(null)
            setMetadata(null)
            return
        }
        GetSchemaMetadata(selected.id, false)
            .then((meta) => {
                setActiveMetadata(meta)
                setMetadata(meta)
            })
            .catch((err) => setStatusMessage(String(err)))
    }, [selected])

    function refreshMetadata() {
        if (!selected) return
        setStatusMessage('Actualizando metadata…')
        GetSchemaMetadata(selected.id, true)
            .then((meta) => {
                setActiveMetadata(meta)
                setMetadata(meta)
                setStatusMessage('Metadata actualizada')
            })
            .catch((err) => setStatusMessage(String(err)))
    }

    const runText = useCallback(
        (sqlText: string) => {
            if (!selected || running || !sqlText.trim()) return

            const queryId = newQueryId()
            queryIdRef.current = queryId
            setRunning(true)
            setResultSets([])
            setActiveResultTab(0)

            const unsubscribe = EventsOn(queryId, (event: QueryEvent) => {
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
                    unsubscribe()
                }
            })

            ExecuteQuery(selected.id, queryId, sqlText).catch((err) => {
                setResultSets([{...emptyResultSet(), status: 'error', error: String(err)}])
                setRunning(false)
                unsubscribe()
            })
        },
        [selected, running],
    )

    // Spec: "linter básico... warning antes de ejecutar". Only for
    // user-initiated runs (selection/line, full block) — not for
    // auto-generated queries (double-click LIMIT, sort-by-column requery),
    // which would otherwise pop this dialog on every double-click.
    function confirmAndRun(sqlText: string) {
        const warnings = lintSQL(sqlText)
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

    function openTableQuery(table: string) {
        if (!selected) return
        const q = limitQueryFor(selected.dbType, table)
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
        <div className="flex h-screen w-screen bg-neutral-950 text-neutral-100">
            <ConnectionTree
                selectedId={selected?.id ?? null}
                onSelect={setSelected}
                onNewConnection={() => setShowDialog(true)}
                reloadToken={reloadToken}
                metadata={metadata}
                onOpenTable={openTableQuery}
                onExportConnectionConfig={(connId) => void exportConnectionConfig(connId)}
                onExportTableDDL={(table, schema) => void exportTableDDL(table, schema)}
            />

            <div className="flex flex-1 flex-col">
                <div className="flex items-center gap-2 border-b border-neutral-800 p-2">
                    <span className="text-xs text-neutral-500">
                        {selected ? `Conectado a: ${selected.name}` : 'Selecciona una conexión'}
                    </span>
                    {statusMessage && <span className="text-xs text-neutral-500">{statusMessage}</span>}
                    {backupMessage && <span className="text-xs text-neutral-500">{backupMessage}</span>}
                    <div className="flex-1" />
                    <button
                        onClick={() => void openFileDialog()}
                        className="rounded bg-neutral-800 px-3 py-1 text-xs font-medium hover:bg-neutral-700"
                    >
                        Abrir
                    </button>
                    <RecentFilesMenu onOpen={(path) => void openRecentFile(path)} />
                    <button
                        onClick={() => void saveActiveTab()}
                        className="rounded bg-neutral-800 px-3 py-1 text-xs font-medium hover:bg-neutral-700"
                    >
                        Guardar (Ctrl+S)
                    </button>
                    <button
                        onClick={refreshMetadata}
                        disabled={!selected}
                        className="rounded bg-neutral-800 px-3 py-1 text-xs font-medium hover:bg-neutral-700 disabled:opacity-50"
                    >
                        Refrescar (F5)
                    </button>
                    <button
                        onClick={() => void exportSchemaDDL()}
                        disabled={!selected}
                        className="rounded bg-neutral-800 px-3 py-1 text-xs font-medium hover:bg-neutral-700 disabled:opacity-50"
                    >
                        DDL schema
                    </button>
                    <button
                        onClick={() => void backupVault()}
                        className="rounded bg-neutral-800 px-3 py-1 text-xs font-medium hover:bg-neutral-700"
                    >
                        Backup vault
                    </button>
                    <button
                        onClick={runSelectionOrLine}
                        disabled={!selected || running}
                        className="rounded bg-emerald-700 px-3 py-1 text-xs font-medium hover:bg-emerald-600 disabled:opacity-50"
                    >
                        Ejecutar (Ctrl+Enter)
                    </button>
                    <button
                        onClick={runFullScript}
                        disabled={!selected || running}
                        className="rounded bg-emerald-800 px-3 py-1 text-xs font-medium hover:bg-emerald-700 disabled:opacity-50"
                    >
                        Bloque (Ctrl+Shift+Enter)
                    </button>
                    <button
                        onClick={cancelQuery}
                        disabled={!running}
                        className="rounded bg-red-800 px-3 py-1 text-xs font-medium hover:bg-red-700 disabled:opacity-50"
                    >
                        Cancelar
                    </button>
                    <button
                        onClick={() => void runExplain(false)}
                        disabled={!selected}
                        className="rounded bg-neutral-800 px-3 py-1 text-xs font-medium hover:bg-neutral-700 disabled:opacity-50"
                    >
                        Explain
                    </button>
                    <button
                        onClick={() => void runExplain(true)}
                        disabled={!selected}
                        className="rounded bg-neutral-800 px-3 py-1 text-xs font-medium hover:bg-neutral-700 disabled:opacity-50"
                    >
                        Explain Analyze
                    </button>
                </div>

                <EditorTabs tabs={tabs} activeId={activeTabId} onSelect={setActiveTabId} onClose={closeTab} onNew={newTab} />

                <div className="h-64 border-b border-neutral-800">
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

                <div className="flex items-center gap-2 border-b border-neutral-800 px-2 py-1">
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
                    <pre className="max-h-32 overflow-y-auto border-t border-neutral-800 bg-neutral-950 p-2 text-xs text-neutral-400">
                        {activeResult.dbmsOutput.join('\n')}
                    </pre>
                )}

                {showExplain && (
                    <ExplainPlanPanel
                        plan={explainPlan}
                        loading={explainLoading}
                        error={explainError}
                        onClose={() => setShowExplain(false)}
                    />
                )}

                <div className="flex items-center gap-4 border-t border-neutral-800 px-3 py-1 text-xs text-neutral-500">
                    {running && <span>Ejecutando…</span>}
                    {activeResult?.status === 'done' && (
                        <span>
                            {activeResult.rowsAffected} filas · {activeResult.durationMs}ms
                        </span>
                    )}
                    {activeResult?.status === 'cancelled' && <span className="text-amber-400">Cancelada</span>}
                    {activeResult?.status === 'error' && <span className="text-red-400">{activeResult.error}</span>}
                </div>
            </div>

            {showDialog && (
                <ConnectionDialog
                    onClose={() => setShowDialog(false)}
                    onSaved={() => {
                        setShowDialog(false)
                        setReloadToken((n) => n + 1)
                    }}
                />
            )}
        </div>
    )
}
