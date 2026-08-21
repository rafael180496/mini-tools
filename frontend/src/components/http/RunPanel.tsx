import {useCallback, useEffect, useRef, useState} from 'react'
import {HttpCancelRun, HttpRunCollection} from '../../../wailsjs/go/main/App'
import {EventsOn} from '../../../wailsjs/runtime'
import {main} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import {methodColor, statusColor} from './httpShared'

// Correr una colección (o una carpeta) entera y ver el resultado.
//
// **En orden y de a una**: una colección de pruebas casi siempre es una
// secuencia —login, después lo que usa la sesión, después lo que usa el id que
// devolvió la anterior—, y correrlas en paralelo rompe eso además de disparar
// N sesiones simultáneas contra el servidor de alguien.
//
// **Qué significa "pasó"**: la petición salió y el servidor contestó con un
// código menor a 400. Los scripts de test NO se ejecutan acá y el panel lo dice
// abajo: esta aplicación no corre JavaScript, los tests se guardan y los corre
// Postman o newman con la colección exportada. Un resumen «3 tests pasaron»
// calculado sobre scripts que nadie ejecutó sería una mentira con formato de
// informe.

interface RunPanelProps {
    collectionId: string
    folderId: string
    title: string
    onClose: () => void
}

const DELAYS = [
    {ms: 0, label: 'Sin pausa'},
    {ms: 250, label: '250 ms'},
    {ms: 1000, label: '1 s'},
]

