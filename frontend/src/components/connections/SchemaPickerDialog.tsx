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
    // the starting selection, never blocks rendering the list if it fails.
    async function defaultSchema(): Promise<string> {
        try {
            const info = await GetConnectionForEdit(connId)
            if (info.dbType === 'oracle') return (info.params.user ?? '').toUpperCase()
            if (info.dbType === 'sqlserver') return 'dbo'
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
            // No restriction saved yet — start with only the connection's own
            // schema checked instead of everything, so a catalog with dozens
            // of schemas doesn't default to a full unrestricted scan. Only on
            // the initial load — a later manual sync must not stomp on what
            // the user already checked.
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
            // Everything checked is the same as no restriction — store it that
            // way so a schema created later is picked up automatically instead
            // of silently staying excluded.
            const toSave = selected.size === allSchemas.length ? [] : Array.from(selected)
            await SetConnectionSchemas(connId, toSave)
            onSaved()
        } catch (err) {
            setError(String(err))
        } finally {
            setBusy(false)
        }
    }

    const filtered = (allSchemas ?? []).filter((s) => s.toLowerCase().includes(search.trim().toLowerCase()))

    return (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
            <div
                onClick={(e) => e.stopPropagation()}
                className="flex max-h-[85vh] w-104 max-w-[94vw] flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface-container-high text-on-surface shadow-lg"
            >
                {/* Header */}
                <div className="flex items-center gap-3 border-b border-outline-variant px-5 py-3.5">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                        <Icon name="schema" size={20} />
                    </span>
                    <div className="min-w-0 flex-1">
                        <h2 className="text-base font-semibold leading-tight">Esquemas a escanear</h2>
                        <p className="text-xs text-on-surface-variant">Restringí el autocompletado y el árbol de tablas</p>
                    </div>
                    <button
                        type="button"
                        onClick={() => void syncSchemas()}
                        disabled={syncing}
                        title="Vuelve a listar los esquemas contra la base de datos — usalo si acaban de crear uno nuevo que no aparece abajo"
                        className="rounded-full p-1.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-40"
                    >
                        <Icon name="sync" size={18} className={syncing ? 'animate-spin' : ''} />
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        title="Cerrar sin cambiar qué esquemas se escanean"
                        className="rounded-full p-1.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="close" size={20} />
                    </button>
                </div>

                {/* Search + toolbar */}
                <div className="flex flex-col gap-2 border-b border-outline-variant px-5 py-3">
                    <div className="flex items-center gap-2 rounded-lg border border-outline-variant bg-surface px-3 py-2 focus-within:border-primary">
                        <Icon name="search" size={16} className="shrink-0 text-on-surface-variant" />
                        <input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Buscar esquema…"
                            title="Filtra la lista de esquemas por nombre"
                            className="min-w-0 flex-1 bg-transparent text-sm text-on-surface outline-none placeholder:text-on-surface-variant/60"
                        />
                    </div>
                    {allSchemas && allSchemas.length > 0 && (
                        <div className="flex items-center gap-2 text-xs text-on-surface-variant">
                            <span>
                                <span className="font-medium text-on-surface">{selected.size}</span> de {allSchemas.length}{' '}
                                seleccionado{selected.size === 1 ? '' : 's'}
                            </span>
                            <div className="flex-1" />
                            <button
                                type="button"
                                onClick={() => setSelected(new Set(allSchemas))}
                                className="rounded px-2 py-0.5 hover:bg-surface-variant hover:text-on-surface"
                            >
                                Todos
                            </button>
                            <button
                                type="button"
                                onClick={() => setSelected(new Set())}
                                className="rounded px-2 py-0.5 hover:bg-surface-variant hover:text-on-surface"
                            >
                                Ninguno
                            </button>
                        </div>
                    )}
                </div>

                {/* List */}
                <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
                    {allSchemas === null && !error && (
                        <p className="px-2 py-4 text-center text-xs text-on-surface-variant">Cargando esquemas…</p>
                    )}
                    {error && <p className="px-2 py-4 text-center text-xs text-error">{error}</p>}
                    {allSchemas && allSchemas.length === 0 && (
                        <p className="px-2 py-4 text-center text-xs text-on-surface-variant">Sin esquemas.</p>
                    )}
                    {allSchemas && allSchemas.length > 0 && filtered.length === 0 && (
                        <p className="px-2 py-4 text-center text-xs text-on-surface-variant">Ningún esquema coincide con la búsqueda.</p>
                    )}
                    <div className="flex flex-col gap-0.5">
                        {filtered.map((s) => {
                            const on = selected.has(s)
                            return (
                                <button
                                    key={s}
                                    type="button"
                                    onClick={() => toggle(s)}
                                    className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                                        on ? 'bg-primary/10' : 'hover:bg-surface-variant'
                                    }`}
                                >
                                    <span
                                        className={`flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded border transition-colors ${
                                            on ? 'border-primary bg-primary text-on-primary' : 'border-outline'
                                        }`}
                                    >
                                        {on && <Icon name="check" size={14} />}
                                    </span>
                                    <span className="min-w-0 flex-1 truncate text-on-surface">{s}</span>
                                </button>
                            )
                        })}
                    </div>
                </div>

                {/* Footer */}
                <div className="flex justify-end gap-2 border-t border-outline-variant px-5 py-3">
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
                        title="Guarda la selección — solo los esquemas marcados se escanean para autocompletado y el árbol de tablas"
                        className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
                    >
                        {busy ? 'Guardando…' : 'Guardar'}
                    </button>
                </div>
            </div>
        </div>
    )
}
