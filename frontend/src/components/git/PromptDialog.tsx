import {useState} from 'react'

interface PromptDialogProps {
    title: string
    label: string
    initial?: string
    placeholder?: string
    confirmLabel?: string
    // Optional second field — used by "create tag", where the name is required
    // and the annotation message is not.
    secondLabel?: string
    secondPlaceholder?: string
    secondInitial?: string
    // Free-form explanation shown above the fields. The tag and branch dialogs
    // use it to say what the operation will and will not touch.
    description?: string
    onSubmit: (value: string, second: string) => void
    onClose: () => void
}

// Themed single/double-field prompt.
//
// Exists for the same reason ConfirmDialog does: window.prompt() inside the
// Wails webview does not read as a dialog and has already been mistaken twice
// for the app hanging (see .claude/rules/conventions.md). Any Git action that
// needs a name — new branch, new tag, rename, remote URL — comes through here.
export default function PromptDialog({
    title,
    label,
    initial = '',
    placeholder,
    confirmLabel = 'Guardar',
    secondLabel,
    secondPlaceholder,
    secondInitial = '',
    description,
    onSubmit,
    onClose,
}: PromptDialogProps) {
    const [value, setValue] = useState(initial)
    const [second, setSecond] = useState(secondInitial)

    function submit() {
        if (!value.trim()) return
        onSubmit(value.trim(), second.trim())
        onClose()
    }

    return (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60">
            <div className="w-96 rounded-xl border border-outline-variant bg-surface-container-high p-6 shadow-lg">
                <h2 className="text-sm font-medium text-on-surface">{title}</h2>
                {description && <p className="mt-2 text-[11px] leading-relaxed text-on-surface-variant">{description}</p>}

                <label className="mt-3 block text-[11px] text-on-surface-variant">{label}</label>
                <input
                    value={value}
                    autoFocus
                    placeholder={placeholder}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => {
                        // Enter only submits from the single-field form; with a
                        // second field it would submit while the user is still
                        // tabbing toward it.
                        if (e.key === 'Enter' && !secondLabel) submit()
                        if (e.key === 'Escape') onClose()
                    }}
                    className="mt-1 w-full rounded border-none bg-surface-container-highest px-2 py-1.5 text-xs text-on-surface outline-none placeholder:text-on-surface-variant/50 focus:ring-1 focus:ring-primary"
                />

                {secondLabel && (
                    <>
                        <label className="mt-3 block text-[11px] text-on-surface-variant">{secondLabel}</label>
                        <textarea
                            value={second}
                            rows={3}
                            placeholder={secondPlaceholder}
                            onChange={(e) => setSecond(e.target.value)}
                            onKeyDown={(e) => e.key === 'Escape' && onClose()}
                            className="mt-1 w-full resize-none rounded border-none bg-surface-container-highest px-2 py-1.5 text-xs text-on-surface outline-none placeholder:text-on-surface-variant/50 focus:ring-1 focus:ring-primary"
                        />
                    </>
                )}

                <div className="mt-4 flex justify-end gap-2">
                    <button onClick={onClose} title="Cerrar sin aplicar ningún cambio" className="rounded px-3 py-1.5 text-xs text-on-surface-variant hover:bg-surface-variant">
                        Cancelar
                    </button>
                    <button
                        onClick={submit}
                        disabled={!value.trim()}
                        title={value.trim() ? confirmLabel : 'Completá el campo requerido primero'}
                        className="rounded bg-primary px-3 py-1.5 text-xs text-on-primary hover:opacity-90 disabled:opacity-40"
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    )
}
