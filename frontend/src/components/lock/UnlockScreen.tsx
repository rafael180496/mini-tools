import {FormEvent, useState} from 'react'
import logo from '../../assets/logo.png'
import type {Theme} from '../../hooks/useTheme'
import Icon from '../Icon'

interface UnlockScreenProps {
    isInitialized: boolean
    theme: Theme
    onToggleTheme: () => void
    onInitialize: (password: string) => Promise<void>
    onUnlock: (password: string) => Promise<void>
    onRestore: (password: string) => Promise<void>
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

    // Reuses the same password field above rather than opening a separate
    // prompt — the field's meaning is just "the master password for
    // whichever action you click": Crear vault for a brand-new one, or
    // Restaurar for the one embedded in the backup file you're about to
    // pick. RestoreVaultBackup verifies it against the backup itself
    // (backend/vault/backup.go's VerifyBackupPassword) before touching
    // anything on disk, so a wrong password here just fails cleanly.
    async function restore() {
        setError('')
        if (!password) {
            setError('Escribí la clave maestra del backup arriba antes de restaurar')
            return
        }
        setBusy(true)
        try {
            await onRestore(password)
        } catch (err) {
            setError(String(err))
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="relative flex h-screen w-screen items-center justify-center bg-background font-sans text-on-background">
            <button
                type="button"
                onClick={onToggleTheme}
                title="Cambiar tema"
                className="absolute right-4 top-4 flex items-center gap-1.5 rounded-full border border-outline-variant bg-surface-container px-3 py-1.5 text-xs font-medium text-on-surface-variant hover:bg-surface-container-high"
            >
                <Icon name={theme === 'dark' ? 'light_mode' : 'dark_mode'} size={16} />
                {theme === 'dark' ? 'Claro' : 'Oscuro'}
            </button>
            <form
                onSubmit={submit}
                className="flex w-80 flex-col gap-3 rounded-xl border border-outline-variant bg-surface-container p-6 shadow-lg"
            >
                <img src={logo} alt="mini-tools" className="mx-auto h-16 w-16" />
                <h1 className="text-center text-xl font-bold text-on-surface">
                    {isInitialized ? 'Desbloquear vault' : 'Crear clave maestra'}
                </h1>
                <p className="text-xs text-on-surface-variant">
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
                    className="rounded-lg border border-outline bg-surface px-3 py-2 text-sm text-on-surface outline-none focus:border-primary"
                />
                {!isInitialized && (
                    <input
                        type="password"
                        value={confirm}
                        onChange={(e) => setConfirm(e.target.value)}
                        placeholder="Confirmar clave"
                        className="rounded-lg border border-outline bg-surface px-3 py-2 text-sm text-on-surface outline-none focus:border-primary"
                    />
                )}
                {error && <p className="text-xs text-error">{error}</p>}
                <button
                    type="submit"
                    disabled={busy || !password}
                    title={
                        isInitialized
                            ? 'Descifra tus conexiones guardadas con esta clave maestra'
                            : 'Crea el vault cifrado donde se guardarán tus conexiones — esta clave no se guarda en ningún lado, solo vos la sabés'
                    }
                    className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                    {isInitialized ? 'Desbloquear' : 'Crear vault'}
                </button>
                {!isInitialized && (
                    <button
                        type="button"
                        onClick={() => void restore()}
                        disabled={busy}
                        title="Escribí arriba la clave maestra con la que se generó el backup, después hacé click acá y elegí el archivo .mtbackup — se verifica la clave contra el backup antes de restaurar nada"
                        className="text-xs text-on-surface-variant hover:text-on-surface disabled:opacity-50"
                    >
                        Restaurar desde backup…
                    </button>
                )}
            </form>
        </div>
    )
}
