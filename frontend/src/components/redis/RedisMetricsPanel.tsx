import {useCallback, useEffect, useRef, useState} from 'react'
import {GetRedisServerInfo} from '../../../wailsjs/go/main/App'
import {db} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import {formatBytes} from '../../lib/formatBytes'
import {formatDuration} from '../../lib/redisFormat'

const REFRESH_OPTIONS = [
    {value: 0, label: 'manual'},
    {value: 5, label: '5 s'},
    {value: 15, label: '15 s'},
    {value: 60, label: '1 min'},
]

interface RedisMetricsPanelProps {
    connId: string
    onClose: () => void
}

// Health dashboard from INFO: what people currently open a terminal and run
// redis-cli for.
//
// Auto-refresh defaults to OFF. Every refresh is a command against a
// possibly-production instance, and a dashboard that starts polling the
// moment it opens is the kind of thing that gets a tool banned from
// production. The interval is opt-in and visible.
export default function RedisMetricsPanel({connId, onClose}: RedisMetricsPanelProps) {
    const [info, setInfo] = useState<db.RedisServerInfo | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')
    const [intervalSec, setIntervalSec] = useState(0)
    const aliveRef = useRef(true)

    const refresh = useCallback(async () => {
        setLoading(true)
        try {
            const res = await GetRedisServerInfo(connId)
            if (aliveRef.current) {
                setInfo(res)
                setError('')
            }
        } catch (e) {
            if (aliveRef.current) setError(String(e))
        } finally {
            if (aliveRef.current) setLoading(false)
        }
    }, [connId])

    useEffect(() => {
        aliveRef.current = true
        void refresh()
        return () => {
            aliveRef.current = false
        }
    }, [refresh])

    useEffect(() => {
        if (intervalSec <= 0) return
        const timer = window.setInterval(() => void refresh(), intervalSec * 1000)
        return () => window.clearInterval(timer)
    }, [intervalSec, refresh])

    const memoryPct = info && info.maxMemoryBytes > 0 ? (info.usedMemoryBytes / info.maxMemoryBytes) * 100 : null

    return (
        <div className="flex h-full flex-col overflow-hidden">
            <div className="flex items-center gap-2 border-b border-outline-variant px-3 py-1.5 text-xs">
                <Icon name="monitoring" size={15} className="shrink-0 text-primary" />
                <span className="font-semibold text-on-surface">Estado del servidor</span>
                {info?.version && (
                    <span className="font-mono text-on-surface-variant" title="Versión, modo de despliegue y rol de esta instancia">
                        Redis {info.version}
                        {info.mode ? ` · ${info.mode}` : ''}
                        {info.role ? ` · ${info.role}` : ''}
                    </span>
                )}
                {!!info?.nodes && info.nodes > 1 && (
                    <span className="rounded bg-surface-variant px-1.5 py-0.5 text-ui-10 text-on-surface-variant" title="Los contadores están sumados sobre los masters del cluster">
                        {info.nodes} nodos
                    </span>
                )}

                <div className="ml-auto flex items-center gap-2">
                    <label
                        className="flex items-center gap-1 text-on-surface-variant"
                        title="Con qué frecuencia volver a pedir INFO. Cada refresco es un comando contra el servidor, así que arranca en manual a propósito."
                    >
                        Refresco
                        <select
                            value={intervalSec}
                            onChange={(e) => setIntervalSec(Number(e.target.value))}
                            className="rounded border border-outline-variant bg-surface-container-low px-1 py-0.5 text-xs text-on-surface"
                        >
                            {REFRESH_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value}>
                                    {o.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <button
                        onClick={() => void refresh()}
                        disabled={loading}
                        title="Vuelve a pedir INFO al servidor ahora"
                        className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-40"
                    >
                        <Icon name={loading ? 'progress_activity' : 'refresh'} size={15} className={loading ? 'animate-spin' : ''} />
                    </button>
                    <button onClick={onClose} title="Cierra el panel de estado" className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface">
                        <Icon name="close" size={16} />
                    </button>
                </div>
            </div>

            {error && <p className="px-3 py-2 text-xs text-error">{error}</p>}

            {info && (
                <div className="flex-1 overflow-y-auto p-3">
                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                        <Card
                            icon="memory"
                            label="Memoria"
                            value={formatBytes(info.usedMemoryBytes)}
                            detail={
                                info.maxMemoryBytes > 0
                                    ? `de ${formatBytes(info.maxMemoryBytes)} · pico ${formatBytes(info.peakMemoryBytes)}`
                                    : `sin límite configurado · pico ${formatBytes(info.peakMemoryBytes)}`
                            }
                            hint={
                                info.maxMemoryBytes > 0
                                    ? `Política de desalojo: ${info.maxMemoryPolicy || 'desconocida'}. Al llegar al límite Redis aplica esa política.`
                                    : 'Sin maxmemory configurado, Redis crece hasta agotar la RAM del sistema — no hay política de desalojo que lo frene.'
                            }
                            bar={memoryPct}
                            tone={memoryPct !== null && memoryPct > 90 ? 'danger' : memoryPct !== null && memoryPct > 75 ? 'warn' : 'ok'}
                        />

                        <Card
                            icon="target"
                            label="Aciertos de caché"
                            value={`${info.hitRatePct.toFixed(1)}%`}
                            detail={`${info.keyspaceHits.toLocaleString('es')} aciertos · ${info.keyspaceMisses.toLocaleString('es')} fallos`}
                            hint="Acumulado desde que arrancó el servidor, no una tasa instantánea: una caché que estuvo fría una semana sigue arrastrando ese número mucho después de calentarse."
                            bar={info.hitRatePct}
                            tone={info.hitRatePct < 50 ? 'danger' : info.hitRatePct < 80 ? 'warn' : 'ok'}
                        />

                        <Card
                            icon="bolt"
                            label="Operaciones por segundo"
                            value={info.opsPerSecond.toLocaleString('es')}
                            detail={`${info.totalCommandsProcessed.toLocaleString('es')} comandos en total`}
                            hint="Medición instantánea que reporta el propio Redis (instantaneous_ops_per_sec), no un promedio."
                        />

                        <Card
                            icon="group"
                            label="Clientes conectados"
                            value={info.connectedClients.toLocaleString('es')}
                            detail={
                                (info.maxClients ?? 0) > 0
                                    ? `de ${(info.maxClients ?? 0).toLocaleString('es')} · ${info.blockedClients} bloqueados`
                                    : `${info.blockedClients} bloqueados`
                            }
                            hint="Bloqueados son los que esperan en un BLPOP/BRPOP/WAIT. Si hay conexiones rechazadas, se llegó al tope de maxclients."
                            bar={(info.maxClients ?? 0) > 0 ? (info.connectedClients / (info.maxClients ?? 1)) * 100 : null}
                            tone={info.rejectedConnections > 0 ? 'danger' : 'ok'}
                        />
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs lg:grid-cols-3">
                        <Row label="Tiempo encendido" value={formatDuration(info.uptimeSeconds)} hint="Los contadores acumulados de arriba se miden desde este momento." />
                        <Row
                            label="Fragmentación"
                            value={info.fragmentationRatio ? info.fragmentationRatio.toFixed(2) : '—'}
                            hint="used_memory_rss / used_memory. Bastante por encima de 1 significa que el asignador retiene memoria que el dataset ya no usa; por debajo de 1 significa que parte del dataset está en swap, que es mucho peor."
                        />
                        <Row label="Claves vencidas" value={info.expiredKeys.toLocaleString('es')} hint="Claves eliminadas por haber llegado a su TTL." />
                        <Row
                            label="Claves desalojadas"
                            value={info.evictedKeys.toLocaleString('es')}
                            hint="Claves que Redis tuvo que borrar por falta de memoria, aunque no hubieran vencido. Un número que crece es señal de que maxmemory quedó chico."
                            tone={info.evictedKeys > 0 ? 'warn' : undefined}
                        />
                        <Row
                            label="Conexiones rechazadas"
                            value={info.rejectedConnections.toLocaleString('es')}
                            hint="Intentos de conexión que Redis rechazó por haber alcanzado maxclients."
                            tone={info.rejectedConnections > 0 ? 'danger' : undefined}
                        />
                        <Row
                            label="CPU (sistema / usuario)"
                            value={`${info.usedCpuSys?.toFixed(1) ?? '—'}s / ${info.usedCpuUser?.toFixed(1) ?? '—'}s`}
                            hint="Segundos de CPU consumidos desde el arranque, no un porcentaje instantáneo."
                        />
                    </div>
                </div>
            )}
        </div>
    )
}

const TONE_BAR: Record<string, string> = {
    ok: 'bg-primary',
    warn: 'bg-tertiary',
    danger: 'bg-error',
}

const TONE_TEXT: Record<string, string> = {
    warn: 'text-tertiary',
    danger: 'text-error',
}

function Card({
    icon,
    label,
    value,
    detail,
    hint,
    bar,
    tone = 'ok',
}: {
    icon: string
    label: string
    value: string
    detail: string
    hint: string
    bar?: number | null
    tone?: 'ok' | 'warn' | 'danger'
}) {
    return (
        <div className="rounded-lg border border-outline-variant bg-surface-container-low p-2.5" title={hint}>
            <div className="flex items-center gap-1.5 text-ui-11 uppercase tracking-wide text-on-surface-variant">
                <Icon name={icon} size={13} />
                {label}
            </div>
            <div className={`mt-0.5 font-mono text-lg ${TONE_TEXT[tone] ?? 'text-on-surface'}`}>{value}</div>
            <div className="text-ui-11 text-on-surface-variant/80">{detail}</div>
            {bar !== null && bar !== undefined && (
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-variant">
                    <div className={`h-full rounded-full ${TONE_BAR[tone]}`} style={{width: `${Math.min(100, Math.max(0, bar))}%`}} />
                </div>
            )}
        </div>
    )
}

function Row({label, value, hint, tone}: {label: string; value: string; hint: string; tone?: 'warn' | 'danger'}) {
    return (
        <div className="flex items-baseline justify-between gap-2 border-b border-outline-variant/40 py-0.5" title={hint}>
            <span className="text-on-surface-variant">{label}</span>
            <span className={`font-mono ${tone ? TONE_TEXT[tone] : 'text-on-surface'}`}>{value}</span>
        </div>
    )
}
