import {db} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import MongoFieldCombo from './MongoFieldCombo'
import {bsonTypes, inferBsonType, typeWarning, type BsonType} from '../../lib/mongoBson'
import {MONGO_BSON_TYPE_NAMES, mongoOperators, operatorDef, type MongoCondition} from '../../lib/mongoFilter'
import {useT} from '../../i18n'

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
    const t = useT()
    const cr = t.mongo.condition
    const types = bsonTypes()
    const def = operatorDef(condition.op)
    const valueType = condition.valueType ?? 'auto'
    const fieldInfo = fields.find((f) => f.path === condition.field.trim())
    const typedValue = def.valueKind === 'text' || def.valueKind === 'list'
    const isRegex = condition.op === '$regex'
    const showInferred = valueType === 'auto' && condition.value.trim() !== '' && typedValue
    const warning = typedValue
        ? typeWarning(condition.value, valueType, condition.field, fieldInfo?.types)
        : ''

    return (
        <div className="rounded border border-outline-variant/60 bg-surface-container-low/40 p-1.5">
            <div className="flex items-center gap-1.5">
                <MongoFieldCombo
                    value={condition.field}
                    onChange={(v) => onChange({field: v})}
                    fields={fields}
                    placeholder={cr.field}
                    className="flex-1"
                />

                <select
                    value={condition.op}
                    onChange={(e) => onChange({op: e.target.value})}
                    title={def.hint}
                    className="w-36 shrink-0 rounded border border-outline-variant bg-surface-container-low px-1 py-1 text-xs text-on-surface"
                >
                    {mongoOperators().map((op) => (
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
                {typedValue && (
                    <select
                        value={valueType}
                        onChange={(e) => onChange({valueType: e.target.value as BsonType})}
                        title={types.find((bt) => bt.value === valueType)?.hint}
                        className="w-24 shrink-0 rounded border border-outline-variant bg-surface-container-low px-1 py-1 text-xs text-on-surface"
                    >
                        {types.map((bt) => (
                            <option key={bt.value} value={bt.value} title={bt.hint}>
                                {bt.label}
                            </option>
                        ))}
                    </select>
                )}

                <button
                    onClick={onRemove}
                    disabled={!removable}
                    title={removable ? cr.removeHint : cr.cannotRemove}
                    className="shrink-0 text-on-surface-variant hover:text-error disabled:opacity-30"
                >
                    <Icon name="remove_circle_outline" size={16} />
                </button>
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-1">
                {isRegex && (
                    <label
                        className="flex items-center gap-1 text-ui-11 text-on-surface-variant"
                        title={cr.ignoreCaseHint}
                    >
                        <input
                            type="checkbox"
                            checked={!!condition.caseInsensitive}
                            onChange={(e) => onChange({caseInsensitive: e.target.checked})}
                            className="accent-primary"
                        />
                        {cr.ignoreCase}
                    </label>
                )}

                {/* What "auto" decided, spelled out. The whole failure mode
                    this guards against is invisible, so the inference has to
                    stop being invisible too. */}
                {showInferred && (
                    <span className="text-ui-11 text-on-surface-variant/70">
                        {cr.autoInferred({type: inferBsonType(condition.value)})}
                    </span>
                )}

                {warning && (
                    <span className="flex items-center gap-1 text-ui-11 text-tertiary">
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
    const t = useT()
    const cr = t.mongo.condition
    const shared = 'min-w-0 flex-1 rounded border border-outline-variant bg-surface-container-low px-2 py-1 font-mono text-xs text-on-surface'

    if (def.valueKind === 'bool') {
        return (
            <select
                value={condition.value.trim() === 'false' ? 'false' : 'true'}
                onChange={(e) => onChange({value: e.target.value})}
                title={cr.existsHint}
                className={shared}
            >
                <option value="true">{cr.existsTrue}</option>
                <option value="false">{cr.existsFalse}</option>
            </select>
        )
    }

    if (def.valueKind === 'type') {
        return (
            <select
                value={condition.value || 'string'}
                onChange={(e) => onChange({value: e.target.value})}
                title={cr.typeHint}
                className={shared}
            >
                {MONGO_BSON_TYPE_NAMES.map((name) => (
                    <option key={name} value={name}>
                        {name}
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
                def.valueKind === 'list' ? cr.listPlaceholder : def.valueKind === 'number' ? cr.countPlaceholder : condition.op === '$regex' ? cr.patternPlaceholder : cr.valuePlaceholder
            }
            title={def.hint}
            className={shared}
        />
    )
}
