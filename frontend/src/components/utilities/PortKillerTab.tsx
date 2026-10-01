import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {ListListeningPorts} from '../../../wailsjs/go/main/App'
import {BrowserOpenURL} from '../../../wailsjs/runtime'
import type {portkill} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import {errorText, formatDateTime, useT} from '../../i18n'
import {NoticeBar, useProcessKiller, type KillTarget} from './useProcessKiller'

// Port Killer: qué proceso tiene ocupado cada puerto TCP, y terminarlo.
//
// **Cuesta solo mientras se usa.** Este componente existe únicamente mientras
// la pestaña está abierta, y su única fuente de trabajo es un temporizador que
// vive en el efecto de abajo: se arma cuando la pestaña está a la vista y la
// ventana visible, y se desarma en el mismo momento en que deja de estarlo o se
// cierra la pestaña. El backend tampoco guarda nada entre consultas (ver
// backend/portkill): cada lectura es un `lsof`/`netstat` que arranca y termina.
// Con la pestaña cerrada no hay timer, ni goroutine, ni proceso, ni datos.

// Cada cuánto se relee mientras el modo automático está encendido.
const AUTO_REFRESH_MS = 5000

type Scope = 'all' | 'local' | 'network'
type SortKey = 'port' | 'process' | 'pid'

// Una dirección que acepta conexiones de otras máquinas. `*`, `0.0.0.0` y `::`
// son «todas las interfaces»; lo demás (127.0.0.1, ::1, una IP concreta) es lo
// que el proceso eligió. Lo que importa mostrar es la diferencia entre un
// servidor de desarrollo y uno expuesto a la red.
function isNetworkAddress(addr: string): boolean {
    return addr === '*' || addr === '0.0.0.0' || addr === '::' || addr === ''
}

function isLoopback(addr: string): boolean {
    return addr === '127.0.0.1' || addr === '::1' || addr === 'localhost'
}

interface PortKillerTabProps {
    // La pestaña está a la vista. Una pestaña oculta sigue montada (para no
    // perder el filtro ni el aviso al cambiar de pestaña), pero no consulta.
    visible: boolean
}

