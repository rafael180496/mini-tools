import {useEffect, useState} from 'react'
import {GetConnectionForEdit, ListSchemas, SetConnectionSchemas} from '../../../wailsjs/go/main/App'
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
// Postgres and Oracle: ListSchemas returns an empty list for SQLite, and
// this dialog is only ever opened from a context that already knows that.
export default function SchemaPickerDialog({connId, currentSchemas, onClose, onSaved}: SchemaPickerDialogProps) {
    const [allSchemas, setAllSchemas] = useState<string[] | null>(null)
    const [selected, setSelected] = useState<Set<string>>(new Set(currentSchemas))
    const [search, setSearch] = useState('')
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const [syncing, setSyncing] = useState(false)

    // Oracle's "own schema" is the connected user; Postgres' is 'public' —
    // same convention Workspace.tsx uses to pick activeSchema. Only used as
    // the starting checkbox selection, never blocks rendering the list if
    // it fails.
    async function defaultSchema(): Promise<string> {
        try {
            const info = await GetConnectionForEdit(connId)
            if (info.dbType === 'oracle') return (info.params.user ?? '').toUpperCase()
        } catch {
            // best-effort — falls through to 'public'
        }
        return 'public'
    }

    // forceRefresh=false reads ListSchemas' persisted cache (instant, even
    // on a catalog where listing every schema live is itself slow) — the
    // sync button passes true to discover a schema created since the last
    // sync.
    async function load(forceRefresh: boolean) {
        setError('')
        try {
            const [schemas, defSchema] = await Promise.all([ListSchemas(connId, forceRefresh), defaultSchema()])
            setAllSchemas(schemas)
            // No restriction saved yet — start with only the connection's
            // own schema checked instead of everything, so a catalog with
            // dozens of schemas doesn't default to a full unrestricted
            // scan. Only applies on the initial load — a manual sync
            // afterward must not stomp on what the user already checked.
            if (currentSchemas.length === 0 && !forceRefresh) {
                setSelected(new Set(schemas.includes(defSchema) ? [defSchema] : []))
            }
        } catch (err) {
            setError(String(err))
        }
    }

    useEffect(() => {
        void load(false)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connId])

    async function syncSchemas() {
        setSyncing(true)
        try {
            await load(true)
        } finally {
            setSyncing(false)
        }
    }

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
                    <span className="flex-1">Esquemas a escanear</span>
                    <button
                        type="button"
                        onClick={() => void syncSchemas()}
                        disabled={syncing}
                        title="Vuelve a listar los esquemas contra la base de datos — usalo si acaban de crear un esquema nuevo que no aparece abajo"
                        className="rounded p-1 text-on-surface-variant opacity-70 hover:opacity-100 disabled:opacity-40"
                    >
                        <Icon name="sync" size={16} className={syncing ? 'animate-spin' : ''} />
                    </button>
                </h2>
                <p className="text-xs text-on-surface-variant">
                    Restringe qué esquemas usa el autocomplete/árbol de tablas — útil si esta base tiene muchos esquemas y el
                    escaneo completo es lento.
                </p>

                {allSchemas === null && !error && <p className="text-xs text-on-surface-variant">Cargando esquemas…</p>}
                {error && <p className="text-xs text-error">{error}</p>}

                {allSchemas && allSchemas.length > 4 && (
                    <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Buscar esquema..."
                        title="Filtra la lista de esquemas por nombre"
                        className="rounded-lg border-none bg-surface-container-highest px-3 py-1.5 text-xs text-on-surface outline-none placeholder:text-on-surface-variant/60 focus:ring-1 focus:ring-primary"
                    />
                )}

                {allSchemas && (
                    <div className="flex flex-col gap-1">
                        {allSchemas
                            .filter((s) => s.toLowerCase().includes(search.trim().toLowerCase()))
                            .map((s) => (
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
