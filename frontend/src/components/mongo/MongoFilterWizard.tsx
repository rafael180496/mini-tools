import {useState} from 'react'
import Icon from '../Icon'
import {buildFilterObject, MONGO_FILTER_OPERATORS, type MongoCondition} from '../../lib/mongoFilter'

interface MongoFilterWizardProps {
    // Field names of the collection, offered as a datalist for each condition.
    fields: string[]
    onApply: (filterJSON: string) => void
    onClose: () => void
}

// Visual filter builder for the Mongo browser — add field/operator/value rows
// and it emits a filter object (lenient mongosh syntax, e.g. a 24-hex value
// becomes ObjectId("…")) into the browser's filter box. For users who don't
// want to write the JSON by hand. Shares its condition logic with the find
// wizard via lib/mongoFilter.ts.
export default function MongoFilterWizard({fields, onApply, onClose}: MongoFilterWizardProps) {
    const [conditions, setConditions] = useState<MongoCondition[]>([{field: '', op: '$eq', value: ''}])

    function updateCondition(i: number, patch: Partial<MongoCondition>) {
        setConditions((prev) => prev.map((c, idx) => (idx === i ? {...c, ...patch} : c)))
    }

    const filter = buildFilterObject(conditions)
    const canApply = conditions.some((c) => c.field.trim() !== '')

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
            <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-outline-variant bg-surface p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
                <div className="mb-3 flex items-center justify-between">
                    <h2 className="flex items-center gap-2 text-sm font-semibold text-on-surface">
                        <Icon name="filter_alt" size={16} /> Asistente de filtro
                    </h2>
                    <button onClick={onClose} title="Cerrar" className="text-on-surface-variant hover:text-on-surface">
                        <Icon name="close" size={18} />
                    </button>
                </div>

                <div className="mb-3 space-y-1.5">
                    {conditions.map((c, i) => (
                        <div key={i} className="flex items-center gap-1.5">
                            <input
                                list="mongo-filter-fields"
                                value={c.field}
                                onChange={(e) => updateCondition(i, {field: e.target.value})}
                                placeholder="campo"
                                className="min-w-0 flex-1 rounded border border-outline-variant bg-surface-container-low px-2 py-1 font-mono text-xs text-on-surface"
                            />
                            <select
                                value={c.op}
                                onChange={(e) => updateCondition(i, {op: e.target.value})}
                                title="Operador"
                                className="shrink-0 rounded border border-outline-variant bg-surface-container-low px-1 py-1 font-mono text-xs text-on-surface"
                            >
                                {MONGO_FILTER_OPERATORS.map((op) => (
                                    <option key={op} value={op}>
                                        {op}
                                    </option>
                                ))}
                            </select>
                            <input
                                value={c.value}
                                onChange={(e) => updateCondition(i, {value: e.target.value})}
                                placeholder={c.op === '$in' ? 'a, b, c' : c.op === '$exists' ? 'true / false' : 'valor'}
                                className="min-w-0 flex-1 rounded border border-outline-variant bg-surface-container-low px-2 py-1 font-mono text-xs text-on-surface"
                            />
                            <button
                                onClick={() => setConditions((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev))}
                                title="Quitar condición"
                                className="shrink-0 text-on-surface-variant hover:text-error"
                            >
                                <Icon name="remove_circle_outline" size={16} />
                            </button>
                        </div>
                    ))}
                    <button
                        onClick={() => setConditions((prev) => [...prev, {field: '', op: '$eq', value: ''}])}
                        className="flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                        <Icon name="add" size={14} /> Agregar condición
                    </button>
                    <datalist id="mongo-filter-fields">
                        {fields.map((f) => (
                            <option key={f} value={f} />
                        ))}
                    </datalist>
                </div>

                <div className="mb-3 rounded border border-outline-variant bg-surface-container-low p-2 font-mono text-xs text-on-surface">{filter}</div>

                <div className="flex justify-end gap-2">
                    <button onClick={onClose} className="rounded px-3 py-1.5 text-xs text-on-surface-variant hover:text-on-surface">
                        Cancelar
                    </button>
                    <button
                        disabled={!canApply}
                        onClick={() => onApply(filter)}
                        className="rounded bg-primary px-3 py-1.5 text-xs text-on-primary disabled:opacity-40"
                    >
                        Aplicar filtro
                    </button>
                </div>
            </div>
        </div>
    )
}
