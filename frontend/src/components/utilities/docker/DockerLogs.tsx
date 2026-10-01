import {memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode} from 'react'
import {
    DockerBuildLogs,
    DockerExportBuildLogs,
    DockerExportContainerLogs,
    DockerInspect,
    DockerLogsStart,
    DockerLogsStop,
    DockerSaveText,
} from '../../../../wailsjs/go/main/App'
import {EventsOn} from '../../../../wailsjs/runtime'
import Icon from '../../Icon'
import {errorText, useT} from '../../../i18n'
import type {ContainerOp} from './DockerContainers'
import {formatBytes} from '../format'
import ExportLimit from './ExportLimit'
import type {Notice} from '../useProcessKiller'

// El panel de detalle de Docker: los logs en vivo de un contenedor, o la
// configuración completa (`docker inspect`) de lo que se haya elegido.
//
// **Los logs en vivo existen solo mientras este panel está montado.** Abrir el
// panel arranca un `docker logs -f` en el backend; cerrarlo (o cambiar a otro
// contenedor, o salir de la pestaña) lo termina. No hay un flujo que siga
// corriendo para un panel que nadie mira.

// 'build' es el log de un build del historial: se lee como texto, como el
// inspect, pero se puede exportar.
export type DetailKind = 'container' | 'image' | 'volume' | 'network' | 'build'

export interface DetailTarget {
    kind: DetailKind
    // Lo que se le pasa a Docker: el id (o el nombre del volumen/red).
    id: string
    // Cómo se lo nombra en la cabecera.
    title: string
}

// Estado del contenedor del panel, para ofrecer detenerlo o iniciarlo sin salir
// de los logs: es justo donde uno decide hacerlo.
export interface ContainerInfo {
    running: boolean
    busy: boolean
}

// Cuántas líneas se piden al abrir, como máximo. El backend aplica el mismo tope.
const MAX_TAIL = 10000
const TAIL_PRESETS = [100, 500, 1000, 5000, 10000]
// Cuántas líneas se conservan en pantalla: lo pedido más un margen para lo que
// llegue después, con un piso y un techo. Un contenedor hablador produce decenas
// de miles de líneas, y dibujarlas todas congelaría la interfaz.
const keepFor = (tail: number) => Math.min(11000, Math.max(3000, tail + 1000))
const FONT_SIZES = [10, 11, 12, 13, 14, 16]
const DEFAULT_FONT = 11
const FONT_KEY = 'mini-tools.docker.logFont'

interface LogEvent {
    lines?: string[]
    end?: boolean
    error?: string
}

// Secuencias de color/cursor de la terminal. Docker las deja pasar tal cual
// cuando el contenedor las escribe, y en un <div> se verían como `[32m`.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

const TS = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s?/

// Una línea ya partida en hora y texto. Se calcula al llegar y no al dibujar:
// con miles de líneas y un dibujado cada 100 ms, parsear fechas en cada uno
// sería trabajo repetido para obtener lo mismo.
interface Line {
    n: number
    time: string
    text: string
    // En minúsculas, una vez: buscar en cada línea con cada tecla sin esto
    // vuelve a bajar a minúsculas miles de textos.
    lower: string
    level: 'error' | 'warn' | ''
}

function toLine(raw: string, n: number): Line {
    const clean = raw.replace(ANSI, '')
    const m = TS.exec(clean)
    let time = ''
    let text = clean
    if (m) {
        text = clean.slice(m[0].length)
        const d = new Date(m[1])
        // Hora local con milésimas; si la fecha no se puede leer, cae a la
        // cruda en vez de esconder la línea.
        time = Number.isNaN(d.getTime())
            ? m[1]
            : `${d.toLocaleTimeString([], {hour12: false})}.${String(d.getMilliseconds()).padStart(3, '0')}`
    }
    // Heurística de color, no una clasificación: pinta lo que llama la atención
    // (un error o un aviso) y deja el resto neutro.
    const level = /\b(error|fatal|panic|exception|fail(ed)?)\b/i.test(text) ? 'error' : /\b(warn(ing)?)\b/i.test(text) ? 'warn' : ''
    return {n, time, text, lower: text.toLowerCase(), level}
}

