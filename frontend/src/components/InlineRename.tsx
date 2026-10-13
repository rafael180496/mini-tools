import {useEffect, useRef} from 'react'
import {cleanChatTitle, MAX_CHAT_TITLE} from '../lib/chatTitle'

// Campo para renombrar en el lugar (pestaña, fila de un árbol, cabecera del chat).
//
// Enter y salir del campo guardan; Esc cancela. Un nombre vacío o igual al
// anterior no cambia nada: vuelve al que había. El valor se recorta y se limita
// a MAX_CHAT_TITLE (lib/chatTitle). Los eventos de puntero, clic y teclado no
// suben: el campo vive dentro de una pestaña arrastrable (dnd-kit) y de filas
// que abren o seleccionan al hacer clic, y ninguna debe reaccionar a lo que se
// escribe acá.
export default function InlineRename({
    value,
    ariaLabel,
    title,
    onCommit,
    onCancel,
    className = '',
}: {
    value: string
    ariaLabel: string
    title: string
    onCommit: (title: string) => void
    onCancel: () => void
    className?: string
}) {
    const ref = useRef<HTMLInputElement>(null)
    const done = useRef(false)

    useEffect(() => {
        const el = ref.current
        if (!el) return
        el.focus()
        el.select()
    }, [])

    const finish = (save: boolean) => {
        if (done.current) return
        done.current = true
        const next = save ? cleanChatTitle(ref.current?.value ?? '') : null
        if (next && next !== value) onCommit(next)
        else onCancel()
    }

    return (
        <input
            ref={ref}
            defaultValue={value}
            maxLength={MAX_CHAT_TITLE}
            aria-label={ariaLabel}
            title={title}
            spellCheck={false}
            data-inline-rename
            onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') {
                    e.preventDefault()
                    finish(true)
                } else if (e.key === 'Escape') {
                    e.preventDefault()
                    finish(false)
                }
            }}
            onBlur={() => finish(true)}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            className={`min-w-0 rounded border border-primary bg-surface-container-lowest px-1 text-on-surface outline-none focus:ring-1 focus:ring-primary ${className}`}
        />
    )
}
