import {Fragment, useMemo, useState} from 'react'
import {BrowserOpenURL} from '../../../../wailsjs/runtime'
import type {dockerctl} from '../../../../wailsjs/go/models'
import Icon from '../../Icon'
import {useT} from '../../../i18n'

// La tabla de contenedores, agrupada por proyecto de Compose como la de Docker
// Desktop: es como se piensa un stack («levantá el de mandados»), no como una
// lista plana de nombres sueltos.

export type ContainerOp = 'start' | 'stop' | 'restart' | 'remove'
export type ComposeOp = 'up' | 'down' | 'stop' | 'start' | 'restart'

interface Props {
    containers: dockerctl.Container[]
    stats: Record<string, dockerctl.Stat>
    query: string
    // Con el panel de detalle abierto la lista queda a la mitad del ancho: se
    // ocultan imagen, CPU y memoria (lo que se puede leer en el panel o
    // recuperar cerrándolo) en vez de apretar el nombre hasta cortarlo.
    compact: boolean
    busy: Set<string>
    // Proyectos con una operación de Compose en curso: `up` puede tardar minutos.
    composeBusy: Set<string>
    onCompose: (op: ComposeOp, project: string) => void
    onOp: (op: ContainerOp, containers: dockerctl.Container[], label: string) => void
    onLogs: (c: dockerctl.Container) => void
    onInspect: (c: dockerctl.Container) => void
}

// Los puertos PUBLICADOS en el host, sin repetir: Docker informa cada uno dos
// veces (IPv4 e IPv6) y como rango cuando son varios seguidos. Solo esos se
// pueden abrir en el navegador; un `5432/tcp` sin publicar no es alcanzable.
function publishedPorts(ports: string): string[] {
    const out = new Set<string>()
    for (const m of ports.matchAll(/(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]*\]|::):(\d+)(?:-\d+)?->/gi)) out.add(m[1])
    return [...out]
}

type Tone = 'running' | 'stopped' | 'error' | 'transition'

// El color del punto de estado. «Detenido» y «falló» no son lo mismo: un
// contenedor que salió con código distinto de 0 es justo el que se busca.
function toneOf(c: dockerctl.Container): Tone {
    if (c.state === 'running') return 'running'
    if (c.state === 'restarting' || c.state === 'paused') return 'transition'
    if (c.state === 'dead' || /^Exited \((?!0\))/.test(c.status)) return 'error'
    return 'stopped'
}

const DOT: Record<Tone, string> = {
    running: 'bg-primary',
    transition: 'bg-tertiary',
    error: 'bg-error',
    stopped: 'bg-outline',
}

function IconBtn({icon, title, onClick, disabled, danger}: {icon: string; title: string; onClick: () => void; disabled?: boolean; danger?: boolean}) {
    return (
        <button
            onClick={(e) => {
                e.stopPropagation()
                onClick()
            }}
            disabled={disabled}
            title={title}
            aria-label={title}
            className={`flex h-7 w-7 items-center justify-center rounded-lg enabled:hover:bg-surface-variant disabled:opacity-30 ${
                danger ? 'text-error enabled:hover:bg-error-container/50' : 'text-on-surface-variant enabled:hover:text-on-surface'
            }`}
        >
            <Icon name={icon} size={16} />
        </button>
    )
}

