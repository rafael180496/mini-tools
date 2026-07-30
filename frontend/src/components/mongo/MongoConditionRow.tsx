import {db} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import MongoFieldCombo from './MongoFieldCombo'
import {BSON_TYPES, inferBsonType, typeWarning, type BsonType} from '../../lib/mongoBson'
import {MONGO_BSON_TYPE_NAMES, MONGO_OPERATORS, operatorDef, type MongoCondition} from '../../lib/mongoFilter'

interface MongoConditionRowProps {
    condition: MongoCondition
    fields: db.MongoFieldInfo[]
    onChange: (patch: Partial<MongoCondition>) => void
    onRemove: () => void
    removable: boolean
}

// One field / operator / value row of the visual filter.
//
// The value carries an explicit BSON type because MongoDB does not coerce:
// {_id: "507f…"} matches nothing when _id holds an ObjectId, and the query
// fails silently with zero results rather than with an error. "Auto" infers
// (and says what it inferred), the rest force the user's choice.
export default function MongoConditionRow({condition, fields, onChange, onRemove, removable}: MongoConditionRowProps) {
    const def = operatorDef(condition.op)
    const valueType = condition.valueType ?? 'auto'
    const fieldInfo = fields.find((f) => f.path === condition.field.trim())
    const warning = def.valueKind === 'text' || def.valueKind === 'list'
        ? typeWarning(condition.value, valueType, condition.field, fieldInfo?.types)
        : ''

    return (
        <div className="rounded border border-outline-variant/60 bg-surface-container-low/40 p-1.5">
            <div className="flex items-center gap-1.5">
                <MongoFieldCombo
                    value={condition.field}
                    onChange={(v) => onChange({field: v})}
                    fields={fields}
                    placeholder="campo"
                    className="flex-1"
                />

                <select
                    value={condition.op}
                    onChange={(e) => onChange({op: e.target.value})}
                    title={def.hint}
                    className="w-36 shrink-0 rounded border border-outline-variant bg-surface-container-low px-1 py-1 text-xs text-on-surface"
                >
                    {MONGO_OPERATORS.map((op) => (
                        <option key={op.value} value={op.value} title={op.hint}>
                            {op.label}
                        </option>
                    ))}
                </select>

                <ValueInput condition={condition} def={def} onChange={onChange} />

                {/* The type selector only appears where a value is actually
                    typed: $exists takes a boolean and $type takes a type
                    name, so offering "cast this as ObjectId" there would be
                    meaningless. */}
                {(def.valueKind === 'text' || def.valueKind === 'list') && (
                    <select
                        value={valueType}
                        onChange={(e) => onChange({valueType: e.target.value as BsonType})}
                        title={BSON_TYPES.find((t) => t.value === valueType)?.hint}
                        className="w-24 shrink-0 rounded border border-outline-variant bg-surface-container-low px-1 py-1 text-xs text-on-surface"
                    >
                        {BSON_TYPES.map((t) => (
                            <option key={t.value} value={t.value} title={t.hint}>
                                {t.label}
                            </option>
                        ))}
                    </select>
                )}

                <button
                    onClick={onRemove}
                    disabled={!removable}
                    title={removable ? 'Quita esta condición del filtro' : 'No se puede quitar la única condición'}
                    className="shrink-0 text-on-surface-variant hover:text-error disabled:opacity-30"
                >
                    <Icon name="remove_circle_outline" size={16} />
                </button>
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-1">
                {condition.op === '$regex' && (
                    <label
                        className="flex items-center gap-1 text-[11px] text-on-surface-variant"
                        title="Agrega $options: 'i' para que la búsqueda no distinga mayúsculas de minúsculas"
                    >
                        <input
                            type="checkbox"
                            checked={!!condition.caseInsensitive}
                            onChange={(e) => onChange({caseInsensitive: e.target.checked})}
                            className="accent-primary"
                        />
                        ignorar mayúsculas
                    </label>
                )}

                {/* What "auto" decided, spelled out. The whole failure mode
                    this guards against is invisible, so the inference has to
                    stop being invisible too. */}
                {valueType === 'auto' && condition.value.trim() !== '' && (def.valueKind === 'text' || def.valueKind === 'list') && (
                    <span className="text-[11px] text-on-surface-variant/70">
                        auto → {inferBsonType(condition.value)}
                    </span>
                )}

                {warning && (
                    <span className="flex items-center gap-1 text-[11px] text-tertiary">
                        <Icon name="warning" size={12} />
                        {warning}
                    </span>
                )}
            </div>
        </div>
    )
}

function ValueInput({
    condition,
    def,
    onChange,
}: {
    condition: MongoCondition
    def: ReturnType<typeof operatorDef>
    onChange: (patch: Partial<MongoCondition>) => void
}) {
    const shared = 'min-w-0 flex-1 rounded border border-outline-variant bg-surface-container-low px-2 py-1 font-mono text-xs text-on-surface'

    if (def.valueKind === 'bool') {
        return (
            <select
                value={condition.value.trim() === 'false' ? 'false' : 'true'}
                onChange={(e) => onChange({value: e.target.value})}
                title="El campo debe estar presente (true) o ausente (false) en el documento"
                className={shared}
            >
                <option value="true">true — el campo existe</option>
                <option value="false">false — el campo no existe</option>
            </select>
        )
    }

    if (def.valueKind === 'type') {
        return (
            <select
                value={condition.value || 'string'}
                onChange={(e) => onChange({value: e.target.value})}
                title="Tipo BSON que debe tener el campo"
                className={shared}
            >
                {MONGO_BSON_TYPE_NAMES.map((t) => (
                    <option key={t} value={t}>
                        {t}
                    </option>
                ))}
            </select>
        )
    }

    return (
        <input
            value={condition.value}
            onChange={(e) => onChange({value: e.target.value})}
            placeholder={
                def.valueKind === 'list' ? 'a, b, c' : def.valueKind === 'number' ? 'cantidad' : condition.op === '$regex' ? 'patrón' : 'valor'
            }
            title={def.hint}
            className={shared}
        />
    )
}
