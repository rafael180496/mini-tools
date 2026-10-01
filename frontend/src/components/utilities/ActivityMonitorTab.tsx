import {memo, useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {ProcessSnapshot, StopProcessMonitor} from '../../../wailsjs/go/main/App'
import type {procmon} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import {errorText, formatDateTime, useT} from '../../i18n'
import Sparkline from './Sparkline'
import {formatBytes, formatPercent, formatRate} from './format'
import {NoticeBar, useProcessKiller} from './useProcessKiller'

// Activity Monitor: qué procesos usan CPU y memoria, y cuánta red entra y sale.
//
// **Cuesta solo mientras se mira.** Igual que el Port Killer: el temporizador
// vive en un efecto que solo corre con la pestaña a la vista y la ventana
// visible, y se desarma al ocultarse o cerrarse. Al salir de la vista se llama
// además a StopProcessMonitor, que suelta la lectura que el backend guardaba
// para calcular el % de CPU: con la pestaña fuera de pantalla no queda nada
// retenido ni en marcha. El historial de los gráficos vive solo en este
// componente, así que desaparece con la pestaña.

const INTERVALS = [1, 2, 5]
const DEFAULT_INTERVAL = 2
// Puntos de historia de cada gráfico: con 2 s por lectura son dos minutos.
const HISTORY = 60

type Scope = 'all' | 'mine' | 'active'
type SortKey = 'name' | 'pid' | 'user' | 'cpu' | 'memory'
type Sort = {key: SortKey; dir: 'asc' | 'desc'}

// Por encima de esto un proceso se marca: no es un error, es lo que llama la
// atención cuando se mira una lista de seiscientos.
const CPU_WARN = 25
const CPU_HIGH = 80

interface History {
    cpu: number[]
    mem: number[]
    rx: number[]
    tx: number[]
}

function push(arr: number[], v: number): number[] {
    const next = arr.length >= HISTORY ? arr.slice(arr.length - HISTORY + 1) : arr.slice()
    next.push(v)
    return next
}

interface RowProps {
    p: procmon.Process
    maxMem: number
    showUser: boolean
    selected: boolean
    busy: boolean
    onSelect: (pid: number) => void
    onKill: (p: procmon.Process, force: boolean) => void
    labels: {terminate: string; force: string; terminateTitle: string; forceTitle: string; protectedTitle: string}
}

// Cada fila se redibuja solo si cambió algo de lo que muestra: con unos
// seiscientos procesos y una lectura cada pocos segundos, redibujarlos todos
// por cada lectura sería trabajo en balde para que casi nada cambie.
const ProcessRow = memo(
    function ProcessRow({p, maxMem, showUser, selected, busy, onSelect, onKill, labels}: RowProps) {
        const cpuClass = p.cpu >= CPU_HIGH ? 'font-semibold text-error' : p.cpu >= CPU_WARN ? 'font-semibold text-tertiary' : 'text-on-surface'
        return (
            <tr
                onClick={() => onSelect(p.pid)}
                aria-selected={selected}
                className={`group cursor-default border-b border-outline-variant/30 ${
                    selected ? 'bg-primary-container/40' : 'hover:bg-surface-container-low'
                }`}
            >
                <td className="truncate px-3 py-1.5 font-medium" title={p.name}>
                    {p.name}
                </td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums text-on-surface-variant">{p.pid}</td>
                {showUser && (
                    <td className="truncate px-3 py-1.5 text-on-surface-variant" title={p.user}>
                        {p.user}
                    </td>
                )}
                <td className={`px-3 py-1.5 text-right font-mono tabular-nums ${cpuClass}`}>{formatPercent(p.cpu)}</td>
                <td className="relative px-3 py-1.5 text-right font-mono tabular-nums">
                    {/* La barra detrás del número: la memoria se compara de un
                        vistazo, y el número sigue ahí para quien lo necesite. */}
                    <span
                        aria-hidden
                        className="absolute inset-y-1 left-0 rounded-r bg-primary/15"
                        style={{width: `${maxMem > 0 ? Math.max(1, (p.memory / maxMem) * 100) : 0}%`}}
                    />
                    <span className="relative">{formatBytes(p.memory)}</span>
                </td>
                <td className="px-2 py-1">
                    <span
                        className={`flex items-center justify-end gap-0.5 ${
                            selected ? 'opacity-100' : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100'
                        }`}
                    >
                        <button
                            disabled={p.protected || busy}
                            onClick={(e) => {
                                e.stopPropagation()
                                onKill(p, false)
                            }}
                            title={p.protected ? labels.protectedTitle : labels.terminateTitle}
                            aria-label={labels.terminate}
                            className="flex h-6 w-6 items-center justify-center rounded text-on-surface-variant enabled:hover:bg-surface-variant enabled:hover:text-on-surface disabled:opacity-30"
                        >
                            <Icon name="stop_circle" size={15} />
                        </button>
                        <button
                            disabled={p.protected || busy}
                            onClick={(e) => {
                                e.stopPropagation()
                                onKill(p, true)
                            }}
                            title={p.protected ? labels.protectedTitle : labels.forceTitle}
                            aria-label={labels.force}
                            className="flex h-6 w-6 items-center justify-center rounded text-error enabled:hover:bg-error-container/50 disabled:opacity-30"
                        >
                            <Icon name="dangerous" size={15} />
                        </button>
                    </span>
                </td>
            </tr>
        )
    },
    (a, b) =>
        a.p.pid === b.p.pid &&
        a.p.name === b.p.name &&
        a.p.cpu === b.p.cpu &&
        a.p.memory === b.p.memory &&
        a.p.protected === b.p.protected &&
        a.maxMem === b.maxMem &&
        a.showUser === b.showUser &&
        a.selected === b.selected &&
        a.busy === b.busy &&
        a.labels.terminateTitle === b.labels.terminateTitle &&
        a.labels.forceTitle === b.labels.forceTitle &&
        a.labels.protectedTitle === b.labels.protectedTitle,
)

interface ActivityMonitorTabProps {
    // La pestaña está a la vista. Una pestaña oculta sigue montada (para no
    // perder el filtro ni el orden), pero no consulta.
    visible: boolean
}

export default function ActivityMonitorTab({visible}: ActivityMonitorTabProps) {
    const t = useT()
    const ta = t.utilities.activityMonitor

    const [snap, setSnap] = useState<procmon.Snapshot | null>(null)
    const [history, setHistory] = useState<History>({cpu: [], mem: [], rx: [], tx: []})
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState('')
    const [query, setQuery] = useState('')
    const [scope, setScope] = useState<Scope>('all')
    const [sort, setSort] = useState<Sort>({key: 'cpu', dir: 'desc'})
    const [live, setLive] = useState(true)
    const [every, setEvery] = useState(DEFAULT_INTERVAL)
    const [selected, setSelected] = useState<number | null>(null)

    // Una lectura a la vez: con la máquina cargada una lectura puede tardar más
    // que el intervalo, y apilar otra encima solo la empeoraría.
    const inFlight = useRef(false)

    const load = useCallback(async () => {
        if (inFlight.current) return
        inFlight.current = true
        try {
            const s = await ProcessSnapshot()
            setSnap(s)
            setLoadError('')
            setHistory((h) => {
                // La primera lectura entra dos veces: una línea necesita dos
                // puntos, y mostrar el gráfico vacío hasta la segunda lectura
                // se lee como «no anda».
                const first = h.cpu.length === 0
                const add = (arr: number[], v: number) => (first ? push(push(arr, v), v) : push(arr, v))
                return {
                    cpu: add(h.cpu, s.cpuTotal),
                    mem: add(h.mem, s.memTotal > 0 ? (s.memUsed / s.memTotal) * 100 : 0),
                    rx: add(h.rx, s.netRx),
                    tx: add(h.tx, s.netTx),
                }
            })
        } catch (e) {
            setLoadError(errorText(e))
        } finally {
            inFlight.current = false
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        if (!visible) return
        void load()
        if (!live) return
        const timer = window.setInterval(() => {
            if (!document.hidden) void load()
        }, every * 1000)
        return () => window.clearInterval(timer)
    }, [visible, live, every, load])

    // Al salir de la vista (o cerrar la pestaña) el backend suelta la lectura
    // anterior. Es un efecto aparte del de arriba: pausar o cambiar el
    // intervalo no debe tirarla, solo irse de la pantalla.
    useEffect(() => {
        if (!visible) return
        return () => void StopProcessMonitor()
    }, [visible])

    const killer = useProcessKiller(
        {
            ...ta.kill,
            gone: t.utilities.portKiller.result.gone,
            denied: t.utilities.portKiller.result.denied,
            failed: (error) => t.utilities.portKiller.result.failed({error}),
            ended: (k) => ta.kill.ended({process: k.process}),
            stillRunning: (k) => ta.kill.stillRunning({process: k.process}),
            terminateDescription: (k) => ta.kill.terminateDescription({process: k.process, pid: k.pid}),
            forceDescription: (k) => ta.kill.forceDescription({process: k.process, pid: k.pid}),
            elevateDescription: (k) => ta.kill.elevateDescription({process: k.process, pid: k.pid}),
        },
        () => void load(),
    )

    const processes = snap?.processes ?? []
    const showUser = !!snap?.hasUser

    const counts = useMemo(
        () => ({
            all: processes.length,
            mine: snap?.me ? processes.filter((p) => p.user === snap.me).length : 0,
            active: processes.filter((p) => p.cpu >= 0.1).length,
        }),
        [processes, snap?.me],
    )

    const rows = useMemo(() => {
        const q = query.trim().toLowerCase()
        const list = processes.filter((p) => {
            if (scope === 'mine' && p.user !== snap?.me) return false
            if (scope === 'active' && p.cpu < 0.1) return false
            if (!q) return true
            return p.name.toLowerCase().includes(q) || String(p.pid) === q || p.user.toLowerCase().includes(q)
        })
        const dir = sort.dir === 'asc' ? 1 : -1
        return list.sort((a, b) => {
            const cmp =
                sort.key === 'name'
                    ? a.name.localeCompare(b.name)
                    : sort.key === 'user'
                      ? a.user.localeCompare(b.user)
                      : sort.key === 'pid'
                        ? a.pid - b.pid
                        : sort.key === 'memory'
                          ? a.memory - b.memory
                          : a.cpu - b.cpu
            // Desempate por pid: con muchas filas en 0,0 % el orden no puede
            // depender del azar de cada lectura, o la lista «baila».
            return cmp * dir || a.pid - b.pid
        })
    }, [processes, query, scope, sort, snap?.me])

    const maxMem = useMemo(() => rows.reduce((m, p) => Math.max(m, p.memory), 0), [rows])

    function toggleSort(key: SortKey) {
        setSort((s) =>
            s.key === key
                ? {key, dir: s.dir === 'asc' ? 'desc' : 'asc'}
                : // Números del más grande al más chico: se busca lo que más
                  // consume. Los textos, de la A a la Z.
                  {key, dir: key === 'name' || key === 'user' ? 'asc' : 'desc'},
        )
    }

    const labels = useMemo(
        () => ({
            terminate: ta.terminate,
            force: ta.force,
            terminateTitle: '',
            forceTitle: '',
            protectedTitle: ta.protectedTitle,
        }),
        [ta],
    )

    const onSelect = useCallback((pid: number) => setSelected((cur) => (cur === pid ? null : pid)), [])
    // Función y no componente: definida adentro como componente, cada lectura
    // (cada pocos segundos) la remontaría y el encabezado que acabás de tocar
    // perdería el foco del teclado.
    function sortHead(k: SortKey, label: string) {
        const active = sort.key === k
        const right = k !== 'name' && k !== 'user'
        return (
            <th
                key={k}
                scope="col"
                aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                className="px-3 py-2 font-semibold"
            >
                <button
                    onClick={() => toggleSort(k)}
                    title={ta.sortBy({column: label})}
                    className={`flex w-full items-center gap-1 uppercase tracking-wider ${right ? 'justify-end' : ''} ${
                        active ? 'text-on-surface' : 'hover:text-on-surface'
                    }`}
                >
                    {label}
                    {active && <Icon name={sort.dir === 'asc' ? 'arrow_upward' : 'arrow_downward'} size={12} />}
                </button>
            </th>
        )
    }

    const chips: {id: Scope; label: string; title: string; n: number; hidden?: boolean}[] = [
        {id: 'all', label: ta.filters.all, title: ta.filterTitle.all, n: counts.all},
        {id: 'mine', label: ta.filters.mine, title: ta.filterTitle.mine, n: counts.mine, hidden: !snap?.me},
        {id: 'active', label: ta.filters.active, title: ta.filterTitle.active, n: counts.active},
    ]

    // Tres tarjetas al pie, como las del Monitor de actividad: el estado de
    // toda la máquina queda a la vista mientras se recorre la lista de arriba.
    const last = (a: number[]) => (a.length ? a[a.length - 1] : 0)
    const netMax = Math.max(1024, ...history.rx, ...history.tx)
    const memPct = snap && snap.memTotal > 0 ? (snap.memUsed / snap.memTotal) * 100 : 0

    return (
        <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col bg-surface text-on-surface">
            <div className="flex shrink-0 items-center gap-3 border-b border-outline-variant bg-surface-container-low px-4 py-2">
                <Icon name="monitor_heart" size={18} className="shrink-0 text-primary" />
                <span className="text-sm font-semibold">{t.utilities.tools.activityMonitor.name}</span>

                <div className="ml-2 flex min-w-0 max-w-sm flex-1 items-center gap-1.5 rounded-lg bg-surface-container-highest px-2.5 py-1.5 focus-within:ring-1 focus-within:ring-primary">
                    <Icon name="search" size={14} className="shrink-0 text-on-surface-variant/60" />
                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder={ta.searchPlaceholder}
                        title={ta.searchTitle}
                        className="min-w-0 flex-1 bg-transparent text-xs text-on-surface outline-none placeholder:text-on-surface-variant/60"
                    />
                    {query && (
                        <button onClick={() => setQuery('')} title={ta.clearSearch} className="shrink-0 rounded text-on-surface-variant/60 hover:text-on-surface">
                            <Icon name="close" size={14} />
                        </button>
                    )}
                </div>

                <span className="ml-auto flex shrink-0 items-center gap-1">
                    <button
                        onClick={() => setLive((v) => !v)}
                        title={live ? ta.liveTitle({seconds: every}) : ta.pausedTitle}
                        aria-pressed={live}
                        className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs ${
                            live ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
                        }`}
                    >
                        <Icon name={live ? 'sensors' : 'pause_circle'} size={14} />
                        {live ? ta.live : ta.paused}
                    </button>
                    {/* El intervalo: tres opciones, no un campo numérico. Un
                        valor libre invita a poner 0,1 s y consultar diez veces
                        por segundo. */}
                    <span role="group" title={ta.everyTitle} className="flex items-center rounded-lg bg-surface-container-highest p-0.5">
                        {INTERVALS.map((s) => (
                            <button
                                key={s}
                                onClick={() => setEvery(s)}
                                aria-pressed={every === s}
                                className={`rounded-md px-2 py-1 font-mono text-ui-10 tabular-nums ${
                                    every === s ? 'bg-surface text-on-surface shadow-sm' : 'text-on-surface-variant hover:text-on-surface'
                                }`}
                            >
                                {ta.everySeconds({seconds: s})}
                            </button>
                        ))}
                    </span>
                    <button
                        onClick={() => void load()}
                        title={ta.refreshTitle}
                        className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="refresh" size={14} />
                        {ta.refresh}
                    </button>
                </span>
            </div>

            <div className="flex shrink-0 items-center gap-1.5 border-b border-outline-variant px-4 py-2">
                {chips
                    .filter((c) => !c.hidden)
                    .map((c) => (
                        <button
                            key={c.id}
                            onClick={() => setScope(c.id)}
                            title={c.title}
                            aria-pressed={scope === c.id}
                            className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition-colors ${
                                scope === c.id ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
                            }`}
                        >
                            {c.label}
                            <span className="font-mono text-ui-10 tabular-nums opacity-70">{c.n}</span>
                        </button>
                    ))}
                {/* Ancho reservado para el contador: «642 procesos» y «3 de 642
                    procesos» no deben empujar nada cuando cambian. */}
                <span className="ml-auto flex items-center gap-2 text-ui-10 text-on-surface-variant/70">
                    <span className="font-mono tabular-nums">{ta.count({shown: rows.length, total: processes.length})}</span>
                    {snap && <span>· {ta.updatedAt({time: formatDateTime(new Date(snap.takenAt), {timeStyle: 'medium'})})}</span>}
                </span>
            </div>

            <NoticeBar notice={killer.notice} onDismiss={killer.dismiss} dismissLabel={t.utilities.portKiller.dismiss} />

            <div className="min-h-0 flex-1 overflow-auto">
                {loadError && !snap ? (
                    <div className="flex flex-col items-center gap-1 px-6 py-12 text-center">
                        <Icon name="error" size={24} className="text-error" />
                        <p className="text-sm font-medium">{ta.loadFailed}</p>
                        <p className="max-w-md text-xs text-on-surface-variant">{loadError}</p>
                    </div>
                ) : loading ? (
                    <p className="px-6 py-12 text-center text-xs text-on-surface-variant">{ta.loading}</p>
                ) : rows.length === 0 ? (
                    <div className="flex flex-col items-center gap-1 px-6 py-12 text-center text-on-surface-variant">
                        <Icon name="monitor_heart" size={28} className="opacity-40" />
                        <p className="text-xs">{query.trim() ? ta.noMatches({query: query.trim()}) : ta.empty}</p>
                    </div>
                ) : (
                    <table className="w-full table-fixed border-collapse text-xs">
                        <colgroup>
                            <col />
                            <col className="w-20" />
                            {showUser && <col className="w-36" />}
                            <col className="w-24" />
                            <col className="w-40" />
                            <col className="w-20" />
                        </colgroup>
                        <thead className="sticky top-0 z-[1] bg-surface-container-low text-left text-ui-10 text-on-surface-variant">
                            <tr className="border-b border-outline-variant">
                                {sortHead('name', ta.columns.name)}
                                {sortHead('pid', ta.columns.pid)}
                                {showUser && sortHead('user', ta.columns.user)}
                                {sortHead('cpu', ta.columns.cpu)}
                                {sortHead('memory', ta.columns.memory)}
                                <th />
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((p) => (
                                <ProcessRow
                                    key={p.pid}
                                    p={p}
                                    maxMem={maxMem}
                                    showUser={showUser}
                                    selected={selected === p.pid}
                                    busy={killer.busyPid === p.pid}
                                    onSelect={onSelect}
                                    onKill={(proc, force) => killer.request({process: proc.name, pid: proc.pid}, force)}
                                    labels={{
                                        ...labels,
                                        terminateTitle: ta.terminateTitle({process: p.name, pid: p.pid}),
                                        forceTitle: ta.forceTitle({process: p.name, pid: p.pid}),
                                    }}
                                />
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {snap && (
                <div className="grid shrink-0 grid-cols-1 gap-3 border-t border-outline-variant bg-surface-container-low px-4 py-3 sm:grid-cols-3">
                    <div className="min-w-0 rounded-lg border border-outline-variant/60 bg-surface px-3 py-2">
                        <div className="flex items-baseline justify-between gap-2">
                            <span className="text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant">{ta.summary.cpu}</span>
                            <span className="truncate text-ui-10 text-on-surface-variant/70">{ta.summary.cpuDetail({cores: snap.cores})}</span>
                        </div>
                        <div className="font-mono text-lg font-semibold tabular-nums">{formatPercent(snap.cpuTotal)}%</div>
                        <Sparkline values={history.cpu} max={100} capacity={HISTORY} className="text-primary" />
                    </div>
                    <div className="min-w-0 rounded-lg border border-outline-variant/60 bg-surface px-3 py-2">
                        <div className="flex items-baseline justify-between gap-2">
                            <span className="text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant">{ta.summary.memory}</span>
                            <span className="truncate text-ui-10 text-on-surface-variant/70">
                                {ta.summary.memoryDetail({used: formatBytes(snap.memUsed), total: formatBytes(snap.memTotal)})}
                            </span>
                        </div>
                        <div className="font-mono text-lg font-semibold tabular-nums">{formatPercent(memPct, 0)}%</div>
                        <Sparkline values={history.mem} max={100} capacity={HISTORY} className="text-secondary" />
                    </div>
                    <div className="min-w-0 rounded-lg border border-outline-variant/60 bg-surface px-3 py-2">
                        <div className="flex items-baseline justify-between gap-2">
                            <span className="text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant">{ta.summary.network}</span>
                            <span className="flex items-center gap-2 font-mono text-ui-10 tabular-nums text-on-surface-variant">
                                <span className="flex items-center gap-0.5 text-primary" title={ta.summary.down}>
                                    <Icon name="arrow_downward" size={11} />
                                    {formatRate(last(history.rx))}
                                </span>
                                <span className="flex items-center gap-0.5 text-tertiary" title={ta.summary.up}>
                                    <Icon name="arrow_upward" size={11} />
                                    {formatRate(last(history.tx))}
                                </span>
                            </span>
                        </div>
                        <div className="font-mono text-lg font-semibold tabular-nums">{formatRate(last(history.rx) + last(history.tx))}</div>
                        <Sparkline values={history.rx} secondary={history.tx} max={netMax} capacity={HISTORY} className="text-primary" secondaryClassName="text-tertiary" />
                    </div>
                </div>
            )}

            <p className="flex shrink-0 items-center gap-1.5 border-t border-outline-variant px-4 py-1.5 text-ui-10 text-on-surface-variant/70">
                <Icon name="info" size={12} className="shrink-0" />
                {ta.footNote}
            </p>

            {killer.dialog}
        </div>
    )
}
