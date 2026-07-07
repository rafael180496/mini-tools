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
        <div className="flex gap-1 border-b border-neutral-800 bg-neutral-900 px-2 pt-1">
            {Array.from({length: count}).map((_, i) => (
                <button
                    key={i}
                    onClick={() => onSelect(i)}
                    className={`rounded-t px-3 py-1 text-xs ${
                        i === active
                            ? 'bg-neutral-950 text-neutral-100'
                            : 'text-neutral-500 hover:text-neutral-300'
                    }`}
                >
                    Resultado {i + 1}
                    {statuses[i] === 'error' && ' ⚠'}
                    {statuses[i] === 'cancelled' && ' ⊘'}
                </button>
            ))}
        </div>
    )
}
