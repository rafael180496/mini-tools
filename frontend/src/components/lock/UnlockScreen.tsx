import {FormEvent, useState} from 'react'
import logo from '../../assets/logo.png'

interface UnlockScreenProps {
    isInitialized: boolean
    onInitialize: (password: string) => Promise<void>
    onUnlock: (password: string) => Promise<void>
    onRestore: () => Promise<void>
}

export default function UnlockScreen({isInitialized, onInitialize, onUnlock, onRestore}: UnlockScreenProps) {
    const [password, setPassword] = useState('')
    const [confirm, setConfirm] = useState('')
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)

    async function submit(e: FormEvent) {
        e.preventDefault()
        setError('')

        if (!isInitialized && password !== confirm) {
            setError('Las contraseñas no coinciden')
            return
        }

        setBusy(true)
        try {
            if (isInitialized) {
                await onUnlock(password)
            } else {
                await onInitialize(password)
            }
        } catch (err) {
            setError(isInitialized ? 'Clave maestra incorrecta' : String(err))
        } finally {
            setBusy(false)
        }
    }

    async function restore() {
        setError('')
        setBusy(true)
        try {
            await onRestore()
        } catch (err) {
            setError(String(err))
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="flex h-screen w-screen items-center justify-center bg-neutral-950 text-neutral-100">
            <form onSubmit={submit} className="flex w-72 flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-6">
                <img src={logo} alt="mini-tools" className="mx-auto h-16 w-16" />
                <h1 className="text-center text-lg font-semibold">
                    {isInitialized ? 'Desbloquear vault' : 'Crear clave maestra'}
                </h1>
                <p className="text-xs text-neutral-400">
                    {isInitialized
                        ? 'Ingresa tu clave maestra para acceder a tus conexiones.'
                        : 'Esta clave cifra tus conexiones guardadas. Si la pierdes, pierdes el vault — no hay recuperación.'}
                </p>
                <input
                    type="password"
                    autoFocus
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Clave maestra"
                    className="rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-500"
                />
                {!isInitialized && (
                    <input
                        type="password"
                        value={confirm}
                        onChange={(e) => setConfirm(e.target.value)}
                        placeholder="Confirmar clave"
                        className="rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-500"
                    />
                )}
                {error && <p className="text-xs text-red-400">{error}</p>}
                <button
                    type="submit"
                    disabled={busy || !password}
                    className="rounded bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 disabled:opacity-50"
                >
                    {isInitialized ? 'Desbloquear' : 'Crear vault'}
                </button>
                {!isInitialized && (
                    <button
                        type="button"
                        onClick={() => void restore()}
                        disabled={busy}
                        className="text-xs text-neutral-500 hover:text-neutral-300 disabled:opacity-50"
                    >
                        Restaurar desde backup…
                    </button>
                )}
            </form>
        </div>
    )
}
