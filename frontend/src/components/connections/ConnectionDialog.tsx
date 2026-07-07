import {FormEvent, useState} from 'react'
import {SaveConnection, TestConnection} from '../../../wailsjs/go/main/App'
import {main} from '../../../wailsjs/go/models'

interface ConnectionDialogProps {
    onClose: () => void
    onSaved: () => void
}

// Only the sqlite fields (a file path) exist for now — Postgres/Oracle
// fields (host/port/user/sslmode, TNS/EasyConnect/SID/Service Name) get
// added to this form in Fase 4.
export default function ConnectionDialog({onClose, onSaved}: ConnectionDialogProps) {
    const [name, setName] = useState('')
    const [path, setPath] = useState('')
    const [pingStatus, setPingStatus] = useState<'idle' | 'testing' | 'ok' | 'failed'>('idle')
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)

    function cfg(): main.ConnectionInput {
        return new main.ConnectionInput({name, dbType: 'sqlite', params: {path}})
    }

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

    const canSubmit = name.trim() !== '' && path.trim() !== '' && !busy

    return (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60">
            <form
                onSubmit={handleSubmit}
                className="flex w-96 flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-6 text-neutral-100"
            >
                <h2 className="text-lg font-semibold">Nueva conexión</h2>

                <label className="flex flex-col gap-1 text-xs text-neutral-400">
                    Nombre
                    <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="mi base local"
                        className="rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-500"
                    />
                </label>

                <label className="flex flex-col gap-1 text-xs text-neutral-400">
                    Tipo
                    <input
                        value="sqlite"
                        disabled
                        className="rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-500"
                    />
                </label>

                <label className="flex flex-col gap-1 text-xs text-neutral-400">
                    Archivo (.db / .sqlite)
                    <input
                        value={path}
                        onChange={(e) => setPath(e.target.value)}
                        placeholder="/ruta/a/archivo.db"
                        className="rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-500"
                    />
                </label>

                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={testConnection}
                        disabled={!name || !path || pingStatus === 'testing'}
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
