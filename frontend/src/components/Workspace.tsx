import {useCallback, useEffect, useRef, useState} from 'react'
import ConnectionTree from './sidebar/ConnectionTree'
import ConnectionDialog from './connections/ConnectionDialog'
import ResultGrid from './results/ResultGrid'
import ResultTabs from './results/ResultTabs'
import {BackupVault, CancelQuery, ExecuteQuery} from '../../wailsjs/go/main/App'
import {EventsOn} from '../../wailsjs/runtime'
import {vault} from '../../wailsjs/go/models'

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

export default function Workspace() {
    const [selected, setSelected] = useState<vault.ConnectionSummary | null>(null)
    const [showDialog, setShowDialog] = useState(false)
    const [reloadToken, setReloadToken] = useState(0)

    const [sqlText, setSqlText] = useState('SELECT 1')
    const [running, setRunning] = useState(false)
    const [resultSets, setResultSets] = useState<ResultSet[]>([])
    const [activeTab, setActiveTab] = useState(0)
    const [backupMessage, setBackupMessage] = useState('')

    const queryIdRef = useRef<string | null>(null)

    async function backupVault() {
        setBackupMessage('Guardando backup…')
        try {
            const dest = await BackupVault()
            setBackupMessage(dest ? `Backup guardado en ${dest}` : '')
        } catch (err) {
            setBackupMessage(`Error: ${String(err)}`)
        }
    }

    const runQuery = useCallback(() => {
        if (!selected || running) return

        const queryId = newQueryId()
        queryIdRef.current = queryId
        setRunning(true)
        setResultSets([])
        setActiveTab(0)

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

            // A cancellation stops the whole script immediately (no further
            // statements run); otherwise the script is done once the last
            // statement reaches a terminal state.
            if (event.type === 'cancelled' || ((event.type === 'done' || event.type === 'error') && event.statementIndex === event.totalStatements - 1)) {
                setRunning(false)
                unsubscribe()
            }
        })

        ExecuteQuery(selected.id, queryId, sqlText).catch((err) => {
            setResultSets([{...emptyResultSet(), status: 'error', error: String(err)}])
            setRunning(false)
            unsubscribe()
        })
    }, [selected, running, sqlText])

    function cancelQuery() {
        if (queryIdRef.current) {
            void CancelQuery(queryIdRef.current)
        }
    }

    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault()
                runQuery()
            }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [runQuery])

    const active = resultSets[activeTab]

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
                    {backupMessage && <span className="text-xs text-neutral-500">{backupMessage}</span>}
                    <div className="flex-1" />
                    <button
                        onClick={() => void backupVault()}
                        className="rounded bg-neutral-800 px-3 py-1 text-xs font-medium hover:bg-neutral-700"
                    >
                        Backup vault
                    </button>
                    <button
                        onClick={runQuery}
                        disabled={!selected || running}
                        className="rounded bg-emerald-700 px-3 py-1 text-xs font-medium hover:bg-emerald-600 disabled:opacity-50"
                    >
                        Ejecutar (Ctrl+Enter)
                    </button>
                    <button
                        onClick={cancelQuery}
                        disabled={!running}
                        className="rounded bg-red-800 px-3 py-1 text-xs font-medium hover:bg-red-700 disabled:opacity-50"
                    >
                        Cancelar
                    </button>
                </div>

                <textarea
                    value={sqlText}
                    onChange={(e) => setSqlText(e.target.value)}
                    spellCheck={false}
                    className="h-40 resize-none border-b border-neutral-800 bg-neutral-950 p-3 font-mono text-sm text-neutral-100 outline-none"
                />

                <ResultTabs
                    count={resultSets.length}
                    active={activeTab}
                    onSelect={setActiveTab}
                    statuses={resultSets.map((r) => r.status)}
                />

                <ResultGrid columns={active?.columns ?? []} rows={active?.rows ?? []} />

                {active && active.dbmsOutput.length > 0 && (
                    <pre className="max-h-32 overflow-y-auto border-t border-neutral-800 bg-neutral-950 p-2 text-xs text-neutral-400">
                        {active.dbmsOutput.join('\n')}
                    </pre>
                )}

                <div className="flex items-center gap-4 border-t border-neutral-800 px-3 py-1 text-xs text-neutral-500">
                    {running && <span>Ejecutando…</span>}
                    {active?.status === 'done' && (
                        <span>
                            {active.rowsAffected} filas · {active.durationMs}ms
                        </span>
                    )}
                    {active?.status === 'cancelled' && <span className="text-amber-400">Cancelada</span>}
                    {active?.status === 'error' && <span className="text-red-400">{active.error}</span>}
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
