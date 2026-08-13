import {FormEvent, useState} from 'react'
import {createPortal} from 'react-dom'
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
// machine), restore (before trusting a file that came from somewhere else) y
// para revelar la contraseña guardada de una conexión. Self-contained: calls
// onConfirm and closes itself on success, shows the error and stays open on
// failure (wrong password, etc.) so the user can just retry without
// re-triggering the whole flow from scratch.
//
// Se dibuja en un portal sobre <body> y no donde lo monta quien lo usa. Es un
// modal a pantalla completa (fixed inset-0), así que anidarlo no aporta nada
// al layout, y sí traía un problema concreto: abierto desde el diálogo de
// conexión quedaba como un <form> dentro de otro <form>, que es HTML inválido
// y deja al botón de confirmar con un dueño ambiguo. El portal lo saca del
// árbol DOM del contenedor; el stopPropagation de submit() se encarga de la
// otra mitad, la del árbol de React.
export default function PasswordConfirmDialog({title, description, confirmLabel, onConfirm, onClose}: PasswordConfirmDialogProps) {
    const [password, setPassword] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    async function submit(e: FormEvent) {
        e.preventDefault()
        // stopPropagation, y no es defensivo por las dudas: este diálogo se
        // abre desde adentro de otros formularios (el de conexión, para "ver
        // la contraseña guardada"). React propaga los eventos por SU árbol, no
        // por el DOM, así que el `submit` de este form llegaba igual al
        // onSubmit del formulario contenedor — que guardaba la conexión y
        // cerraba el diálogo entero apenas apretabas "Mostrar". Bug real.
        e.stopPropagation()
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

    return createPortal(
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60">
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
        </div>,
        document.body,
    )
}