export default function DockerContainers({containers, stats, query, compact, busy, composeBusy, onCompose, onOp, onLogs, onInspect}: Props) {
    const t = useT()
    const tc = t.utilities.docker.containers
    const tk = t.utilities.docker.compose
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

    const groups = useMemo(() => {
        const q = query.trim().toLowerCase()
        const rows = q
            ? containers.filter((c) => [c.name, c.image, c.project, c.service].some((v) => v.toLowerCase().includes(q)))
            : containers
        const map = new Map<string, dockerctl.Container[]>()
        for (const c of rows) {
            const list = map.get(c.project) ?? []
            list.push(c)
            map.set(c.project, list)
        }
        // La lista ya viene ordenada del backend: proyectos por nombre y los
        // sueltos ('') al final.
        return [...map.entries()]
    }, [containers, query])

    function toggle(project: string) {
        setCollapsed((cur) => {
            const next = new Set(cur)
            if (!next.delete(project)) next.add(project)
            return next
        })
    }

    return (
        <table className="w-full table-fixed border-collapse text-xs">
            <colgroup>
                <col />
                {!compact && <col className="w-48" />}
                <col className="w-32" />
                {!compact && <col className="w-16" />}
                {!compact && <col className="w-24" />}
                <col className="w-48" />
            </colgroup>
            <thead className="sticky top-0 z-[1] bg-surface-container-low text-left text-ui-10 uppercase tracking-wider text-on-surface-variant">
                <tr className="border-b border-outline-variant">
                    <th className="px-3 py-2 font-semibold">{tc.columns.name}</th>
                    {!compact && <th className="px-3 py-2 font-semibold">{tc.columns.image}</th>}
                    <th className="px-3 py-2 font-semibold">{tc.columns.ports}</th>
                    {!compact && <th className="px-3 py-2 text-right font-semibold">{tc.columns.cpu}</th>}
                    {!compact && <th className="px-3 py-2 text-right font-semibold">{tc.columns.memory}</th>}
                    <th />
                </tr>
            </thead>
            <tbody>
                {groups.map(([project, list]) => {
                    const running = list.filter((c) => c.state === 'running')
                    const stopped = list.filter((c) => c.state !== 'running')
                    const isOpen = !collapsed.has(project)
                    const name = project || tc.unassigned
                    return (
                        <Fragment key={project || '__none'}>
                            {project && (
                                <tr className="border-b border-outline-variant/40 bg-surface-container-low/60">
                                    <td colSpan={compact ? 2 : 5} className="px-3 py-1.5">
                                        <button
                                            onClick={() => toggle(project)}
                                            title={isOpen ? tc.collapse : tc.expand}
                                            aria-expanded={isOpen}
                                            className="flex w-full items-center gap-2 text-left"
                                        >
                                            <Icon name={isOpen ? 'expand_more' : 'chevron_right'} size={16} className="shrink-0 text-on-surface-variant" />
                                            <Icon name="layers" size={16} className="shrink-0 text-primary" />
                                            <span className="truncate font-semibold">{project}</span>
                                            <span className="shrink-0 text-ui-10 text-on-surface-variant/70">
                                                {tc.groupCount({total: list.length, running: running.length})}
                                            </span>
                                        </button>
                                    </td>
                                    <td className="px-2">
                                        <span className="flex items-center justify-end gap-0.5">
                                            {composeBusy.has(project) ? (
                                                <span title={tk.working} className="flex h-7 items-center gap-1 px-2 text-ui-10 text-on-surface-variant">
                                                    <Icon name="progress_activity" size={15} className="animate-spin text-primary" />
                                                </span>
                                            ) : (
                                                <>
                                                    <IconBtn icon="play_arrow" title={tk.startTitle({name})} disabled={stopped.length === 0} onClick={() => onCompose('start', project)} />
                                                    <IconBtn icon="stop" title={tk.stopTitle({name})} disabled={running.length === 0} onClick={() => onCompose('stop', project)} />
                                                    <IconBtn icon="restart_alt" title={tk.restartTitle({name})} onClick={() => onCompose('restart', project)} />
                                                    <IconBtn icon="rocket_launch" title={tk.upTitle({name})} onClick={() => onCompose('up', project)} />
                                                    <IconBtn icon="delete" title={tk.downTitle({name})} danger onClick={() => onCompose('down', project)} />
                                                </>
                                            )}
                                        </span>
                                    </td>
                                </tr>
                            )}
                            {isOpen &&
                                list.map((c) => {
                                    const tone = toneOf(c)
                                    const st = stats[c.id.slice(0, 12)]
                                    const ports = publishedPorts(c.ports)
                                    const isBusy = busy.has(c.id)
                                    const isRunning = c.state === 'running'
                                    const label = c.service || c.name
                                    return (
                                        <tr key={c.id} className="group border-b border-outline-variant/30 hover:bg-surface-container-low">
                                            <td className={`py-2 pr-3 ${project ? 'pl-10' : 'pl-3'}`}>
                                                <span className="flex min-w-0 items-center gap-2">
                                                    <span
                                                        title={`${tc.states[c.state as keyof typeof tc.states] ?? c.state} — ${c.status}`}
                                                        className={`h-2 w-2 shrink-0 rounded-full ${DOT[tone]}`}
                                                    />
                                                    <span className="flex min-w-0 flex-col">
                                                        <button onClick={() => onLogs(c)} title={tc.logsTitle({name: c.name})} className="truncate text-left font-medium hover:text-primary">
                                                            {label}
                                                        </button>
                                                        <span className="truncate font-mono text-ui-10 text-on-surface-variant/70" title={c.status}>
                                                            {c.id.slice(0, 12)} · {c.status}
                                                        </span>
                                                    </span>
                                                </span>
                                            </td>
                                            {!compact && (
                                                <td className="truncate px-3 py-2 font-mono text-ui-11 text-on-surface-variant" title={c.image}>
                                                    {c.image}
                                                </td>
                                            )}
                                            <td className="px-3 py-2">
                                                <span className="flex flex-wrap gap-1">
                                                    {ports.map((p) => (
                                                        <button
                                                            key={p}
                                                            onClick={() => BrowserOpenURL(`http://localhost:${p}`)}
                                                            title={tc.openPort({port: p})}
                                                            className="flex items-center gap-0.5 rounded bg-surface-container-highest px-1.5 py-px font-mono text-ui-10 text-primary hover:bg-primary-container"
                                                        >
                                                            {p}
                                                            <Icon name="open_in_new" size={10} />
                                                        </button>
                                                    ))}
                                                </span>
                                            </td>
                                            {!compact && (
                                                <td className="px-3 py-2 text-right font-mono tabular-nums text-on-surface-variant">
                                                    {isRunning && st ? `${st.cpu.toFixed(1)}%` : ''}
                                                </td>
                                            )}
                                            {!compact && (
                                                <td className="px-3 py-2 text-right font-mono tabular-nums text-on-surface-variant" title={st?.memUsage}>
                                                    {isRunning && st ? `${st.memPercent.toFixed(1)}%` : ''}
                                                </td>
                                            )}
                                            <td className="px-2 py-1">
                                                <span className="flex items-center justify-end gap-0.5">
                                                    {isRunning ? (
                                                        <IconBtn icon="stop" title={tc.stopTitle({name: c.name})} disabled={isBusy} onClick={() => onOp('stop', [c], label)} />
                                                    ) : (
                                                        <IconBtn icon="play_arrow" title={tc.startTitle({name: c.name})} disabled={isBusy} onClick={() => onOp('start', [c], label)} />
                                                    )}
                                                    <IconBtn icon="restart_alt" title={tc.restartTitle({name: c.name})} disabled={isBusy} onClick={() => onOp('restart', [c], label)} />
                                                    <IconBtn icon="article" title={tc.logsTitle({name: c.name})} onClick={() => onLogs(c)} />
                                                    <IconBtn icon="data_object" title={tc.inspectTitle({name: c.name})} onClick={() => onInspect(c)} />
                                                    <IconBtn icon="delete" title={tc.removeTitle({name: c.name})} danger disabled={isBusy} onClick={() => onOp('remove', [c], label)} />
                                                </span>
                                            </td>
                                        </tr>
                                    )
                                })}
                        </Fragment>
                    )
                })}
            </tbody>
        </table>
    )
}
