import {FormEvent, useState} from 'react'
import {PickVaultBackupFileFirstRun} from '../../../wailsjs/go/main/App'
import logo from '../../assets/logo.png'
import type {Theme} from '../../hooks/useTheme'
import Icon from '../Icon'

interface UnlockScreenProps {
    isInitialized: boolean
    theme: Theme
    onToggleTheme: () => void
    onInitialize: (password: string) => Promise<void>
    onUnlock: (password: string) => Promise<void>
    // Restores the already-picked backup file with ITS own master password.
    // The file is chosen first (PickVaultBackupFileFirstRun, in-component),
    // then this is called — see startRestore.
    onRestore: (path: string, backupPassword: string) => Promise<void>
}

// No Node `path` module in the browser context — same manual split-by-
// separator convention as RestoreVaultDialog.tsx.
function fileName(path: string) {
    return path.split(/[/\\]/).pop() ?? path
}

export default function UnlockScreen({isInitialized, theme, onToggleTheme, onInitialize, onUnlock, onRestore}: UnlockScreenProps) {
    const [password, setPassword] = useState('')
    const [confirm, setConfirm] = useState('')
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    // Restore-from-backup on first run: null = normal create view; a string =
    // a backup file was picked and we're now asking for THAT file's own master
    // password (step 2). The top "Clave maestra" field is only ever for
    // creating a NEW vault, never for restore — restore never touches it.
    const [restorePath, setRestorePath] = useState<string | null>(null)
    const [backupPassword, setBackupPassword] = useState('')

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

    // Step 1: open the file picker straight away. On first run there is no
    // existing vault to authorize against, so nothing is asked BEFORE the
    // picker — only once a file is chosen do we ask for that file's own master
    // password (step 2, submitRestore). Works whether or not the create field
    // above has anything typed in it; that field is for a new vault, not this.
    async function startRestore() {
        setError('')
        setBusy(true)
        try {
            const path = await PickVaultBackupFileFirstRun()
            if (path) {
                setRestorePath(path)
                setBackupPassword('')
            }
            // path === "" means the user cancelled the native picker — stay on
            // the create view with no error, same convention as BackupVault.
        } catch (err) {
            setError(String(err))
        } finally {
            setBusy(false)
        }
    }

    async function submitRestore(e: FormEvent) {
        e.preventDefault()
        if (!restorePath) return
        setError('')
        setBusy(true)
        try {
            await onRestore(restorePath, backupPassword)
            // Restore succeeded: the vault is now initialized with the backup's
            // password. Leave the restore view so the screen falls through to
            // "Desbloquear" (isInitialized is now true) instead of staying on a
            // form whose next submit would hit "ya existe un vault inicializado"
            // — that stale-form re-submit was the reported false-positive error.
            setRestorePath(null)
            setBackupPassword('')
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

            {restorePath !== null ? (
                <form
                    onSubmit={submitRestore}
                    className="flex w-80 flex-col gap-3 rounded-xl border border-outline-variant bg-surface-container p-6 shadow-lg"
                >
                    <img src={logo} alt="mini-tools" className="mx-auto h-16 w-16" />
                    <h1 className="text-center text-xl font-bold text-on-surface">Restaurar desde backup</h1>
                    <div className="flex items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-highest px-3 py-2 text-xs text-on-surface-variant">
                        <Icon name="description" size={16} className="shrink-0" />
                        <span className="min-w-0 flex-1 truncate" title={restorePath}>
                            {fileName(restorePath)}
                        </span>
                        <button
                            type="button"
                            onClick={() => void startRestore()}
                            disabled={busy}
                            title="Elegir un archivo de backup distinto"
                            className="shrink-0 text-primary hover:underline disabled:opacity-50"
                        >
                            Cambiar
                        </button>
                    </div>
                    <p className="text-xs text-on-surface-variant">
                        Ingresá la clave maestra con la que se generó este backup — casi seguro distinta de cualquier otra.
                    </p>
                    <input
                        type="password"
                        autoFocus
                        value={backupPassword}
                        onChange={(e) => setBackupPassword(e.target.value)}
                        placeholder="Clave del backup"
                        className="rounded-lg border border-outline bg-surface px-3 py-2 text-sm text-on-surface outline-none focus:border-primary"
                    />
                    {error && <p className="text-xs text-error">{error}</p>}
                    <button
                        type="submit"
                        disabled={busy || !backupPassword}
                        title="Verifica la clave contra el backup y restaura el vault"
                        className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                        {busy ? 'Restaurando…' : 'Restaurar'}
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            setRestorePath(null)
                            setError('')
                        }}
                        disabled={busy}
                        className="text-xs text-on-surface-variant hover:text-on-surface disabled:opacity-50"
                    >
                        Cancelar
                    </button>
                </form>
            ) : (
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
                            onClick={() => void startRestore()}
                            disabled={busy}
                            title="Elegí el archivo .mtbackup; después te pedimos la clave con la que se generó ese backup"
                            className="text-xs text-on-surface-variant hover:text-on-surface disabled:opacity-50"
                        >
                            Restaurar desde backup…
                        </button>
                    )}
                </form>
            )}
        </div>
    )
}
