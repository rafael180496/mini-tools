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
import DbTypeIcon, {DB_TYPES, dbTypeLabel} from '../DbTypeIcon'
import Icon from '../Icon'

interface ConnectionDialogProps {
    // null = creating a new connection; a connection id = editing that one.
    editingId: string | null
    onClose: () => void
    onSaved: () => void
    // Set when opened from a type-specific "+" button (e.g.
    // SshConnectionTree's own module, see Workspace.tsx's 'new-ssh' dialog
    // state) instead of the generic "Conexiones" module — pre-selects that
    // type and hides the type picker entirely (ignored while editingId is
    // set; an existing connection's type is already locked by that path,
    // see the picker's own disabled state below).
    initialDbType?: DBType
}

type DBType = 'sqlite' | 'postgres' | 'oracle' | 'redis' | 'ssh'
type OracleMode = 'service_name' | 'easy_connect' | 'sid' | 'tns'
type RedisMode = 'standalone' | 'cluster' | 'sentinel'
type SSHAuthMethod = 'password' | 'key'

const SSL_MODES = ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']

// Fields required per engine (and, for Oracle/Redis, per connect mode)
// before the dialog will let you Test/Save — mirrors what each
// db.Connector.BuildDSN implementation requires. See
// backend/db/{sqlite,postgres,oracle,redis}.go.
function requiredFields(dbType: DBType, oracleMode: OracleMode, redisMode: RedisMode): string[] {
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
        case 'redis':
            switch (redisMode) {
                case 'cluster':
                    return ['nodes']
                case 'sentinel':
                    return ['sentinels', 'master']
                default:
                    return ['host']
            }
        case 'ssh':
            // password/privateKey deliberately excluded, same convention as
            // postgres/oracle's password — Guardar never depends on a
            // credential being filled in (see the "sin ping ok -> guarda
            // igual si usuario fuerza" spec rule), only Test Connection
            // cares, via passwordUnknownWhileEditing below.
            return ['host', 'user']
    }
}

// normalizeNodeList turns a textarea's freeform newline/comma-separated
// host:port list into the single comma-separated string
// backend/db/redis.go's BuildDSN expects for "nodes"/"sentinels" — the
// textarea accepts either separator for easier pasting, but the Go side
// only ever splits on commas.
function normalizeNodeList(raw: string): string {
    return raw
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .join(',')
}

