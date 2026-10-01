import {useMemo} from 'react'
import type {dockerctl} from '../../../../wailsjs/go/models'
import Icon from '../../Icon'
import {formatDateTime, useT} from '../../../i18n'
import {formatDuration} from '../format'
import ExportLimit from './ExportLimit'

// El historial de builds de imágenes (`docker buildx history`): qué se construyó,
// cómo terminó, cuánto tardó, y su log completo para leerlo o exportarlo.

interface Props {
    builds: dockerctl.Build[]
    query: string
    busy: Set<string>
    onLogs: (b: dockerctl.Build) => void
    onExport: (b: dockerctl.Build) => void
    exportLines: number
    onExportLines: (n: number) => void
}

const STATUS_CLASS: Record<string, string> = {
    Completed: 'text-primary',
    Error: 'font-semibold text-error',
    Canceled: 'text-on-surface-variant',
    Running: 'text-tertiary',
}

// Una URL de repositorio larga («https://github.com/org/repo.git») no cabe y lo
// que identifica el build es el final: se recorta el principio.
function shortName(name: string): string {
    return name.replace(/^https?:\/\//, '')
}

export default function DockerBuilds({builds, query, busy, onLogs, onExport, exportLines, onExportLines}: Props) {
    const t = useT()
    const tb = t.utilities.docker.builds

    const rows = useMemo(() => {
        const q = query.trim().toLowerCase()
        return q ? builds.filter((b) => b.name.toLowerCase().includes(q) || b.ref.toLowerCase().includes(q)) : builds
    }, [builds, query])

    return (
        <>
        <div className="flex items-center justify-end gap-2 border-b border-outline-variant px-3 py-1.5">
            <ExportLimit value={exportLines} onChange={onExportLines} />
        </div>
        <table className="w-full table-fixed border-collapse text-xs">
            <colgroup>
                <col />
                <col className="w-28" />
                <col className="w-36" />
                <col className="w-40" />
                <col className="w-24" />
                <col className="w-20" />
            </colgroup>
            <thead className="sticky top-0 z-[1] bg-surface-container-low text-left text-ui-10 uppercase tracking-wider text-on-surface-variant">
                <tr className="border-b border-outline-variant">
                    <th className="px-3 py-2 font-semibold">{tb.columns.name}</th>
                    <th className="px-3 py-2 font-semibold">{tb.columns.status}</th>
                    <th className="px-3 py-2 font-semibold">{tb.columns.steps}</th>
                    <th className="px-3 py-2 font-semibold">{tb.columns.created}</th>
                    <th className="px-3 py-2 text-right font-semibold">{tb.columns.duration}</th>
                    <th />
                </tr>
            </thead>
            <tbody>
                {rows.map((b) => {
                    const label = shortName(b.name)
                    return (
                        <tr key={b.ref} className="border-b border-outline-variant/30 hover:bg-surface-container-low">
                            <td className="px-3 py-2">
                                <button onClick={() => onLogs(b)} title={tb.logsTitle} className="block w-full min-w-0 text-left">
                                    <span className="block truncate font-medium hover:text-primary" title={b.name}>
                                        {label}
                                    </span>
                                    <span className="block truncate font-mono text-ui-10 text-on-surface-variant/70">{b.ref}</span>
                                </button>
                            </td>
                            <td className={`px-3 py-2 ${STATUS_CLASS[b.status] ?? 'text-on-surface'}`}>
                                {(tb.status as Record<string, string>)[b.status] ?? b.status}
                            </td>
                            <td className="px-3 py-2 font-mono text-ui-11 text-on-surface-variant">
                                {tb.steps({done: b.completedSteps, total: b.totalSteps, cached: b.cachedSteps})}
                            </td>
                            <td className="px-3 py-2 text-on-surface-variant">
                                {b.createdAt ? formatDateTime(new Date(b.createdAt), {dateStyle: 'short', timeStyle: 'short'}) : '—'}
                            </td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums text-on-surface-variant">{formatDuration(b.durationMs)}</td>
                            <td className="px-2 py-1">
                                <span className="flex items-center justify-end gap-0.5">
                                    <button
                                        onClick={() => onLogs(b)}
                                        title={tb.logsTitle}
                                        aria-label={tb.logsTitle}
                                        className="flex h-7 w-7 items-center justify-center rounded-lg text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                                    >
                                        <Icon name="article" size={16} />
                                    </button>
                                    <button
                                        disabled={busy.has(b.ref)}
                                        onClick={() => onExport(b)}
                                        title={tb.exportTitle}
                                        aria-label={tb.exportTitle}
                                        className="flex h-7 w-7 items-center justify-center rounded-lg text-on-surface-variant enabled:hover:bg-surface-variant enabled:hover:text-on-surface disabled:opacity-40"
                                    >
                                        <Icon name="download" size={16} />
                                    </button>
                                </span>
                            </td>
                        </tr>
                    )
                })}
            </tbody>
        </table>
        </>
    )
}
