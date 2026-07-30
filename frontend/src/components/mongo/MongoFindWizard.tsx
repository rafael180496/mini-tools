import {useEffect, useState} from 'react'
import Icon from '../Icon'
import {SampleMongoFields} from '../../../wailsjs/go/main/App'
import {db} from '../../../wailsjs/go/models'
import {getActiveMongoCollections} from '../../codemirror/mongoCollectionsStore'
import {buildFilterObject, fieldKey, type MongoCondition, type MongoLogic} from '../../lib/mongoFilter'
import {buildPipelineCommand, type PipelineStage} from '../../lib/mongoPipeline'
import MongoConditionRow from './MongoConditionRow'
import MongoFieldCombo, {FieldSampleStatus} from './MongoFieldCombo'
import MongoPipelineBuilder from './MongoPipelineBuilder'

type Mode = 'find' | 'aggregate'

interface MongoFindWizardProps {
    // Called with the generated mongosh command. run=true means "insert and
    // execute", false means "just insert into the editor".
    onGenerate: (query: string, run: boolean) => void
    onClose: () => void
    initialCollection?: string
    // Connection + active database — used to sample the chosen collection so
    // the field inputs autocomplete real fields.
    connId?: string
    database?: string
}

// Visual query builder for MongoDB, in two modes.
//
// Find covers the everyday case; Aggregate exists because find() runs out of
// road the moment a question involves grouping or joining, and dropping the
// user into raw MQL at that point defeats the purpose of a wizard.
//
// Everything it emits goes through the editor's lenient mongosh parser
// (backend/mongoquery/extjson.go), so ObjectId("…")/ISODate("…") helpers and
// unquoted keys are all valid output.
export default function MongoFindWizard({onGenerate, onClose, initialCollection, connId, database}: MongoFindWizardProps) {
    const [mode, setMode] = useState<Mode>('find')
    const [collection, setCollection] = useState(initialCollection ?? '')

    const [logic, setLogic] = useState<MongoLogic>('and')
    const [conditions, setConditions] = useState<MongoCondition[]>([{field: '', op: '$eq', value: '', valueType: 'auto'}])
    const [projection, setProjection] = useState('')
    const [sortField, setSortField] = useState('')
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
    const [limit, setLimit] = useState('20')
    const [skip, setSkip] = useState('')

    const [stages, setStages] = useState<PipelineStage[]>([])

    const [fields, setFields] = useState<db.MongoFieldInfo[]>([])
    const [sampling, setSampling] = useState(false)

    // rawOverride is the manual-edit escape hatch. While it is null the
    // preview mirrors the builder; once the user edits it, THEIR text is the
    // query and the builder stops overwriting it — silently reverting an
    // edit the moment another control moved would be the worst of both
    // worlds. Going back to visual mode discards the manual text explicitly.
    const [rawOverride, setRawOverride] = useState<string | null>(null)

    const knownCollections = getActiveMongoCollections()

    // Sample the collection to discover its field paths. Debounced so typing
    // a collection name doesn't fire a scan per keystroke.
    useEffect(() => {
        const coll = collection.trim()
        if (!connId || !database || !coll) {
            setFields([])
            return
        }
        let cancelled = false
        setSampling(true)
        const timer = window.setTimeout(() => {
            SampleMongoFields(connId, database, coll)
                .then((res) => {
                    if (!cancelled) setFields(res ?? [])
                })
                .catch(() => {
                    if (!cancelled) setFields([])
                })
                .finally(() => {
                    if (!cancelled) setSampling(false)
                })
        }, 300)
        return () => {
            cancelled = true
            window.clearTimeout(timer)
        }
    }, [connId, database, collection])

    const generated = mode === 'find'
        ? buildFindCommand(collection, conditions, logic, projection, sortField, sortDir, limit, skip)
        : buildPipelineCommand(collection, stages)

    const query = rawOverride ?? generated
    const canGenerate = collection.trim() !== ''

    function updateCondition(i: number, patch: Partial<MongoCondition>) {
        setConditions((prev) => prev.map((c, idx) => (idx === i ? {...c, ...patch} : c)))
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
            <div
                className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between border-b border-outline-variant px-4 py-2.5">
                    <h2 className="flex items-center gap-2 text-sm font-semibold text-on-surface">
                        <Icon name="search" size={16} /> Asistente de consulta MongoDB
                    </h2>
                    <div className="flex items-center gap-2">
                        <div className="flex rounded-md border border-outline-variant p-0.5">
                            <button
                                onClick={() => setMode('find')}
                                title="find(): buscar documentos con un filtro, proyección, orden y paginado"
                                className={`rounded px-2.5 py-0.5 text-[11px] ${
                                    mode === 'find' ? 'bg-primary/15 text-primary' : 'text-on-surface-variant hover:text-on-surface'
                                }`}
                            >
                                Find
                            </button>
                            <button
                                onClick={() => setMode('aggregate')}
                                title="aggregate(): pipeline de etapas para agrupar, unir con otra colección ($lookup) o reformar documentos — lo que find() no puede hacer"
                                className={`rounded px-2.5 py-0.5 text-[11px] ${
                                    mode === 'aggregate' ? 'bg-primary/15 text-primary' : 'text-on-surface-variant hover:text-on-surface'
                                }`}
                            >
                                Aggregate
                            </button>
                        </div>
                        <button onClick={onClose} title="Cierra el asistente sin generar nada" className="text-on-surface-variant hover:text-on-surface">
                            <Icon name="close" size={18} />
                        </button>
                    </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                    <label className="mb-3 block text-xs text-on-surface-variant">
                        Colección
                        <input
                            list="mongo-wizard-collections"
                            value={collection}
                            onChange={(e) => setCollection(e.target.value)}
                            placeholder="nombre de la colección"
                            title="Colección sobre la que corre la consulta. Si abriste el asistente parado sobre una colección, viene preseleccionada."
                            className="mt-0.5 w-full rounded border border-outline-variant bg-surface-container-low px-2 py-1 font-mono text-on-surface"
                        />
                        <datalist id="mongo-wizard-collections">
                            {knownCollections.map((c) => (
                                <option key={c} value={c} />
                            ))}
                        </datalist>
                    </label>

                    {mode === 'find' ? (
                        <>
                            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-on-surface">
                                Condiciones (filtro)
                                {/* Mongo combines an object's keys with AND
                                    implicitly; OR has no implicit form at all,
                                    so without this switch the builder simply
                                    could not express it. */}
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
                                <FieldSampleStatus loading={sampling} count={fields.length} ready={!!connId && !!database && collection.trim() !== ''} />
                            </div>

                            <div className="mb-3 space-y-1.5">
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

                            <div className="grid grid-cols-2 gap-2">
                                <label className="block text-xs text-on-surface-variant">
                                    Campos a devolver (proyección, opcional)
                                    <input
                                        value={projection}
                                        onChange={(e) => setProjection(e.target.value)}
                                        placeholder="name, age"
                                        title="Lista separada por comas. Traer solo lo necesario reduce lo que viaja desde el servidor; vacío devuelve el documento completo."
                                        className="mt-0.5 w-full rounded border border-outline-variant bg-surface-container-low px-2 py-1 font-mono text-xs text-on-surface"
                                    />
                                </label>
                                <div className="grid grid-cols-2 gap-2">
                                    <label className="block text-xs text-on-surface-variant">
                                        Límite
                                        <input
                                            value={limit}
                                            onChange={(e) => setLimit(e.target.value)}
                                            title="Máximo de documentos a devolver"
                                            className="mt-0.5 w-full rounded border border-outline-variant bg-surface-container-low px-2 py-1 font-mono text-xs text-on-surface"
                                        />
                                    </label>
                                    <label className="block text-xs text-on-surface-variant">
                                        Saltar (skip)
                                        <input
                                            value={skip}
                                            onChange={(e) => setSkip(e.target.value)}
                                            placeholder="0"
                                            title="Documentos a descartar antes de empezar a devolver. Con el límite arma la paginación: página 3 de 20 en 20 es skip 40."
                                            className="mt-0.5 w-full rounded border border-outline-variant bg-surface-container-low px-2 py-1 font-mono text-xs text-on-surface"
                                        />
                                    </label>
                                </div>
                                <label className="block text-xs text-on-surface-variant">
                                    Ordenar por (opcional)
                                    <div className="mt-0.5 flex">
                                        <MongoFieldCombo
                                            value={sortField}
                                            onChange={setSortField}
                                            fields={fields}
                                            placeholder="campo"
                                            title="Campo por el que ordenar. Ordenar por un campo sin índice obliga a Mongo a ordenar en memoria."
                                            className="w-full"
                                        />
                                    </div>
                                </label>
                                <label className="block text-xs text-on-surface-variant">
                                    Dirección
                                    <select
                                        value={sortDir}
                                        onChange={(e) => setSortDir(e.target.value as 'asc' | 'desc')}
                                        title="Ascendente (1) o descendente (-1)"
                                        className="mt-0.5 w-full rounded border border-outline-variant bg-surface-container-low px-2 py-1 font-mono text-xs text-on-surface"
                                    >
                                        <option value="asc">Ascendente (1)</option>
                                        <option value="desc">Descendente (-1)</option>
                                    </select>
                                </label>
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="mb-2 flex flex-wrap items-center gap-x-3 text-xs font-medium text-on-surface">
                                Etapas del pipeline
                                <FieldSampleStatus loading={sampling} count={fields.length} ready={!!connId && !!database && collection.trim() !== ''} />
                            </div>
                            <MongoPipelineBuilder stages={stages} onChange={setStages} />
                        </>
                    )}
                </div>

                <div className="border-t border-outline-variant p-3">
                    <div className="mb-1.5 flex items-center justify-between">
                        <span className="text-[11px] font-medium uppercase tracking-wide text-on-surface-variant">
                            {rawOverride === null ? 'Vista previa' : 'Edición manual'}
                        </span>
                        {rawOverride === null ? (
                            <button
                                onClick={() => setRawOverride(generated)}
                                title="Editá la consulta a mano. Al hacerlo, los controles de arriba dejan de sobrescribirla — nada de perder lo que escribiste porque tocaste un campo."
                                className="flex items-center gap-1 text-[11px] text-primary hover:underline"
                            >
                                <Icon name="edit" size={13} /> Editar a mano
                            </button>
                        ) : (
                            <button
                                onClick={() => setRawOverride(null)}
                                title="Vuelve a generar la consulta desde los controles. Descarta lo que hayas editado a mano."
                                className="flex items-center gap-1 text-[11px] text-on-surface-variant hover:text-on-surface"
                            >
                                <Icon name="undo" size={13} /> Volver al modo visual
                            </button>
                        )}
                    </div>

                    {rawOverride === null ? (
                        <pre
                            onClick={() => setRawOverride(generated)}
                            title="Click para editar la consulta a mano"
                            className="max-h-40 cursor-text overflow-auto whitespace-pre rounded border border-outline-variant bg-surface-container-low p-2 font-mono text-xs text-on-surface"
                        >
                            {generated}
                        </pre>
                    ) : (
                        <textarea
                            value={rawOverride}
                            onChange={(e) => setRawOverride(e.target.value)}
                            rows={Math.min(10, Math.max(3, rawOverride.split('\n').length))}
                            spellCheck={false}
                            className="w-full resize-y rounded border border-primary/50 bg-surface-container-low p-2 font-mono text-xs text-on-surface"
                        />
                    )}

                    <div className="mt-3 flex justify-end gap-2">
                        <button onClick={onClose} title="Cierra sin generar nada" className="rounded px-3 py-1.5 text-xs text-on-surface-variant hover:text-on-surface">
                            Cancelar
                        </button>
                        <button
                            disabled={!canGenerate}
                            onClick={() => onGenerate(query, false)}
                            title="Pega la consulta en el editor sin ejecutarla, para revisarla o ajustarla antes"
                            className="rounded border border-outline-variant px-3 py-1.5 text-xs text-on-surface hover:bg-surface-container-high disabled:opacity-40"
                        >
                            Insertar en el editor
                        </button>
                        <button
                            disabled={!canGenerate}
                            onClick={() => onGenerate(query, true)}
                            title="Pega la consulta en el editor y la corre de inmediato"
                            className="rounded bg-primary px-3 py-1.5 text-xs text-on-primary disabled:opacity-40"
                        >
                            Insertar y ejecutar
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}

// buildFindCommand renders the find() call. It breaks across lines once the
// arguments stop fitting comfortably on one — a filter with four conditions
// on a single line is valid and unreadable, and the preview is meant to be
// read before it is run.
function buildFindCommand(
    collection: string,
    conditions: MongoCondition[],
    logic: MongoLogic,
    projection: string,
    sortField: string,
    sortDir: 'asc' | 'desc',
    limit: string,
    skip: string,
): string {
    const coll = collection.trim() || 'colección'
    const filter = buildFilterObject(conditions, logic)

    const projFields = projection.split(',').map((p) => p.trim()).filter(Boolean)
    const projArg = projFields.length > 0 ? `{ ${projFields.map((p) => `${fieldKey(p)}: 1`).join(', ')} }` : ''

    const args = projArg ? `${filter}, ${projArg}` : filter
    let q = args.length > 60 ? `db.${coll}.find(\n  ${filter}${projArg ? `,\n  ${projArg}` : ''}\n)` : `db.${coll}.find(${args})`

    if (sortField.trim()) q += `.sort({ ${fieldKey(sortField.trim())}: ${sortDir === 'desc' ? -1 : 1} })`
    // skip before limit, matching how the cursor actually applies them.
    const s = parseInt(skip, 10)
    if (!isNaN(s) && s > 0) q += `.skip(${s})`
    const n = parseInt(limit, 10)
    if (!isNaN(n) && n > 0) q += `.limit(${n})`
    return q
}
