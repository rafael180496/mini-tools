import {useEffect, useState} from 'react'
import {ListSchemas, SetConnectionSchemas} from '../../../wailsjs/go/main/App'
import Icon from '../Icon'

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
            <div className="flex max-h-[80vh] w-80 flex-col gap-3 overflow-y-auto rounded-xl border border-outline-variant bg-surface-container-high p-6 text-on-surface shadow-lg">
                <h2 className="flex items-center gap-2 text-lg font-semibold">
                    <Icon name="schema" className="text-primary" />
                    Esquemas a escanear
                </h2>
                <p className="text-xs text-on-surface-variant">
                    Restringe qué esquemas usa el autocomplete/árbol de tablas — útil si esta base tiene muchos esquemas y el
                    escaneo completo es lento.
                </p>

                {allSchemas === null && !error && <p className="text-xs text-on-surface-variant">Cargando esquemas…</p>}
                {error && <p className="text-xs text-error">{error}</p>}

                {allSchemas && (
                    <div className="flex flex-col gap-1">
                        {allSchemas.map((s) => (
                            <label key={s} className="flex items-center gap-2 text-sm text-on-surface">
                                <input type="checkbox" checked={selected.has(s)} onChange={() => toggle(s)} className="accent-primary" />
                                {s}
                            </label>
                        ))}
                        {allSchemas.length === 0 && <p className="text-xs text-on-surface-variant">Sin esquemas.</p>}
                    </div>
                )}

                <div className="mt-2 flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        title="Cierra sin cambiar qué esquemas se escanean"
                        className="rounded-lg px-3 py-1.5 text-sm text-on-surface-variant hover:text-on-surface"
                    >
                        Cancelar
                    </button>
                    <button
                        type="button"
                        onClick={() => void save()}
                        disabled={!allSchemas || busy}
                        title="Guarda la selección — solo los esquemas marcados se escanean para autocompletado y el árbol de tablas (útil en bases con muchos esquemas para evitar escaneos lentos)"
                        className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
                    >
                        Guardar
                    </button>
                </div>
            </div>
        </div>
    )
}
