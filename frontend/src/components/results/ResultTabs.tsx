import Icon from '../Icon'
import {useT} from '../../i18n'
import {closeOnMiddleClick, middleClickHint} from '../../lib/middleClickClose'

interface ResultTabsProps {
    count: number
    active: number
    onSelect: (i: number) => void
    onClose: (i: number) => void
    onCloseAll: () => void
    statuses: string[]
}

// Ícono del desenlace de un statement en su pestaña: nada si terminó bien.
function statusIcon(status: string | undefined) {
    if (status === 'error') return <Icon name="error" size={14} className="text-error" filled />
    if (status === 'cancelled') return <Icon name="block" size={14} className="text-tertiary" />
    return null
}

// Shown only when a script has more than one statement — one tab per
// result set, per spec's "múltiples result-tabs si un bloque PL/SQL
// devuelve varios cursores" / multi-statement scripts.
export default function ResultTabs({count, active, onSelect, onClose, onCloseAll, statuses}: ResultTabsProps) {
    const t = useT()
    if (count <= 1) return null

    return (
        <div className="flex items-center gap-1 overflow-x-auto border-b border-outline-variant bg-surface-container px-2 pt-1">
            <div className="flex flex-1 gap-1 overflow-x-auto">
                {Array.from({length: count}).map((_, i) => (
                    <div
                        key={i}
                        // Clic central de la rueda para cerrar, igual que en las
                        // pestañas del editor.
                        {...closeOnMiddleClick(() => onClose(i))}
                        className={`group flex shrink-0 items-center gap-1 rounded-t-xs pl-3 pr-1 py-1 text-xs ${
                            i === active
                                ? 'bg-surface text-on-surface'
                                : 'text-on-surface-variant hover:text-on-surface'
                        }`}
                    >
                        <button
                            onClick={() => onSelect(i)}
                            title={t.results.tabs.selectTitle({n: i + 1, count, hint: middleClickHint()})}
                            className="flex items-center gap-1.5"
                        >
                            {t.results.tabs.label(i + 1)}
                            {statusIcon(statuses[i])}
                        </button>
                        <button
                            onClick={(e) => {
                                e.stopPropagation()
                                onClose(i)
                            }}
                            title={t.results.tabs.closeTitle(i + 1)}
                            className="rounded p-0.5 text-on-surface-variant/60 hover:bg-surface-variant hover:text-on-surface"
                        >
                            <Icon name="close" size={12} />
                        </button>
                    </div>
                ))}
            </div>
            <button
                onClick={onCloseAll}
                title={t.results.tabs.closeAllTitle}
                className="shrink-0 rounded px-2 py-1 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
            >
                {t.results.tabs.closeAll}
            </button>
        </div>
    )
}
