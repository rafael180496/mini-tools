import {useState} from 'react'
import {db} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import MongoConditionRow from './MongoConditionRow'
import {FieldSampleStatus} from './MongoFieldCombo'
import {buildFilterObject, type MongoCondition, type MongoLogic} from '../../lib/mongoFilter'

interface MongoFilterWizardProps {
    // Sampled fields of the collection (App.SampleMongoFields), so each row
    // can autocomplete real paths and warn when the value's type disagrees
    // with what the collection actually holds.
    fields: db.MongoFieldInfo[]
    sampling: boolean
    onApply: (filterJSON: string) => void
    onClose: () => void
}

// Visual filter builder for the Mongo browser.
//
// Shares MongoConditionRow with the full query wizard rather than keeping its
// own reduced version: the BSON type selector, the extended operators and the
// type-mismatch warning matter exactly as much here — arguably more, since
// this is where someone filters by _id and gets zero results without ever
// being told the value needed to be an ObjectId.
export default function MongoFilterWizard({fields, sampling, onApply, onClose}: MongoFilterWizardProps) {
    const [conditions, setConditions] = useState<MongoCondition[]>([{field: '', op: '$eq', value: '', valueType: 'auto'}])
    const [logic, setLogic] = useState<MongoLogic>('and')

    function updateCondition(i: number, patch: Partial<MongoCondition>) {
        setConditions((prev) => prev.map((c, idx) => (idx === i ? {...c, ...patch} : c)))
    }

    const filter = buildFilterObject(conditions, logic)
    const canApply = conditions.some((c) => c.field.trim() !== '')

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
            <div
                className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between border-b border-outline-variant px-4 py-2.5">
                    <h2 className="flex items-center gap-2 text-sm font-semibold text-on-surface">
                        <Icon name="filter_alt" size={16} /> Asistente de filtro
                    </h2>
                    <button onClick={onClose} title="Cierra sin aplicar nada" className="text-on-surface-variant hover:text-on-surface">
                        <Icon name="close" size={18} />
                    </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-on-surface">
                        <span className="flex items-center gap-1 font-normal text-on-surface-variant">
                            coincidir con
                            <select
                                value={logic}
                                onChange={(e) => setLogic(e.target.value as MongoLogic)}
                                title="TODAS exige que se cumplan todas las condiciones (AND, la forma implícita de Mongo). CUALQUIERA alcanza con que se cumpla una ($or)."
                                className="rounded border border-outline-variant bg-surface-container-low px-1 py-0.5 text-xs text-on-surface"
                            >
                                <option value="and">TODAS las condiciones (AND)</option>
                                <option value="or">CUALQUIER condición (OR)</option>
                            </select>
                        </span>
                        <FieldSampleStatus loading={sampling} count={fields.length} ready />
                    </div>

                    <div className="space-y-1.5">
                        {conditions.map((c, i) => (
                            <MongoConditionRow
                                key={i}
                                condition={c}
                                fields={fields}
                                onChange={(patch) => updateCondition(i, patch)}
                                onRemove={() => setConditions((prev) => prev.filter((_, idx) => idx !== i))}
                                removable={conditions.length > 1}
                            />
                        ))}
                        <button
                            onClick={() => setConditions((prev) => [...prev, {field: '', op: '$eq', value: '', valueType: 'auto'}])}
                            title="Suma otra condición al filtro"
                            className="flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                            <Icon name="add" size={14} /> Agregar condición
                        </button>
                    </div>
                </div>

                <div className="border-t border-outline-variant p-3">
                    <span className="mb-1.5 block text-ui-11 font-medium uppercase tracking-wide text-on-surface-variant">Filtro generado</span>
                    <pre className="max-h-28 overflow-auto whitespace-pre-wrap rounded border border-outline-variant bg-surface-container-low p-2 font-mono text-xs text-on-surface">
                        {filter}
                    </pre>
                    <div className="mt-3 flex justify-end gap-2">
                        <button onClick={onClose} title="Cierra sin aplicar nada" className="rounded px-3 py-1.5 text-xs text-on-surface-variant hover:text-on-surface">
                            Cancelar
                        </button>
                        <button
                            disabled={!canApply}
                            onClick={() => onApply(filter)}
                            title="Pone este filtro en la caja de arriba y recarga los documentos"
                            className="rounded bg-primary px-3 py-1.5 text-xs text-on-primary disabled:opacity-40"
                        >
                            Aplicar filtro
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}
