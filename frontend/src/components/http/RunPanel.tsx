import {useCallback, useEffect, useRef, useState} from 'react'
import {HttpCancelRun, HttpRunCollection} from '../../../wailsjs/go/main/App'
import {EventsOn} from '../../../wailsjs/runtime'
import {main} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import Select from '../Select'
import {methodColor, rich, statusColor} from './httpShared'
import {useT} from '../../i18n'

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

// Pausas ofrecidas entre peticiones; el rótulo se arma al dibujar.
const DELAYS = [0, 250, 1000]

export default function RunPanel({collectionId, folderId, title, onClose}: RunPanelProps) {
    const t = useT()
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
                    <p className="min-w-0 flex-1 truncate text-sm font-medium text-on-surface">{t.http.run.title({name: title})}</p>

                    {!running && (
                        <Select
                            value={String(delayMs)}
                            options={DELAYS.map((ms) => ({value: String(ms), label: ms === 0 ? t.http.run.noDelay : t.http.request.ms(ms)}))}
                            onChange={(v) => setDelayMs(Number(v))}
                            size="sm"
                            ariaLabel={t.http.run.delayAria}
                            title={t.http.run.delayTitle}
                            className="w-36 shrink-0"
                        />
                    )}

                    {running ? (
                        <button
                            onClick={() => HttpCancelRun(runIdRef.current)}
                            title={t.http.run.stopTitle}
                            className="rounded border border-outline-variant px-2 py-0.5 text-ui-11 text-on-surface-variant hover:bg-surface-variant"
                        >
                            {t.http.run.stop}
                        </button>
                    ) : (
                        <button
                            onClick={() => void start()}
                            title={t.http.run.rerunTitle}
                            className="rounded bg-primary px-3 py-0.5 text-ui-11 text-on-primary hover:opacity-90"
                        >
                            {t.http.run.rerun}
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
                        title={running ? t.http.run.closeAndStop : t.common.close}
                        className="rounded p-1 text-on-surface-variant hover:bg-surface-variant"
                    >
                        <Icon name="close" size={16} />
                    </button>
                </div>

                {error && <p className="shrink-0 bg-error-container px-3 py-1 text-ui-11 text-on-error-container">{error}</p>}

                <div className="flex shrink-0 items-center gap-3 border-b border-outline-variant px-3 py-1.5 text-ui-11">
                    <span className="text-secondary">{t.http.run.passed(passed)}</span>
                    <span className={failed > 0 ? 'text-error' : 'text-on-surface-variant/50'}>{t.http.run.failed(failed)}</span>
                    {(summary?.skipped ?? 0) > 0 && <span className="text-tertiary">{t.http.run.skipped(summary?.skipped ?? 0)}</span>}
                    <span className="flex-1" />
                    {summary?.environment ? (
                        <span className="text-on-surface-variant" title={t.http.run.environmentTitle}>
                            {t.http.run.environment({name: summary.environment})}
                        </span>
                    ) : (
                        <span className="text-on-surface-variant/60" title={t.http.run.noEnvironmentTitle}>
                            {t.http.run.noEnvironment}
                        </span>
                    )}
                    {summary && <span className="font-mono tabular-nums text-on-surface-variant">{t.http.request.ms(summary.durationMs)}</span>}
                    {running && progress && (
                        <span className="font-mono tabular-nums text-on-surface-variant">
                            {progress.done}/{progress.total}
                        </span>
                    )}
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto">
                    {rows.length === 0 && (
                        <p className="px-3 py-4 text-ui-11 text-on-surface-variant">{running ? t.http.run.running : t.http.run.noResults}</p>
                    )}
                    {rows.map((r, i) => (
                        <div key={`${r.itemId}-${i}`} className="flex items-start gap-2 border-b border-outline-variant/40 px-3 py-1.5 text-ui-11">
                            <Icon
                                name={r.skipped ? 'remove' : r.passed ? 'check_circle' : 'cancel'}
                                size={14}
                                className={`mt-0.5 shrink-0 ${r.skipped ? 'text-on-surface-variant/40' : r.passed ? 'text-secondary' : 'text-error'}`}
                            />
                            <span className={`mt-0.5 w-14 shrink-0 font-mono text-ui-10 ${methodColor(r.method)}`}>{r.method}</span>
                            <span className="min-w-0 flex-1">
                                <span className="block truncate text-on-surface" title={r.url}>
                                    {r.folder ? <span className="text-on-surface-variant/60">{r.folder} / </span> : null}
                                    {r.name}
                                </span>
                                <span className="block truncate font-mono text-ui-10 text-on-surface-variant/60" title={r.url}>
                                    {r.url}
                                </span>
                                {r.error && <span className="block text-ui-10 leading-relaxed text-error">{r.error}</span>}
                                {r.missing && r.missing.length > 0 && (
                                    <span className="block text-ui-10 leading-relaxed text-tertiary">
                                        {t.http.run.missing({list: r.missing.map((m) => `{{${m}}}`).join(', ')})}
                                    </span>
                                )}
                            </span>
                            {r.status > 0 && <span className={`shrink-0 font-mono tabular-nums ${statusColor(r.status)}`}>{r.status}</span>}
                            {r.durationMs > 0 && <span className="w-16 shrink-0 text-right font-mono tabular-nums text-on-surface-variant/60">{t.http.request.ms(r.durationMs)}</span>}
                        </div>
                    ))}
                </div>

                <p className="shrink-0 border-t border-outline-variant px-3 py-2 text-ui-10 leading-relaxed text-on-surface-variant/70">
                    {rich(t.http.run.footer)}
                </p>
            </div>
        </div>
    )
}
