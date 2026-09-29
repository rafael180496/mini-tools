import {useCallback, useEffect, useRef, useState} from 'react'
import {GetRedisServerInfo} from '../../../wailsjs/go/main/App'
import {db} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import {formatBytes} from '../../lib/formatBytes'
import {formatDuration} from '../../lib/redisFormat'
import {formatNumber, useT} from '../../i18n'

// Refresh intervals in seconds; 0 = manual. Their labels come from the
// dictionary at render.
const REFRESH_OPTIONS = [0, 5, 15, 60]

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
    const t = useT()
    const m = t.redis.metrics
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
                <span className="font-semibold text-on-surface">{t.redis.browser.serverStatus}</span>
                {info?.version && (
                    <span className="font-mono text-on-surface-variant" title={m.versionHint}>
                        Redis {info.version}
                        {info.mode ? ` · ${info.mode}` : ''}
                        {info.role ? ` · ${info.role}` : ''}
                    </span>
                )}
                {!!info?.nodes && info.nodes > 1 && (
                    <span className="rounded bg-surface-variant px-1.5 py-0.5 text-ui-10 text-on-surface-variant" title={m.nodesHint}>
                        {m.nodes(info.nodes)}
                    </span>
                )}

                <div className="ml-auto flex items-center gap-2">
                    <label
                        className="flex items-center gap-1 text-on-surface-variant"
                        title={m.refreshEveryHint}
                    >
                        {m.refreshEvery}
                        <select
                            value={intervalSec}
                            onChange={(e) => setIntervalSec(Number(e.target.value))}
                            className="rounded border border-outline-variant bg-surface-container-low px-1 py-0.5 text-xs text-on-surface"
                        >
                            {REFRESH_OPTIONS.map((sec) => (
                                <option key={sec} value={sec}>
                                    {m.interval(sec)}
                                </option>
                            ))}
                        </select>
                    </label>
                    <button
                        onClick={() => void refresh()}
                        disabled={loading}
                        title={m.refreshNowHint}
                        className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-40"
                    >
                        <Icon name={loading ? 'progress_activity' : 'refresh'} size={15} className={loading ? 'animate-spin' : ''} />
                    </button>
                    <button onClick={onClose} title={m.closeHint} className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface">
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
                            label={m.memory}
                            value={formatBytes(info.usedMemoryBytes)}
                            detail={
                                info.maxMemoryBytes > 0
                                    ? m.memoryOf({max: formatBytes(info.maxMemoryBytes), peak: formatBytes(info.peakMemoryBytes)})
                                    : m.memoryNoLimit({peak: formatBytes(info.peakMemoryBytes)})
                            }
                            hint={info.maxMemoryBytes > 0 ? m.evictionPolicy({policy: info.maxMemoryPolicy || m.unknownPolicy}) : m.noMaxMemory}
                            bar={memoryPct}
                            tone={memoryPct !== null && memoryPct > 90 ? 'danger' : memoryPct !== null && memoryPct > 75 ? 'warn' : 'ok'}
                        />

                        <Card
                            icon="target"
                            label={m.hitRate}
                            value={`${formatNumber(info.hitRatePct, {minimumFractionDigits: 1, maximumFractionDigits: 1})}%`}
                            detail={m.hitsMisses({hits: formatNumber(info.keyspaceHits), misses: formatNumber(info.keyspaceMisses)})}
                            hint={m.hitRateHint}
                            bar={info.hitRatePct}
                            tone={info.hitRatePct < 50 ? 'danger' : info.hitRatePct < 80 ? 'warn' : 'ok'}
                        />

                        <Card
                            icon="bolt"
                            label={m.opsPerSec}
                            value={formatNumber(info.opsPerSecond)}
                            detail={m.totalCommands({count: formatNumber(info.totalCommandsProcessed)})}
                            hint={m.opsPerSecHint}
                        />

                        <Card
                            icon="group"
                            label={m.clients}
                            value={formatNumber(info.connectedClients)}
                            detail={
                                (info.maxClients ?? 0) > 0
                                    ? m.clientsOf({max: formatNumber(info.maxClients ?? 0), blocked: info.blockedClients})
                                    : m.blocked({blocked: info.blockedClients})
                            }
                            hint={m.clientsHint}
                            bar={(info.maxClients ?? 0) > 0 ? (info.connectedClients / (info.maxClients ?? 1)) * 100 : null}
                            tone={info.rejectedConnections > 0 ? 'danger' : 'ok'}
                        />
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs lg:grid-cols-3">
                        <Row label={m.uptime} value={formatDuration(info.uptimeSeconds)} hint={m.uptimeHint} />
                        <Row
                            label={m.fragmentation}
                            value={info.fragmentationRatio ? formatNumber(info.fragmentationRatio, {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '—'}
                            hint={m.fragmentationHint}
                        />
                        <Row label={m.expiredKeys} value={formatNumber(info.expiredKeys)} hint={m.expiredKeysHint} />
                        <Row
                            label={m.evictedKeys}
                            value={formatNumber(info.evictedKeys)}
                            hint={m.evictedKeysHint}
                            tone={info.evictedKeys > 0 ? 'warn' : undefined}
                        />
                        <Row
                            label={m.rejected}
                            value={formatNumber(info.rejectedConnections)}
                            hint={m.rejectedHint}
                            tone={info.rejectedConnections > 0 ? 'danger' : undefined}
                        />
                        <Row
                            label={m.cpu}
                            value={`${info.usedCpuSys?.toFixed(1) ?? '—'}s / ${info.usedCpuUser?.toFixed(1) ?? '—'}s`}
                            hint={m.cpuHint}
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
