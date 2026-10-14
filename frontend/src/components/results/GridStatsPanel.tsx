import {useMemo} from 'react'
import Icon from '../Icon'
import {formatNumber, useT} from '../../i18n'
import {columnStats} from './columnStats'

interface GridStatsPanelProps {
    columns: string[]
    // Las filas sobre las que se calcula: la selección, o todo lo visible.
    rows: unknown[][]
    scopeLabel: string
    column: string
    onColumn: (column: string) => void
    onCopy: (value: string) => void
}

// Franja de estadísticas al pie de la grilla. Cada valor se copia con un
// clic: el uso habitual es "¿cuánto suma esto?" para pegarlo en otro lado.
export default function GridStatsPanel({columns, rows, scopeLabel, column, onColumn, onCopy}: GridStatsPanelProps) {
    const t = useT()
    const tg = t.results.grid
    const index = columns.indexOf(column)
    const stats = useMemo(() => (index < 0 ? null : columnStats(rows, index)), [rows, index])

    const items: {label: string; value: string}[] = []
    if (stats) {
        items.push({label: tg.statRows, value: formatNumber(stats.rows)})
        items.push({label: tg.statNonNull, value: formatNumber(stats.nonNull)})
        items.push({label: tg.statNulls, value: formatNumber(stats.nulls)})
        items.push({label: tg.statDistinct, value: formatNumber(stats.distinct)})
        if (stats.numeric) {
            items.push({label: tg.statSum, value: formatNumber(stats.sum ?? 0, {maximumFractionDigits: 6})})
            items.push({label: tg.statAvg, value: formatNumber(stats.avg ?? 0, {maximumFractionDigits: 6})})
            items.push({label: tg.statMin, value: formatNumber(Number(stats.min), {maximumFractionDigits: 6})})
            items.push({label: tg.statMax, value: formatNumber(Number(stats.max), {maximumFractionDigits: 6})})
        } else if (stats.min !== undefined) {
            items.push({label: tg.statMin, value: stats.min})
            items.push({label: tg.statMax, value: stats.max ?? ''})
            items.push({label: tg.statMinLen, value: formatNumber(stats.minLen ?? 0)})
            items.push({label: tg.statMaxLen, value: formatNumber(stats.maxLen ?? 0)})
        }
    }

    return (
        <div className="flex shrink-0 flex-wrap items-center gap-x-1 gap-y-1 border-t border-outline-variant bg-surface-container-low px-2 py-1 text-ui-11">
            <Icon name="functions" size={14} className="shrink-0 text-primary" />
            <label className="flex items-center gap-1 text-on-surface-variant">
                {tg.statsColumn}
                <select
                    value={column}
                    onChange={(e) => onColumn(e.target.value)}
                    className="max-w-[16em] rounded border-none bg-surface-container-highest px-1 py-0.5 font-mono text-ui-11 text-on-surface outline-none focus:ring-1 focus:ring-primary"
                >
                    {columns.map((c) => (
                        <option key={c} value={c}>
                            {c}
                        </option>
                    ))}
                </select>
            </label>
            <span className="mr-1 text-on-surface-variant/70">{scopeLabel}</span>
            {items.map((it) => (
                <button
                    key={it.label}
                    onClick={() => onCopy(it.value)}
                    title={tg.statCopyTitle}
                    className="flex max-w-[22em] items-center gap-1 rounded px-1.5 py-0.5 hover:bg-surface-variant"
                >
                    <span className="text-on-surface-variant">{it.label}</span>
                    <span className="truncate font-mono text-on-surface">{it.value}</span>
                </button>
            ))}
        </div>
    )
}