// El texto de una línea con las coincidencias marcadas. Se corta con índices
// sobre la versión en minúsculas (que mide lo mismo que el original para el
// texto habitual) en vez de armar una expresión regular con lo que escribió el
// usuario: así un `(` o un `*` en la búsqueda no rompe nada.
function highlight(text: string, lower: string, q: string, active: boolean): ReactNode {
    if (!q) return text || ' '
    const out: ReactNode[] = []
    let from = 0
    for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, from)) {
        if (i > from) out.push(text.slice(from, i))
        out.push(
            <mark
                key={i}
                className={`rounded-sm px-px text-on-surface ${active ? 'bg-primary/60 ring-1 ring-primary' : 'bg-tertiary/30'}`}
            >
                {text.slice(i, i + q.length)}
            </mark>,
        )
        from = i + q.length
    }
    if (from === 0) return text || ' '
    if (from < text.length) out.push(text.slice(from))
    return out
}

const LogLine = memo(function LogLine({
    line,
    showTime,
    wrap,
    query,
    active,
}: {
    line: Line
    showTime: boolean
    wrap: boolean
    query: string
    active: boolean
}) {
    const color = line.level === 'error' ? 'text-error' : line.level === 'warn' ? 'text-tertiary' : 'text-on-surface'
    return (
        <div data-line={line.n} className={`flex gap-3 px-3 hover:bg-surface-container-low ${active ? 'bg-primary/10' : ''} ${wrap ? 'items-start' : ''}`}>
            {showTime && <span className="w-24 shrink-0 select-none text-on-surface-variant/50">{line.time}</span>}
            <span className={`min-w-0 flex-1 ${color} ${wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}`}>
                {highlight(line.text, line.lower, query, active)}
            </span>
        </div>
    )
})

function readFont(): number {
    try {
        const v = Number(localStorage.getItem(FONT_KEY))
        return FONT_SIZES.includes(v) ? v : DEFAULT_FONT
    } catch {
        return DEFAULT_FONT
    }
}

interface DockerDetailProps {
    target: DetailTarget
    // El panel abre en Logs para un contenedor y en Inspeccionar para el resto
    // (una imagen o un volumen no tienen logs).
    initialTab: 'logs' | 'inspect'
    onClose: () => void
    // Solo para un contenedor: su estado y qué hacer con él desde el panel.
    container?: ContainerInfo
    onOp?: (op: ContainerOp) => void
    // Maximizar: el panel ocupa todo el ancho y la lista se esconde.
    expanded: boolean
    onToggleExpand: () => void
    // El resultado de una exportación se avisa en la franja de la pantalla.
    onNotice: (n: Notice) => void
    // Tope de líneas de lo que se exporta (100 a 10000), compartido por todo lo
    // exportable de la pantalla.
    exportLines: number
    onExportLines: (n: number) => void
}

