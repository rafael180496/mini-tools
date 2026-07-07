import {useCallback, useEffect, useRef, useState} from 'react'
import ConnectionTree from './sidebar/ConnectionTree'
import ConnectionDialog from './connections/ConnectionDialog'
import ResultGrid from './results/ResultGrid'
import {BackupVault, CancelQuery, ExecuteQuery} from '../../wailsjs/go/main/App'
import {EventsOn} from '../../wailsjs/runtime'
import {vault} from '../../wailsjs/go/models'

interface QueryEvent {
    type: 'columns' | 'rows' | 'done' | 'cancelled' | 'error'
    columns?: string[]
    rows?: unknown[][]
    rowsAffected?: number
    durationMs?: number
    error?: string
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
    const [columns, setColumns] = useState<string[]>([])
    const [rows, setRows] = useState<unknown[][]>([])
    const [status, setStatus] = useState<{rowsAffected: number; durationMs: number} | null>(null)
    const [error, setError] = useState('')
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
        setColumns([])
        setRows([])
        setStatus(null)
        setError('')

        const unsubscribe = EventsOn(queryId, (event: QueryEvent) => {
            switch (event.type) {
                case 'columns':
                    setColumns(event.columns ?? [])
                    break
                case 'rows':
                    setRows((prev) => [...prev, ...(event.rows ?? [])])
                    break
                case 'done':
                    setStatus({rowsAffected: event.rowsAffected ?? 0, durationMs: event.durationMs ?? 0})
                    setRunning(false)
                    unsubscribe()
                    break
                case 'cancelled':
                    setError('Query cancelada')
                    setRunning(false)
                    unsubscribe()
                    break
                case 'error':
                    setError(event.error ?? 'Error desconocido')
                    setRunning(false)
                    unsubscribe()
                    break
            }
        })

        ExecuteQuery(selected.id, queryId, sqlText).catch((err) => {
            setError(String(err))
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

                <ResultGrid columns={columns} rows={rows} />

                <div className="flex items-center gap-4 border-t border-neutral-800 px-3 py-1 text-xs text-neutral-500">
                    {running && <span>Ejecutando…</span>}
                    {status && (
                        <span>
                            {status.rowsAffected} filas · {status.durationMs}ms
                        </span>
                    )}
                    {error && <span className="text-red-400">{error}</span>}
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
