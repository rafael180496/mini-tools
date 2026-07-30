import {useCallback, useEffect, useMemo, useState} from 'react'
import {ListMongoDocuments, CountMongoDocuments, ReplaceMongoDocument, DeleteMongoDocument, SampleMongoFields} from '../../../wailsjs/go/main/App'
import {db} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import JsonView from '../results/JsonView'
import JsonEditor from './JsonEditor'
import ConfirmDialog from '../ConfirmDialog'
import MongoFilterInput from './MongoFilterInput'
import MongoFilterWizard from './MongoFilterWizard'
import MongoDocTable from '../results/MongoDocTable'
import MongoPager from './MongoPager'
import {mongoResultToTable} from '../../lib/mongoResultToTable'
import {fieldKey} from '../../lib/mongoFilter'
import {deriveFieldModel, valueToLiteral} from '../../lib/mongoFields'

interface MongoDocumentPanelProps {
    connId: string
    database: string
    collection: string
}

// Paginated viewer/editor for a collection's documents — the MongoDB analogue
// of RedisKeyDetailPanel. Read via ListMongoDocuments; edit one document as raw
// Extended JSON (ReplaceMongoDocument, keyed by the doc's own _id) or delete it
// (DeleteMongoDocument). The filter box autocompletes the collection's field
// names + operators, can be built with a wizard, and — like Redis's tree — a
// field can be clicked in any document to filter by it.
export default function MongoDocumentPanel({connId, database, collection}: MongoDocumentPanelProps) {
    const [docs, setDocs] = useState<string[]>([])
    const [total, setTotal] = useState(0)
    const [page, setPage] = useState(0)
    const [pageSize, setPageSize] = useState(20)
    const [filter, setFilter] = useState('')
    const [appliedFilter, setAppliedFilter] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')
    const [editing, setEditing] = useState<number | null>(null)
    const [draft, setDraft] = useState('')
    const [draftValid, setDraftValid] = useState(true)
    const [message, setMessage] = useState('')
    const [pendingDelete, setPendingDelete] = useState<string | null>(null)
    const [viewMode, setViewMode] = useState<'json' | 'table'>('json')
    const [showWizard, setShowWizard] = useState(false)
    // Field paths sampled server-side (App.SampleMongoFields): unlike the
    // client-side model derived from the page on screen, this sees the whole
    // sample and carries each path's BSON type and frequency — which is what
    // lets the filter wizard warn "este campo es objectId y estás filtrando
    // como texto" before the query comes back empty.
    const [sampledFields, setSampledFields] = useState<db.MongoFieldInfo[]>([])
    const [sampling, setSampling] = useState(false)

    const load = useCallback(
        async (pageArg: number, filterArg: string, sizeArg: number) => {
            setLoading(true)
            setError('')
            try {
                const [list, count] = await Promise.all([
                    ListMongoDocuments(connId, database, collection, filterArg, pageArg * sizeArg, sizeArg),
                    CountMongoDocuments(connId, database, collection, filterArg),
                ])
                setDocs(list ?? [])
                setTotal(count)
                setEditing(null)
            } catch (e) {
                setError(String(e))
            } finally {
                setLoading(false)
            }
        },
        [connId, database, collection],
    )

    useEffect(() => {
        setPage(0)
        setAppliedFilter('')
        setFilter('')
        void load(0, '', pageSize)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connId, database, collection, load])

    // Sample the collection's schema once per collection — the filter
    // wizard's autocomplete and its type warnings both feed off this.
    useEffect(() => {
        let cancelled = false
        setSampling(true)
        SampleMongoFields(connId, database, collection)
            .then((res) => {
                if (!cancelled) setSampledFields(res ?? [])
            })
            .catch(() => {
                if (!cancelled) setSampledFields([])
            })
            .finally(() => {
                if (!cancelled) setSampling(false)
            })
        return () => {
            cancelled = true
        }
    }, [connId, database, collection])

    // Field paths (nested included) + sample values of the loaded documents —
    // feeds the filter autocomplete (fields in key position, values in value
    // position) and the wizard's field datalist.
    const fieldModel = useMemo(() => deriveFieldModel(docs), [docs])

    function runFilter(f: string) {
        setPage(0)
        setAppliedFilter(f)
        void load(0, f, pageSize)
    }

    function applyFilter() {
        runFilter(filter)
    }

    function clearFilter() {
        setFilter('')
        runFilter('')
    }

    // "Like Redis": click a field in any document to filter the collection by it.
    function filterByField(key: string, value: unknown) {
        const built = `{ ${fieldKey(key)}: ${valueToLiteral(value)} }`
        setFilter(built)
        runFilter(built)
    }

    function goToPage(next: number) {
        setPage(next)
        void load(next, appliedFilter, pageSize)
    }

    // Changing the page size lands back on page 1: keeping the index would
    // jump to a different part of the collection, since page 40 of 20 and
    // page 40 of 200 are nowhere near each other.
    function changePageSize(size: number) {
        setPageSize(size)
        setPage(0)
        void load(0, appliedFilter, size)
    }

    async function saveEdit() {
        setMessage('')
        try {
            await ReplaceMongoDocument(connId, database, collection, draft)
            setMessage('Documento actualizado')
            void load(page, appliedFilter, pageSize)
        } catch (e) {
            setError(`No se pudo guardar: ${e}`)
        }
    }

    async function copyDoc(doc: string) {
        try {
            await navigator.clipboard.writeText(prettyJson(doc))
            setMessage('Documento copiado al portapapeles')
        } catch {
            setError('No se pudo copiar')
        }
    }

    async function doDelete(doc: string) {
        setMessage('')
        try {
            await DeleteMongoDocument(connId, database, collection, doc)
            setMessage('Documento eliminado')
            void load(page, appliedFilter, pageSize)
        } catch (e) {
            setError(`No se pudo eliminar: ${e}`)
        }
    }

    const table = viewMode === 'table' && docs.length > 0 ? mongoResultToTable(docs) : {columns: [], rows: []}

    return (
        <div className="flex h-full flex-col">
            {/* Context row */}
            <div className="flex items-center gap-2 border-b border-outline-variant px-2 py-1 text-xs">
                <span className="min-w-0 flex-1 truncate font-mono text-on-surface">
                    {database}.<span className="font-semibold">{collection}</span>
                </span>
                <div className="inline-flex shrink-0 overflow-hidden rounded-md border border-outline-variant">
                    <button
                        onClick={() => setViewMode('json')}
                        title="Ver documentos como JSON con color"
                        className={`px-2 py-0.5 ${viewMode === 'json' ? 'bg-secondary-container text-on-secondary-container' : 'text-on-surface-variant hover:bg-surface-container-high'}`}
                    >
                        JSON
                    </button>
                    <button
                        onClick={() => setViewMode('table')}
                        title="Ver documentos como tabla"
                        className={`px-2 py-0.5 ${viewMode === 'table' ? 'bg-secondary-container text-on-secondary-container' : 'text-on-surface-variant hover:bg-surface-container-high'}`}
                    >
                        Tabla
                    </button>
                </div>
                <span className="shrink-0 text-on-surface-variant">{total} doc(s)</span>
            </div>

            {/* Filter row */}
            <div className="flex items-center gap-1.5 border-b border-outline-variant px-2 py-1.5 text-xs">
                <MongoFilterInput value={filter} onChange={setFilter} onApply={applyFilter} fields={fieldModel.fields} valuesByField={fieldModel.valuesByField} />
                <button
                    onClick={() => setShowWizard(true)}
                    title="Asistente para construir el filtro sin escribir JSON"
                    className="flex shrink-0 items-center gap-1 rounded border border-outline-variant px-2 py-1 text-on-surface-variant hover:bg-surface-container-high"
                >
                    <Icon name="filter_alt" size={14} />
                    Asistente
                </button>
                <button onClick={applyFilter} title="Aplicar filtro (Enter)" className="shrink-0 rounded bg-primary px-2.5 py-1 text-on-primary">
                    Filtrar
                </button>
                {appliedFilter && (
                    <button onClick={clearFilter} title="Quitar el filtro" className="shrink-0 rounded px-2 py-1 text-on-surface-variant hover:text-on-surface">
                        Limpiar
                    </button>
                )}
            </div>

            <p className="px-2 py-0.5 text-[10px] text-on-surface-variant/60">
                Ctrl+Espacio autocompleta campos y valores · doble-click un campo de un documento para filtrar por él
            </p>

            {error && <p className="px-2 py-1 text-xs text-error">{error}</p>}
            {message && <p className="px-2 py-1 text-xs text-emerald-700 dark:text-emerald-300">{message}</p>}

            <div className="flex-1 overflow-y-auto p-2">
                {loading ? (
                    <p className="text-xs text-on-surface-variant">Cargando…</p>
                ) : docs.length === 0 ? (
                    <p className="text-xs text-on-surface-variant">Sin documentos.</p>
                ) : viewMode === 'table' ? (
                    <MongoDocTable columns={table.columns} rows={table.rows} />
                ) : (
                    <div className="space-y-1.5">
                        {docs.map((d, i) => (
                            <div key={i} className="rounded border border-outline-variant bg-surface p-2">
                                <div className="mb-1 flex items-center gap-2">
                                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-on-surface-variant" title={docIdLabel(d)}>
                                        {docIdLabel(d)}
                                    </span>
                                    {editing === i ? (
                                        <>
                                            <button
                                                onClick={saveEdit}
                                                disabled={!draftValid}
                                                title={draftValid ? 'Guardar (replaceOne por _id)' : 'El JSON tiene errores de sintaxis'}
                                                className="shrink-0 rounded bg-primary px-2 py-0.5 text-xs text-on-primary disabled:opacity-40"
                                            >
                                                Guardar
                                            </button>
                                            <button onClick={() => setEditing(null)} title="Cancelar edición" className="shrink-0 rounded px-2 py-0.5 text-xs text-on-surface-variant hover:text-on-surface">
                                                Cancelar
                                            </button>
                                        </>
                                    ) : (
                                        <>
                                            <button onClick={() => copyDoc(d)} title="Copiar el documento (JSON) al portapapeles" className="shrink-0 rounded p-0.5 text-on-surface-variant hover:text-on-surface">
                                                <Icon name="content_copy" size={14} />
                                            </button>
                                            <button
                                                onClick={() => {
                                                    setEditing(i)
                                                    setDraft(prettyJson(d))
                                                    setDraftValid(true)
                                                }}
                                                title="Editar este documento como JSON"
                                                className="shrink-0 rounded p-0.5 text-on-surface-variant hover:text-on-surface"
                                            >
                                                <Icon name="edit" size={14} />
                                            </button>
                                            <button onClick={() => setPendingDelete(d)} title="Eliminar este documento" className="shrink-0 rounded p-0.5 text-on-surface-variant hover:text-error">
                                                <Icon name="delete" size={14} />
                                            </button>
                                        </>
                                    )}
                                </div>
                                {editing === i ? (
                                    <JsonEditor value={draft} onChange={setDraft} onValidityChange={setDraftValid} />
                                ) : (
                                    <JsonView data={d} onFilterField={filterByField} />
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <MongoPager
                page={page}
                pageSize={pageSize}
                total={total}
                loading={loading}
                onPage={goToPage}
                onPageSize={changePageSize}
            />

            {showWizard && (
                <MongoFilterWizard
                    fields={sampledFields}
                    sampling={sampling}
                    onApply={(f) => {
                        setShowWizard(false)
                        setFilter(f)
                        runFilter(f)
                    }}
                    onClose={() => setShowWizard(false)}
                />
            )}

            {pendingDelete && (
                <ConfirmDialog
                    title="Eliminar documento"
                    description="Se eliminará este documento (deleteOne por _id). Es irreversible."
                    confirmLabel="Eliminar"
                    danger
                    onConfirm={() => doDelete(pendingDelete)}
                    onClose={() => setPendingDelete(null)}
                />
            )}
        </div>
    )
}

function prettyJson(s: string): string {
    try {
        return JSON.stringify(JSON.parse(s), null, 2)
    } catch {
        return s
    }
}

// docIdLabel renders a document's _id compactly for the card header, e.g.
// _id: ObjectId("…").
function docIdLabel(doc: string): string {
    try {
        const o = JSON.parse(doc)
        if (o && typeof o === 'object' && '_id' in o) return `_id: ${valueToLiteral((o as Record<string, unknown>)._id)}`
    } catch {
        // ignore
    }
    return ''
}
