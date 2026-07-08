import {FormEvent, useEffect, useState} from 'react'
import {
    GetConnectionForEdit,
    ListSchemasForNewConnection,
    SaveConnection,
    SetConnectionSchemas,
    TestConnection,
    UpdateConnection,
} from '../../../wailsjs/go/main/App'
import {main} from '../../../wailsjs/go/models'
import {parseConnectionString} from '../../lib/connStringParser'
import Icon from '../Icon'

interface ConnectionDialogProps {
    // null = creating a new connection; a connection id = editing that one.
    editingId: string | null
    onClose: () => void
    onSaved: () => void
}

type DBType = 'sqlite' | 'postgres' | 'oracle'
type OracleMode = 'service_name' | 'easy_connect' | 'sid' | 'tns'

const SSL_MODES = ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']

// Fields required per engine (and, for Oracle, per connect mode) before the
// dialog will let you Test/Save — mirrors what each db.Connector.BuildDSN
// implementation requires. See backend/db/{sqlite,postgres,oracle}.go.
function requiredFields(dbType: DBType, oracleMode: OracleMode): string[] {
    switch (dbType) {
        case 'sqlite':
            return ['path']
        case 'postgres':
            return ['host', 'user', 'dbname']
        case 'oracle': {
            const base = ['host', 'user']
            if (oracleMode === 'sid') return [...base, 'sid']
            if (oracleMode === 'tns') return [...base, 'connectDescriptor']
            return [...base, 'service']
        }
    }
}

