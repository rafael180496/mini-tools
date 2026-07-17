import {useEffect, useRef} from 'react'
import Icon from '../Icon'

export interface ConsoleLogEntry {
    index: number
    total: number
    sqlText: string
    status: 'done' | 'error' | 'cancelled'
    hasColumns: boolean
    rowsAffected: number
    durationMs: number
    error: string
    // DBMS_OUTPUT.PUT_LINE lines captured from an Oracle PL/SQL block (empty
    // for everything else) — shown right under the result line, same place a
    // desktop SQL client's console echoes server output.
    dbmsOutput: string[]
    timestamp: number
}

interface ExecutionConsoleProps {
    entries: ConsoleLogEntry[]
    running: boolean
    onClear: () => void
}

function timeLabel(ts: number) {
    return new Date(ts).toLocaleTimeString(undefined, {hour12: false})
}

// One entry's result line — mirrors the distinction a desktop SQL client's
// console makes: a SELECT-like statement reports rows retrieved, anything
// else (DDL/exec/PL-SQL block) reports "completado", an error shows the
// full backend message (never truncated — that's the whole point of this
// view over a bare "Resultado N" grid tab for a DDL-heavy script).
function ResultLine({entry}: {entry: ConsoleLogEntry}) {
    const time = `[${timeLabel(entry.timestamp)}]`

    if (entry.status === 'cancelled') {
        return (
            <span className="text-tertiary">
                {time} cancelado
            </span>
        )
    }
    if (entry.status === 'error') {
        return (
            <span className="text-error">
                {time} ERROR: {entry.error || 'Error desconocido'}
            </span>
        )
    }
    if (entry.hasColumns) {
        return (
            <span className="text-on-surface-variant">
                {time} {entry.rowsAffected} {entry.rowsAffected === 1 ? 'fila obtenida' : 'filas obtenidas'} en {entry.durationMs}ms
            </span>
        )
    }
    return (
        <span className="text-on-surface-variant">
            {time} completado en {entry.durationMs}ms
            {entry.rowsAffected > 0 ? ` (${entry.rowsAffected} ${entry.rowsAffected === 1 ? 'fila afectada' : 'filas afectadas'})` : ''}
        </span>
    )
}

// Statement-by-statement execution log for a script run — one entry per
// statement/PL-SQL block with its full source text echoed verbatim, then a
// result line (OK+duration, or the full error), same experience as a
// desktop SQL client's console (DataGrip/SQL Developer) instead of paging
// through a "Resultado N" grid tab per statement, which is only useful for
// statements that actually return rows. Workspace.tsx auto-switches here
// when a run has more than one statement (see runText/activeBottomTab).
export default function ExecutionConsole({entries, running, onClear}: ExecutionConsoleProps) {
    const bottomRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        bottomRef.current?.scrollIntoView({block: 'end'})
    }, [entries.length])

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-outline-variant bg-surface-container px-2 py-1">
                <span className="text-xs text-on-surface-variant">
                    {entries.length === 0
                        ? 'Sin statements ejecutados todavía.'
                        : `${entries.length}/${entries[entries.length - 1]?.total ?? entries.length} statements`}
                </span>
                <div className="flex-1" />
                <button
                    onClick={onClear}
                    disabled={entries.length === 0}
                    title="Borra el log de esta consola — no afecta el historial de ejecuciones ni nada ya corrido"
                    className="flex items-center gap-1 rounded px-2 py-1 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-40"
                >
                    <Icon name="delete_sweep" size={14} />
                    Limpiar consola
                </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto bg-surface-container-lowest">
                {entries.length === 0 && !running && (
                    <p className="p-3 text-xs text-on-surface-variant">
                        Ejecutá un script con "Bloque" para ver acá el detalle de cada statement — texto completo, si terminó OK
                        (con duración) o con error.
                    </p>
                )}
                <div className="flex flex-col divide-y divide-outline-variant">
                    {entries.map((entry, i) => (
                        <div key={`${entry.index}-${entry.timestamp}-${i}`} className="p-2">
                            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant/70">
                                Statement {entry.index + 1}/{entry.total}
                            </div>
                            <pre className="overflow-x-auto font-mono text-xs text-on-surface">{entry.sqlText}</pre>
                            {entry.dbmsOutput.length > 0 && (
                                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-xs text-secondary">
                                    {entry.dbmsOutput.join('\n')}
                                </pre>
                            )}
                            <div className="mt-1 font-mono text-xs">
                                <ResultLine entry={entry} />
                            </div>
                        </div>
                    ))}
                </div>
                <div ref={bottomRef} />
            </div>
        </div>
    )
}
