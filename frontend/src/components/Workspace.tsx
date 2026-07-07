import {useCallback, useEffect, useRef, useState} from 'react'
import ConnectionTree from './sidebar/ConnectionTree'
import ConnectionDialog from './connections/ConnectionDialog'
import ResultGrid from './results/ResultGrid'
import ResultTabs from './results/ResultTabs'
import EditorTabs, {EditorTab} from './editor/EditorTabs'
import MonacoSQLEditor from './editor/MonacoSQLEditor'
import RecentFilesMenu from './editor/RecentFilesMenu'
import {
    BackupVault,
    CancelQuery,
    ExecuteQuery,
    GetSchemaMetadata,
    OpenSQLFileDialog,
    OpenSQLFilePath,
    SaveSQLFile,
    SaveSQLFileAs,
} from '../../wailsjs/go/main/App'
import {EventsOn} from '../../wailsjs/runtime'
import {vault} from '../../wailsjs/go/models'
import {setActiveMetadata} from '../monaco/metadataStore'
import {monaco} from '../monaco/setup'

interface QueryEvent {
    type: 'columns' | 'rows' | 'done' | 'cancelled' | 'error'
    statementIndex: number
    totalStatements: number
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
}

function emptyResultSet(): ResultSet {
    return {columns: [], rows: [], status: 'running', rowsAffected: 0, durationMs: 0, error: '', dbmsOutput: []}
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

export default function Workspace() {
    const [selected, setSelected] = useState<vault.ConnectionSummary | null>(null)
    const [showDialog, setShowDialog] = useState(false)
    const [reloadToken, setReloadToken] = useState(0)

    const [tabs, setTabs] = useState<EditorTab[]>(() => [newScratchTab()])
    const [activeTabId, setActiveTabId] = useState(() => tabs[0].id)

    const [running, setRunning] = useState(false)
    const [resultSets, setResultSets] = useState<ResultSet[]>([])
    const [activeResultTab, setActiveResultTab] = useState(0)
    const [backupMessage, setBackupMessage] = useState('')
    const [metadataStatus, setMetadataStatus] = useState('')

    const queryIdRef = useRef<string | null>(null)
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
    const tabsRef = useRef(tabs)
    tabsRef.current = tabs
    const activeTabIdRef = useRef(activeTabId)
    activeTabIdRef.current = activeTabId

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
    // changes, so autocomplete/hover have data as soon as possible.
    useEffect(() => {
        if (!selected) {
            setActiveMetadata(null)
            return
        }
        GetSchemaMetadata(selected.id, false)
            .then(setActiveMetadata)
            .catch((err) => setMetadataStatus(String(err)))
    }, [selected])

    function refreshMetadata() {
        if (!selected) return
        setMetadataStatus('Actualizando metadata…')
        GetSchemaMetadata(selected.id, true)
            .then((meta) => {
                setActiveMetadata(meta)
                setMetadataStatus('Metadata actualizada')
            })
            .catch((err) => setMetadataStatus(String(err)))
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
        runText(text)
    }

    function runFullScript() {
        runText(activeTabData?.content ?? '')
    }

    function cancelQuery() {
        if (queryIdRef.current) {
            void CancelQuery(queryIdRef.current)
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
            setMetadataStatus(String(err))
        }
    }

    async function openRecentFile(path: string) {
        try {
            const file = await OpenSQLFilePath(path)
            if (file) openTabForFile(file.path, file.content)
        } catch (err) {
            setMetadataStatus(String(err))
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
            setMetadataStatus(String(err))
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
            />

            <div className="flex flex-1 flex-col">
                <div className="flex items-center gap-2 border-b border-neutral-800 p-2">
                    <span className="text-xs text-neutral-500">
                        {selected ? `Conectado a: ${selected.name}` : 'Selecciona una conexión'}
                    </span>
                    {metadataStatus && <span className="text-xs text-neutral-500">{metadataStatus}</span>}
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

                <ResultGrid columns={activeResult?.columns ?? []} rows={activeResult?.rows ?? []} />

                {activeResult && activeResult.dbmsOutput.length > 0 && (
                    <pre className="max-h-32 overflow-y-auto border-t border-neutral-800 bg-neutral-950 p-2 text-xs text-neutral-400">
                        {activeResult.dbmsOutput.join('\n')}
                    </pre>
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