export default function DockerDetail({target, initialTab, onClose, container, onOp, expanded, onToggleExpand, onNotice, exportLines, onExportLines}: DockerDetailProps) {
    const t = useT()
    const td = t.utilities.docker.detail
    const tc = t.utilities.docker.containers
    const canLog = target.kind === 'container'
    const [tab, setTab] = useState<'logs' | 'inspect'>(canLog ? initialTab : 'inspect')

    const hdrBtn = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-on-surface-variant enabled:hover:bg-surface-variant enabled:hover:text-on-surface disabled:opacity-40'

    return (
        <div className="flex h-full min-h-0 min-w-0 flex-col bg-surface">
            <div className="flex shrink-0 items-center gap-1.5 border-b border-outline-variant bg-surface-container-low px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate text-xs font-semibold" title={target.title}>
                    {target.title}
                </span>
                {canLog && container && onOp && (
                    <span className="flex shrink-0 items-center gap-0.5">
                        {container.running ? (
                            <button disabled={container.busy} onClick={() => onOp('stop')} title={tc.stopTitle({name: target.title})} aria-label={tc.stop} className={hdrBtn}>
                                <Icon name="stop" size={16} />
                            </button>
                        ) : (
                            <button disabled={container.busy} onClick={() => onOp('start')} title={tc.startTitle({name: target.title})} aria-label={tc.start} className={hdrBtn}>
                                <Icon name="play_arrow" size={16} />
                            </button>
                        )}
                        <button disabled={container.busy} onClick={() => onOp('restart')} title={tc.restartTitle({name: target.title})} aria-label={tc.restart} className={hdrBtn}>
                            <Icon name="restart_alt" size={16} />
                        </button>
                    </span>
                )}
                {canLog && (
                    <span role="tablist" className="flex shrink-0 items-center rounded-lg bg-surface-container-highest p-0.5">
                        {(['logs', 'inspect'] as const).map((k) => (
                            <button
                                key={k}
                                role="tab"
                                aria-selected={tab === k}
                                onClick={() => setTab(k)}
                                className={`rounded-md px-2.5 py-1 text-xs ${
                                    tab === k ? 'bg-surface text-on-surface shadow-sm' : 'text-on-surface-variant hover:text-on-surface'
                                }`}
                            >
                                {k === 'logs' ? td.logs : td.inspect}
                            </button>
                        ))}
                    </span>
                )}
                <button onClick={onToggleExpand} title={expanded ? td.restore : td.expand} aria-label={expanded ? td.restore : td.expand} className={hdrBtn}>
                    <Icon name={expanded ? 'close_fullscreen' : 'open_in_full'} size={15} />
                </button>
                <button onClick={onClose} title={td.closeTitle} aria-label={td.close} className={hdrBtn}>
                    <Icon name="close" size={16} />
                </button>
            </div>
            {tab === 'logs' && canLog ? (
                <LogsView key={target.id} id={target.id} name={target.title} onNotice={onNotice} exportLines={exportLines} onExportLines={onExportLines} />
            ) : (
                <InspectView key={`${target.kind}:${target.id}`} target={target} onNotice={onNotice} exportLines={exportLines} onExportLines={onExportLines} />
            )}
        </div>
    )
}

// Texto de solo lectura: la configuración de lo elegido (`docker inspect`) o el
// log de un build. Es lo mismo —un bloque de texto largo que se copia— salvo que
// el log de un build además se exporta.
function InspectView({target, onNotice, exportLines, onExportLines}: {target: DetailTarget; onNotice: (n: Notice) => void; exportLines: number; onExportLines: (n: number) => void}) {
    const t = useT()
    const td = t.utilities.docker.detail
    const tb = t.utilities.docker.builds
    const isBuild = target.kind === 'build'
    const [text, setText] = useState('')
    const [truncated, setTruncated] = useState(false)
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(true)
    const [copied, setCopied] = useState(false)
    const [exporting, setExporting] = useState(false)

    useEffect(() => {
        let cancelled = false
        setLoading(true)
        const load = isBuild
            ? DockerBuildLogs(target.id).then((r) => ({text: r.text, truncated: r.truncated}))
            : DockerInspect(target.kind, target.id).then((s) => ({text: s, truncated: false}))
        load.then((r) => !cancelled && (setText(r.text), setTruncated(r.truncated), setError('')))
            .catch((e) => !cancelled && setError(errorText(e)))
            .finally(() => !cancelled && setLoading(false))
        return () => {
            cancelled = true
        }
    }, [target.kind, target.id, isBuild])

    async function exportBuild() {
        setExporting(true)
        try {
            const r = await DockerExportBuildLogs(target.id, target.title, exportLines)
            if (r.path) onNotice({tone: 'ok', text: td.exported({path: r.path, size: formatBytes(r.bytes), lines: r.lines})})
        } catch (e) {
            onNotice({tone: 'error', text: td.exportFailed({error: errorText(e)})})
        } finally {
            setExporting(false)
        }
    }

    const btn = 'flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-on-surface-variant enabled:hover:bg-surface-variant enabled:hover:text-on-surface disabled:opacity-40'
    return (
        <>
            <div className="flex shrink-0 items-center justify-end gap-1 border-b border-outline-variant px-3 py-1.5">
                {isBuild && <ExportLimit value={exportLines} onChange={onExportLines} />}
                {isBuild && (
                    <button disabled={exporting} onClick={() => void exportBuild()} title={tb.exportTitle} className={btn}>
                        <Icon name="download" size={14} />
                        {td.export}
                    </button>
                )}
                <button
                    disabled={!text}
                    onClick={() => {
                        void navigator.clipboard.writeText(text).then(() => {
                            setCopied(true)
                            window.setTimeout(() => setCopied(false), 1500)
                        })
                    }}
                    title={td.copyTitle}
                    className={btn}
                >
                    <Icon name={copied ? 'check' : 'content_copy'} size={14} />
                    {copied ? td.copied : td.copy}
                </button>
            </div>
            {truncated && (
                <p className="shrink-0 border-b border-outline-variant bg-tertiary-container/40 px-3 py-1.5 text-ui-10 text-on-tertiary-container">
                    {tb.truncated({kb: 2048})}
                </p>
            )}
            <div className="min-h-0 flex-1 overflow-auto p-3">
                {loading ? (
                    <p className="text-xs text-on-surface-variant">{td.inspectLoading}</p>
                ) : error ? (
                    <div className="flex flex-col gap-1">
                        <p className="text-sm font-medium text-error">{td.inspectFailed}</p>
                        <p className="text-xs text-on-surface-variant">{error}</p>
                    </div>
                ) : (
                    <pre className="whitespace-pre font-mono text-ui-11 leading-relaxed text-on-surface">{text}</pre>
                )}
            </div>
        </>
    )
}

