import {useEffect, useRef, useState} from 'react'
import {EventsOff, EventsOn} from '../../../wailsjs/runtime/runtime'
import {ReadRedisStream, StopRedisMonitor, SubscribeRedisChannels} from '../../../wailsjs/go/main/App'
import Icon from '../Icon'

// Mirrors backend/redisquery.StreamEvent / StreamMessage. Hand-written
// because Wails only generates TS models for types that appear in a binding
// SIGNATURE, and these only ever travel as emitted events — same reason
// Workspace.tsx mirrors redisquery.Event and mongoquery.Event by hand.
interface StreamMessage {
    channel: string
    pattern?: string
    payload?: string
    id?: string
    fields?: Record<string, string>
    receivedAtMs: number
}

interface StreamEvent {
    type: 'started' | 'message' | 'stopped' | 'error'
    messages?: StreamMessage[]
    dropped?: number
    error?: string
}

// How many messages the panel keeps. A monitor left open on a busy channel
// would otherwise grow until the tab dies — this is the same "bounded, and
// say so" discipline the backend applies to its own buffer.
const MAX_MESSAGES = 2_000

type Mode = 'pubsub' | 'stream'

interface RedisLiveMonitorProps {
    connId: string
    onClose: () => void
}

// Live monitor: Pub/Sub subscriptions and stream tails, streaming into the
// app instead of a separate redis-cli window.
//
// Everything here is bounded on purpose. The backend batches messages every
// 250 ms and drops (counting) past its own buffer; this side keeps the last
// 2.000 and says when it trimmed. A monitor that silently loses messages is
// worse than one that admits it, because the whole point is trusting what
// you see.
export default function RedisLiveMonitor({connId, onClose}: RedisLiveMonitorProps) {
    const [mode, setMode] = useState<Mode>('pubsub')
    const [channels, setChannels] = useState('')
    const [patterns, setPatterns] = useState('*')
    const [streamKey, setStreamKey] = useState('')
    const [fromStart, setFromStart] = useState(false)

    const [running, setRunning] = useState(false)
    const [paused, setPaused] = useState(false)
    const [messages, setMessages] = useState<StreamMessage[]>([])
    const [dropped, setDropped] = useState(0)
    const [trimmed, setTrimmed] = useState(0)
    const [error, setError] = useState('')
    const [filter, setFilter] = useState('')
    const [autoScroll, setAutoScroll] = useState(true)

    const monitorIdRef = useRef('')
    const bottomRef = useRef<HTMLDivElement>(null)
    // Paused is read inside the event handler, which is registered once —
    // a stale closure would keep appending while the user thinks it stopped.
    const pausedRef = useRef(paused)
    pausedRef.current = paused

    // Stop the monitor when the panel goes away, including on a connection
    // change. A subscription holds its own connection open; leaking one per
    // panel open would eventually exhaust the server's client limit.
    useEffect(() => {
        return () => {
            if (monitorIdRef.current) {
                void StopRedisMonitor(monitorIdRef.current)
                EventsOff(monitorIdRef.current)
            }
        }
    }, [])

    useEffect(() => {
        if (autoScroll && !paused) bottomRef.current?.scrollIntoView({block: 'end'})
    }, [messages, autoScroll, paused])

    async function start() {
        setError('')
        setMessages([])
        setDropped(0)
        setTrimmed(0)

        // The frontend generates the id and subscribes BEFORE calling the
        // backend — otherwise the first batch could be emitted before the
        // listener exists. Same race the query executor already avoids.
        const id = `redis-monitor-${connId}-${Math.random().toString(36).slice(2)}`
        monitorIdRef.current = id

        EventsOn(id, (ev: StreamEvent) => {
            if (ev.type === 'error') {
                setError(ev.error ?? 'error desconocido')
                setRunning(false)
                return
            }
            if (ev.type === 'stopped') {
                setRunning(false)
                return
            }
            if (ev.type !== 'message') return

            if (ev.dropped) setDropped((n) => n + ev.dropped!)
            // Pausing stops APPENDING, not the subscription: messages keep
            // being consumed server-side so resuming does not leave a hole
            // in the middle of the stream, and the drop counter still moves
            // if the buffer overflows meanwhile.
            if (pausedRef.current) return

            const batch = ev.messages ?? []
            if (batch.length === 0) return

            setMessages((prev) => {
                const next = [...prev, ...batch]
                if (next.length <= MAX_MESSAGES) return next
                const over = next.length - MAX_MESSAGES
                setTrimmed((n) => n + over)
                return next.slice(over)
            })
        })

        try {
            if (mode === 'pubsub') {
                const ch = splitList(channels)
                const pt = splitList(patterns)
                await SubscribeRedisChannels(connId, id, ch, pt)
            } else {
                await ReadRedisStream(connId, id, streamKey.trim(), fromStart ? '0' : '$')
            }
            setRunning(true)
        } catch (e) {
            setError(String(e))
            EventsOff(id)
            monitorIdRef.current = ''
        }
    }

    async function stop() {
        const id = monitorIdRef.current
        if (!id) return
        await StopRedisMonitor(id)
        EventsOff(id)
        monitorIdRef.current = ''
        setRunning(false)
    }

    const visible = filter.trim()
        ? messages.filter((m) => matchesFilter(m, filter.trim().toLowerCase()))
        : messages

    return (
        <div className="flex h-full flex-col overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 border-b border-outline-variant px-3 py-1.5 text-xs">
                <Icon name="sensors" size={15} className="shrink-0 text-primary" />
                <span className="font-semibold text-on-surface">Monitor en vivo</span>

                <div className="flex rounded-md border border-outline-variant p-0.5">
                    <button
                        onClick={() => setMode('pubsub')}
                        disabled={running}
                        title="Escucha canales de Pub/Sub (SUBSCRIBE / PSUBSCRIBE)"
                        className={`rounded px-2 py-0.5 text-[11px] disabled:opacity-50 ${
                            mode === 'pubsub' ? 'bg-primary/15 text-primary' : 'text-on-surface-variant hover:text-on-surface'
                        }`}
                    >
                        Pub/Sub
                    </button>
                    <button
                        onClick={() => setMode('stream')}
                        disabled={running}
                        title="Consume entradas nuevas de un stream (XREAD)"
                        className={`rounded px-2 py-0.5 text-[11px] disabled:opacity-50 ${
                            mode === 'stream' ? 'bg-primary/15 text-primary' : 'text-on-surface-variant hover:text-on-surface'
                        }`}
                    >
                        Stream
                    </button>
                </div>

                <button onClick={onClose} title="Cierra el monitor y corta la suscripción" className="ml-auto rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface">
                    <Icon name="close" size={16} />
                </button>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-b border-outline-variant px-3 py-1.5 text-xs">
                {mode === 'pubsub' ? (
                    <>
                        <label className="flex min-w-0 flex-1 items-center gap-1 text-on-surface-variant">
                            Canales
                            <input
                                value={channels}
                                onChange={(e) => setChannels(e.target.value)}
                                disabled={running}
                                placeholder="noticias, alertas"
                                title="Canales exactos a escuchar, separados por comas (SUBSCRIBE). Dejalo vacío si solo vas a usar patrones."
                                className="min-w-0 flex-1 rounded border border-outline-variant bg-surface-container-low px-1.5 py-0.5 font-mono text-on-surface disabled:opacity-50"
                            />
                        </label>
                        <label className="flex min-w-0 flex-1 items-center gap-1 text-on-surface-variant">
                            Patrones
                            <input
                                value={patterns}
                                onChange={(e) => setPatterns(e.target.value)}
                                disabled={running}
                                placeholder="eventos:*"
                                title="Patrones glob a escuchar (PSUBSCRIBE). '*' escucha todo — útil para descubrir qué canales hay, pero en un servidor con tráfico real es una manguera."
                                className="min-w-0 flex-1 rounded border border-outline-variant bg-surface-container-low px-1.5 py-0.5 font-mono text-on-surface disabled:opacity-50"
                            />
                        </label>
                    </>
                ) : (
                    <>
                        <label className="flex min-w-0 flex-1 items-center gap-1 text-on-surface-variant">
                            Stream
                            <input
                                value={streamKey}
                                onChange={(e) => setStreamKey(e.target.value)}
                                disabled={running}
                                placeholder="nombre del stream"
                                title="Clave del stream a consumir con XREAD"
                                className="min-w-0 flex-1 rounded border border-outline-variant bg-surface-container-low px-1.5 py-0.5 font-mono text-on-surface disabled:opacity-50"
                            />
                        </label>
                        <label
                            className="flex items-center gap-1 text-on-surface-variant"
                            title="Desactivado, solo trae lo que llegue de ahora en adelante ($). Activado, reproduce el stream desde el principio (0) — puede ser mucho contenido de golpe."
                        >
                            <input type="checkbox" checked={fromStart} onChange={(e) => setFromStart(e.target.checked)} disabled={running} className="accent-primary" />
                            desde el principio
                        </label>
                    </>
                )}

                {running ? (
                    <>
                        <button
                            onClick={() => setPaused((v) => !v)}
                            title={
                                paused
                                    ? 'Reanuda la vista. La suscripción nunca se cortó: los mensajes se siguieron consumiendo, así que no queda un hueco en el medio.'
                                    : 'Congela la vista para poder leer. La suscripción sigue activa por detrás.'
                            }
                            className="flex items-center gap-1 rounded border border-outline-variant px-2 py-1 text-on-surface-variant hover:bg-surface-variant"
                        >
                            <Icon name={paused ? 'play_arrow' : 'pause'} size={13} />
                            {paused ? 'Reanudar' : 'Pausar'}
                        </button>
                        <button
                            onClick={() => void stop()}
                            title="Corta la suscripción y libera su conexión"
                            className="flex items-center gap-1 rounded bg-error/15 px-2 py-1 text-error hover:bg-error/25"
                        >
                            <Icon name="stop" size={13} />
                            Detener
                        </button>
                    </>
                ) : (
                    <button
                        onClick={() => void start()}
                        disabled={mode === 'stream' && streamKey.trim() === ''}
                        title="Abre la suscripción. Usa una conexión dedicada mientras esté activa."
                        className="flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-on-primary disabled:opacity-40"
                    >
                        <Icon name="play_arrow" size={13} />
                        Escuchar
                    </button>
                )}
            </div>

            <div className="flex flex-wrap items-center gap-3 border-b border-outline-variant px-3 py-1 text-[11px] text-on-surface-variant">
                <span className={running ? 'flex items-center gap-1 text-primary' : 'flex items-center gap-1'}>
                    <span className={`h-1.5 w-1.5 rounded-full ${running ? (paused ? 'bg-tertiary' : 'animate-pulse bg-primary') : 'bg-outline'}`} />
                    {running ? (paused ? 'en pausa' : 'escuchando') : 'detenido'}
                </span>
                <span title="Mensajes retenidos en el panel">{messages.length.toLocaleString('es')} mensajes</span>
                {trimmed > 0 && (
                    <span className="text-on-surface-variant/70" title={`El panel guarda los últimos ${MAX_MESSAGES.toLocaleString('es')} mensajes; los más viejos se descartaron para no crecer sin límite.`}>
                        {trimmed.toLocaleString('es')} descartados por antigüedad
                    </span>
                )}
                {dropped > 0 && (
                    <span className="text-tertiary" title="El servidor produjo mensajes más rápido de lo que se pudieron consumir y algunos se perdieron. Se informa en vez de ocultarse.">
                        {dropped.toLocaleString('es')} perdidos por saturación
                    </span>
                )}
                <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="filtrar lo recibido"
                    title="Filtra los mensajes ya recibidos, en el panel. No cambia la suscripción."
                    className="ml-auto w-48 rounded border border-outline-variant bg-surface-container-low px-1.5 py-0.5 text-on-surface"
                />
                <label className="flex items-center gap-1" title="Baja solo al último mensaje a medida que llegan">
                    <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} className="accent-primary" />
                    auto-scroll
                </label>
            </div>

            {error && <p className="px-3 py-1.5 text-xs text-error">{error}</p>}

            <div className="flex-1 overflow-y-auto p-2 font-mono text-xs">
                {visible.length === 0 ? (
                    <p className="text-on-surface-variant">
                        {running ? 'Esperando mensajes…' : 'Elegí canales o un stream y presioná Escuchar.'}
                    </p>
                ) : (
                    visible.map((m, i) => (
                        <div key={i} className="flex gap-2 border-b border-outline-variant/30 py-0.5">
                            <span className="w-20 shrink-0 text-on-surface-variant/60" title={new Date(m.receivedAtMs).toISOString()}>
                                {new Date(m.receivedAtMs).toLocaleTimeString('es')}
                            </span>
                            <span className="w-40 shrink-0 truncate text-primary" title={m.pattern ? `${m.channel} (por el patrón ${m.pattern})` : m.channel}>
                                {m.channel}
                            </span>
                            {m.id && <span className="w-36 shrink-0 truncate text-on-surface-variant/70">{m.id}</span>}
                            <span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-on-surface">
                                {m.fields ? JSON.stringify(m.fields) : m.payload}
                            </span>
                        </div>
                    ))
                )}
                <div ref={bottomRef} />
            </div>
        </div>
    )
}

function splitList(raw: string): string[] {
    return raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '')
}

function matchesFilter(m: StreamMessage, needle: string): boolean {
    if (m.channel.toLowerCase().includes(needle)) return true
    if (m.payload?.toLowerCase().includes(needle)) return true
    if (m.id?.toLowerCase().includes(needle)) return true
    return m.fields ? JSON.stringify(m.fields).toLowerCase().includes(needle) : false
}