export default function ConnectionDialog({editingId, onClose, onSaved}: ConnectionDialogProps) {
    const [name, setName] = useState('')
    const [dbType, setDbType] = useState<DBType>('sqlite')
    const [oracleMode, setOracleMode] = useState<OracleMode>('service_name')
    const [params, setParams] = useState<Record<string, string>>({})
    const [pingStatus, setPingStatus] = useState<'idle' | 'testing' | 'ok' | 'failed'>('idle')
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const [loadingEdit, setLoadingEdit] = useState(!!editingId)

    const [pasteInput, setPasteInput] = useState('')
    const [pasteHint, setPasteHint] = useState('')

    // Postgres-only, offered right after a successful Test Connection —
    // "which schemas should autocomplete/the sidebar tree scan", same
    // question SchemaPickerDialog asks later from the sidebar, but here at
    // creation time so it's not a separate step. null = not fetched yet
    // (or not applicable), [] = fetched but no schemas found.
    const [availableSchemas, setAvailableSchemas] = useState<string[] | null>(null)
    const [selectedSchemas, setSelectedSchemas] = useState<Set<string>>(new Set())
    const [schemasLoading, setSchemasLoading] = useState(false)
    const [schemaSearch, setSchemaSearch] = useState('')

    // Pre-fill from the saved connection when editing. Password never comes
    // back from GetConnectionForEdit (see its doc comment) — the field
    // stays blank, meaning "keep the existing one" on save, not "clear it".
    useEffect(() => {
        if (!editingId) return
        setLoadingEdit(true)
        GetConnectionForEdit(editingId)
            .then((info) => {
                setName(info.name)
                setDbType(info.dbType as DBType)
                const {mode, ...rest} = info.params
                if (mode) setOracleMode(mode as OracleMode)
                setParams(rest)
            })
            .catch((err) => setError(String(err)))
            .finally(() => setLoadingEdit(false))
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editingId])

    function setParam(key: string, value: string) {
        setParams((prev) => ({...prev, [key]: value}))
    }

    function changeDbType(next: DBType) {
        setDbType(next)
        setParams({})
        setPingStatus('idle')
        setAvailableSchemas(null)
        setSelectedSchemas(new Set())
    }

    function toggleSchema(schema: string) {
        setSelectedSchemas((prev) => {
            const next = new Set(prev)
            if (next.has(schema)) next.delete(schema)
            else next.add(schema)
            return next
        })
    }

    // Copy-paste a connection string (from a .env, psql URL, JDBC URL,
    // Oracle Easy Connect string, or tnsnames.ora descriptor) and auto-fill
    // the type + every field below — see frontend/src/lib/connStringParser.ts.
    // Best-effort: an unrecognized format just leaves the form as-is, so
    // nothing is lost by trying.
    function handlePasteChange(value: string) {
        setPasteInput(value)
        if (!value.trim()) {
            setPasteHint('')
            return
        }
        const parsed = parseConnectionString(value)
        if (!parsed) {
            setPasteHint('No se pudo detectar el formato — completá los campos a mano.')
            return
        }
        setDbType(parsed.dbType)
        if (parsed.oracleMode) setOracleMode(parsed.oracleMode)
        setParams(parsed.params)
        setPingStatus('idle')
        setPasteHint(`Detectado: ${parsed.dbType === 'oracle' ? `Oracle (${parsed.oracleMode})` : parsed.dbType}`)
    }

    function cfg(): main.ConnectionInput {
        const effectiveParams = dbType === 'oracle' ? {...params, mode: oracleMode} : params
        return new main.ConnectionInput({name, dbType, params: effectiveParams})
    }

    const missing = requiredFields(dbType, oracleMode).filter((f) => !(params[f] ?? '').trim())
    const canSubmit = name.trim() !== '' && missing.length === 0 && !busy && !loadingEdit
    // Editing with a blank password means "keep the existing one" on save
    // (UpdateConnection merges it server-side) — but Test Connection has no
    // such merge, so it would falsely fail against an empty password.
    // Simplest fix: just don't offer it in that state, push toward Guardar
    // instead (which pings for real, with the real password, before it commits).
    const passwordUnknownWhileEditing = !!editingId && dbType !== 'sqlite' && !(params.password ?? '').trim()

    async function testConnection() {
        setPingStatus('testing')
        setError('')
        setAvailableSchemas(null)
        setSelectedSchemas(new Set())
        try {
            await TestConnection(cfg())
            setPingStatus('ok')

            // Only new Postgres/Oracle connections get the inline picker —
            // editing an existing one already has this via the sidebar's
            // "esq" button (SchemaPickerDialog), and SQLite has nothing to
            // restrict (see backend/db/metadata.go's ListSchemas doc
            // comment).
            if (!editingId && (dbType === 'postgres' || dbType === 'oracle')) {
                setSchemasLoading(true)
                try {
                    const schemas = await ListSchemasForNewConnection(cfg())
                    setAvailableSchemas(schemas ?? [])
                    // Start with only the connection's own schema checked
                    // (Oracle: the connected user, folded to uppercase like
                    // Oracle does; Postgres: 'public') instead of everything
                    // — a catalog with dozens of schemas shouldn't default
                    // to a full unrestricted scan.
                    const defaultSchema = dbType === 'oracle' ? (params.user ?? '').toUpperCase() : 'public'
                    setSelectedSchemas(new Set((schemas ?? []).includes(defaultSchema) ? [defaultSchema] : []))
                } catch {
                    // Best-effort: if listing schemas fails for some reason,
                    // just skip the picker — the connection can still be
                    // saved and scanned unrestricted, same as before this
                    // feature existed.
                    setAvailableSchemas(null)
                } finally {
                    setSchemasLoading(false)
                }
            }
        } catch (err) {
            setPingStatus('failed')
            setError(String(err))
        }
    }

    async function doSave(force: boolean) {
        setBusy(true)
        setError('')
        try {
            if (editingId) {
                await UpdateConnection(editingId, cfg(), force)
            } else {
                const saved = await SaveConnection(cfg(), force)
                // Everything checked == no restriction, same convention as
                // SchemaPickerDialog — only persist a restriction if the
                // user actually unchecked something.
                if (saved && availableSchemas && availableSchemas.length > 0 && selectedSchemas.size < availableSchemas.length) {
                    await SetConnectionSchemas(saved.id, Array.from(selectedSchemas))
                }
            }
            onSaved()
        } catch (err) {
            setError(String(err))
        } finally {
            setBusy(false)
        }
    }

    function handleSubmit(e: FormEvent) {
        e.preventDefault()
        void doSave(false)
    }

    const inputClass =
        'rounded-lg border border-outline bg-surface px-3 py-2 text-sm text-on-surface outline-none focus:border-primary'
    const labelClass = 'flex flex-col gap-1 text-xs text-on-surface-variant'

    return (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60">
            <form
                onSubmit={handleSubmit}
                className="flex max-h-[90vh] w-104 flex-col gap-3 overflow-y-auto rounded-xl border border-outline-variant bg-surface-container-high p-6 text-on-surface shadow-lg"
            >
                <h2 className="text-lg font-semibold">{editingId ? 'Editar conexión' : 'Nueva conexión'}</h2>
                {loadingEdit && <p className="text-xs text-on-surface-variant">Cargando conexión…</p>}

                <label className={labelClass}>
                    Nombre
                    <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="mi base"
                        className={inputClass}
                    />
                </label>

                <label className={labelClass}>
                    Pegar connection string (opcional)
                    <textarea
                        value={pasteInput}
                        onChange={(e) => handlePasteChange(e.target.value)}
                        placeholder="postgres://user:pass@host:5432/db?sslmode=require, user/pass@host:1521/service, jdbc:oracle:thin:..., o una ruta .db — copiado directo de un .env"
                        rows={2}
                        className={`${inputClass} font-mono text-xs`}
                    />
                    {pasteHint && <span className="text-xs text-on-surface-variant">{pasteHint}</span>}
                </label>

                <label className={labelClass}>
                    Tipo
                    <select
                        value={dbType}
                        onChange={(e) => changeDbType(e.target.value as DBType)}
                        disabled={!!editingId}
                        title={editingId ? 'No se puede cambiar el motor de una conexión existente — creá una nueva' : undefined}
                        className={`${inputClass} disabled:opacity-50`}
                    >
                        <option value="sqlite">SQLite</option>
                        <option value="postgres">PostgreSQL</option>
                        <option value="oracle">Oracle</option>
                    </select>
                </label>

                {dbType === 'sqlite' && (
                    <label className={labelClass}>
                        Archivo (.db / .sqlite)
                        <input
                            value={params.path ?? ''}
                            onChange={(e) => setParam('path', e.target.value)}
                            placeholder="/ruta/a/archivo.db"
                            className={inputClass}
                        />
                    </label>
                )}

                {dbType === 'postgres' && (
                    <>
                        <div className="flex gap-2">
                            <label className={`${labelClass} flex-1`}>
                                Host
                                <input
                                    value={params.host ?? ''}
                                    onChange={(e) => setParam('host', e.target.value)}
                                    placeholder="localhost"
                                    className={inputClass}
                                />
                            </label>
                            <label className={labelClass} style={{width: '5rem'}}>
                                Puerto
                                <input
                                    value={params.port ?? ''}
                                    onChange={(e) => setParam('port', e.target.value)}
                                    placeholder="5432"
                                    className={inputClass}
                                />
                            </label>
                        </div>
                        <label className={labelClass}>
                            Usuario
                            <input
                                value={params.user ?? ''}
                                onChange={(e) => setParam('user', e.target.value)}
                                className={inputClass}
                            />
                        </label>
                        <label className={labelClass}>
                            Password
                            <input
                                type="password"
                                value={params.password ?? ''}
                                onChange={(e) => setParam('password', e.target.value)}
                                placeholder={editingId ? 'Dejar en blanco para mantener la actual' : undefined}
                                className={inputClass}
                            />
                        </label>
                        <label className={labelClass}>
                            Base de datos
                            <input
                                value={params.dbname ?? ''}
                                onChange={(e) => setParam('dbname', e.target.value)}
                                className={inputClass}
                            />
                        </label>
                        <label className={labelClass}>
                            SSL mode
                            <select
                                value={params.sslmode ?? 'prefer'}
                                onChange={(e) => setParam('sslmode', e.target.value)}
                                className={inputClass}
                            >
                                {SSL_MODES.map((m) => (
                                    <option key={m} value={m}>
                                        {m}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </>
                )}

                {dbType === 'oracle' && (
                    <>
                        <div className="flex gap-2">
                            <label className={`${labelClass} flex-1`}>
                                Host
                                <input
                                    value={params.host ?? ''}
                                    onChange={(e) => setParam('host', e.target.value)}
                                    placeholder="localhost"
                                    className={inputClass}
                                />
                            </label>
                            <label className={labelClass} style={{width: '5rem'}}>
                                Puerto
                                <input
                                    value={params.port ?? ''}
                                    onChange={(e) => setParam('port', e.target.value)}
                                    placeholder="1521"
                                    className={inputClass}
                                />
                            </label>
                        </div>
                        <label className={labelClass}>
                            Usuario
                            <input
                                value={params.user ?? ''}
                                onChange={(e) => setParam('user', e.target.value)}
                                className={inputClass}
                            />
                        </label>
                        <label className={labelClass}>
                            Password
                            <input
                                type="password"
                                value={params.password ?? ''}
                                onChange={(e) => setParam('password', e.target.value)}
                                placeholder={editingId ? 'Dejar en blanco para mantener la actual' : undefined}
                                className={inputClass}
                            />
                        </label>
                        <label className={labelClass}>
                            Modo de conexión
                            <select
                                value={oracleMode}
                                onChange={(e) => setOracleMode(e.target.value as OracleMode)}
                                className={inputClass}
                            >
                                <option value="service_name">Service Name</option>
                                <option value="easy_connect">Easy Connect</option>
                                <option value="sid">SID</option>
                                <option value="tns">TNS (descriptor completo)</option>
                            </select>
                        </label>

                        {(oracleMode === 'service_name' || oracleMode === 'easy_connect') && (
                            <label className={labelClass}>
                                Service name
                                <input
                                    value={params.service ?? ''}
                                    onChange={(e) => setParam('service', e.target.value)}
                                    placeholder="ORCLPDB1"
                                    className={inputClass}
                                />
                            </label>
                        )}
                        {oracleMode === 'sid' && (
                            <label className={labelClass}>
                                SID
                                <input
                                    value={params.sid ?? ''}
                                    onChange={(e) => setParam('sid', e.target.value)}
                                    placeholder="ORCL"
                                    className={inputClass}
                                />
                            </label>
                        )}
                        {oracleMode === 'tns' && (
                            <label className={labelClass}>
                                Connect descriptor (tnsnames.ora)
                                <textarea
                                    value={params.connectDescriptor ?? ''}
                                    onChange={(e) => setParam('connectDescriptor', e.target.value)}
                                    placeholder="(DESCRIPTION=(ADDRESS=(HOST=...)(PORT=...))(CONNECT_DATA=(SERVICE_NAME=...)))"
                                    rows={3}
                                    className={`${inputClass} font-mono text-xs`}
                                />
                            </label>
                        )}
                    </>
                )}

                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={testConnection}
                        disabled={missing.length > 0 || pingStatus === 'testing' || passwordUnknownWhileEditing}
                        title={
                            passwordUnknownWhileEditing
                                ? 'Ingresá el password para probar, o guardá directo (se prueba con el password actual antes de guardar)'
                                : 'Intenta conectar con estos datos ahora mismo, sin guardar la conexión — para confirmar que host/usuario/password son correctos'
                        }
                        className="flex items-center gap-1.5 rounded bg-surface-container-highest px-3 py-1.5 text-xs text-on-surface-variant hover:bg-surface-variant disabled:opacity-50"
                    >
                        <Icon name="network_check" size={15} />
                        Test Connection
                    </button>
                    {pingStatus === 'ok' && (
                        <span className="flex items-center gap-1 text-xs text-secondary">
                            <Icon name="check_circle" size={14} filled />
                            conexión ok
                        </span>
                    )}
                    {pingStatus === 'failed' && (
                        <span className="flex items-center gap-1 text-xs text-error">
                            <Icon name="error" size={14} filled />
                            falló
                        </span>
                    )}
                    {passwordUnknownWhileEditing && pingStatus === 'idle' && (
                        <span className="text-xs text-on-surface-variant">Password sin cambios — se prueba al guardar</span>
                    )}
                </div>

                {schemasLoading && (
                    <p className="flex items-center gap-1.5 text-xs text-on-surface-variant">
                        <span
                            aria-hidden
                            className="h-3 w-3 animate-spin rounded-full border-2 border-t-transparent border-primary"
                        />
                        Buscando esquemas…
                    </p>
                )}

                {availableSchemas && availableSchemas.length > 0 && (
                    <div className={labelClass}>
                        <span className="flex items-center gap-1.5">
                            <Icon name="schema" size={14} />
                            Esquemas a escanear ({selectedSchemas.size}/{availableSchemas.length})
                        </span>
                        {availableSchemas.length > 4 && (
                            <input
                                value={schemaSearch}
                                onChange={(e) => setSchemaSearch(e.target.value)}
                                placeholder="Buscar esquema..."
                                title="Filtra la lista de esquemas por nombre"
                                className={`${inputClass} text-xs`}
                            />
                        )}
                        <div className="max-h-32 overflow-y-auto rounded-lg border border-outline-variant bg-surface p-2">
                            {availableSchemas
                                .filter((s) => s.toLowerCase().includes(schemaSearch.trim().toLowerCase()))
                                .map((s) => (
                                    <label key={s} className="flex items-center gap-2 py-0.5 text-sm text-on-surface">
                                        <input
                                            type="checkbox"
                                            checked={selectedSchemas.has(s)}
                                            onChange={() => toggleSchema(s)}
                                            className="accent-primary"
                                        />
                                        {s}
                                    </label>
                                ))}
                        </div>
                        <span className="text-[11px] text-on-surface-variant">
                            Por default queda marcado solo el esquema propio de la conexión — tildá los que además te interesan
                            o desmarcá todo para no escanear ninguno. Se puede cambiar después desde el ícono "esq" en la lista
                            de conexiones.
                        </span>
                    </div>
                )}

                {error && <p className="text-xs text-error">{error}</p>}

                <div className="mt-2 flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        title="Cierra este formulario sin guardar cambios"
                        className="rounded-lg px-3 py-1.5 text-sm text-on-surface-variant hover:text-on-surface"
                    >
                        Cancelar
                    </button>
                    {pingStatus === 'failed' && (
                        <button
                            type="button"
                            disabled={!canSubmit}
                            onClick={() => void doSave(true)}
                            title="Guarda la conexión aunque la prueba haya fallado — útil si el servidor está apagado ahora pero vas a usarlo más tarde"
                            className="rounded-lg bg-tertiary-container px-3 py-1.5 text-sm font-medium text-on-tertiary-container disabled:opacity-50"
                        >
                            Guardar de todos modos
                        </button>
                    )}
                    <button
                        type="submit"
                        disabled={!canSubmit}
                        title={editingId ? 'Guarda los cambios de esta conexión' : 'Guarda esta conexión nueva en el vault cifrado'}
                        className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
                    >
                        {editingId ? 'Guardar cambios' : 'Guardar'}
                    </button>
                </div>
            </form>
        </div>
    )
}