function LogsView({id, name, onNotice, exportLines, onExportLines}: {id: string; name: string; onNotice: (n: Notice) => void; exportLines: number; onExportLines: (n: number) => void}) {
    const t = useT()
    const td = t.utilities.docker.detail

    const [lines, setLines] = useState<Line[]>([])
    const [search, setSearch] = useState('')
    const [onlyMatches, setOnlyMatches] = useState(false)
    const [cur, setCur] = useState(0)
    const [navTick, setNavTick] = useState(0)
    const [follow, setFollow] = useState(true)
    const [wrap, setWrap] = useState(false)
    const [showTime, setShowTime] = useState(true)
    const [tail, setTail] = useState(500)
    const [tailText, setTailText] = useState('500')
    const [font, setFont] = useState(readFont)
    const [streaming, setStreaming] = useState(true)
    const [note, setNote] = useState('')
    const [copied, setCopied] = useState(false)
    const [menu, setMenu] = useState(false)
    const [exporting, setExporting] = useState(false)

    const scroller = useRef<HTMLDivElement>(null)
    const counter = useRef(0)
    const keep = useRef(keepFor(500))
    keep.current = keepFor(tail)

    // Base del id de sesión: el nombre del evento de Wails por el que llegan las
    // líneas. Cada APERTURA del flujo le suma un número (ver el efecto): si
    // reabrir reusara el mismo nombre, el aviso de cierre del flujo viejo
    // —que llega después de pedir su cierre— se leería como el cierre del nuevo.
    const base = useRef(`docker-logs-${Math.random().toString(36).slice(2)}`)
    const opens = useRef(0)

    // Abre el flujo mientras `streaming` esté encendido. Cambiar `tail` o
    // reanudar lo reabre; pausar, cambiar de contenedor o cerrar el panel lo
    // termina.
    useEffect(() => {
        if (!streaming) return
        setNote('')
        const sid = `${base.current}-${++opens.current}`
        // Suscribirse ANTES de abrir: el primer lote puede llegar antes de que
        // EventsOn corra si se hace al revés (mismo contrato que las terminales).
        const off = EventsOn(sid, (ev: LogEvent) => {
            if (ev.lines?.length) {
                const batch = ev.lines.map((raw) => toLine(raw, counter.current++))
                setLines((prev) => {
                    const all = prev.concat(batch)
                    return all.length > keep.current ? all.slice(all.length - keep.current) : all
                })
            }
            if (ev.end) {
                setNote(ev.error ? td.endedError({error: ev.error}) : td.ended)
                setStreaming(false)
            }
        })
        DockerLogsStart(sid, id, tail).catch((e) => {
            setNote(td.endedError({error: errorText(e)}))
            setStreaming(false)
        })
        return () => {
            off()
            void DockerLogsStop(sid)
        }
        // `td` cambia con el idioma y no debe reabrir el flujo.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, tail, streaming])

    const q = search.trim().toLowerCase()
    // «Solo coincidencias» filtra; sin ello se ve todo y las coincidencias se
    // marcan. En los dos casos `matches` son las líneas que contienen el texto.
    const shown = useMemo(() => (q && onlyMatches ? lines.filter((l) => l.lower.includes(q)) : lines), [lines, q, onlyMatches])
    const matches = useMemo(() => (q ? shown.filter((l) => l.lower.includes(q)).map((l) => l.n) : []), [shown, q])
    const curIdx = matches.length ? Math.min(cur, matches.length - 1) : -1
    const activeLine = curIdx >= 0 ? matches[curIdx] : -1

    // Cambiar el texto vuelve a la primera coincidencia.
    useEffect(() => {
        setCur(0)
        setNavTick((n) => n + 1)
    }, [q])

    function go(delta: 1 | -1) {
        if (matches.length === 0) return
        setCur((c) => (Math.min(c, matches.length - 1) + delta + matches.length) % matches.length)
        // Saltar a una coincidencia vieja no puede pelear con el seguimiento
        // del final.
        setFollow(false)
        setNavTick((n) => n + 1)
    }

    // Lleva la coincidencia activa al centro. Solo al navegar o al cambiar el
    // texto (navTick), no por cada línea nueva: si no, el panel saltaría solo
    // mientras se lee.
    useLayoutEffect(() => {
        if (activeLine < 0) return
        scroller.current?.querySelector(`[data-line="${activeLine}"]`)?.scrollIntoView({block: 'center'})
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [navTick])

    // Pegado al final mientras `follow` esté encendido. useLayoutEffect y no
    // useEffect: con el efecto normal se ve un cuadro con la línea nueva fuera
    // de vista antes de bajar.
    useLayoutEffect(() => {
        const el = scroller.current
        if (follow && el) el.scrollTop = el.scrollHeight
    }, [shown, follow])

    function onScroll() {
        const el = scroller.current
        if (!el) return
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        // Subir apaga el seguimiento (leer una línea vieja no puede pelear con
        // las nuevas); volver al fondo lo enciende.
        setFollow((f) => (f === atBottom ? f : atBottom))
    }

    function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
        if (e.key === 'Enter') {
            e.preventDefault()
            go(e.shiftKey ? -1 : 1)
        } else if (e.key === 'Escape') {
            setSearch('')
        }
    }

    // Aplica el tamaño escrito. Reabre el flujo solo si cambió: pedir otra
    // cantidad de líneas anteriores es abrir otro `docker logs`.
    function commitTail() {
        const n = Math.round(Number(tailText))
        const next = Number.isFinite(n) && n >= 1 ? Math.min(MAX_TAIL, n) : tail
        setTailText(String(next))
        if (next !== tail) {
            setLines([])
            setTail(next)
            setStreaming(true)
        }
    }

    // Exportar. «Todo el historial» lo pide a Docker sin el tope del panel (puede
    // ser mucho más que lo que se ve); «Lo que se ve» guarda las líneas en
    // pantalla con el filtro de la búsqueda aplicado.
    async function doExport(what: 'all' | 'view') {
        setMenu(false)
        setExporting(true)
        try {
            const r =
                what === 'all'
                    ? await DockerExportContainerLogs(id, name, exportLines)
                    : await DockerSaveText(name, shown.map((l) => (showTime && l.time ? `${l.time} ${l.text}` : l.text)).join('\n'), exportLines)
            // Path vacío: se canceló el diálogo, y cancelar no es un resultado.
            if (r.path) onNotice({tone: 'ok', text: td.exported({path: r.path, size: formatBytes(r.bytes), lines: r.lines})})
        } catch (e) {
            onNotice({tone: 'error', text: td.exportFailed({error: errorText(e)})})
        } finally {
            setExporting(false)
        }
    }

    function changeFont(delta: 1 | -1) {
        const i = FONT_SIZES.indexOf(font)
        const next = FONT_SIZES[Math.min(FONT_SIZES.length - 1, Math.max(0, i + delta))]
        setFont(next)
        try {
            localStorage.setItem(FONT_KEY, String(next))
        } catch {
            // El tamaño de letra es una comodidad: sin almacenamiento, vale
            // solo para esta apertura.
        }
    }

    const toggle = (on: boolean) =>
        on ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
    const btn = 'flex items-center gap-1 rounded-lg px-2 py-1 text-xs'
    const idle = 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'

    return (
        <>
            {/* Fila 1: buscar. El contador «3 de 12» es el índice: dice cuántas
                coincidencias hay y en cuál se está parado. */}
            <div className="flex shrink-0 items-center gap-1.5 border-b border-outline-variant px-3 py-1.5">
                <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-surface-container-highest px-2 py-1 focus-within:ring-1 focus-within:ring-primary">
                    <Icon name="search" size={13} className="shrink-0 text-on-surface-variant/60" />
                    <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        onKeyDown={onSearchKey}
                        placeholder={td.filterPlaceholder}
                        title={td.filterTitle}
                        className="min-w-0 flex-1 bg-transparent text-xs text-on-surface outline-none placeholder:text-on-surface-variant/60"
                    />
                    {q && (
                        <span className={`shrink-0 font-mono text-ui-10 tabular-nums ${matches.length ? 'text-on-surface-variant' : 'text-error'}`}>
                            {matches.length ? td.matchOf({cur: curIdx + 1, total: matches.length}) : td.noMatch}
                        </span>
                    )}
                    {search && (
                        <button onClick={() => setSearch('')} aria-label={t.utilities.docker.clearSearch} className="shrink-0 rounded text-on-surface-variant/60 hover:text-on-surface">
                            <Icon name="close" size={13} />
                        </button>
                    )}
                </div>
                <button disabled={matches.length === 0} onClick={() => go(-1)} title={td.prevMatch} aria-label={td.prevMatch} className={`${btn} ${idle} px-1.5 disabled:opacity-35`}>
                    <Icon name="keyboard_arrow_up" size={16} />
                </button>
                <button disabled={matches.length === 0} onClick={() => go(1)} title={td.nextMatch} aria-label={td.nextMatch} className={`${btn} ${idle} px-1.5 disabled:opacity-35`}>
                    <Icon name="keyboard_arrow_down" size={16} />
                </button>
                <button onClick={() => setOnlyMatches((v) => !v)} aria-pressed={onlyMatches} title={td.onlyMatchesTitle} className={`${btn} ${toggle(onlyMatches)}`}>
                    <Icon name="filter_alt" size={14} />
                    {td.onlyMatches}
                </button>
            </div>

            {/* Fila 2: qué se ve y cómo. */}
            <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-outline-variant px-3 py-1">
                <label title={td.tailTitle} className="flex items-center gap-1.5 rounded-lg bg-surface-container-highest px-2 py-1 text-xs text-on-surface-variant">
                    {td.tailLabel}
                    <input
                        type="number"
                        min={1}
                        max={MAX_TAIL}
                        list="docker-tail-presets"
                        value={tailText}
                        onChange={(e) => setTailText(e.target.value)}
                        onBlur={commitTail}
                        onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget.blur(), undefined)}
                        className="w-16 bg-transparent text-right font-mono tabular-nums text-on-surface outline-none"
                    />
                    <datalist id="docker-tail-presets">
                        {TAIL_PRESETS.map((n) => (
                            <option key={n} value={n} />
                        ))}
                    </datalist>
                    {td.tailUnit}
                </label>

                <span className="ml-auto flex flex-wrap items-center gap-0.5">
                    <button onClick={() => setStreaming((s) => !s)} aria-pressed={streaming} title={streaming ? td.liveTitle : td.pausedTitle} className={`${btn} ${toggle(streaming)}`}>
                        <Icon name={streaming ? 'sensors' : 'pause_circle'} size={14} />
                        {streaming ? td.live : td.pause}
                    </button>
                    <button onClick={() => setFollow((f) => !f)} aria-pressed={follow} title={td.followTitle} className={`${btn} ${toggle(follow)}`}>
                        <Icon name="vertical_align_bottom" size={14} />
                        {td.follow}
                    </button>
                    <button onClick={() => setShowTime((v) => !v)} aria-pressed={showTime} title={td.timeTitle} className={`${btn} ${toggle(showTime)}`}>
                        <Icon name="schedule" size={14} />
                        {td.time}
                    </button>
                    <button onClick={() => setWrap((v) => !v)} aria-pressed={wrap} title={td.wrapTitle} className={`${btn} ${toggle(wrap)}`}>
                        <Icon name="wrap_text" size={14} />
                        {td.wrap}
                    </button>
                    <span className="flex items-center">
                        <button disabled={font === FONT_SIZES[0]} onClick={() => changeFont(-1)} title={td.fontSmaller} aria-label={td.fontSmaller} className={`${btn} ${idle} px-1.5 disabled:opacity-35`}>
                            <Icon name="text_decrease" size={15} />
                        </button>
                        <button disabled={font === FONT_SIZES[FONT_SIZES.length - 1]} onClick={() => changeFont(1)} title={td.fontBigger} aria-label={td.fontBigger} className={`${btn} ${idle} px-1.5 disabled:opacity-35`}>
                            <Icon name="text_increase" size={15} />
                        </button>
                    </span>
                    <button onClick={() => setLines([])} title={td.clearTitle} className={`${btn} ${idle}`}>
                        <Icon name="delete_sweep" size={14} />
                        {td.clear}
                    </button>
                    <button
                        disabled={shown.length === 0}
                        onClick={() => {
                            const text = shown.map((l) => (showTime && l.time ? `${l.time} ${l.text}` : l.text)).join('\n')
                            void navigator.clipboard.writeText(text).then(() => {
                                setCopied(true)
                                window.setTimeout(() => setCopied(false), 1500)
                            })
                        }}
                        title={td.copyTitle}
                        className={`${btn} ${idle} disabled:opacity-40`}
                    >
                        <Icon name={copied ? 'check' : 'content_copy'} size={14} />
                        {copied ? td.copied : td.copy}
                    </button>
                    <span className="relative">
                        <button disabled={exporting} onClick={() => setMenu((m) => !m)} aria-expanded={menu} title={td.exportTitle} className={`${btn} ${idle} disabled:opacity-40`}>
                            <Icon name="download" size={14} />
                            {td.export}
                        </button>
                        {menu && (
                            <>
                                {/* Un velo transparente: cerrar el menú con un clic afuera. */}
                                <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
                                <div role="menu" className="absolute right-0 top-full z-20 mt-1 w-64 rounded-lg border border-outline-variant bg-surface-container-high p-1 shadow-lg">
                                    <div className="px-1.5 pb-1 pt-0.5">
                                        <ExportLimit value={exportLines} onChange={onExportLines} />
                                    </div>
                                    <button role="menuitem" onClick={() => void doExport('all')} title={td.exportAllTitle} className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs hover:bg-surface-variant">
                                        <Icon name="history" size={14} className="text-on-surface-variant" />
                                        {td.exportAll}
                                    </button>
                                    <button role="menuitem" disabled={shown.length === 0} onClick={() => void doExport('view')} title={td.exportViewTitle} className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs hover:bg-surface-variant disabled:opacity-40">
                                        <Icon name="visibility" size={14} className="text-on-surface-variant" />
                                        {td.exportView}
                                    </button>
                                </div>
                            </>
                        )}
                    </span>
                </span>
            </div>

            <div
                ref={scroller}
                onScroll={onScroll}
                style={{fontSize: `calc(${font}px * var(--ui-font-scale))`, lineHeight: 1.55}}
                className="min-h-0 flex-1 overflow-auto bg-surface-container-lowest py-1 font-mono"
            >
                {shown.length === 0 ? (
                    <p className="px-3 py-2 font-sans text-xs text-on-surface-variant">{lines.length === 0 ? td.waiting : td.noMatches}</p>
                ) : (
                    shown.map((l) => <LogLine key={l.n} line={l} showTime={showTime} wrap={wrap} query={q} active={l.n === activeLine} />)
                )}
            </div>

            <div className="flex shrink-0 items-center gap-2 border-t border-outline-variant px-3 py-1 text-ui-10 text-on-surface-variant/70">
                <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${streaming ? 'bg-primary' : 'bg-outline'}`} />
                <span className="font-mono tabular-nums">{td.lines({shown: shown.length, total: lines.length})}</span>
                {lines.length >= keep.current && <span>· {td.capped({max: keep.current})}</span>}
                {note && <span className="min-w-0 truncate text-on-surface-variant">· {note}</span>}
            </div>
        </>
    )
}
