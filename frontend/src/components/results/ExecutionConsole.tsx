import {useEffect, useMemo, useRef} from 'react'
import Icon from '../Icon'
import {highlightSql, SQL_TOKEN_CLASS} from '../../lib/sqlHighlight'

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
    // Aclaración de por qué el statement terminó como terminó cuando no fue
    // ni un éxito ni un error normal — hoy, un comando de cliente SQL*Plus
    // que mini-tools omite en vez de mandárselo a Oracle. Vacío para todo lo
    // demás.
    note: string
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

// El SQL ejecutado, con el mismo resaltado por colores que el editor —
// palabras clave, literales, comentarios y binds. Antes se echaba como un
// bloque de texto plano de un solo color, y en un script de doce statements
// encontrar dónde empieza el que falló significaba leerlo entero.
function HighlightedSql({sql}: {sql: string}) {
    const tokens = useMemo(() => highlightSql(sql), [sql])
    return (
        <pre className="overflow-x-auto font-mono text-xs leading-relaxed">
            {tokens.map((tk, i) => (
                <span key={i} className={SQL_TOKEN_CLASS[tk.kind]}>
                    {tk.text}
                </span>
            ))}
        </pre>
    )
}

// El código del motor (ORA-01843, PLS-00201, SP2-0640…) es lo que se busca y
// lo que se pega en un buscador: va destacado dentro del mensaje en vez de
// perdido en una línea larga.
const ERROR_CODE = /\b([A-Z]{2,4}-\d{3,5})\b/g

function ErrorMessage({text}: {text: string}) {
    const parts = useMemo(() => text.split(ERROR_CODE), [text])
    return (
        <>
            {parts.map((part, i) =>
                // split() con grupo de captura intercala los códigos en los
                // índices impares.
                i % 2 === 1 ? (
                    <span key={i} className="rounded bg-error/20 px-1 font-semibold text-error">
                        {part}
                    </span>
                ) : (
                    <span key={i}>{part}</span>
                ),
            )}
        </>
    )
}

// One entry's result line — mirrors the distinction a desktop SQL client's
// console makes: a SELECT-like statement reports rows retrieved, anything
// else (DDL/exec/PL-SQL block) reports "completado", an error shows the
// full backend message (never truncated — that's the whole point of this
// view over a bare "Resultado N" grid tab for a DDL-heavy script).
function ResultLine({entry}: {entry: ConsoleLogEntry}) {
    const time = <span className="text-on-surface-variant/60">[{timeLabel(entry.timestamp)}]</span>

    if (entry.status === 'cancelled') {
        return (
            <span className="text-tertiary">
                {time} cancelado
            </span>
        )
    }
    if (entry.status === 'error') {
        // El error va en un bloque propio y no en una línea suelta: es lo
        // único de la consola que hay que leer entero, y un mensaje de Oracle
        // ocupa varios renglones.
        return (
            <div className="mt-1 flex items-start gap-1.5 rounded border border-error/40 bg-error/10 px-2 py-1 text-error">
                <Icon name="error" size={14} filled className="mt-0.5 shrink-0" />
                <span className="min-w-0 whitespace-pre-wrap wrap-break-word">
                    {time} <ErrorMessage text={entry.error || 'Error desconocido'} />
                </span>
            </div>
        )
    }
    if (entry.note) {
        return (
            <span className="text-tertiary">
                {time} {entry.note}
            </span>
        )
    }
    if (entry.hasColumns) {
        return (
            <span className="text-on-surface-variant">
                {time} <span className="font-semibold text-secondary">{entry.rowsAffected}</span>{' '}
                {entry.rowsAffected === 1 ? 'fila obtenida' : 'filas obtenidas'} en {entry.durationMs}ms
            </span>
        )
    }
    return (
        <span className="text-on-surface-variant">
            {time} <span className="text-secondary">completado</span> en {entry.durationMs}ms
            {entry.rowsAffected > 0 ? ` (${entry.rowsAffected} ${entry.rowsAffected === 1 ? 'fila afectada' : 'filas afectadas'})` : ''}
        </span>
    )
}

// El borde izquierdo dice el desenlace sin tener que leer: es lo que permite
// encontrar el statement que falló en una consola de cien entradas
// desplazándose, en vez de leyendo.
const STATUS_EDGE: Record<ConsoleLogEntry['status'], string> = {
    done: 'border-l-secondary/40',
    error: 'border-l-error',
    cancelled: 'border-l-tertiary/60',
}

// Statement-by-statement execution log for a script run — one entry per
// statement/PL-SQL block with its full source text echoed verbatim, then a
// result line (OK+duration, or the full error), same experience as a
// desktop SQL client's console (DataGrip/SQL Developer) instead of paging
// through a "Resultado N" grid tab per statement, which is only useful for
// statements that actually return rows. Workspace.tsx auto-switches here
// when a run has more than one statement (see runText/activeBottomTab).
//
// Es además el ÚNICO registro de lo ejecutado: el historial de consultas que
// vivía en una solapa aparte se retiró porque decía lo mismo con menos
// contexto (ver CHANGELOG).
export default function ExecutionConsole({entries, running, onClear}: ExecutionConsoleProps) {
    const bottomRef = useRef<HTMLDivElement>(null)
    const errorCount = useMemo(() => entries.filter((e) => e.status === 'error').length, [entries])

    useEffect(() => {
        bottomRef.current?.scrollIntoView({block: 'end'})
    }, [entries.length])

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-outline-variant bg-surface-container px-2 py-1">
                {/* Cuántos statements lleva la consola de esta sesión, no del
                    último script: es un log corrido. Antes decía "60/12", que
                    se leía como un progreso que nunca terminaba. */}
                <span className="text-xs text-on-surface-variant">
                    {entries.length === 0
                        ? 'Sin statements ejecutados todavía.'
                        : `${entries.length} ${entries.length === 1 ? 'statement ejecutado' : 'statements ejecutados'}`}
                </span>
                {errorCount > 0 && (
                    <span
                        title={`${errorCount} de los statements de esta consola terminó con error — tienen el borde y el mensaje en rojo`}
                        className="flex items-center gap-1 rounded-full bg-error/15 px-1.5 text-ui-10 font-semibold text-error"
                    >
                        <Icon name="error" size={12} filled />
                        {errorCount} con error
                    </span>
                )}
                {running && (
                    <span className="flex items-center gap-1 text-xs text-on-surface-variant">
                        <span
                            aria-hidden
                            className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-t-transparent border-primary"
                        />
                        ejecutando…
                    </span>
                )}
                <div className="flex-1" />
                <button
                    onClick={onClear}
                    disabled={entries.length === 0}
                    title="Borra el log de esta consola — no cancela nada ni deshace lo que ya se ejecutó, solo vacía lo que se ve acá"
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
                        <div key={`${entry.index}-${entry.timestamp}-${i}`} className={`border-l-2 p-2 ${STATUS_EDGE[entry.status]}`}>
                            <div className="mb-1 flex items-center gap-1.5 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/70">
                                Statement {entry.index + 1}/{entry.total}
                            </div>
                            <HighlightedSql sql={entry.sqlText} />
                            {entry.dbmsOutput.length > 0 && (
                                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap border-l-2 border-outline-variant pl-2 font-mono text-xs text-on-surface-variant">
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
