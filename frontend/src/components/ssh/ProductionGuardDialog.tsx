import {useEffect, useRef} from 'react'
import type {Risk} from '../../lib/productionGuard'
import Icon from '../Icon'

interface ProductionGuardDialogProps {
    commands: {command: string; risks: Risk[]}[]
    onConfirm: () => void
    onCancel: () => void
}

// Shown when something destructive is about to run on a server marked as
// production.
//
// The default action is CANCEL, and it is the focused button: this dialog
// appears at the exact moment someone is moving fast, and a focused
// "Ejecutar" would be dismissed with the Enter key that was already on its
// way down.
export default function ProductionGuardDialog({commands, onConfirm, onCancel}: ProductionGuardDialogProps) {
    const cancelRef = useRef<HTMLButtonElement>(null)

    useEffect(() => {
        cancelRef.current?.focus()
        function onKey(e: KeyboardEvent) {
            if (e.key === 'Escape') {
                e.preventDefault()
                onCancel()
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
            <div className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border-2 border-red-500 bg-surface-container shadow-xl dark:border-red-400">
                <div className="flex shrink-0 items-center gap-2 border-b border-red-500/40 bg-red-50 px-4 py-3 dark:bg-red-950/60">
                    <Icon name="dangerous" size={20} className="text-red-600 dark:text-red-400" />
                    <h2 className="text-sm font-semibold text-red-800 dark:text-red-200">
                        ¿Seguro que querés ejecutar esto en PRODUCCIÓN?
                    </h2>
                </div>

                <div className="min-h-0 flex-1 space-y-3 overflow-auto px-4 py-3">
                    {commands.map((c, i) => (
                        <div key={i}>
                            <pre className="overflow-x-auto rounded bg-surface-container-highest px-3 py-2 font-mono text-xs whitespace-pre-wrap text-on-surface">
                                {c.command}
                            </pre>
                            <ul className="mt-1.5 space-y-1">
                                {c.risks.map((r) => (
                                    <li key={r.label} className="flex gap-2 text-xs text-on-surface-variant">
                                        <Icon name="warning" size={14} className="mt-0.5 shrink-0 text-red-600 dark:text-red-400" />
                                        <span>
                                            <span className="font-medium text-on-surface">{r.label}</span> — {r.detail}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}
                    {commands.length > 1 && (
                        <p className="text-ui-11 text-on-surface-variant">
                            Son {commands.length} comandos: al confirmar se ejecutan todos, uno detrás de otro.
                        </p>
                    )}
                </div>

                <div className="flex shrink-0 items-center gap-2 border-t border-outline-variant px-4 py-3">
                    <button
                        ref={cancelRef}
                        onClick={onCancel}
                        title="No se envía nada al servidor. Si lo habías pegado, no se pega ni una parte."
                        className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:opacity-90"
                    >
                        Cancelar
                    </button>
                    <button
                        onClick={onConfirm}
                        title="Envía el comando tal cual a la terminal de producción."
                        className="rounded border border-red-500 px-3 py-1.5 text-xs text-red-700 hover:bg-red-50 dark:border-red-400 dark:text-red-300 dark:hover:bg-red-950/50"
                    >
                        Ejecutar igual
                    </button>
                    <span className="ml-auto text-ui-11 text-on-surface-variant">Esc cancela</span>
                </div>
            </div>
        </div>
    )
}
