import {useCallback, useRef, useState} from 'react'
import {CancelQuery, ExecuteQuery, ListConnections} from '../../../wailsjs/go/main/App'
import {EventsOn} from '../../../wailsjs/runtime'
import {vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import ConfirmDialog from '../ConfirmDialog'
import {inspectSQL} from '../../lib/sqlProductionGuard'

// Bloque SQL ejecutable de un runbook: ```sql connection="Prod_Analytics".
//
// Es la parte del módulo de notas donde una nota deja de ser un documento y
// pasa a ser un script, así que hay tres reglas que no se negocian:
//
//  1. **Se dispara uno por uno.** No hay "ejecutar todos los bloques": una
//     nota con seis bloques ejecutados de un clic sobre producción es
//     exactamente el accidente que el Production Guard existe para evitar. Que
//     el documento se llame "runbook" lo hace MÁS probable de correr contra
//     prod, no menos.
//  2. **El Production Guard aplica igual que en el editor.** Sobre una conexión
//     marcada como producción, una sentencia destructiva abre la MISMA
//     confirmación que abre el botón Ejecutar del editor SQL, con el mismo
//     análisis (`inspectSQL`) y el mismo texto. Un diálogo propio acá sería una
//     segunda implementación de la guarda que puede quedar atrás de la real.
//  3. **El resultado no se guarda en la nota.** Se muestra debajo del bloque y
//     se va al cerrar. Una nota con las filas de la última corrida pegadas
//     adentro es documentación que envejece sola y que además puede terminar
//     conteniendo datos que nadie decidió guardar.

interface QueryEvent {
    type: 'columns' | 'rows' | 'page' | 'done' | 'cancelled' | 'error'
    columns?: string[]
    rows?: unknown[][]
    rowsAffected?: number
    durationMs?: number
    error?: string
}

interface Props {
    // Alias tal cual lo escribió el usuario en el atributo del bloque.
    connectionName: string
    sql: string
}

export default function RunbookSqlBlock({connectionName, sql}: Props) {
    const [running, setRunning] = useState(false)
    const [error, setError] = useState('')
    const [columns, setColumns] = useState<string[]>([])
    const [rows, setRows] = useState<unknown[][]>([])
    const [summary, setSummary] = useState('')
    // Confirmación de producción pendiente: la conexión y el detalle de qué
    // riesgos detectó el mismo analizador que usa el editor.
    const [confirmProd, setConfirmProd] = useState<{conn: vault.ConnectionSummary; detail: string} | null>(null)
    const queryIdRef = useRef('')

    const run = useCallback(
        async (conn: vault.ConnectionSummary) => {
            const queryId = `runbook-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
            queryIdRef.current = queryId
            setRunning(true)
            setError('')
            setColumns([])
            setRows([])
            setSummary('')

            // Suscribirse ANTES de ejecutar: el primer evento puede llegar
            // antes de que resuelva el await, misma carrera que resuelven el
            // editor y la terminal.
            const off = EventsOn(queryId, (ev: QueryEvent) => {
                if (queryIdRef.current !== queryId) return
                switch (ev.type) {
                    case 'columns':
                        setColumns(ev.columns ?? [])
                        break
                    case 'rows':
                    case 'page':
                        setRows((prev) => [...prev, ...(ev.rows ?? [])])
                        break
                    case 'done':
                        setSummary(`${ev.rowsAffected ?? 0} filas · ${ev.durationMs ?? 0} ms`)
                        setRunning(false)
                        off()
                        break
                    case 'cancelled':
                        setSummary('Cancelada')
                        setRunning(false)
                        off()
                        break
                    case 'error':
                        setError(ev.error ?? 'error desconocido')
                        setRunning(false)
                        off()
                        break
                }
            })

            try {
                await ExecuteQuery(conn.id, queryId, sql, false)
            } catch (e) {
                setError(String(e))
                setRunning(false)
                off()
            }
        },
        [sql],
    )

    const start = useCallback(() => {
        if (running) return
        setError('')
        ListConnections()
            .then((conns) => {
                const conn = (conns ?? []).find(
                    (c) => c.name.toLowerCase() === connectionName.trim().toLowerCase(),
                )
                if (!conn) {
                    // Un alias que ya no existe se dice con su nombre: un
                    // runbook viejo apunta a conexiones que se renombraron, y
                    // "error al ejecutar" no ayudaría a arreglarlo.
                    setError(`La conexión «${connectionName}» ya no está guardada en este equipo.`)
                    return
                }
                if (conn.dbType === 'ssh') {
                    setError(`«${conn.name}» es una conexión SSH: este bloque es SQL.`)
                    return
                }
                if (conn.environment === 'prod') {
                    const risks = inspectSQL(sql)
                    if (risks.length > 0) {
                        const detail = risks
                            .slice(0, 5)
                            .map((r) => `• ${r.label}: ${r.detail}\n  ${r.statement.split('\n')[0]}`)
                            .join('\n\n')
                        const extra = risks.length > 5 ? `\n\n…y ${risks.length - 5} sentencia(s) más.` : ''
                        setConfirmProd({conn, detail: detail + extra})
                        return
                    }
                }
                void run(conn)
            })
            .catch((e) => setError(String(e)))
    }, [connectionName, sql, running, run])

    return (
        <div className="my-1.5 overflow-hidden rounded border border-outline-variant">
            <div className="flex items-center gap-2 bg-surface-container px-2 py-1 text-[10px]">
                <Icon name="database" size={12} className="shrink-0 text-primary" />
                <span className="font-medium text-on-surface">{connectionName}</span>
                <span className="text-on-surface-variant">bloque ejecutable</span>

                {running ? (
                    <button
                        onClick={() => {
                            void CancelQuery(queryIdRef.current)
                        }}
                        title="Corta la ejecución en curso"
                        className="ml-auto flex shrink-0 items-center gap-1 rounded bg-error px-2 py-0.5 text-on-error"
                    >
                        <Icon name="stop" size={11} />
                        Cancelar
                    </button>
                ) : (
                    <button
                        onClick={start}
                        title={`Ejecuta SOLO este bloque contra «${connectionName}». Si esa conexión está marcada como producción y la sentencia modifica datos o estructura, se pide la misma confirmación que en el editor SQL.`}
                        className="ml-auto flex shrink-0 items-center gap-1 rounded bg-primary px-2 py-0.5 text-on-primary"
                    >
                        <Icon name="play_arrow" size={12} filled />
                        Ejecutar
                    </button>
                )}
            </div>

            <pre className="overflow-x-auto bg-surface-container-highest px-2 py-1 font-mono text-[11px] text-on-surface">
                {sql}
            </pre>

            {error && <p className="bg-error-container/40 px-2 py-1 text-[11px] text-error">{error}</p>}

            {(columns.length > 0 || summary) && (
                <div className="border-t border-outline-variant bg-surface">
                    {columns.length > 0 && (
                        <div className="max-h-56 overflow-auto">
                            <table className="w-full text-left text-[11px]">
                                <thead className="sticky top-0 bg-surface-container">
                                    <tr>
                                        {columns.map((c) => (
                                            <th key={c} className="px-2 py-0.5 font-medium text-on-surface-variant">
                                                {c}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {rows.slice(0, 200).map((r, n) => (
                                        <tr key={n} className="border-t border-outline-variant/40">
                                            {r.map((cell, m) => (
                                                <td key={m} className="px-2 py-0.5 font-mono text-on-surface">
                                                    {cell === null ? (
                                                        <span className="opacity-50">NULL</span>
                                                    ) : (
                                                        String(cell)
                                                    )}
                                                </td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                    <p
                        className="px-2 py-0.5 text-[10px] text-on-surface-variant"
                        title="El resultado no se guarda dentro de la nota: se muestra acá y se va al cerrar. Una nota con las filas de la última corrida pegadas adentro es documentación que envejece sola."
                    >
                        {summary}
                        {rows.length > 200 && ` · mostrando 200 de ${rows.length}`}
                    </p>
                </div>
            )}

            {confirmProd && (
                <ConfirmDialog
                    title={`Estás en PRODUCCIÓN — ${confirmProd.conn.name}`}
                    description={`Este bloque del runbook modifica datos o estructura en una conexión marcada como Producción:\n\n${confirmProd.detail}`}
                    confirmLabel="Ejecutar igual"
                    danger
                    onConfirm={() => {
                        const conn = confirmProd.conn
                        setConfirmProd(null)
                        void run(conn)
                    }}
                    onClose={() => setConfirmProd(null)}
                />
            )}
        </div>
    )
}
