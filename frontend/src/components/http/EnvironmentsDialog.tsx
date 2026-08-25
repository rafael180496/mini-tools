import {useCallback, useEffect, useState} from 'react'
import {
    HttpDeleteEnvironment,
    HttpListCollections,
    HttpListEnvironments,
    HttpSaveEnvironment,
} from '../../../wailsjs/go/main/App'
import {vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import ConfirmDialog from '../ConfirmDialog'
import VariablesTable from './VariablesTable'
import {parseVariables, type HttpVariable} from './httpShared'

// Administrador de entornos: la lista a la izquierda, sus variables a la
// derecha.
//
// Un entorno es transversal a las colecciones —el mismo "prod" se usa desde
// varias—, y por eso se administra desde un lugar propio y no adentro de una
// colección.

interface EnvironmentsDialogProps {
    onClose: () => void
    onChanged: () => void
}

export default function EnvironmentsDialog({onClose, onChanged}: EnvironmentsDialogProps) {
    const [envs, setEnvs] = useState<vault.HTTPEnvironment[]>([])
    const [collections, setCollections] = useState<vault.HTTPCollection[]>([])
    const [selectedId, setSelectedId] = useState<string>('')
    const [name, setName] = useState('')
    const [pinned, setPinned] = useState('')
    const [rows, setRows] = useState<HttpVariable[]>([])
    const [dirty, setDirty] = useState(false)
    const [confirmDelete, setConfirmDelete] = useState<vault.HTTPEnvironment | null>(null)
    const [error, setError] = useState<string | null>(null)

    const load = useCallback(async () => {
        try {
            const [list, cols] = await Promise.all([HttpListEnvironments(), HttpListCollections()])
            setEnvs(list ?? [])
            setCollections(cols ?? [])
            return list ?? []
        } catch (e) {
            setError(String(e))
            return []
        }
    }, [])

    useEffect(() => {
        void load().then((list) => {
            if (list.length > 0) select(list[0])
        })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    function select(e: vault.HTTPEnvironment) {
        setSelectedId(e.id)
        setName(e.name)
        setPinned(e.pinnedCollectionId ?? '')
        setRows(parseVariables(e.variables))
        setDirty(false)
    }

    async function save() {
        setError(null)
        try {
            const saved = await HttpSaveEnvironment(
                new vault.HTTPEnvironment({
                    id: selectedId,
                    name,
                    pinnedCollectionId: pinned,
                    variables: rows.length === 0 ? '' : JSON.stringify(rows),
                }),
            )
            const list = await load()
            if (saved) {
                const fresh = list.find((e) => e.id === saved.id)
                if (fresh) select(fresh)
            }
            setDirty(false)
            onChanged()
        } catch (e) {
            setError(String(e))
        }
    }

    async function create() {
        setError(null)
        try {
            const saved = await HttpSaveEnvironment(new vault.HTTPEnvironment({name: 'Entorno nuevo'}))
            const list = await load()
            if (saved) {
                const fresh = list.find((e) => e.id === saved.id)
                if (fresh) select(fresh)
            }
            onChanged()
        } catch (e) {
            setError(String(e))
        }
    }

    const selected = envs.find((e) => e.id === selectedId) ?? null

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
            <div
                className="flex h-[32rem] w-[52rem] max-w-full flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface-container shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-3 py-2">
                    <Icon name="layers" size={16} className="text-on-surface-variant" />
                    <p className="flex-1 text-sm font-medium text-on-surface">Entornos</p>
                    <button onClick={onClose} title="Cerrar" className="rounded p-1 text-on-surface-variant hover:bg-surface-variant">
                        <Icon name="close" size={16} />
                    </button>
                </div>

                {error && (
                    <p className="shrink-0 bg-error-container px-3 py-1 text-ui-11 text-on-error-container" title={error}>
                        {error}
                    </p>
                )}

                <div className="flex min-h-0 flex-1">
                    {/* Lista */}
                    <div className="flex w-56 shrink-0 flex-col border-r border-outline-variant">
                        <div className="min-h-0 flex-1 overflow-y-auto p-1">
                            {envs.length === 0 && (
                                <p className="px-2 py-3 text-ui-11 leading-relaxed text-on-surface-variant/70">
                                    Sin entornos todavía. Un entorno guarda los valores que cambian entre dev, pruebas y producción.
                                </p>
                            )}
                            {envs.map((e) => (
                                <button
                                    key={e.id}
                                    onClick={() => select(e)}
                                    title={e.pinnedCollectionId ? 'Anclado a una colección: se elige solo al abrir sus peticiones' : e.name}
                                    className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-ui-11 ${
                                        e.id === selectedId ? 'bg-surface-variant text-on-surface' : 'text-on-surface-variant hover:bg-surface-variant'
                                    }`}
                                >
                                    <span className="truncate">{e.name}</span>
                                    {e.pinnedCollectionId && <Icon name="push_pin" size={11} className="ml-auto shrink-0 opacity-60" />}
                                </button>
                            ))}
                        </div>
                        <button
                            onClick={() => void create()}
                            title="Crear un entorno nuevo"
                            className="flex shrink-0 items-center gap-1 border-t border-outline-variant px-2 py-1.5 text-ui-11 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                        >
                            <Icon name="add" size={13} /> Nuevo entorno
                        </button>
                    </div>

                    {/* Detalle */}
                    {selected ? (
                        <div className="flex min-w-0 flex-1 flex-col">
                            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-outline-variant px-3 py-2">
                                <input
                                    value={name}
                                    onChange={(e) => {
                                        setName(e.target.value)
                                        setDirty(true)
                                    }}
                                    title="Nombre del entorno, el que se ve en el selector"
                                    className="min-w-0 flex-1 rounded bg-surface-container-highest px-2 py-1 text-ui-11 text-on-surface outline-none focus:ring-1 focus:ring-primary"
                                />
                                <select
                                    value={pinned}
                                    onChange={(e) => {
                                        setPinned(e.target.value)
                                        setDirty(true)
                                    }}
                                    title="Anclar este entorno a una colección: al abrir una petición de esa colección se usa este entorno automáticamente, sin importar cuál esté seleccionado. Solo un entorno puede estar anclado a cada colección."
                                    className="shrink-0 rounded bg-surface-container-highest px-2 py-1 text-ui-11 text-on-surface outline-none focus:ring-1 focus:ring-primary"
                                >
                                    <option value="">Sin anclar</option>
                                    {collections.map((c) => (
                                        <option key={c.id} value={c.id}>
                                            Anclado a «{c.name}»
                                        </option>
                                    ))}
                                </select>
                                <button
                                    onClick={() => void save()}
                                    disabled={!dirty}
                                    title={dirty ? 'Guardar los cambios del entorno' : 'No hay cambios sin guardar'}
                                    className="shrink-0 rounded bg-primary px-3 py-1 text-ui-11 text-on-primary hover:opacity-90 disabled:opacity-40"
                                >
                                    Guardar
                                </button>
                                <button
                                    onClick={() => setConfirmDelete(selected)}
                                    title="Borrar este entorno"
                                    className="shrink-0 rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-error"
                                >
                                    <Icon name="delete" size={15} />
                                </button>
                            </div>

                            <div className="min-h-0 flex-1 overflow-y-auto">
                                <VariablesTable
                                    rows={rows}
                                    onChange={(r) => {
                                        setRows(r)
                                        setDirty(true)
                                    }}
                                />
                            </div>

                            <p className="shrink-0 border-t border-outline-variant px-3 py-2 text-ui-10 leading-relaxed text-on-surface-variant/70">
                                Estas variables pisan a las de la colección: la colección define el valor por defecto y el entorno lo cambia según dónde estés
                                probando. Se usan escribiendo <span className="font-mono">{'{{nombre}}'}</span> en la URL, en los headers o en el cuerpo.
                            </p>
                        </div>
                    ) : (
                        <div className="flex flex-1 items-center justify-center text-ui-11 text-on-surface-variant/60">
                            Elegí un entorno de la izquierda, o creá uno.
                        </div>
                    )}
                </div>
            </div>

            {confirmDelete && (
                <ConfirmDialog
                    title="Borrar el entorno"
                    description={`Se borra "${confirmDelete.name}" con todas sus variables. Las peticiones que las usen van a quedar con las llaves sin resolver hasta que elijas otro entorno.`}
                    confirmLabel="Borrar"
                    danger
                    onConfirm={() =>
                        void HttpDeleteEnvironment(confirmDelete.id)
                            .then(async () => {
                                const list = await load()
                                setSelectedId('')
                                if (list.length > 0) select(list[0])
                                onChanged()
                            })
                            .catch((e) => setError(String(e)))
                    }
                    onClose={() => setConfirmDelete(null)}
                />
            )}
        </div>
    )
}
