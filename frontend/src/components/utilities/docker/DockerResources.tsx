import {useMemo, type ReactElement} from 'react'
import type {dockerctl} from '../../../../wailsjs/go/models'
import Icon from '../../Icon'
import {useT} from '../../../i18n'

// Imágenes, volúmenes y redes: tres tablas simples con la misma forma —nombre,
// unos datos, y las acciones inspeccionar y eliminar—. Se separan de la de
// contenedores porque no se agrupan ni tienen estado.

export type ResourceKind = 'image' | 'volume' | 'network'

interface Row {
    id: string // lo que se le pasa a Docker
    name: string
    cells: (string | ReactElement)[]
    blocked: string // si no está vacío, por qué no se puede eliminar
    removeTitle: string
    inspectTitle: string
}

interface Props {
    kind: ResourceKind
    images: dockerctl.Image[]
    volumes: dockerctl.Volume[]
    networks: dockerctl.Network[]
    query: string
    busy: Set<string>
    onRemove: (kind: ResourceKind, id: string, name: string) => void
    onInspect: (kind: ResourceKind, id: string, name: string) => void
}

// Las redes que Docker crea solo y no deja eliminar.
const DEFAULT_NETWORKS = new Set(['bridge', 'host', 'none'])

export default function DockerResources({kind, images, volumes, networks, query, busy, onRemove, onInspect}: Props) {
    const t = useT()
    const td = t.utilities.docker

    const {headers, rows} = useMemo(() => {
        const q = query.trim().toLowerCase()
        const match = (...v: string[]) => !q || v.some((x) => x.toLowerCase().includes(q))

        if (kind === 'image') {
            const ti = td.images
            return {
                headers: [ti.columns.name, ti.columns.id, ti.columns.size, ti.columns.created, ti.columns.inUse],
                rows: images
                    .filter((i) => match(i.repository, i.tag, i.id))
                    .map<Row>((i) => {
                        const dangling = i.repository === '<none>'
                        const name = dangling ? `<none>:${i.tag}` : `${i.repository}:${i.tag}`
                        return {
                            // Por id, no por nombre: una imagen sin etiqueta
                            // (`<none>`) no se puede direccionar por nombre.
                            id: i.id,
                            name,
                            cells: [
                                <span key="n" className="flex min-w-0 items-center gap-2">
                                    <span className="truncate font-mono font-medium" title={name}>
                                        {name}
                                    </span>
                                    {dangling && <span className="shrink-0 rounded bg-surface-container-highest px-1.5 py-px text-ui-9 uppercase text-on-surface-variant">{ti.dangling}</span>}
                                </span>,
                                <span key="i" className="font-mono text-on-surface-variant">{i.id.replace('sha256:', '').slice(0, 12)}</span>,
                                i.size,
                                i.created,
                                i.inUse > 0 ? <span key="u" className="text-primary">{ti.inUse({count: i.inUse})}</span> : <span key="u" className="text-on-surface-variant/60">{ti.unused}</span>,
                            ],
                            blocked: i.inUse > 0 ? ti.removeBlocked : '',
                            removeTitle: ti.removeTitle({name}),
                            inspectTitle: ti.inspectTitle,
                        }
                    }),
            }
        }
        if (kind === 'volume') {
            const tv = td.volumes
            return {
                headers: [tv.columns.name, tv.columns.driver, tv.columns.usedBy, tv.columns.mountpoint],
                rows: volumes
                    .filter((v) => match(v.name))
                    .map<Row>((v) => ({
                        id: v.name,
                        name: v.name,
                        cells: [
                            <span key="n" className="block truncate font-mono font-medium" title={v.name}>{v.name}</span>,
                            v.driver,
                            v.usedBy > 0 ? <span key="u" className="text-primary">{tv.usedBy({count: v.usedBy})}</span> : <span key="u" className="text-on-surface-variant/60">{tv.unused}</span>,
                            <span key="m" className="block truncate font-mono text-on-surface-variant" title={v.mountpoint}>{v.mountpoint}</span>,
                        ],
                        blocked: v.usedBy > 0 ? tv.removeBlocked : '',
                        removeTitle: tv.removeTitle({name: v.name}),
                        inspectTitle: tv.inspectTitle,
                    })),
            }
        }
        const tn = td.networks
        return {
            headers: [tn.columns.name, tn.columns.driver, tn.columns.scope, tn.columns.id],
            rows: networks
                .filter((n) => match(n.name, n.id))
                .map<Row>((n) => ({
                    id: n.id,
                    name: n.name,
                    cells: [
                        <span key="n" className="block truncate font-mono font-medium" title={n.name}>{n.name}</span>,
                        n.driver,
                        n.scope,
                        <span key="i" className="font-mono text-on-surface-variant">{n.id.slice(0, 12)}</span>,
                    ],
                    blocked: DEFAULT_NETWORKS.has(n.name) ? tn.removeBlocked : '',
                    removeTitle: tn.removeTitle({name: n.name}),
                    inspectTitle: tn.inspectTitle,
                })),
        }
    }, [kind, images, volumes, networks, query, td])

    return (
        <table className="w-full table-fixed border-collapse text-xs">
            <thead className="sticky top-0 z-[1] bg-surface-container-low text-left text-ui-10 uppercase tracking-wider text-on-surface-variant">
                <tr className="border-b border-outline-variant">
                    {headers.map((h, i) => (
                        <th key={h} className={`px-3 py-2 font-semibold ${i === 0 ? '' : kind === 'volume' && i === 3 ? '' : 'w-36'}`}>
                            {h}
                        </th>
                    ))}
                    <th className="w-20" />
                </tr>
            </thead>
            <tbody>
                {rows.map((r) => (
                    <tr key={r.id} className="border-b border-outline-variant/30 hover:bg-surface-container-low">
                        {r.cells.map((c, i) => (
                            <td key={i} className="truncate px-3 py-2">
                                {c}
                            </td>
                        ))}
                        <td className="px-2 py-1">
                            <span className="flex items-center justify-end gap-0.5">
                                <button
                                    onClick={() => onInspect(kind, r.id, r.name)}
                                    title={r.inspectTitle}
                                    aria-label={r.inspectTitle}
                                    className="flex h-7 w-7 items-center justify-center rounded-lg text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                                >
                                    <Icon name="data_object" size={16} />
                                </button>
                                <button
                                    disabled={!!r.blocked || busy.has(r.id)}
                                    onClick={() => onRemove(kind, r.id, r.name)}
                                    title={r.blocked || r.removeTitle}
                                    aria-label={r.blocked || r.removeTitle}
                                    className="flex h-7 w-7 items-center justify-center rounded-lg text-error enabled:hover:bg-error-container/50 disabled:opacity-30"
                                >
                                    <Icon name="delete" size={16} />
                                </button>
                            </span>
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    )
}
