import {useEffect, useState} from 'react'
import {ListSchemas, SetConnectionSchemas} from '../../../wailsjs/go/main/App'

interface SchemaPickerDialogProps {
    connId: string
    currentSchemas: string[]
    onClose: () => void
    onSaved: () => void
}

// Lets the user restrict which schemas GetSchemaMetadata scans for a
// connection — matters on catalogs with 100+ schemas, where an unrestricted
// scan (the default) can be slow or, on some servers, effectively unusable.
// Postgres-only: ListSchemas returns an empty list for SQLite/Oracle, and
// this dialog is only ever opened from a context that already knows that.
export default function SchemaPickerDialog({connId, currentSchemas, onClose, onSaved}: SchemaPickerDialogProps) {
    const [allSchemas, setAllSchemas] = useState<string[] | null>(null)
    const [selected, setSelected] = useState<Set<string>>(new Set(currentSchemas))
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)

    useEffect(() => {
        ListSchemas(connId)
            .then((schemas) => {
                setAllSchemas(schemas)
                // No restriction saved yet ("scan everything") — start with
                // every schema checked, matching the current real behavior,
                // instead of an empty/confusing all-unchecked list.
                if (currentSchemas.length === 0) setSelected(new Set(schemas))
            })
            .catch((err) => setError(String(err)))
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connId])

    function toggle(schema: string) {
        setSelected((prev) => {
            const next = new Set(prev)
            if (next.has(schema)) next.delete(schema)
            else next.add(schema)
            return next
        })
    }

    async function save() {
        if (!allSchemas) return
        setBusy(true)
        setError('')
        try {
            // Everything checked is the same as no restriction — store it
            // that way so a schema created later is picked up automatically
            // instead of silently staying excluded.
            const toSave = selected.size === allSchemas.length ? [] : Array.from(selected)
            await SetConnectionSchemas(connId, toSave)
            onSaved()
        } catch (err) {
            setError(String(err))
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60">
            <div className="flex max-h-[80vh] w-80 flex-col gap-3 overflow-y-auto rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900 p-6 text-neutral-900 dark:text-neutral-100">
                <h2 className="text-lg font-semibold">Esquemas a escanear</h2>
                <p className="text-xs text-neutral-600 dark:text-neutral-400">
                    Restringe qué esquemas usa el autocomplete/árbol de tablas — útil si esta base tiene muchos esquemas y el
                    escaneo completo es lento.
                </p>

                {allSchemas === null && !error && <p className="text-xs text-neutral-500">Cargando esquemas…</p>}
                {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

                {allSchemas && (
                    <div className="flex flex-col gap-1">
                        {allSchemas.map((s) => (
                            <label key={s} className="flex items-center gap-2 text-sm">
                                <input type="checkbox" checked={selected.has(s)} onChange={() => toggle(s)} />
                                {s}
                            </label>
                        ))}
                        {allSchemas.length === 0 && <p className="text-xs text-neutral-500">Sin esquemas.</p>}
                    </div>
                )}

                <div className="mt-2 flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        title="Cierra sin cambiar qué esquemas se escanean"
                        className="rounded px-3 py-1.5 text-sm text-neutral-600 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200"
                    >
                        Cancelar
                    </button>
                    <button
                        type="button"
                        onClick={() => void save()}
                        disabled={!allSchemas || busy}
                        title="Guarda la selección — solo los esquemas marcados se escanean para autocompletado y el árbol de tablas (útil en bases con muchos esquemas para evitar escaneos lentos)"
                        className="rounded bg-neutral-900 dark:bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-100 dark:text-neutral-900 disabled:opacity-50"
                    >
                        Guardar
                    </button>
                </div>
            </div>
        </div>
    )
}
