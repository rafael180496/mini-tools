import {FormEvent, useState} from 'react'
import {SaveConnection, TestConnection} from '../../../wailsjs/go/main/App'
import {main} from '../../../wailsjs/go/models'

interface ConnectionDialogProps {
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

export default function ConnectionDialog({onClose, onSaved}: ConnectionDialogProps) {
    const [name, setName] = useState('')
    const [dbType, setDbType] = useState<DBType>('sqlite')
    const [oracleMode, setOracleMode] = useState<OracleMode>('service_name')
    const [params, setParams] = useState<Record<string, string>>({})
    const [pingStatus, setPingStatus] = useState<'idle' | 'testing' | 'ok' | 'failed'>('idle')
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)

    function setParam(key: string, value: string) {
        setParams((prev) => ({...prev, [key]: value}))
    }

    function changeDbType(next: DBType) {
        setDbType(next)
        setParams({})
        setPingStatus('idle')
    }

    function cfg(): main.ConnectionInput {
        const effectiveParams = dbType === 'oracle' ? {...params, mode: oracleMode} : params
        return new main.ConnectionInput({name, dbType, params: effectiveParams})
    }

    const missing = requiredFields(dbType, oracleMode).filter((f) => !(params[f] ?? '').trim())
    const canSubmit = name.trim() !== '' && missing.length === 0 && !busy

    async function testConnection() {
        setPingStatus('testing')
        setError('')
        try {
            await TestConnection(cfg())
            setPingStatus('ok')
        } catch (err) {
            setPingStatus('failed')
            setError(String(err))
        }
    }

    async function doSave(force: boolean) {
        setBusy(true)
        setError('')
        try {
            await SaveConnection(cfg(), force)
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
        'rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-500'
    const labelClass = 'flex flex-col gap-1 text-xs text-neutral-400'

    return (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60">
            <form
                onSubmit={handleSubmit}
                className="flex max-h-[90vh] w-104 flex-col gap-3 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-900 p-6 text-neutral-100"
            >
                <h2 className="text-lg font-semibold">Nueva conexión</h2>

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
                    Tipo
                    <select
                        value={dbType}
                        onChange={(e) => changeDbType(e.target.value as DBType)}
                        className={inputClass}
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
                        disabled={missing.length > 0 || pingStatus === 'testing'}
                        className="rounded bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700 disabled:opacity-50"
                    >
                        Test Connection
                    </button>
                    {pingStatus === 'ok' && <span className="text-xs text-emerald-400">✓ conexión ok</span>}
                    {pingStatus === 'failed' && <span className="text-xs text-red-400">✗ falló</span>}
                </div>

                {error && <p className="text-xs text-red-400">{error}</p>}

                <div className="mt-2 flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded px-3 py-1.5 text-sm text-neutral-400 hover:text-neutral-200"
                    >
                        Cancelar
                    </button>
                    {pingStatus === 'failed' && (
                        <button
                            type="button"
                            disabled={!canSubmit}
                            onClick={() => void doSave(true)}
                            className="rounded bg-amber-600 px-3 py-1.5 text-sm font-medium text-neutral-950 disabled:opacity-50"
                        >
                            Guardar de todos modos
                        </button>
                    )}
                    <button
                        type="submit"
                        disabled={!canSubmit}
                        className="rounded bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 disabled:opacity-50"
                    >
                        Guardar
                    </button>
                </div>
            </form>
        </div>
    )
}
