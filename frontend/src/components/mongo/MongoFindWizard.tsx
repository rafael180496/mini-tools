import {useEffect, useState} from 'react'
import Icon from '../Icon'
import {ListMongoDocuments} from '../../../wailsjs/go/main/App'
import {getActiveMongoCollections} from '../../codemirror/mongoCollectionsStore'
import {fieldKey, valueLiteral} from '../../lib/mongoFilter'
import {deriveFieldModel} from '../../lib/mongoFields'

interface Condition {
    field: string
    op: string
    value: string
}

const OPERATORS = ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$regex', '$exists']

interface MongoFindWizardProps {
    // Called with the generated mongosh command. onRun=true means "insert and
    // execute", false means "just insert into the editor".
    onGenerate: (query: string, run: boolean) => void
    onClose: () => void
    initialCollection?: string
    // Connection + active database — used to scan a sample of the chosen
    // collection's documents so the field inputs autocomplete real fields.
    connId?: string
    database?: string
}

// A visual find() builder for users who don't know MQL — pick a collection, add
// field/operator/value conditions, optional projection/sort/limit, and it emits
// a db.<coll>.find({...}) command (using the editor's lenient mongosh syntax,
// e.g. a 24-hex value becomes ObjectId("...")) either into the editor or to run.
export default function MongoFindWizard({onGenerate, onClose, initialCollection, connId, database}: MongoFindWizardProps) {
    const [collection, setCollection] = useState(initialCollection ?? '')
    const [conditions, setConditions] = useState<Condition[]>([{field: '', op: '$eq', value: ''}])
    const [projection, setProjection] = useState('')
    const [sortField, setSortField] = useState('')
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
    const [limit, setLimit] = useState('20')
    const [collectionFields, setCollectionFields] = useState<string[]>([])
    const [scanning, setScanning] = useState(false)
    const knownCollections = getActiveMongoCollections()

    // Scan a sample of the chosen collection's documents to discover its field
    // paths (nested included) for the field-input autocomplete. Debounced so
    // typing a collection name doesn't fire a fetch per keystroke.
    useEffect(() => {
        const coll = collection.trim()
        if (!connId || !database || !coll) {
            setCollectionFields([])
            return
        }
        let cancelled = false
        setScanning(true)
        const timer = setTimeout(() => {
            ListMongoDocuments(connId, database, coll, '', 0, 25)
                .then((docs) => {
                    if (!cancelled) setCollectionFields(deriveFieldModel(docs ?? []).fields)
                })
                .catch(() => {})
                .finally(() => {
                    if (!cancelled) setScanning(false)
                })
        }, 350)
        return () => {
            cancelled = true
            clearTimeout(timer)
        }
    }, [connId, database, collection])

    function updateCondition(i: number, patch: Partial<Condition>) {
        setConditions((prev) => prev.map((c, idx) => (idx === i ? {...c, ...patch} : c)))
    }

    const query = buildQuery(collection, conditions, projection, sortField, sortDir, limit)
    const canGenerate = collection.trim() !== ''

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
            <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-lg border border-outline-variant bg-surface p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
                <div className="mb-3 flex items-center justify-between">
                    <h2 className="flex items-center gap-2 text-sm font-semibold text-on-surface">
                        <Icon name="search" size={16} /> Asistente de búsqueda (find)
                    </h2>
                    <button onClick={onClose} title="Cerrar" className="text-on-surface-variant hover:text-on-surface">
                        <Icon name="close" size={18} />
                    </button>
                </div>

                <label className="mb-3 block text-xs text-on-surface-variant">
                    Colección
                    <input
                        list="mongo-wizard-collections"
                        value={collection}
                        onChange={(e) => setCollection(e.target.value)}
                        placeholder="nombre de la colección"
                        className="mt-0.5 w-full rounded border border-outline-variant bg-surface-container-low px-2 py-1 font-mono text-on-surface"
                    />
                    <datalist id="mongo-wizard-collections">
                        {knownCollections.map((c) => (
                            <option key={c} value={c} />
                        ))}
                    </datalist>
                </label>

                <div className="mb-2 flex items-center gap-2 text-xs font-medium text-on-surface">
                    Condiciones (filtro)
                    {scanning && <span className="font-normal text-on-surface-variant/70">escaneando campos…</span>}
                    {!scanning && collectionFields.length > 0 && (
                        <span className="font-normal text-on-surface-variant/70">{collectionFields.length} campos detectados</span>
                    )}
                </div>
                <div className="mb-3 space-y-1.5">
                    {conditions.map((c, i) => (
                        <div key={i} className="flex items-center gap-1.5">
                            <input
                                list="mongo-wizard-fields"
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
                                {OPERATORS.map((op) => (
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
                    <datalist id="mongo-wizard-fields">
                        {collectionFields.map((f) => (
                            <option key={f} value={f} />
                        ))}
                    </datalist>
                </div>

                <div className="mb-3 grid grid-cols-2 gap-2">
                    <label className="block text-xs text-on-surface-variant">
                        Campos a devolver (proyección, opcional)
                        <input
                            value={projection}
                            onChange={(e) => setProjection(e.target.value)}
                            placeholder="name, age"
                            className="mt-0.5 w-full rounded border border-outline-variant bg-surface-container-low px-2 py-1 font-mono text-xs text-on-surface"
                        />
                    </label>
                    <label className="block text-xs text-on-surface-variant">
                        Límite
                        <input
                            value={limit}
                            onChange={(e) => setLimit(e.target.value)}
                            className="mt-0.5 w-full rounded border border-outline-variant bg-surface-container-low px-2 py-1 font-mono text-xs text-on-surface"
                        />
                    </label>
                    <label className="block text-xs text-on-surface-variant">
                        Ordenar por (opcional)
                        <input
                            list="mongo-wizard-fields"
                            value={sortField}
                            onChange={(e) => setSortField(e.target.value)}
                            placeholder="campo"
                            className="mt-0.5 w-full rounded border border-outline-variant bg-surface-container-low px-2 py-1 font-mono text-xs text-on-surface"
                        />
                    </label>
                    <label className="block text-xs text-on-surface-variant">
                        Dirección
                        <select
                            value={sortDir}
                            onChange={(e) => setSortDir(e.target.value as 'asc' | 'desc')}
                            className="mt-0.5 w-full rounded border border-outline-variant bg-surface-container-low px-2 py-1 font-mono text-xs text-on-surface"
                        >
                            <option value="asc">Ascendente (1)</option>
                            <option value="desc">Descendente (-1)</option>
                        </select>
                    </label>
                </div>

                <div className="mb-3 rounded border border-outline-variant bg-surface-container-low p-2 font-mono text-xs text-on-surface">{query}</div>

                <div className="flex justify-end gap-2">
                    <button onClick={onClose} className="rounded px-3 py-1.5 text-xs text-on-surface-variant hover:text-on-surface">
                        Cancelar
                    </button>
                    <button
                        disabled={!canGenerate}
                        onClick={() => onGenerate(query, false)}
                        className="rounded border border-outline-variant px-3 py-1.5 text-xs text-on-surface disabled:opacity-40 hover:bg-surface-container-high"
                    >
                        Insertar en el editor
                    </button>
                    <button
                        disabled={!canGenerate}
                        onClick={() => onGenerate(query, true)}
                        className="rounded bg-primary px-3 py-1.5 text-xs text-on-primary disabled:opacity-40"
                    >
                        Insertar y ejecutar
                    </button>
                </div>
            </div>
        </div>
    )
}

function buildQuery(collection: string, conditions: Condition[], projection: string, sortField: string, sortDir: 'asc' | 'desc', limit: string): string {
    const coll = collection.trim() || 'colección'
    const parts: string[] = []
    for (const c of conditions) {
        const f = c.field.trim()
        if (!f) continue
        const key = fieldKey(f)
        if (c.op === '$eq') {
            parts.push(`${key}: ${valueLiteral(c.value)}`)
        } else if (c.op === '$in') {
            const items = c.value.split(',').map((v) => valueLiteral(v)).join(', ')
            parts.push(`${key}: { $in: [${items}] }`)
        } else if (c.op === '$exists') {
            parts.push(`${key}: { $exists: ${c.value.trim() === 'false' ? 'false' : 'true'} }`)
        } else if (c.op === '$regex') {
            parts.push(`${key}: { $regex: ${JSON.stringify(c.value)} }`)
        } else {
            parts.push(`${key}: { ${c.op}: ${valueLiteral(c.value)} }`)
        }
    }
    const filter = parts.length > 0 ? `{ ${parts.join(', ')} }` : '{}'

    let projArg = ''
    const projFields = projection.split(',').map((p) => p.trim()).filter(Boolean)
    if (projFields.length > 0) {
        projArg = `, { ${projFields.map((p) => `${fieldKey(p)}: 1`).join(', ')} }`
    }

    let q = `db.${coll}.find(${filter}${projArg})`
    if (sortField.trim()) q += `.sort({ ${fieldKey(sortField.trim())}: ${sortDir === 'desc' ? -1 : 1} })`
    const n = parseInt(limit, 10)
    if (!isNaN(n) && n > 0) q += `.limit(${n})`
    return q
}
