import {FormEvent, useState} from 'react'
import Icon from './Icon'

interface PasswordConfirmDialogProps {
    title: string
    description: string
    confirmLabel: string
    onConfirm: (password: string) => Promise<void>
    onClose: () => void
}

// Generic "re-type your master password to confirm this sensitive action"
// modal — used for backup (before writing a file that can leave the
// machine) and restore (before trusting a file that came from somewhere
// else). Self-contained: calls onConfirm and closes itself on success,
// shows the error and stays open on failure (wrong password, etc.) so the
// user can just retry without re-triggering the whole flow from scratch.
export default function PasswordConfirmDialog({title, description, confirmLabel, onConfirm, onClose}: PasswordConfirmDialogProps) {
    const [password, setPassword] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    async function submit(e: FormEvent) {
        e.preventDefault()
        setBusy(true)
        setError('')
        try {
            await onConfirm(password)
            onClose()
        } catch (err) {
            setError(String(err))
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60">
            <form
                onSubmit={submit}
                className="flex w-80 flex-col gap-3 rounded-xl border border-outline-variant bg-surface-container-high p-6 text-on-surface shadow-lg"
            >
                <h2 className="flex items-center gap-2 text-lg font-semibold">
                    <Icon name="lock" size={18} className="text-primary" />
                    {title}
                </h2>
                <p className="text-xs text-on-surface-variant">{description}</p>
                <input
                    type="password"
                    autoFocus
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Clave maestra"
                    className="rounded-lg border border-outline bg-surface px-3 py-2 text-sm text-on-surface outline-none focus:border-primary"
                />
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
                    <button
                        type="submit"
                        disabled={busy || !password}
                        className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
                    >
                        {busy ? 'Verificando…' : confirmLabel}
                    </button>
                </div>
            </form>
        </div>
    )
}