export default function PortKillerTab({visible}: PortKillerTabProps) {
    const t = useT()
    const tp = t.utilities.portKiller

    const [listeners, setListeners] = useState<portkill.Listener[]>([])
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState('')
    const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
    const [query, setQuery] = useState('')
    const [scope, setScope] = useState<Scope>('all')
    const [sort, setSort] = useState<{key: SortKey; dir: 'asc' | 'desc'}>({key: 'port', dir: 'asc'})
    const [auto, setAuto] = useState(true)

    // Una lectura a la vez: con un lsof lento, el temporizador no apila otra
    // encima de la que todavía no volvió.
    const inFlight = useRef(false)

    const load = useCallback(async () => {
        if (inFlight.current) return
        inFlight.current = true
        try {
            const list = await ListListeningPorts()
            setListeners(list ?? [])
            setLoadError('')
            setUpdatedAt(new Date())
        } catch (e) {
            setLoadError(errorText(e))
        } finally {
            inFlight.current = false
            setLoading(false)
        }
    }, [])

    // Lee al ponerse a la vista (la lista pudo quedar vieja mientras estaba
    // oculta) y, con el modo automático, cada AUTO_REFRESH_MS — pero no con la
    // ventana minimizada o en otra pestaña del escritorio: nadie la mira.
    useEffect(() => {
        if (!visible) return
        void load()
        if (!auto) return

        const tick = () => {
            if (!document.hidden) void load()
        }
        const timer = window.setInterval(tick, AUTO_REFRESH_MS)
        return () => window.clearInterval(timer)
    }, [visible, auto, load])

    // Cuántos hay de cada alcance, sobre la lista completa y no sobre la
    // filtrada: la pastilla dice lo que vas a ver al hacer clic.
    const counts = useMemo(() => {
        const network = listeners.filter((l) => isNetworkAddress(l.address)).length
        const local = listeners.filter((l) => isLoopback(l.address)).length
        return {all: listeners.length, local, network}
    }, [listeners])

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase()
        const rows = listeners.filter((l) => {
            if (scope === 'local' && !isLoopback(l.address)) return false
            if (scope === 'network' && !isNetworkAddress(l.address)) return false
            if (!q) return true
            return (
                String(l.port).includes(q) ||
                String(l.pid) === q ||
                l.process.toLowerCase().includes(q) ||
                l.address.toLowerCase().includes(q)
            )
        })
        const dir = sort.dir === 'asc' ? 1 : -1
        return [...rows].sort((a, b) => {
            const cmp =
                sort.key === 'process'
                    ? a.process.localeCompare(b.process)
                    : sort.key === 'pid'
                      ? a.pid - b.pid
                      : a.port - b.port
            // Desempate estable por puerto: dos filas iguales no cambian de
            // lugar entre una lectura y la siguiente.
            return cmp * dir || a.port - b.port
        })
    }, [listeners, query, scope, sort])

    function nameOf(l: portkill.Listener): string {
        return l.process || tp.unknownProcess
    }

    function toggleSort(key: SortKey) {
        setSort((s) => (s.key === key ? {key, dir: s.dir === 'asc' ? 'desc' : 'asc'} : {key, dir: 'asc'}))
    }

    // Terminar un proceso: el flujo (confirmar, permisos, resultado) es el del
    // hook compartido con el Activity Monitor; acá solo se le dan los textos.
    const killer = useProcessKiller(
        {
            ...tp.confirm,
            ended: (k) => tp.result.ended({process: k.process, port: k.port ?? 0}),
            stillRunning: (k) => tp.result.stillRunning({process: k.process}),
            gone: tp.result.gone,
            denied: tp.result.denied,
            failed: (error) => tp.result.failed({error}),
            terminateDescription: (k) => tp.confirm.terminateDescription({process: k.process, pid: k.pid, port: k.port ?? 0}),
            forceDescription: (k) => tp.confirm.forceDescription({process: k.process, pid: k.pid, port: k.port ?? 0}),
            elevateDescription: (k) => tp.confirm.elevateDescription({process: k.process, pid: k.pid}),
        },
        () => void load(),
    )
    const target = (l: portkill.Listener): KillTarget => ({process: nameOf(l), pid: l.pid, port: l.port})

    // Cabecera de columna que ordena. La flecha solo aparece en la columna
    // activa: una flecha en las tres diría más ruido que orden.
    // Función y no componente: como componente interno se remontaría en cada
    // lectura y el encabezado tocado perdería el foco.
    function sortHead(k: SortKey, label: string) {
        const active = sort.key === k
        return (
            <th key={k} className="px-3 py-2 font-semibold">
                <button
                    onClick={() => toggleSort(k)}
                    title={tp.sortBy({column: label})}
                    className={`flex items-center gap-1 uppercase tracking-wider ${active ? 'text-on-surface' : 'hover:text-on-surface'}`}
                >
                    {label}
                    {active && <Icon name={sort.dir === 'asc' ? 'arrow_upward' : 'arrow_downward'} size={12} />}
                </button>
            </th>
        )
    }

    const chips: {id: Scope; label: string; title: string; n: number}[] = [
        {id: 'all', label: tp.filters.all, title: tp.filterTitle.all, n: counts.all},
        {id: 'local', label: tp.filters.local, title: tp.filterTitle.local, n: counts.local},
        {id: 'network', label: tp.filters.network, title: tp.filterTitle.network, n: counts.network},
    ]

    return (
        <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col bg-surface text-on-surface">
            {/* Barra de herramientas: qué es, buscar, y las dos formas de
                actualizar. */}
            <div className="flex shrink-0 items-center gap-3 border-b border-outline-variant bg-surface-container-low px-4 py-2">
                <Icon name="lan" size={18} className="shrink-0 text-primary" />
                <span className="text-sm font-semibold">{t.utilities.tools.portKiller.name}</span>

                <div className="ml-2 flex min-w-0 max-w-sm flex-1 items-center gap-1.5 rounded-lg bg-surface-container-highest px-2.5 py-1.5 focus-within:ring-1 focus-within:ring-primary">
                    <Icon name="search" size={14} className="shrink-0 text-on-surface-variant/60" />
                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder={tp.searchPlaceholder}
                        title={tp.searchTitle}
                        className="min-w-0 flex-1 bg-transparent text-xs text-on-surface outline-none placeholder:text-on-surface-variant/60"
                    />
                    {query && (
                        <button
                            onClick={() => setQuery('')}
                            title={tp.clearSearch}
                            className="shrink-0 rounded text-on-surface-variant/60 hover:text-on-surface"
                        >
                            <Icon name="close" size={14} />
                        </button>
                    )}
                </div>

                <span className="ml-auto flex shrink-0 items-center gap-1">
                    <button
                        onClick={() => setAuto((v) => !v)}
                        title={auto ? tp.autoOnTitle({seconds: AUTO_REFRESH_MS / 1000}) : tp.autoOffTitle}
                        className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs ${
                            auto
                                ? 'bg-primary-container text-on-primary-container'
                                : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
                        }`}
                    >
                        <Icon name="autorenew" size={14} />
                        {tp.auto}
                    </button>
                    <button
                        onClick={() => void load()}
                        title={tp.refreshTitle}
                        className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="refresh" size={14} />
                        {tp.refresh}
                    </button>
                </span>
            </div>

            {/* Filtros por alcance y estado de la lectura. Las pastillas con su
                cuenta responden de un vistazo «qué está expuesto a la red». */}
            <div className="flex shrink-0 items-center gap-1.5 border-b border-outline-variant px-4 py-2">
                {chips.map((c) => (
                    <button
                        key={c.id}
                        onClick={() => setScope(c.id)}
                        title={c.title}
                        className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition-colors ${
                            scope === c.id
                                ? 'bg-primary-container text-on-primary-container'
                                : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
                        }`}
                    >
                        {c.label}
                        <span className="font-mono text-ui-10 tabular-nums opacity-70">{c.n}</span>
                    </button>
                ))}
                <span className="ml-auto flex items-center gap-2 text-ui-10 text-on-surface-variant/70">
                    <span className="font-mono tabular-nums">{tp.count({shown: filtered.length, total: listeners.length})}</span>
                    {updatedAt && <span>· {tp.updatedAt({time: formatDateTime(updatedAt, {timeStyle: 'medium'})})}</span>}
                </span>
            </div>

            <NoticeBar notice={killer.notice} onDismiss={killer.dismiss} dismissLabel={tp.dismiss} />

            <div className="min-h-0 flex-1 overflow-auto">
                {loadError && listeners.length === 0 ? (
                    <div className="flex flex-col items-center gap-1 px-6 py-12 text-center">
                        <Icon name="error" size={24} className="text-error" />
                        <p className="text-sm font-medium">{tp.loadFailed}</p>
                        <p className="max-w-md text-xs text-on-surface-variant">{loadError}</p>
                    </div>
                ) : loading ? (
                    <p className="px-6 py-12 text-center text-xs text-on-surface-variant">{tp.loading}</p>
                ) : filtered.length === 0 ? (
                    <div className="flex flex-col items-center gap-1 px-6 py-12 text-center text-on-surface-variant">
                        <Icon name="lan" size={28} className="opacity-40" />
                        <p className="text-xs">{query.trim() ? tp.noMatches({query: query.trim()}) : tp.empty}</p>
                    </div>
                ) : (
                    // El ancho se acota y se alinea a la izquierda: estirada a
                    // toda la ventana, la tabla separaba el puerto de su
                    // proceso y de sus botones por cientos de píxeles, y la
                    // vista tenía que recorrerlos para leer una fila.
                    <table className="w-full max-w-5xl table-fixed border-collapse text-xs">
                        <colgroup>
                            <col className="w-24" />
                            <col className="w-60" />
                            <col />
                            <col className="w-24" />
                            <col className="w-[17rem]" />
                        </colgroup>
                        <thead className="sticky top-0 z-[1] bg-surface-container-low text-left text-ui-10 text-on-surface-variant">
                            <tr className="border-b border-outline-variant">
                                {sortHead('port', tp.columns.port)}
                                <th className="px-3 py-2 font-semibold uppercase tracking-wider">{tp.columns.address}</th>
                                {sortHead('process', tp.columns.process)}
                                {sortHead('pid', tp.columns.pid)}
                                <th />
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.map((l) => {
                                const busy = killer.busyPid === l.pid
                                const name = nameOf(l)
                                return (
                                    <tr
                                        key={`${l.pid}-${l.address}-${l.port}`}
                                        className="group border-b border-outline-variant/40 hover:bg-surface-container-low"
                                    >
                                        <td className="px-3 py-2.5 font-mono text-sm font-semibold tabular-nums text-primary">{l.port}</td>
                                        <td className="px-3 py-2.5">
                                            <span className="flex items-center gap-2">
                                                <span className="truncate font-mono text-on-surface-variant">{l.address || '*'}</span>
                                                {isNetworkAddress(l.address) ? (
                                                    <span
                                                        title={tp.scopeNetworkTitle}
                                                        className="shrink-0 rounded bg-tertiary-container px-1.5 py-px text-ui-9 font-semibold uppercase text-on-tertiary-container"
                                                    >
                                                        {tp.scopeNetwork}
                                                    </span>
                                                ) : isLoopback(l.address) ? (
                                                    <span
                                                        title={tp.scopeLocalTitle}
                                                        className="shrink-0 rounded bg-surface-container-highest px-1.5 py-px text-ui-9 font-semibold uppercase text-on-surface-variant"
                                                    >
                                                        {tp.scopeLocal}
                                                    </span>
                                                ) : null}
                                            </span>
                                        </td>
                                        <td className={`truncate px-3 py-2.5 ${l.process ? 'font-medium' : 'italic text-on-surface-variant/60'}`} title={name}>
                                            {name}
                                        </td>
                                        <td className="px-3 py-2.5 font-mono tabular-nums text-on-surface-variant">{l.pid || '—'}</td>
                                        <td className="px-3 py-1.5">
                                            <span className="flex items-center justify-end gap-1">
                                                {/* Abrir en el navegador: solo se
                                                    muestra al pasar el mouse, es una
                                                    ayuda y no la acción de la fila. */}
                                                <button
                                                    onClick={() => BrowserOpenURL(`http://localhost:${l.port}`)}
                                                    title={tp.openBrowserTitle({port: l.port})}
                                                    className="flex items-center gap-1 rounded-lg px-2 py-1 text-on-surface-variant opacity-0 transition-opacity hover:bg-surface-variant hover:text-on-surface focus-visible:opacity-100 group-hover:opacity-100"
                                                >
                                                    <Icon name="open_in_new" size={14} />
                                                    {tp.openBrowser}
                                                </button>
                                                <button
                                                    disabled={l.protected || busy}
                                                    onClick={() => killer.request(target(l), false)}
                                                    title={l.protected ? tp.protectedTitle : tp.terminateTitle({process: name, pid: l.pid})}
                                                    className="flex items-center gap-1 rounded-lg border border-outline-variant px-2.5 py-1 text-on-surface enabled:hover:bg-surface-variant disabled:opacity-35"
                                                >
                                                    <Icon name="stop_circle" size={14} />
                                                    {tp.terminate}
                                                </button>
                                                <button
                                                    disabled={l.protected || busy}
                                                    onClick={() => killer.request(target(l), true)}
                                                    title={l.protected ? tp.protectedTitle : tp.forceTitle({process: name, pid: l.pid})}
                                                    className="flex items-center gap-1 rounded-lg bg-error-container/60 px-2.5 py-1 text-on-error-container enabled:hover:bg-error-container disabled:opacity-35"
                                                >
                                                    <Icon name="dangerous" size={14} />
                                                    {tp.force}
                                                </button>
                                            </span>
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                )}
            </div>

            <p className="flex shrink-0 items-center gap-1.5 border-t border-outline-variant px-4 py-1.5 text-ui-10 text-on-surface-variant/70">
                <Icon name="info" size={12} className="shrink-0" />
                {tp.footNote}
            </p>

            {killer.dialog}
        </div>
    )
}
