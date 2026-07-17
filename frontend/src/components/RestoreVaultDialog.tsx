import {FormEvent, useState} from 'react'
import {PickVaultBackupFile, RestoreVaultBackupFromFile} from '../../wailsjs/go/main/App'
import Icon from './Icon'

interface RestoreVaultDialogProps {
    onRestored: () => void
    onClose: () => void
}

// No Node `path` module in the Vite/browser context — same manual split-by-
// separator convention as Workspace.tsx's fileTitle()/dirName().
function fileName(path: string) {
    return path.split(/[/\\]/).pop() ?? path
}

// Two steps, not one form — see app.go's PickVaultBackupFile doc comment for
// why: asking for "the backup's password" before the user has even chosen
// WHICH backup file it's for is backwards. Step 1 confirms the current
// vault's master password and opens the file picker; only once a file is
// actually chosen does step 2 ask for THAT file's own password (shown next
// to its name), and a wrong guess there retries against the same already-
// picked file instead of reopening the picker.
type Step = {kind: 'current'} | {kind: 'backup'; path: string; currentPassword: string}

export default function RestoreVaultDialog({onRestored, onClose}: RestoreVaultDialogProps) {
    const [step, setStep] = useState<Step>({kind: 'current'})
    const [currentPassword, setCurrentPassword] = useState('')
    const [backupPassword, setBackupPassword] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    async function pickFile(e: FormEvent) {
        e.preventDefault()
        setBusy(true)
        setError('')
        try {
            const path = await PickVaultBackupFile(currentPassword)
            if (path) {
                setStep({kind: 'backup', path, currentPassword})
                setBackupPassword('')
            }
            // path === "" means the user cancelled the native file picker —
            // stay on step "current" with no error, same as any other
            // cancelled-dialog convention in this app (e.g. BackupVault).
        } catch (err) {
            setError(String(err))
        } finally {
            setBusy(false)
        }
    }

    async function restoreFromPicked(e: FormEvent) {
        e.preventDefault()
        if (step.kind !== 'backup') return
        setBusy(true)
        setError('')
        try {
            await RestoreVaultBackupFromFile(step.path, backupPassword)
            onRestored()
            onClose()
        } catch (err) {
            setError(String(err))
        } finally {
            setBusy(false)
        }
    }

    // Re-picks a different file without re-typing the current password
    // (already verified, still valid — nothing destructive has happened
    // yet at this point).
    async function pickDifferentFile() {
        setBusy(true)
        setError('')
        try {
            const path = await PickVaultBackupFile(currentPassword)
            if (path) {
                setStep({kind: 'backup', path, currentPassword})
                setBackupPassword('')
            }
        } catch (err) {
            setError(String(err))
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60">
            <form
                onSubmit={step.kind === 'current' ? pickFile : restoreFromPicked}
                className="flex w-96 flex-col gap-3 rounded-xl border border-outline-variant bg-surface-container-high p-6 text-on-surface shadow-lg"
            >
                <h2 className="flex items-center gap-2 text-lg font-semibold">
                    <Icon name="restore" size={18} className="text-error" />
                    Restaurar backup
                </h2>
                <p className="flex items-start gap-2 rounded-lg bg-error-container p-2 text-xs text-on-error-container">
                    <Icon name="warning" size={16} className="mt-0.5 shrink-0" filled />
                    Esto reemplaza TODO lo que hay ahora en el vault (conexiones, snippets, historial) con el contenido del
                    backup elegido — no se puede deshacer. Después de restaurar, la app te va a pedir desbloquear de nuevo
                    con la clave que tenía el vault cuando se hizo ESE backup.
                </p>

                {step.kind === 'current' ? (
                    <label className="flex flex-col gap-1 text-xs text-on-surface-variant">
                        Clave maestra actual (confirma que podés hacer esto)
                        <input
                            type="password"
                            autoFocus
                            value={currentPassword}
                            onChange={(e) => setCurrentPassword(e.target.value)}
                            placeholder="Clave maestra actual"
                            className="rounded-lg border border-outline bg-surface px-3 py-2 text-sm text-on-surface outline-none focus:border-primary"
                        />
                    </label>
                ) : (
                    <>
                        <div className="flex items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-highest px-3 py-2 text-xs text-on-surface-variant">
                            <Icon name="description" size={16} className="shrink-0" />
                            <span className="min-w-0 flex-1 truncate" title={step.path}>
                                {fileName(step.path)}
                            </span>
                            <button
                                type="button"
                                onClick={() => void pickDifferentFile()}
                                disabled={busy}
                                title="Elegir un archivo de backup distinto"
                                className="shrink-0 text-primary hover:underline disabled:opacity-50"
                            >
                                Cambiar
                            </button>
                        </div>
                        <label className="flex flex-col gap-1 text-xs text-on-surface-variant">
                            Clave con la que se hizo este backup
                            <input
                                type="password"
                                autoFocus
                                value={backupPassword}
                                onChange={(e) => setBackupPassword(e.target.value)}
                                placeholder="Clave original de este backup"
                                title="La clave maestra que estaba vigente cuando se generó ESTE archivo — casi seguro distinta de la actual"
                                className="rounded-lg border border-outline bg-surface px-3 py-2 text-sm text-on-surface outline-none focus:border-primary"
                            />
                        </label>
                    </>
                )}

                {error && <p className="text-xs text-error">{error}</p>}

                <div className="mt-2 flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={busy}
                        title="Cierra sin hacer nada"
                        className="rounded-lg px-3 py-1.5 text-sm text-on-surface-variant hover:text-on-surface disabled:opacity-50"
                    >
                        Cancelar
                    </button>
                    {step.kind === 'current' ? (
                        <button
                            type="submit"
                            disabled={busy || !currentPassword}
                            title="Confirma tu clave actual y abre el selector de archivo .mtbackup"
                            className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
                        >
                            {busy ? 'Verificando…' : 'Elegir archivo…'}
                        </button>
                    ) : (
                        <button
                            type="submit"
                            disabled={busy || !backupPassword}
                            title="Reemplaza el vault actual con el contenido de este backup"
                            className="rounded-lg bg-error-container px-3 py-1.5 text-sm font-medium text-on-error-container hover:opacity-90 disabled:opacity-50"
                        >
                            {busy ? 'Restaurando…' : 'Restaurar'}
                        </button>
                    )}
                </div>
            </form>
        </div>
    )
}