export default function RunPanel({collectionId, folderId, title, onClose}: RunPanelProps) {
    const [running, setRunning] = useState(false)
    const [delayMs, setDelayMs] = useState(0)
    const [live, setLive] = useState<main.HTTPRunResult[]>([])
    const [progress, setProgress] = useState<{done: number; total: number} | null>(null)
    const [summary, setSummary] = useState<main.HTTPRunSummary | null>(null)
    const [error, setError] = useState<string | null>(null)
    const runIdRef = useRef('')

    const start = useCallback(async () => {
        const runId = `run-${collectionId}-${Date.now()}`
        runIdRef.current = runId
        setRunning(true)
        setError(null)
        setLive([])
        setSummary(null)
        setProgress(null)
        try {
            const out = await HttpRunCollection(runId, collectionId, folderId, delayMs)
            if (out) setSummary(out)
        } catch (e) {
            setError(String(e))
        } finally {
            setRunning(false)
        }
    }, [collectionId, folderId, delayMs])

    // El progreso llega por evento: una corrida de treinta peticiones tarda, y
    // un botón girando sin decir por cuál va no sirve de nada.
    useEffect(() => {
        // Se guarda la función que devuelve EventsOn y se llama al desmontar,
        // como hace el chat del agente. `EventsOff` borra TODOS los oyentes de
        // ese evento, así que cerrar este panel apagaría también el de
        // cualquier otro que llegue a escuchar lo mismo.
        const off = EventsOn('http:run', (payload: {runId: string; index: number; total: number; result: main.HTTPRunResult}) => {
            if (!payload || payload.runId !== runIdRef.current) return
            setLive((prev) => [...prev, payload.result])
            setProgress({done: payload.index + 1, total: payload.total})
        })
        return off
    }, [])

    useEffect(() => {
        void start()
        // Solo al montar: cambiar la pausa no puede relanzar la corrida sola.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const rows = summary?.results ?? live
    const passed = summary?.passed ?? rows.filter((r) => r.passed).length
    const failed = summary?.failed ?? rows.filter((r) => !r.passed && !r.skipped).length

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
            onClick={() => {
                if (running) HttpCancelRun(runIdRef.current)
                onClose()
            }}
        >
            <div
                className="flex h-[34rem] w-[52rem] max-w-full flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface-container shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-3 py-2">
                    <Icon name="play_circle" size={16} className="text-on-surface-variant" />
                    <p className="min-w-0 flex-1 truncate text-sm font-medium text-on-surface">Correr «{title}»</p>

                    {!running && (
                        <select
                            value={delayMs}
                            onChange={(e) => setDelayMs(Number(e.target.value))}
                            title="Pausa entre una petición y la siguiente. Treinta peticiones seguidas sin respirar es exactamente lo que un cortafuegos de aplicación corta."
                            className="rounded border border-outline-variant bg-surface-container-lowest px-2 py-0.5 text-[11px] text-on-surface outline-none"
                        >
                            {DELAYS.map((d) => (
                                <option key={d.ms} value={d.ms}>
                                    {d.label}
                                </option>
                            ))}
                        </select>
                    )}

                    {running ? (
                        <button
                            onClick={() => HttpCancelRun(runIdRef.current)}
                            title="Cortar la corrida. La petición que está en vuelo se deja terminar: ya salió, y cancelarla acá no la deshace del lado del servidor."
                            className="rounded border border-outline-variant px-2 py-0.5 text-[11px] text-on-surface-variant hover:bg-surface-variant"
                        >
                            Cortar
                        </button>
                    ) : (
                        <button
                            onClick={() => void start()}
                            title="Volver a correr"
                            className="rounded bg-primary px-3 py-0.5 text-[11px] text-on-primary hover:opacity-90"
                        >
                            Correr de nuevo
                        </button>
                    )}
                    <button
                        onClick={() => {
                            // Cerrar mientras corre CORTA la corrida. Dejarla
                            // andando por atrás significaría seguir golpeando
                            // el servidor de alguien después de que el usuario
                            // dijo que ya no le interesa, y sin nada en
                            // pantalla que lo diga.
                            if (running) HttpCancelRun(runIdRef.current)
                            onClose()
                        }}
                        title={running ? 'Cerrar y cortar la corrida' : 'Cerrar'}
                        className="rounded p-1 text-on-surface-variant hover:bg-surface-variant"
                    >
                        <Icon name="close" size={16} />
                    </button>
                </div>

                {error && <p className="shrink-0 bg-error-container px-3 py-1 text-[11px] text-on-error-container">{error}</p>}

                <div className="flex shrink-0 items-center gap-3 border-b border-outline-variant px-3 py-1.5 text-[11px]">
                    <span className="text-secondary">{passed} pasaron</span>
                    <span className={failed > 0 ? 'text-error' : 'text-on-surface-variant/50'}>{failed} fallaron</span>
                    {(summary?.skipped ?? 0) > 0 && <span className="text-tertiary">{summary?.skipped} salteadas</span>}
                    <span className="flex-1" />
                    {summary?.environment ? (
                        <span className="text-on-surface-variant" title="Entorno con el que se corrió: el mismo resumen contra otro entorno significa otra cosa.">
                            entorno «{summary.environment}»
                        </span>
                    ) : (
                        <span className="text-on-surface-variant/60" title="Sin entorno activo: las variables de entorno no se resolvieron.">
                            sin entorno
                        </span>
                    )}
                    {summary && <span className="font-mono tabular-nums text-on-surface-variant">{summary.durationMs} ms</span>}
                    {running && progress && (
                        <span className="font-mono tabular-nums text-on-surface-variant">
                            {progress.done}/{progress.total}
                        </span>
                    )}
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto">
                    {rows.length === 0 && (
                        <p className="px-3 py-4 text-[11px] text-on-surface-variant">{running ? 'Corriendo…' : 'No hay resultados.'}</p>
                    )}
                    {rows.map((r, i) => (
                        <div key={`${r.itemId}-${i}`} className="flex items-start gap-2 border-b border-outline-variant/40 px-3 py-1.5 text-[11px]">
                            <Icon
                                name={r.skipped ? 'remove' : r.passed ? 'check_circle' : 'cancel'}
                                size={14}
                                className={`mt-0.5 shrink-0 ${r.skipped ? 'text-on-surface-variant/40' : r.passed ? 'text-secondary' : 'text-error'}`}
                            />
                            <span className={`mt-0.5 w-14 shrink-0 font-mono text-[10px] ${methodColor(r.method)}`}>{r.method}</span>
                            <span className="min-w-0 flex-1">
                                <span className="block truncate text-on-surface" title={r.url}>
                                    {r.folder ? <span className="text-on-surface-variant/60">{r.folder} / </span> : null}
                                    {r.name}
                                </span>
                                <span className="block truncate font-mono text-[10px] text-on-surface-variant/60" title={r.url}>
                                    {r.url}
                                </span>
                                {r.error && <span className="block text-[10px] leading-relaxed text-error">{r.error}</span>}
                                {r.missing && r.missing.length > 0 && (
                                    <span className="block text-[10px] leading-relaxed text-tertiary">
                                        Sin definir: {r.missing.map((m) => `{{${m}}}`).join(', ')}
                                    </span>
                                )}
                            </span>
                            {r.status > 0 && <span className={`shrink-0 font-mono tabular-nums ${statusColor(r.status)}`}>{r.status}</span>}
                            {r.durationMs > 0 && <span className="w-16 shrink-0 text-right font-mono tabular-nums text-on-surface-variant/60">{r.durationMs} ms</span>}
                        </div>
                    ))}
                </div>

                <p className="shrink-0 border-t border-outline-variant px-3 py-2 text-[10px] leading-relaxed text-on-surface-variant/70">
                    «Pasó» significa que la petición salió y el servidor contestó con un código menor a 400. Los scripts de test **no se ejecutan acá**:
                    esta aplicación no corre JavaScript — se guardan, viajan en el export y los corre Postman o newman.
                </p>
            </div>
        </div>
    )
}
