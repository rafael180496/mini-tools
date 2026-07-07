import Icon from '../Icon'

interface ResultTabsProps {
    count: number
    active: number
    onSelect: (i: number) => void
    statuses: string[]
}

// Shown only when a script has more than one statement — one tab per
// result set, per spec's "múltiples result-tabs si un bloque PL/SQL
// devuelve varios cursores" / multi-statement scripts.
export default function ResultTabs({count, active, onSelect, statuses}: ResultTabsProps) {
    if (count <= 1) return null

    return (
        <div className="flex gap-1 border-b border-outline-variant bg-surface-container px-2 pt-1">
            {Array.from({length: count}).map((_, i) => (
                <button
                    key={i}
                    onClick={() => onSelect(i)}
                    title={`Ver el resultado del statement ${i + 1} de ${count} — cada statement de un bloque tiene su propia pestaña de resultados`}
                    className={`flex items-center gap-1.5 rounded-t-xs px-3 py-1 text-xs ${
                        i === active
                            ? 'bg-surface text-on-surface'
                            : 'text-on-surface-variant hover:text-on-surface'
                    }`}
                >
                    Resultado {i + 1}
                    {statuses[i] === 'error' && <Icon name="error" size={14} className="text-error" filled />}
                    {statuses[i] === 'cancelled' && <Icon name="block" size={14} className="text-tertiary" />}
                </button>
            ))}
        </div>
    )
}
