import {FormEvent, useState} from 'react'
import logo from '../../assets/logo.png'
import type {Theme} from '../../hooks/useTheme'

interface UnlockScreenProps {
    isInitialized: boolean
    theme: Theme
    onToggleTheme: () => void
    onInitialize: (password: string) => Promise<void>
    onUnlock: (password: string) => Promise<void>
    onRestore: () => Promise<void>
}

export default function UnlockScreen({isInitialized, theme, onToggleTheme, onInitialize, onUnlock, onRestore}: UnlockScreenProps) {
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
        <div className="relative flex h-screen w-screen items-center justify-center bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100">
            <button
                type="button"
                onClick={onToggleTheme}
                title="Cambiar tema"
                className="absolute right-4 top-4 rounded border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900 px-2 py-1 text-xs hover:bg-neutral-200 dark:hover:bg-neutral-800"
            >
                {theme === 'dark' ? '☀ Claro' : '🌙 Oscuro'}
            </button>
            <form onSubmit={submit} className="flex w-72 flex-col gap-3 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900 p-6">
                <img src={logo} alt="mini-tools" className="mx-auto h-16 w-16" />
                <h1 className="text-center text-lg font-semibold">
                    {isInitialized ? 'Desbloquear vault' : 'Crear clave maestra'}
                </h1>
                <p className="text-xs text-neutral-600 dark:text-neutral-400">
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
                    className="rounded border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-500"
                />
                {!isInitialized && (
                    <input
                        type="password"
                        value={confirm}
                        onChange={(e) => setConfirm(e.target.value)}
                        placeholder="Confirmar clave"
                        className="rounded border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-500"
                    />
                )}
                {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
                <button
                    type="submit"
                    disabled={busy || !password}
                    title={
                        isInitialized
                            ? 'Descifra tus conexiones guardadas con esta clave maestra'
                            : 'Crea el vault cifrado donde se guardarán tus conexiones — esta clave no se guarda en ningún lado, solo vos la sabés'
                    }
                    className="rounded bg-neutral-900 dark:bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-100 dark:text-neutral-900 disabled:opacity-50"
                >
                    {isInitialized ? 'Desbloquear' : 'Crear vault'}
                </button>
                {!isInitialized && (
                    <button
                        type="button"
                        onClick={() => void restore()}
                        disabled={busy}
                        title="Reemplaza el vault actual con un archivo de backup que hayas generado antes (botón Backup vault en la app)"
                        className="text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 disabled:opacity-50"
                    >
                        Restaurar desde backup…
                    </button>
                )}
            </form>
        </div>
    )
}
