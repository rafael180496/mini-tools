import Icon from './Icon'

interface ConfirmDialogProps {
    title: string
    description: string
    confirmLabel: string
    danger?: boolean
    onConfirm: () => void
    onClose: () => void
}

// Generic in-app yes/no modal, themed like PasswordConfirmDialog. Exists
// because window.confirm() inside the Wails webview isn't obviously a
// dialog to the user — the same failure mode already documented for the
// SELECT * linter warning (a native confirm() got mistaken for "the app
// isn't responding"). Any destructive click-to-confirm action should use
// this instead of window.confirm().
export default function ConfirmDialog({title, description, confirmLabel, danger, onConfirm, onClose}: ConfirmDialogProps) {
    return (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60">
            <div className="flex w-80 flex-col gap-3 rounded-xl border border-outline-variant bg-surface-container-high p-6 text-on-surface shadow-lg">
                <h2 className="flex items-center gap-2 text-lg font-semibold">
                    <Icon name={danger ? 'warning' : 'help'} size={18} className={danger ? 'text-error' : 'text-primary'} />
                    {title}
                </h2>
                <p className="text-xs text-on-surface-variant">{description}</p>
                <div className="mt-2 flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        title="Cierra sin hacer nada"
                        className="rounded-lg px-3 py-1.5 text-sm text-on-surface-variant hover:text-on-surface"
                    >
                        Cancelar
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            onConfirm()
                            onClose()
                        }}
                        title={confirmLabel}
                        className={`rounded-lg px-3 py-1.5 text-sm font-medium hover:opacity-90 ${
                            danger ? 'bg-error-container text-on-error-container' : 'bg-primary text-on-primary'
                        }`}
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    )
}
