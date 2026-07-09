import Icon from '../Icon'

interface ResultTabsProps {
    count: number
    active: number
    onSelect: (i: number) => void
    onClose: (i: number) => void
    onCloseAll: () => void
    statuses: string[]
}

// Shown only when a script has more than one statement — one tab per
// result set, per spec's "múltiples result-tabs si un bloque PL/SQL
// devuelve varios cursores" / multi-statement scripts.
export default function ResultTabs({count, active, onSelect, onClose, onCloseAll, statuses}: ResultTabsProps) {
    if (count <= 1) return null

    return (
        <div className="flex items-center gap-1 overflow-x-auto border-b border-outline-variant bg-surface-container px-2 pt-1">
            <div className="flex flex-1 gap-1 overflow-x-auto">
                {Array.from({length: count}).map((_, i) => (
                    <div
                        key={i}
                        className={`group flex shrink-0 items-center gap-1 rounded-t-xs pl-3 pr-1 py-1 text-xs ${
                            i === active
                                ? 'bg-surface text-on-surface'
                                : 'text-on-surface-variant hover:text-on-surface'
                        }`}
                    >
                        <button
                            onClick={() => onSelect(i)}
                            title={`Ver el resultado del statement ${i + 1} de ${count} — cada statement de un bloque tiene su propia pestaña de resultados`}
                            className="flex items-center gap-1.5"
                        >
                            Resultado {i + 1}
                            {statuses[i] === 'error' && <Icon name="error" size={14} className="text-error" filled />}
                            {statuses[i] === 'cancelled' && <Icon name="block" size={14} className="text-tertiary" />}
                        </button>
                        <button
                            onClick={(e) => {
                                e.stopPropagation()
                                onClose(i)
                            }}
                            title={`Cerrar la pestaña "Resultado ${i + 1}" — solo oculta este resultado, no cancela ni reejecuta nada`}
                            className="rounded p-0.5 text-on-surface-variant/60 hover:bg-surface-variant hover:text-on-surface"
                        >
                            <Icon name="close" size={12} />
                        </button>
                    </div>
                ))}
            </div>
            <button
                onClick={onCloseAll}
                title="Cerrar todas las pestañas de resultados de este script"
                className="shrink-0 rounded px-2 py-1 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
            >
                Cerrar todos
            </button>
        </div>
    )
}
