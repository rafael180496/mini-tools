import {useEffect, useRef, useState} from 'react'
import {ChangeSSHPassword} from '../../../wailsjs/go/main/App'
import Icon from '../Icon'

interface SshPasswordChangeDialogProps {
    connId: string
    // Nombre visible del servidor: lo que se cambia es la contraseña de una
    // cuenta en UNA máquina, y con varias terminales abiertas el diálogo tiene
    // que decir en cuál, no confiar en que se acuerden de qué pestaña salió.
    connName: string
    // Lo que el servidor dijo al pedir el cambio ("You are required to change
    // your password immediately", "Your password has expired"). Puede venir
    // vacío: no todos lo explican.
    reason: string
    onDone: () => void
    onCancel: () => void
}

// Se abre cuando el servidor rechaza la contraseña guardada porque está
// vencida y pide una nueva.
//
// La contraseña se pide DOS VECES a propósito, aunque ninguna otra pantalla de
// la app lo haga. Equivocarse al escribir una contraseña de login no cuesta
// nada —se reintenta—, pero acá lo que se teclea pasa a ser la contraseña real
// de la cuenta en el servidor: un dedazo no se rechaza, se guarda, y deja
// afuera de la máquina a quien lo cometió.
export default function SshPasswordChangeDialog({
    connId,
    connName,
    reason,
    onDone,
    onCancel,
}: SshPasswordChangeDialogProps) {
    const [password, setPassword] = useState('')
    const [confirm, setConfirm] = useState('')
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const firstRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        firstRef.current?.focus()
    }, [])

    const mismatch = confirm !== '' && password !== confirm
    const ready = password !== '' && password === confirm && !busy

    function submit() {
        if (!ready) return
        setBusy(true)
        setError('')
        ChangeSSHPassword(connId, password)
            .then(onDone)
            .catch((err) => {
                // El texto del servidor es lo único que dice POR QUÉ no la
                // aceptó ("it is too short", "it is based on a dictionary
                // word"), así que se muestra entero en vez de resumirlo en un
                // "no se pudo" que obliga a adivinar.
                setError(String(err))
                setBusy(false)
            })
    }

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            onKeyDown={(e) => {
                if (e.key === 'Escape') {
                    e.preventDefault()
                    onCancel()
                }
            }}
        >
            <div className="flex w-full max-w-md flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface-container shadow-xl">
                <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-4 py-3">
                    <Icon name="key" size={20} className="text-primary" />
                    <h2 className="text-sm font-semibold text-on-surface">
                        La contraseña de {connName} está vencida
                    </h2>
                </div>

                <div className="space-y-3 px-4 py-3">
                    <p className="text-xs text-on-surface-variant">
                        El servidor no deja entrar hasta cambiarla. Se cambia ahí y, si la acepta, se
                        guarda en el vault para que la próxima conexión use la nueva.
                    </p>
                    {reason !== '' && (
                        <p className="rounded bg-surface-container-highest px-3 py-2 font-mono text-ui-11 whitespace-pre-wrap text-on-surface-variant">
                            {reason}
                        </p>
                    )}

                    <label className="block">
                        <span className="text-ui-11 text-on-surface-variant">Contraseña nueva</span>
                        <input
                            ref={firstRef}
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && submit()}
                            title="La contraseña nueva de la cuenta en el servidor. Tiene que cumplir las reglas del servidor (largo mínimo, complejidad); si no, la rechaza y el motivo aparece abajo."
                            className="mt-1 w-full rounded border border-outline-variant bg-surface px-2 py-1.5 text-xs text-on-surface outline-none focus:border-primary"
                        />
                    </label>

                    <label className="block">
                        <span className="text-ui-11 text-on-surface-variant">Repetila</span>
                        <input
                            type="password"
                            value={confirm}
                            onChange={(e) => setConfirm(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && submit()}
                            title="La misma contraseña otra vez. Se pide dos veces porque un error de tecleo acá no se rechaza: queda como la contraseña real de la cuenta y te deja afuera del servidor."
                            className={`mt-1 w-full rounded border bg-surface px-2 py-1.5 text-xs text-on-surface outline-none focus:border-primary ${
                                mismatch ? 'border-red-500 dark:border-red-400' : 'border-outline-variant'
                            }`}
                        />
                    </label>

                    {mismatch && (
                        <p className="text-ui-11 text-red-600 dark:text-red-400">Las dos no coinciden.</p>
                    )}
                    {error !== '' && (
                        <p className="rounded bg-red-50 px-3 py-2 text-ui-11 whitespace-pre-wrap text-red-700 dark:bg-red-950/50 dark:text-red-300">
                            {error}
                        </p>
                    )}
                </div>

                <div className="flex shrink-0 items-center gap-2 border-t border-outline-variant px-4 py-3">
                    <button
                        onClick={submit}
                        disabled={!ready}
                        title={
                            ready
                                ? 'Corre el diálogo de cambio contra el servidor y, si la acepta, guarda la contraseña nueva en el vault y reabre la terminal.'
                                : 'Escribí la contraseña nueva dos veces, iguales, para poder cambiarla.'
                        }
                        className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-40"
                    >
                        {busy ? 'Cambiando…' : 'Cambiar y conectar'}
                    </button>
                    <button
                        onClick={onCancel}
                        disabled={busy}
                        title="Cierra el diálogo sin tocar nada. La contraseña del servidor sigue vencida y la terminal sigue sin conectar."
                        className="rounded border border-outline-variant px-3 py-1.5 text-xs text-on-surface-variant hover:bg-surface-variant disabled:opacity-40"
                    >
                        Cancelar
                    </button>
                    <span className="ml-auto text-ui-11 text-on-surface-variant">Esc cancela</span>
                </div>
            </div>
        </div>
    )
}
