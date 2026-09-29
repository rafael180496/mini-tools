import {FormEvent, useEffect, useState} from 'react'
import {
    DetectSQLiteEncryption,
    GetConnectionForEdit,
    ListSSHKeys,
    ListSchemasForNewConnection,
    PickSQLiteFile,
    SaveConnection,
    SetConnectionSchemas,
    TestConnection,
    UpdateConnection,
} from '../../../wailsjs/go/main/App'
import {main, vault} from '../../../wailsjs/go/models'
import {parseConnectionString} from '../../lib/connStringParser'
import {ENVIRONMENTS, type EnvironmentId} from '../../lib/environments'
import DbTypeIcon, {DB_TYPES, dbTypeLabel} from '../DbTypeIcon'
import Icon from '../Icon'
import Select from '../Select'
import PasswordField from './PasswordField'
import SshKeyVaultDialog from './SshKeyVaultDialog'
import Toggle from '../Toggle'
import {useT} from '../../i18n'

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

type DBType = 'sqlite' | 'postgres' | 'oracle' | 'sqlserver' | 'mongodb' | 'redis' | 'ssh'
type OracleMode = 'service_name' | 'easy_connect' | 'sid' | 'tns'
type RedisMode = 'standalone' | 'cluster' | 'sentinel'
type MongoMode = 'standard' | 'srv'
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
        case 'sqlserver':
            return ['host', 'user', 'dbname']
        case 'mongodb':
            // user/password optional (many Mongo servers run without auth,
            // like Redis); database optional (the tree browses every DB).
            return ['host']
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
    const t = useT()
    const tr = t.db.connectionDialog
    const [name, setName] = useState('')
    const [color, setColor] = useState('#60a5fa')
    // Environment marking. '' = unmarked, which is the default on purpose:
    // see the migration 24 comment — marking production by default would make
    // the confirmation dialog routine, and a routine confirmation is noise.
    const [environment, setEnvironment] = useState('')
    const [dbType, setDbType] = useState<DBType>(initialDbType ?? 'sqlite')
    // Type-locked dialog: hides the generic Tipo picker + "pegar connection
    // string" box, shows a plain "Motor: X" badge instead. True for a NEW
    // connection opened from a type-specific module's own "+" button (e.g.
    // SshConnectionTree, initialDbType='ssh'), AND for EDITING any
    // connection whose engine is excluded from the generic picker below
    // (today only 'ssh' — DB_TYPES.filter(t => t !== 'ssh') deliberately
    // excludes it there, see that picker's comment). Real bug this second
    // clause fixes: without it, editing an existing SSH connection fell
    // through to the generic (disabled) picker with none of its four
    // buttons matching the real type, plus the postgres/oracle/sqlite-
    // flavored paste box — both irrelevant and confusing for SSH.
    const typeLocked = dbType === 'ssh' || (!editingId && !!initialDbType)
    const [oracleMode, setOracleMode] = useState<OracleMode>('service_name')
    const [redisMode, setRedisMode] = useState<RedisMode>('standalone')
    const [mongoMode, setMongoMode] = useState<MongoMode>('standard')
    const [sshAuthMethod, setSshAuthMethod] = useState<SSHAuthMethod>('password')
    // Where the private key comes from when auth is 'key': pasted into this
    // form ('inline', the original behaviour) or referenced from the central
    // store ('stored'). Both are auth=key on the wire — the DSN carries a
    // keyId instead of the material, resolved at dial time.
    const [sshKeySource, setSshKeySource] = useState<'inline' | 'stored'>('inline')
    const [sshKeys, setSshKeys] = useState<vault.SSHKeySummary[]>([])
    const [showKeyVault, setShowKeyVault] = useState(false)
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

    // The stored keys, for the picker below. Loaded only for the SSH form —
    // every other engine has no use for them.
    useEffect(() => {
        if (dbType !== 'ssh') return
        ListSSHKeys()
            .then(setSshKeys)
            .catch(() => setSshKeys([]))
    }, [dbType])

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
                setEnvironment(info.environment ?? '')
                const {mode, auth, ...rest} = info.params
                if (mode && info.dbType === 'oracle') setOracleMode(mode as OracleMode)
                if (mode && info.dbType === 'redis') setRedisMode(mode as RedisMode)
                if (mode && info.dbType === 'mongodb') setMongoMode(mode as MongoMode)
                if (auth && info.dbType === 'ssh') setSshAuthMethod(auth as SSHAuthMethod)
                // A saved keyId is what tells us this connection uses a stored
                // key rather than an inline one — the material itself never
                // comes back from GetConnectionForEdit.
                if (info.dbType === 'ssh' && info.params.keyId) setSshKeySource('stored')
                // An encrypted SQLite comes back with the sqlcipher_encrypted
                // marker (never the key itself); flip the toggle on so the form
                // shows the key field as already-set, blank.
                if (rest.sqlcipher_encrypted === '1') rest.sqlcipher_on = 'true'
                setParams(rest)
            })
            .catch((err) => setError(String(err)))
            .finally(() => setLoadingEdit(false))
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editingId])

    function setParam(key: string, value: string) {
        setParams((prev) => ({...prev, [key]: value}))
    }

    // Pick a SQLite file with the native dialog, then auto-detect whether it's
    // SQLCipher-encrypted and set the toggle accordingly — the user shouldn't
    // have to know, or type the path.
    async function pickSqliteFile() {
        try {
            const path = await PickSQLiteFile()
            if (!path) return
            const enc = await DetectSQLiteEncryption(path).catch(() => false)
            setParams((prev) => ({
                ...prev,
                path,
                // A freshly-picked encrypted file needs its own key, so drop
                // any "keep existing" marker inherited from an edit.
                sqlcipher_on: enc ? 'true' : '',
                sqlcipher_encrypted: '',
                sqlcipher_key: enc ? (prev.sqlcipher_key ?? '') : '',
            }))
        } catch {
            // Cancelling or a dialog error is a no-op — nothing to surface.
        }
    }

    // Re-detect when the user types/pastes a path by hand (on blur), so the
    // toggle also reflects a manually-entered encrypted file.
    async function redetectOnBlur() {
        const path = params.path
        if (!path || params.sqlcipher_encrypted === '1') return
        const enc = await DetectSQLiteEncryption(path).catch(() => null)
        if (enc === null) return
        setParam('sqlcipher_on', enc ? 'true' : '')
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
            setPasteHint(tr.pasteUnrecognized)
            return
        }
        setDbType(parsed.dbType)
        if (parsed.oracleMode) setOracleMode(parsed.oracleMode)
        if (parsed.redisMode) setRedisMode(parsed.redisMode)
        if (parsed.mongoMode) setMongoMode(parsed.mongoMode)
        setParams(parsed.params)
        setPingStatus('idle')
        setPasteHint(tr.pasteDetected({type: parsed.dbType === 'oracle' ? `Oracle (${parsed.oracleMode})` : parsed.dbType}))
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
        } else if (dbType === 'mongodb') {
            effectiveParams = {...params, mode: mongoMode}
        } else if (dbType === 'ssh') {
            effectiveParams = {...params, auth: sshAuthMethod}
            // Only one of the two shapes is ever submitted. Sending both would
            // let a leftover pasted key from before the switch win over the
            // stored one the user just picked.
            if (sshAuthMethod === 'key' && sshKeySource === 'stored') {
                delete effectiveParams.privateKey
                delete effectiveParams.passphrase
            } else {
                delete effectiveParams.keyId
            }
        }
        return new main.ConnectionInput({name, dbType, params: effectiveParams, color, environment})
    }

    const missing = requiredFields(dbType, oracleMode, redisMode).filter((f) => !(params[f] ?? '').trim())
    // A stored-key connection with no key chosen would build a DSN that
    // cannot authenticate, so it is blocked here rather than failing at
    // connect time.
    const storedKeyMissing = dbType === 'ssh' && sshAuthMethod === 'key' && sshKeySource === 'stored' && !(params.keyId ?? '').trim()
    const canSubmit = name.trim() !== '' && missing.length === 0 && !storedKeyMissing && !busy && !loadingEdit
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
        (sshAuthMethod === 'password'
            ? !(params.password ?? '').trim()
            : sshKeySource === 'stored'
              // A stored key is never blank-while-editing: the reference IS the
              // credential and it round-trips, so Test Connection can run.
              ? false
              : !(params.privateKey ?? '').trim())
    const passwordUnknownWhileEditing =
        !!editingId &&
        ((dbType === 'postgres' || dbType === 'oracle' || dbType === 'sqlserver')
            ? !(params.password ?? '').trim()
            : sshCredentialBlank)

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
            if (!editingId && (dbType === 'postgres' || dbType === 'oracle' || dbType === 'sqlserver')) {
                setSchemasLoading(true)
                try {
                    const schemas = await ListSchemasForNewConnection(cfg())
                    setAvailableSchemas(schemas ?? [])
                    // Start with only the connection's own schema checked
                    // (Oracle: the connected user, folded to uppercase like
                    // Oracle does; Postgres: 'public') instead of everything
                    // — a catalog with dozens of schemas shouldn't default
                    // to a full unrestricted scan.
                    const defaultSchema =
                        dbType === 'oracle'
                            ? (params.user ?? '').toUpperCase()
                            : dbType === 'sqlserver'
                              ? 'dbo'
                              : 'public'
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

    // Fuera del JSX: el chequeo de i18n toma los literales de una comparación
    // dentro de {…} como si fueran texto de interfaz.
    const isSqlite = dbType === 'sqlite'
    const isPostgres = dbType === 'postgres'
    const isSqlServer = dbType === 'sqlserver'
    const isOracle = dbType === 'oracle'
    const isMongo = dbType === 'mongodb'
    const isRedis = dbType === 'redis'
    const isSsh = dbType === 'ssh'
    const sqlcipherOn = params.sqlcipher_on === 'true'
    const oracleServiceMode = oracleMode === 'service_name' || oracleMode === 'easy_connect'
    const oracleSidMode = oracleMode === 'sid'
    const oracleTnsMode = oracleMode === 'tns'
    const mongoStandard = mongoMode === 'standard'
    const redisStandalone = redisMode === 'standalone'
    const redisCluster = redisMode === 'cluster'
    const redisSentinel = redisMode === 'sentinel'
    const sshPasswordAuth = sshAuthMethod === 'password'
    const sshKeyAuth = sshAuthMethod === 'key'
    const sshStoredKey = sshKeyAuth && sshKeySource === 'stored'
    const sshInlineKey = sshKeyAuth && sshKeySource === 'inline'
    const pingOk = pingStatus === 'ok'
    const pingFailed = pingStatus === 'failed'
    const pingIdle = pingStatus === 'idle'

    return (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
            <form
                onSubmit={handleSubmit}
                onClick={(e) => e.stopPropagation()}
                className="flex max-h-[92vh] w-120 max-w-[94vw] flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface-container-high text-on-surface shadow-lg"
            >
                {/* Header (fijo) */}
                <div className="flex items-center gap-3 border-b border-outline-variant px-6 py-4">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-container-highest">
                        <DbTypeIcon dbType={dbType} size={20} />
                    </span>
                    <div className="min-w-0 flex-1">
                        <h2 className="text-base font-semibold leading-tight">
                            {editingId ? tr.titleEdit : typeLocked ? tr.titleNewTyped({engine: dbTypeLabel(dbType)}) : tr.titleNew}
                        </h2>
                        <p className="text-xs text-on-surface-variant">
                            {isSsh
                                ? tr.subtitleSsh
                                : editingId
                                  ? tr.subtitleEdit
                                  : tr.subtitleNew}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        title={tr.closeHint}
                        className="rounded-full p-1.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="close" size={20} />
                    </button>
                </div>

                {/* Body (scrolleable) */}
                <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 py-4">
                {loadingEdit && <p className="text-xs text-on-surface-variant">{tr.loading}</p>}

                <div className="flex gap-2">
                    <label className={`${labelClass} flex-1`}>
                        {tr.name}
                        <input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder={tr.namePlaceholder}
                            className={inputClass}
                        />
                    </label>
                    <label className={labelClass} style={{width: '3.25rem'}}>
                        {tr.color}
                        <input
                            type="color"
                            value={color}
                            onChange={(e) => setColor(e.target.value)}
                            title={tr.colorHint}
                            className="h-9 w-full cursor-pointer rounded-lg border border-outline bg-surface p-1"
                        />
                    </label>
                </div>

                <div className={labelClass}>
                    {tr.environment}
                    <Select
                        value={environment}
                        options={[
                            {value: '', label: tr.envNone},
                            {value: 'prod', label: tr.envProd},
                            {value: 'staging', label: tr.envStaging},
                            {value: 'dev', label: tr.envDev},
                        ]}
                        onChange={setEnvironment}
                        title={tr.environmentHint}
                        ariaLabel={tr.environment}
                        className="w-full"
                    />
                    {environment !== '' && (
                        <span className="mt-1 flex items-center gap-1.5 text-ui-11 text-on-surface-variant">
                            <span className={`h-2 w-2 shrink-0 rounded-full ${ENVIRONMENTS[environment as EnvironmentId].dot}`} />
                            {ENVIRONMENTS[environment as EnvironmentId].description}
                        </span>
                    )}
                </div>

                {!typeLocked && (
                    <label className={labelClass}>
                        {tr.paste}
                        <textarea
                            value={pasteInput}
                            onChange={(e) => handlePasteChange(e.target.value)}
                            placeholder={tr.pastePlaceholder}
                            rows={2}
                            className={`${inputClass} font-mono text-xs`}
                        />
                        {pasteHint && <span className="text-xs text-on-surface-variant">{pasteHint}</span>}
                    </label>
                )}

                {typeLocked ? (
                    <div className="flex items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-highest px-3 py-2 text-xs text-on-surface-variant">
                        <DbTypeIcon dbType={dbType} size={18} />
                        {tr.engineLocked({engine: dbTypeLabel(dbType)})}
                    </div>
                ) : (
                    <div className={labelClass}>
                        {tr.type}
                        {/* A responsive grid, not a single flex row — with 6
                            engines a fixed row overflowed the modal and clipped
                            the last chip (Redis). 3 columns = 2 tidy rows that
                            always fit; labels truncate so a wide name never
                            forces horizontal overflow. SSH is deliberately
                            excluded from this generic picker — it lives in its
                            own sidebar module (SshConnectionTree.tsx) with its
                            own "+" that opens this dialog type-locked
                            (initialDbType='ssh'); a connection created 'ssh'
                            from here would never show up in "Conexiones" (see
                            ConnectionTree.tsx's dbConnections filter). */}
                        <div className="grid grid-cols-3 gap-2">
                            {DB_TYPES.filter((ty) => ty !== 'ssh').map((ty) => (
                                <button
                                    key={ty}
                                    type="button"
                                    onClick={() => changeDbType(ty)}
                                    disabled={!!editingId}
                                    title={
                                        editingId
                                            ? tr.typeLockedHint
                                            : tr.useEngine({engine: dbTypeLabel(ty)})
                                    }
                                    className={`flex min-w-0 flex-col items-center gap-1.5 rounded-lg border px-1 py-2.5 text-xs transition-colors disabled:opacity-50 disabled:hover:bg-transparent ${
                                        dbType === ty
                                            ? 'border-primary bg-primary-container text-on-primary-container'
                                            : 'border-outline text-on-surface-variant hover:bg-surface-variant'
                                    }`}
                                >
                                    <DbTypeIcon dbType={ty} size={22} />
                                    <span className="w-full truncate text-center">{dbTypeLabel(ty)}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {isSqlite && (
                    <>
                        <label className={labelClass}>
                            {tr.sqlite.file}
                            <div className="flex gap-2">
                                <input
                                    value={params.path ?? ''}
                                    onChange={(e) => setParam('path', e.target.value)}
                                    onBlur={redetectOnBlur}
                                    placeholder={tr.sqlite.filePlaceholder}
                                    className={`${inputClass} min-w-0 flex-1`}
                                />
                                <button
                                    type="button"
                                    onClick={pickSqliteFile}
                                    title={tr.sqlite.pickFileHint}
                                    className="shrink-0 rounded bg-surface-variant px-3 text-xs text-on-surface-variant hover:bg-surface-container-highest"
                                >
                                    {tr.sqlite.pickFile}
                                </button>
                            </div>
                        </label>
                        <div
                            className="flex items-center gap-2.5 text-xs text-on-surface-variant"
                            title={tr.sqlite.encryptedHint}
                        >
                            <Toggle
                                checked={sqlcipherOn}
                                onChange={(c) => {
                                    setParam('sqlcipher_on', c ? 'true' : '')
                                    if (!c) setParam('sqlcipher_key', '')
                                }}
                                ariaLabel={tr.sqlite.encryptedAria}
                            />
                            {tr.sqlite.encrypted}
                        </div>
                        {sqlcipherOn && (
                            <label className={labelClass}>
                                {tr.sqlite.key}
                                <input
                                    type="password"
                                    value={params.sqlcipher_key ?? ''}
                                    onChange={(e) => setParam('sqlcipher_key', e.target.value)}
                                    placeholder={params.sqlcipher_encrypted === '1' ? tr.sqlite.keyKeep : tr.sqlite.keyPlaceholder}
                                    className={inputClass}
                                />
                            </label>
                        )}
                    </>
                )}

                {isPostgres && (
                    <>
                        <div className="flex gap-2">
                            <label className={`${labelClass} flex-1`}>
                                {tr.host}
                                <input
                                    value={params.host ?? ''}
                                    onChange={(e) => setParam('host', e.target.value)}
                                    placeholder={tr.ph.localhost}
                                    className={inputClass}
                                />
                            </label>
                            <label className={labelClass} style={{width: '5rem'}}>
                                {tr.port}
                                <input
                                    value={params.port ?? ''}
                                    onChange={(e) => setParam('port', e.target.value)}
                                    placeholder="5432"
                                    className={inputClass}
                                />
                            </label>
                        </div>
                        <label className={labelClass}>
                            {tr.user}
                            <input
                                value={params.user ?? ''}
                                onChange={(e) => setParam('user', e.target.value)}
                                className={inputClass}
                            />
                        </label>
                        <PasswordField
                            value={params.password ?? ''}
                            onChange={(v) => setParam('password', v)}
                            editingId={editingId}
                            inputClass={inputClass}
                            labelClass={labelClass}
                        />
                        <label className={labelClass}>
                            {tr.database}
                            <input
                                value={params.dbname ?? ''}
                                onChange={(e) => setParam('dbname', e.target.value)}
                                className={inputClass}
                            />
                        </label>
                        <div className={labelClass}>
                            {tr.sslMode}
                            <Select
                                value={params.sslmode ?? 'prefer'}
                                options={SSL_MODES.map((m) => ({value: m, label: m}))}
                                onChange={(v) => setParam('sslmode', v)}
                                ariaLabel={tr.sslMode}
                                className="w-full"
                            />
                        </div>
                    </>
                )}

                {isSqlServer && (
                    <>
                        <div className="flex gap-2">
                            <label className={`${labelClass} flex-1`}>
                                {tr.host}
                                <input
                                    value={params.host ?? ''}
                                    onChange={(e) => setParam('host', e.target.value)}
                                    placeholder={tr.ph.localhost}
                                    className={inputClass}
                                />
                            </label>
                            <label className={labelClass} style={{width: '5rem'}}>
                                {tr.port}
                                <input
                                    value={params.port ?? ''}
                                    onChange={(e) => setParam('port', e.target.value)}
                                    placeholder="1433"
                                    title={tr.sqlserver.portHint}
                                    className={inputClass}
                                />
                            </label>
                        </div>
                        <label className={labelClass}>
                            {tr.sqlserver.instance}
                            <input
                                value={params.instance ?? ''}
                                onChange={(e) => setParam('instance', e.target.value)}
                                placeholder={tr.ph.sqlExpress}
                                title={tr.sqlserver.instanceHint}
                                className={inputClass}
                            />
                        </label>
                        <label className={labelClass}>
                            {tr.user}
                            <input
                                value={params.user ?? ''}
                                onChange={(e) => setParam('user', e.target.value)}
                                className={inputClass}
                            />
                        </label>
                        <PasswordField
                            value={params.password ?? ''}
                            onChange={(v) => setParam('password', v)}
                            editingId={editingId}
                            inputClass={inputClass}
                            labelClass={labelClass}
                        />
                        <label className={labelClass}>
                            {tr.database}
                            <input
                                value={params.dbname ?? ''}
                                onChange={(e) => setParam('dbname', e.target.value)}
                                className={inputClass}
                            />
                        </label>
                        <div className={labelClass}>
                            {tr.sqlserver.encryption}
                            <Select
                                value={params.encrypt ?? 'disable'}
                                options={['disable', 'false', 'true', 'strict'].map((m) => ({value: m, label: m}))}
                                onChange={(v) => setParam('encrypt', v)}
                                ariaLabel={tr.sqlserver.encryptionAria}
                                className="w-full"
                            />
                        </div>
                        <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
                            <input
                                type="checkbox"
                                checked={(params.trustServerCertificate ?? '') === 'true'}
                                onChange={(e) => setParam('trustServerCertificate', e.target.checked ? 'true' : '')}
                                title={tr.sqlserver.trustCertHint}
                            />
                            {tr.sqlserver.trustCert}
                        </label>
                    </>
                )}

                {isOracle && (
                    <>
                        <div className="flex gap-2">
                            <label className={`${labelClass} flex-1`}>
                                {tr.host}
                                <input
                                    value={params.host ?? ''}
                                    onChange={(e) => setParam('host', e.target.value)}
                                    placeholder={tr.ph.localhost}
                                    className={inputClass}
                                />
                            </label>
                            <label className={labelClass} style={{width: '5rem'}}>
                                {tr.port}
                                <input
                                    value={params.port ?? ''}
                                    onChange={(e) => setParam('port', e.target.value)}
                                    placeholder="1521"
                                    className={inputClass}
                                />
                            </label>
                        </div>
                        <label className={labelClass}>
                            {tr.user}
                            <input
                                value={params.user ?? ''}
                                onChange={(e) => setParam('user', e.target.value)}
                                className={inputClass}
                            />
                        </label>
                        <PasswordField
                            value={params.password ?? ''}
                            onChange={(v) => setParam('password', v)}
                            editingId={editingId}
                            inputClass={inputClass}
                            labelClass={labelClass}
                        />
                        <div className={labelClass}>
                            {tr.connectMode}
                            <Select
                                value={oracleMode}
                                options={[
                                    {value: 'service_name', label: tr.oracle.modeServiceName},
                                    {value: 'easy_connect', label: tr.oracle.modeEasyConnect},
                                    {value: 'sid', label: tr.oracle.modeSid},
                                    {value: 'tns', label: tr.oracle.modeTns},
                                ]}
                                onChange={(v) => setOracleMode(v as OracleMode)}
                                ariaLabel={tr.oracle.modeAria}
                                className="w-full"
                            />
                        </div>

                        {oracleServiceMode && (
                            <label className={labelClass}>
                                {tr.oracle.serviceName}
                                <input
                                    value={params.service ?? ''}
                                    onChange={(e) => setParam('service', e.target.value)}
                                    placeholder={tr.ph.orclPdb}
                                    className={inputClass}
                                />
                            </label>
                        )}
                        {oracleSidMode && (
                            <label className={labelClass}>
                                {tr.oracle.sid}
                                <input
                                    value={params.sid ?? ''}
                                    onChange={(e) => setParam('sid', e.target.value)}
                                    placeholder={tr.ph.orcl}
                                    className={inputClass}
                                />
                            </label>
                        )}
                        {oracleTnsMode && (
                            <label className={labelClass}>
                                {tr.oracle.descriptor}
                                <textarea
                                    value={params.connectDescriptor ?? ''}
                                    onChange={(e) => setParam('connectDescriptor', e.target.value)}
                                    placeholder={tr.ph.tnsDescriptor}
                                    rows={3}
                                    className={`${inputClass} font-mono text-xs`}
                                />
                            </label>
                        )}
                    </>
                )}

                {isMongo && (
                    <>
                        <div className={labelClass}>
                            {tr.mongo.mode}
                            <Select
                                value={mongoMode}
                                options={[
                                    {value: 'standard', label: tr.mongo.modeStandard},
                                    {value: 'srv', label: tr.mongo.modeSrv},
                                ]}
                                onChange={(v) => setMongoMode(v as MongoMode)}
                                ariaLabel={tr.mongo.modeAria}
                                className="w-full"
                            />
                        </div>
                        <div className="flex gap-2">
                            <label className={`${labelClass} flex-1`}>
                                {tr.host}
                                <input value={params.host ?? ''} onChange={(e) => setParam('host', e.target.value)} placeholder={tr.ph.localhost} className={inputClass} />
                            </label>
                            {mongoStandard && (
                                <label className={labelClass} style={{width: '5rem'}}>
                                    {tr.port}
                                    <input value={params.port ?? ''} onChange={(e) => setParam('port', e.target.value)} placeholder="27017" className={inputClass} />
                                </label>
                            )}
                        </div>
                        {mongoStandard && (
                            <label className={labelClass}>
                                {tr.mongo.hosts}
                                <input
                                    value={params.hosts ?? ''}
                                    onChange={(e) => setParam('hosts', e.target.value)}
                                    placeholder={tr.ph.mongoHosts}
                                    title={tr.mongo.hostsHint}
                                    className={inputClass}
                                />
                            </label>
                        )}
                        <label className={labelClass}>
                            {tr.mongo.userOptional}
                            <input value={params.user ?? ''} onChange={(e) => setParam('user', e.target.value)} className={inputClass} />
                        </label>
                        <PasswordField
                            value={params.password ?? ''}
                            onChange={(v) => setParam('password', v)}
                            editingId={editingId}
                            label={tr.mongo.passwordOptional}
                            inputClass={inputClass}
                            labelClass={labelClass}
                        />
                        <label className={labelClass}>
                            {tr.mongo.databaseOptional}
                            <input
                                value={params.database ?? ''}
                                onChange={(e) => setParam('database', e.target.value)}
                                title={tr.mongo.databaseHint}
                                className={inputClass}
                            />
                        </label>
                        <label className={labelClass}>
                            {tr.mongo.authSource}
                            <input value={params.authSource ?? ''} onChange={(e) => setParam('authSource', e.target.value)} placeholder={tr.ph.authSource} className={inputClass} />
                        </label>
                        {mongoStandard && (
                            <label className={labelClass}>
                                {tr.mongo.replicaSet}
                                <input value={params.replicaSet ?? ''} onChange={(e) => setParam('replicaSet', e.target.value)} className={inputClass} />
                            </label>
                        )}
                        <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
                            <input
                                type="checkbox"
                                checked={(params.tls ?? '') === 'true'}
                                onChange={(e) => setParam('tls', e.target.checked ? 'true' : '')}
                                title={tr.mongo.tlsHint}
                            />
                            TLS
                        </label>
                    </>
                )}

                {isRedis && (
                    <>
                        <div className={labelClass}>
                            {tr.connectMode}
                            <Select
                                value={redisMode}
                                options={[
                                    {value: 'standalone', label: tr.redis.modeStandalone},
                                    {value: 'cluster', label: tr.redis.modeCluster},
                                    {value: 'sentinel', label: tr.redis.modeSentinel},
                                ]}
                                onChange={(v) => setRedisMode(v as RedisMode)}
                                title={tr.redis.modeHint}
                                ariaLabel={tr.redis.modeAria}
                                className="w-full"
                            />
                        </div>

                        {redisStandalone && (
                            <div className="flex gap-2">
                                <label className={`${labelClass} flex-1`}>
                                    {tr.host}
                                    <input
                                        value={params.host ?? ''}
                                        onChange={(e) => setParam('host', e.target.value)}
                                        placeholder={tr.ph.localhost}
                                        className={inputClass}
                                    />
                                </label>
                                <label className={labelClass} style={{width: '5rem'}}>
                                    {tr.port}
                                    <input
                                        value={params.port ?? ''}
                                        onChange={(e) => setParam('port', e.target.value)}
                                        placeholder="6379"
                                        className={inputClass}
                                    />
                                </label>
                            </div>
                        )}

                        {redisCluster && (
                            <label className={labelClass}>
                                {tr.redis.clusterNodes}
                                <textarea
                                    value={params.nodes ?? ''}
                                    onChange={(e) => setParam('nodes', e.target.value)}
                                    placeholder={tr.ph.clusterNodes}
                                    title={tr.redis.clusterNodesHint}
                                    rows={3}
                                    className={`${inputClass} font-mono text-xs`}
                                />
                            </label>
                        )}

                        {redisSentinel && (
                            <>
                                <label className={labelClass}>
                                    {tr.redis.sentinelNodes}
                                    <textarea
                                        value={params.sentinels ?? ''}
                                        onChange={(e) => setParam('sentinels', e.target.value)}
                                        placeholder={tr.ph.sentinelNodes}
                                        title={tr.redis.sentinelNodesHint}
                                        rows={3}
                                        className={`${inputClass} font-mono text-xs`}
                                    />
                                </label>
                                <label className={labelClass}>
                                    {tr.redis.masterName}
                                    <input
                                        value={params.master ?? ''}
                                        onChange={(e) => setParam('master', e.target.value)}
                                        placeholder={tr.ph.masterName}
                                        title={tr.redis.masterNameHint}
                                        className={inputClass}
                                    />
                                </label>
                            </>
                        )}

                        <label className={labelClass}>
                            {tr.redis.aclUser}
                            <input
                                value={params.user ?? ''}
                                onChange={(e) => setParam('user', e.target.value)}
                                placeholder={tr.ph.aclUser}
                                title={tr.redis.aclUserHint}
                                className={inputClass}
                            />
                        </label>
                        <PasswordField
                            value={params.password ?? ''}
                            onChange={(v) => setParam('password', v)}
                            editingId={editingId}
                            inputClass={inputClass}
                            labelClass={labelClass}
                        />
                        {!redisCluster && (
                            <label className={labelClass}>
                                {tr.redis.dbIndex}
                                <input
                                    value={params.db ?? ''}
                                    onChange={(e) => setParam('db', e.target.value)}
                                    placeholder="0"
                                    title={tr.redis.dbIndexHint}
                                    className={inputClass}
                                />
                            </label>
                        )}
                        <div
                            className="flex items-center gap-2.5 text-xs text-on-surface-variant"
                            title={tr.redis.tlsHint}
                        >
                            <Toggle
                                checked={params.tls === 'true'}
                                onChange={(c) => setParam('tls', c ? 'true' : '')}
                                ariaLabel="TLS"
                            />
                            TLS
                        </div>
                    </>
                )}

                {isSsh && (
                    <>
                        <div className="flex gap-2">
                            <label className={`${labelClass} flex-1`}>
                                {tr.host}
                                <input
                                    value={params.host ?? ''}
                                    onChange={(e) => setParam('host', e.target.value)}
                                    placeholder="192.168.1.10"
                                    className={inputClass}
                                />
                            </label>
                            <label className={labelClass} style={{width: '5rem'}}>
                                {tr.port}
                                <input
                                    value={params.port ?? ''}
                                    onChange={(e) => setParam('port', e.target.value)}
                                    placeholder="22"
                                    className={inputClass}
                                />
                            </label>
                        </div>
                        <label className={labelClass}>
                            {tr.user}
                            <input
                                value={params.user ?? ''}
                                onChange={(e) => setParam('user', e.target.value)}
                                className={inputClass}
                            />
                        </label>
                        <div className={labelClass}>
                            {tr.ssh.authMethod}
                            <Select
                                value={sshAuthMethod}
                                options={[
                                    {value: 'password', label: tr.ssh.authPassword},
                                    {value: 'key', label: tr.ssh.authKey},
                                ]}
                                onChange={(v) => setSshAuthMethod(v as SSHAuthMethod)}
                                title={tr.ssh.authMethodHint}
                                ariaLabel={tr.ssh.authMethod}
                                className="w-full"
                            />
                        </div>

                        {sshPasswordAuth && (
                            <PasswordField
                                value={params.password ?? ''}
                                onChange={(v) => setParam('password', v)}
                                editingId={editingId}
                                inputClass={inputClass}
                                labelClass={labelClass}
                            />
                        )}

                        {sshKeyAuth && (
                            <div className={labelClass}>
                                {tr.ssh.keySource}
                                <Select
                                    value={sshKeySource}
                                    options={[
                                        {value: 'stored', label: tr.ssh.keySourceStored},
                                        {value: 'inline', label: tr.ssh.keySourceInline},
                                    ]}
                                    onChange={(v) => setSshKeySource(v as 'inline' | 'stored')}
                                    title={tr.ssh.keySourceHint}
                                    ariaLabel={tr.ssh.keySource}
                                    className="w-full"
                                />
                            </div>
                        )}

                        {sshStoredKey && (
                            <div className={labelClass}>
                                {tr.ssh.key}
                                <div className="flex items-center gap-2">
                                    <Select
                                        value={params.keyId ?? ''}
                                        options={[
                                            {value: '', label: sshKeys.length ? tr.ssh.pickKey : tr.ssh.noKeys},
                                            ...sshKeys.map((k) => ({value: k.id, label: `${k.name} · ${k.keyType}`})),
                                        ]}
                                        onChange={(v) => setParam('keyId', v)}
                                        ariaLabel={tr.ssh.storedKeyAria}
                                        className="min-w-0 flex-1"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowKeyVault(true)}
                                        title={tr.ssh.manageKeysHint}
                                        className="flex shrink-0 items-center gap-1 rounded-lg border border-outline px-2.5 py-1.5 text-xs text-on-surface hover:bg-surface-variant"
                                    >
                                        <Icon name="key" size={14} />
                                        {tr.ssh.manageKeys}
                                    </button>
                                </div>
                                {params.keyId && (
                                    <span className="mt-1 block truncate font-mono text-ui-10 text-on-surface-variant">
                                        {sshKeys.find((k) => k.id === params.keyId)?.fingerprint ?? ''}
                                    </span>
                                )}
                            </div>
                        )}

                        {sshInlineKey && (
                            <>
                                <label className={labelClass}>
                                    {tr.ssh.privateKey}
                                    <textarea
                                        value={params.privateKey ?? ''}
                                        onChange={(e) => setParam('privateKey', e.target.value)}
                                        placeholder={
                                            editingId
                                                ? tr.ssh.keepCurrent
                                                : tr.ph.privateKey
                                        }
                                        title={tr.ssh.privateKeyHint}
                                        rows={4}
                                        className={`${inputClass} font-mono text-xs`}
                                    />
                                </label>
                                <label className={labelClass}>
                                    {tr.ssh.passphraseOptional}
                                    <input
                                        type="password"
                                        value={params.passphrase ?? ''}
                                        onChange={(e) => setParam('passphrase', e.target.value)}
                                        placeholder={editingId ? tr.ssh.keepCurrent : undefined}
                                        title={tr.ssh.passphraseHint}
                                        className={inputClass}
                                    />
                                </label>
                            </>
                        )}

                        <div
                            className="flex items-center gap-2.5 text-xs text-on-surface-variant"
                            title={tr.ssh.agentForwardingHint}
                        >
                            <Toggle
                                checked={params.agentForwarding === '1'}
                                onChange={(c) => setParam('agentForwarding', c ? '1' : '')}
                                ariaLabel={tr.ssh.agentForwarding}
                            />
                            {tr.ssh.agentForwarding}
                        </div>
                    </>
                )}

                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={testConnection}
                        disabled={missing.length > 0 || pingStatus === 'testing' || passwordUnknownWhileEditing}
                        title={
                            passwordUnknownWhileEditing
                                ? tr.testNeedPasswordHint
                                : tr.testHint
                        }
                        className="flex items-center gap-1.5 rounded-lg border border-outline-variant bg-surface-container-highest px-3 py-1.5 text-xs font-medium text-on-surface-variant transition-colors hover:border-primary/50 hover:text-on-surface disabled:opacity-50"
                    >
                        <Icon name="network_check" size={15} />
                        {tr.test}
                    </button>
                    {pingOk && (
                        <span className="flex items-center gap-1 text-xs text-secondary">
                            <Icon name="check_circle" size={14} filled />
                            {tr.testOk}
                        </span>
                    )}
                    {pingFailed && (
                        <span className="flex items-center gap-1 text-xs text-error">
                            <Icon name="error" size={14} filled />
                            {tr.testFailed}
                        </span>
                    )}
                    {passwordUnknownWhileEditing && pingIdle && (
                        <span className="text-xs text-on-surface-variant">{tr.passwordUnchanged}</span>
                    )}
                </div>

                {schemasLoading && (
                    <p className="flex items-center gap-1.5 text-xs text-on-surface-variant">
                        <span
                            aria-hidden
                            className="h-3 w-3 animate-spin rounded-full border-2 border-t-transparent border-primary"
                        />
                        {tr.searchingSchemas}
                    </p>
                )}

                {availableSchemas && availableSchemas.length > 0 && (
                    <div className={labelClass}>
                        <span className="flex items-center gap-1.5">
                            <Icon name="schema" size={14} />
                            {tr.schemasToScan({selected: selectedSchemas.size, total: availableSchemas.length})}
                        </span>
                        {availableSchemas.length > 4 && (
                            <input
                                value={schemaSearch}
                                onChange={(e) => setSchemaSearch(e.target.value)}
                                placeholder={tr.searchSchema}
                                title={tr.searchSchemaHint}
                                className={`${inputClass} text-xs`}
                            />
                        )}
                        <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded-lg border border-outline-variant bg-surface p-1">
                            {availableSchemas
                                .filter((s) => s.toLowerCase().includes(schemaSearch.trim().toLowerCase()))
                                .map((s) => {
                                    const on = selectedSchemas.has(s)
                                    return (
                                        <button
                                            key={s}
                                            type="button"
                                            onClick={() => toggleSchema(s)}
                                            className={`flex items-center gap-2.5 rounded-md px-2 py-1 text-left text-sm transition-colors ${
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
                        <span className="text-ui-11 text-on-surface-variant">
                            {tr.schemasNote}
                        </span>
                    </div>
                )}

                {error && <p className="text-xs text-error">{error}</p>}
                </div>

                {/* Footer (fijo) */}
                <div className="flex justify-end gap-2 border-t border-outline-variant px-6 py-3">
                    <button
                        type="button"
                        onClick={onClose}
                        title={tr.cancelHint}
                        className="rounded-lg px-3 py-1.5 text-sm text-on-surface-variant hover:text-on-surface"
                    >
                        {t.common.cancel}
                    </button>
                    <button
                        type="submit"
                        disabled={!canSubmit}
                        title={
                            editingId
                                ? tr.saveEditHint
                                : tr.saveNewHint
                        }
                        className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
                    >
                        {editingId ? tr.saveChanges : t.common.save}
                    </button>
                </div>
            </form>

            {showKeyVault && (
                <SshKeyVaultDialog
                    onClose={() => setShowKeyVault(false)}
                    onChanged={() => {
                        // Refresh the picker so a key added (or removed) in the
                        // manager is immediately selectable here.
                        ListSSHKeys()
                            .then(setSshKeys)
                            .catch(() => setSshKeys([]))
                    }}
                />
            )}
        </div>
    )
}