export default function ConnectionDialog({editingId, onClose, onSaved, initialDbType}: ConnectionDialogProps) {
    const [name, setName] = useState('')
    const [color, setColor] = useState('#60a5fa')
    const [dbType, setDbType] = useState<DBType>(initialDbType ?? 'sqlite')
    // Type-locked dialog (opened from a type-specific module's "+" button,
    // e.g. SshConnectionTree) — same "can't change engine" treatment the
    // type picker already gives an existing connection being edited, just
    // triggered by initialDbType instead of editingId. Only meaningful for
    // a NEW connection; editingId's own lock takes over once one is set.
    const typeLocked = !editingId && !!initialDbType
    const [oracleMode, setOracleMode] = useState<OracleMode>('service_name')
    const [redisMode, setRedisMode] = useState<RedisMode>('standalone')
    const [sshAuthMethod, setSshAuthMethod] = useState<SSHAuthMethod>('password')
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
                if (info.color) setColor(info.color)
                const {mode, auth, ...rest} = info.params
                if (mode && info.dbType === 'oracle') setOracleMode(mode as OracleMode)
                if (mode && info.dbType === 'redis') setRedisMode(mode as RedisMode)
                if (auth && info.dbType === 'ssh') setSshAuthMethod(auth as SSHAuthMethod)
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
        setSshAuthMethod('password')
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
        if (parsed.redisMode) setRedisMode(parsed.redisMode)
        setParams(parsed.params)
        setPingStatus('idle')
        setPasteHint(`Detectado: ${parsed.dbType === 'oracle' ? `Oracle (${parsed.oracleMode})` : parsed.dbType}`)
    }

    function cfg(): main.ConnectionInput {
        let effectiveParams = params
        if (dbType === 'oracle') {
            effectiveParams = {...params, mode: oracleMode}
        } else if (dbType === 'redis') {
            effectiveParams = {...params, mode: redisMode}
            if (redisMode === 'cluster' && effectiveParams.nodes) {
                effectiveParams.nodes = normalizeNodeList(effectiveParams.nodes)
            }
            if (redisMode === 'sentinel' && effectiveParams.sentinels) {
                effectiveParams.sentinels = normalizeNodeList(effectiveParams.sentinels)
            }
        } else if (dbType === 'ssh') {
            effectiveParams = {...params, auth: sshAuthMethod}
        }
        return new main.ConnectionInput({name, dbType, params: effectiveParams, color})
    }

    const missing = requiredFields(dbType, oracleMode, redisMode).filter((f) => !(params[f] ?? '').trim())
    const canSubmit = name.trim() !== '' && missing.length === 0 && !busy && !loadingEdit
    // Editing with a blank password means "keep the existing one" on save
    // (UpdateConnection merges it server-side) — but Test Connection has no
    // such merge, so it would falsely fail against an empty password.
    // Simplest fix: just don't offer it in that state. Only Postgres/Oracle
    // get this treatment — those two conventionally always have a
    // password, so "blank while editing" reliably means "hidden, not
    // absent". Redis is deliberately excluded: a blank password there is
    // routinely real (plenty of Redis servers run with no auth at all), so
    // treating it as "unknown" would permanently block Test Connection on
    // an unauthenticated Redis instance every time you reopen the edit
    // dialog.
    // SSH gets the same treatment as Postgres/Oracle above (never blank by
    // convention), checking whichever credential field its chosen auth
    // method actually uses.
    const sshCredentialBlank =
        dbType === 'ssh' &&
        (sshAuthMethod === 'password' ? !(params.password ?? '').trim() : !(params.privateKey ?? '').trim())
    const passwordUnknownWhileEditing =
        !!editingId &&
        ((dbType === 'postgres' || dbType === 'oracle') ? !(params.password ?? '').trim() : sshCredentialBlank)

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

    // force=true siempre — ver handleSubmit: Guardar no depende de un ping
    // exitoso, ni al crear ni al editar.
    async function doSave() {
        setBusy(true)
        setError('')
        try {
            if (editingId) {
                await UpdateConnection(editingId, cfg(), true)
            } else {
                const saved = await SaveConnection(cfg(), true)
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

    // Guardar nunca depende de un ping exitoso — Test Connection ya existe
    // como paso aparte y opcional para quien quiera verificar antes.
    // Guardar una conexión que hoy no responde (servidor apagado, VPN
    // caída, etc.) es un caso de uso válido tanto al crear como al editar,
    // no un error a bloquear.
    function handleSubmit(e: FormEvent) {
        e.preventDefault()
        void doSave()
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
                <h2 className="text-lg font-semibold">
                    {editingId ? 'Editar conexión' : typeLocked ? `Nueva conexión ${dbTypeLabel(dbType)}` : 'Nueva conexión'}
                </h2>
                {loadingEdit && <p className="text-xs text-on-surface-variant">Cargando conexión…</p>}

                <div className="flex gap-2">
                    <label className={`${labelClass} flex-1`}>
                        Nombre
                        <input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="mi base"
                            className={inputClass}
                        />
                    </label>
                    <label className={labelClass} style={{width: '3.25rem'}}>
                        Color
                        <input
                            type="color"
                            value={color}
                            onChange={(e) => setColor(e.target.value)}
                            title="Color para identificar esta conexión en la lista de conexiones — solo visual, no afecta la conexión"
                            className="h-9 w-full cursor-pointer rounded-lg border border-outline bg-surface p-1"
                        />
                    </label>
                </div>

                {!typeLocked && (
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
                )}

                {typeLocked ? (
                    <div className="flex items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-highest px-3 py-2 text-xs text-on-surface-variant">
                        <DbTypeIcon dbType={dbType} size={18} />
                        Motor: {dbTypeLabel(dbType)}
                    </div>
                ) : (
                    <div className={labelClass}>
                        Tipo
                        <div className="flex gap-2">
                            {/* SSH is deliberately excluded from this generic
                                picker — it lives in its own sidebar module
                                (SshConnectionTree.tsx) with its own "+" that
                                always opens this dialog type-locked
                                (initialDbType='ssh', see typeLocked above).
                                A connection created 'ssh' from here would
                                never show up in "Conexiones" (see
                                ConnectionTree.tsx's dbConnections filter). */}
                            {DB_TYPES.filter((t) => t !== 'ssh').map((t) => (
                                <button
                                    key={t}
                                    type="button"
                                    onClick={() => changeDbType(t)}
                                    disabled={!!editingId}
                                    title={
                                        editingId
                                            ? 'No se puede cambiar el motor de una conexión existente — creá una nueva'
                                            : `Usar ${dbTypeLabel(t)}`
                                    }
                                    className={`flex flex-1 flex-col items-center gap-1 rounded-lg border px-2 py-2 text-xs disabled:opacity-50 disabled:hover:bg-transparent ${
                                        dbType === t
                                            ? 'border-primary bg-primary-container text-on-primary-container'
                                            : 'border-outline text-on-surface-variant hover:bg-surface-variant'
                                    }`}
                                >
                                    <DbTypeIcon dbType={t} size={20} />
                                    {dbTypeLabel(t)}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

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

                {dbType === 'redis' && (
                    <>
                        <label className={labelClass}>
                            Modo de conexión
                            <select
                                value={redisMode}
                                onChange={(e) => setRedisMode(e.target.value as RedisMode)}
                                title="Standalone: un solo servidor Redis. Cluster: varios nodos con sharding automático (sin índice de DB — Redis Cluster no soporta SELECT). Sentinel: alta disponibilidad con failover automático de un master/réplica."
                                className={inputClass}
                            >
                                <option value="standalone">Standalone</option>
                                <option value="cluster">Cluster</option>
                                <option value="sentinel">Sentinel</option>
                            </select>
                        </label>

                        {redisMode === 'standalone' && (
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
                                        placeholder="6379"
                                        className={inputClass}
                                    />
                                </label>
                            </div>
                        )}

                        {redisMode === 'cluster' && (
                            <label className={labelClass}>
                                Nodos del cluster
                                <textarea
                                    value={params.nodes ?? ''}
                                    onChange={(e) => setParam('nodes', e.target.value)}
                                    placeholder={'host1:6379\nhost2:6379\nhost3:6379'}
                                    title="Lista de nodos semilla del cluster (host:puerto), uno por línea o separados por coma — no hace falta listar todos los nodos, con 1-2 nodos vivos el cliente descubre el resto"
                                    rows={3}
                                    className={`${inputClass} font-mono text-xs`}
                                />
                            </label>
                        )}

                        {redisMode === 'sentinel' && (
                            <>
                                <label className={labelClass}>
                                    Nodos Sentinel
                                    <textarea
                                        value={params.sentinels ?? ''}
                                        onChange={(e) => setParam('sentinels', e.target.value)}
                                        placeholder={'sentinel1:26379\nsentinel2:26379\nsentinel3:26379'}
                                        title="Direcciones de los procesos Sentinel (NO del servidor Redis en sí) — uno por línea o separados por coma"
                                        rows={3}
                                        className={`${inputClass} font-mono text-xs`}
                                    />
                                </label>
                                <label className={labelClass}>
                                    Master name
                                    <input
                                        value={params.master ?? ''}
                                        onChange={(e) => setParam('master', e.target.value)}
                                        placeholder="mymaster"
                                        title="Nombre lógico del master configurado en los Sentinel (sentinel monitor <nombre> ...) — no es un host ni una IP"
                                        className={inputClass}
                                    />
                                </label>
                            </>
                        )}

                        <label className={labelClass}>
                            Usuario ACL (opcional)
                            <input
                                value={params.user ?? ''}
                                onChange={(e) => setParam('user', e.target.value)}
                                placeholder="default"
                                title="Usuario ACL de Redis 6+ — dejar en blanco si el servidor no tiene ACLs configuradas"
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
                        {redisMode !== 'cluster' && (
                            <label className={labelClass}>
                                Índice de DB (0-15)
                                <input
                                    value={params.db ?? ''}
                                    onChange={(e) => setParam('db', e.target.value)}
                                    placeholder="0"
                                    title="Base lógica de Redis a usar (0-15, default 0) — no aplica en modo Cluster, que siempre usa una única base"
                                    className={inputClass}
                                />
                            </label>
                        )}
                        <label
                            className="flex items-center gap-2 text-xs text-on-surface-variant"
                            title="Usar TLS (esquema rediss://) para conectar — activalo si el servidor requiere conexión cifrada"
                        >
                            <input
                                type="checkbox"
                                checked={params.tls === 'true'}
                                onChange={(e) => setParam('tls', e.target.checked ? 'true' : '')}
                                className="accent-primary"
                            />
                            TLS
                        </label>
                    </>
                )}

                {dbType === 'ssh' && (
                    <>
                        <div className="flex gap-2">
                            <label className={`${labelClass} flex-1`}>
                                Host
                                <input
                                    value={params.host ?? ''}
                                    onChange={(e) => setParam('host', e.target.value)}
                                    placeholder="192.168.1.10"
                                    className={inputClass}
                                />
                            </label>
                            <label className={labelClass} style={{width: '5rem'}}>
                                Puerto
                                <input
                                    value={params.port ?? ''}
                                    onChange={(e) => setParam('port', e.target.value)}
                                    placeholder="22"
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
                            Método de autenticación
                            <select
                                value={sshAuthMethod}
                                onChange={(e) => setSshAuthMethod(e.target.value as SSHAuthMethod)}
                                title="Password: autenticación con usuario y contraseña. Private key: autenticación con una clave privada (RSA/Ed25519/etc.), opcionalmente protegida por passphrase."
                                className={inputClass}
                            >
                                <option value="password">Password</option>
                                <option value="key">Private key</option>
                            </select>
                        </label>

                        {sshAuthMethod === 'password' && (
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
                        )}

                        {sshAuthMethod === 'key' && (
                            <>
                                <label className={labelClass}>
                                    Private key
                                    <textarea
                                        value={params.privateKey ?? ''}
                                        onChange={(e) => setParam('privateKey', e.target.value)}
                                        placeholder={
                                            editingId
                                                ? 'Dejar en blanco para mantener la actual'
                                                : '-----BEGIN OPENSSH PRIVATE KEY-----\n...'
                                        }
                                        title="Contenido completo del archivo de clave privada (ej. ~/.ssh/id_ed25519) — nunca la ruta del archivo, se guarda cifrada en el vault"
                                        rows={4}
                                        className={`${inputClass} font-mono text-xs`}
                                    />
                                </label>
                                <label className={labelClass}>
                                    Passphrase (opcional)
                                    <input
                                        type="password"
                                        value={params.passphrase ?? ''}
                                        onChange={(e) => setParam('passphrase', e.target.value)}
                                        placeholder={editingId ? 'Dejar en blanco para mantener la actual' : undefined}
                                        title="Passphrase que protege la private key, si tiene una — dejar en blanco si la key no está protegida"
                                        className={inputClass}
                                    />
                                </label>
                            </>
                        )}

                        <label
                            className="flex items-center gap-2 text-xs text-on-surface-variant"
                            title="Reenvía tu ssh-agent local al host remoto para que comandos corridos ahí (git clone, otro ssh) puedan usarlo para autenticarse en un siguiente salto — requiere un ssh-agent corriendo localmente (SSH_AUTH_SOCK). No es un método de autenticación en sí, es independiente de Password/Private key de arriba."
                        >
                            <input
                                type="checkbox"
                                checked={params.agentForwarding === '1'}
                                onChange={(e) => setParam('agentForwarding', e.target.checked ? '1' : '')}
                                className="accent-primary"
                            />
                            Agent Forwarding
                        </label>
                    </>
                )}

                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={testConnection}
                        disabled={missing.length > 0 || pingStatus === 'testing' || passwordUnknownWhileEditing}
                        title={
                            passwordUnknownWhileEditing
                                ? 'Ingresá el password para probar — o guardá directo, Guardar no requiere probar la conexión primero'
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
                        <span className="text-xs text-on-surface-variant">Password sin cambios — se mantiene el actual al guardar</span>
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
                    <button
                        type="submit"
                        disabled={!canSubmit}
                        title={
                            editingId
                                ? 'Guarda los cambios de esta conexión — no hace falta que Test Connection haya sido exitoso'
                                : 'Guarda esta conexión nueva en el vault cifrado — no hace falta probarla antes, podés guardarla aunque no responda ahora mismo'
                        }
                        className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
                    >
                        {editingId ? 'Guardar cambios' : 'Guardar'}
                    </button>
                </div>
            </form>
        </div>
    )
}
