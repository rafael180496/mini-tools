import {useEffect, useRef, useState, type ReactNode} from 'react'
import {createPortal} from 'react-dom'
import Icon from '../Icon'

export interface DropdownItem {
    label: string
    // hint is the one-line explanation shown to the right, dimmed — the Pull
    // and Push menus lean on it heavily because "--force-with-lease" means
    // nothing to someone who has not hit the failure it prevents.
    hint?: string
    icon?: string
    danger?: boolean
    disabled?: boolean
    onSelect: () => void
    // onContext es la acción secundaria, con clic derecho. La usa el
    // historial de chats para renombrar: es una fila que ya tiene una acción
    // principal obvia (abrirla), y meter un segundo botón por fila para algo
    // que se hace de vez en cuando ensuciaría la lista entera.
    onContext?: () => void
}

// DropdownHeader rotula un grupo dentro del menú. No es seleccionable: existe
// para que dos grupos con filas parecidas —"empezar una conversación" y "las
// de este agente"— se lean como lo que son en vez de como una sola lista
// larga donde hay que deducir qué es cada fila.
export interface DropdownHeader {
    header: string
}

type DropdownEntry = DropdownItem | DropdownHeader | 'separator'

// tidySeparators saca los separadores que no separan nada: los del principio,
// los del final y los repetidos.
//
// Hace falta porque estos menús se arman con spreads de grupos que pueden
// venir vacíos (`...gitFlowItems()` no devuelve nada mientras no se sepa si
// el repositorio usa Git Flow), y entonces dos separadores quedan pegados y
// se dibujan como dos líneas. Se resuelve acá, en el componente que dibuja,
// y no en cada armador de menú: cualquier grupo condicional que se agregue
// después tropieza con lo mismo.
export function tidySeparators<T extends {header?: unknown} | 'separator' | object>(items: (T | 'separator')[]): (T | 'separator')[] {
    const out: (T | 'separator')[] = []
    for (const item of items) {
        if (item === 'separator' && (out.length === 0 || out[out.length - 1] === 'separator')) continue
        out.push(item)
    }
    while (out.length > 0 && out[out.length - 1] === 'separator') out.pop()
    return out
}

interface DropdownMenuProps {
    label: string
    icon?: string
    title: string
    items: DropdownEntry[]
    disabled?: boolean
    width?: number
}

// Portal-anchored dropdown for the Git toolbar's Pull/Push/Fetch command
// menus.
//
// The portal is not optional. Pinning one overflow axis forces the other to
// `auto`, so a position:absolute menu inside a scrollable container gets
// clipped — a bug already hit twice in this codebase (see ExportMenu.tsx and
// EditorTabs.tsx). Rendering into document.body at fixed coordinates measured
// from the trigger sidesteps it entirely.
//
// This is the fifth copy of that pattern in the app (ExportMenu,
// MoveToFolderMenu, RecentFilesMenu, EditorTabs' connection chip). It is
// written generically here so the Git module adds no sixth one-off, but the
// existing four were deliberately left alone — folding them in is a refactor
// of working code that belongs in its own change, not a side effect of adding
// a feature.
export default function DropdownMenu({label, icon, title, items, disabled, width = 260}: DropdownMenuProps) {
    const [open, setOpen] = useState(false)
    const [pos, setPos] = useState<{top: number; left: number} | null>(null)
    const buttonRef = useRef<HTMLButtonElement>(null)

    useEffect(() => {
        if (!open) return
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [open])

    function toggle() {
        if (disabled) return
        if (open) {
            setOpen(false)
            return
        }
        const rect = buttonRef.current?.getBoundingClientRect()
        if (rect) {
            // Clamp to the viewport so a trigger near the right edge does not
            // open a menu that runs off screen.
            const left = Math.min(rect.left, window.innerWidth - width - 8)
            setPos({top: rect.bottom + 4, left: Math.max(8, left)})
        }
        setOpen(true)
    }

    let content: ReactNode = null
    if (open && pos) {
        content = createPortal(
            <>
                <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} onContextMenu={(e) => { e.preventDefault(); setOpen(false) }} />
                <div
                    style={{position: 'fixed', top: pos.top, left: pos.left, width}}
                    className="z-50 rounded-lg border border-outline-variant bg-surface-container-high p-1 shadow-lg"
                >
                    {tidySeparators(items).map((item, i) =>
                        item === 'separator' ? (
                            <div key={`sep-${i}`} className="my-1 border-t border-outline-variant" />
                        ) : 'header' in item ? (
                            <div
                                key={`head-${i}`}
                                className="px-2 pb-0.5 pt-2 text-ui-10 font-semibold uppercase tracking-wide text-on-surface-variant/70"
                            >
                                {item.header}
                            </div>
                        ) : (
                            <button
                                // Por índice y no por label: dos
                                // conversaciones pueden tener el mismo
                                // nombre, y ahí React descarta una de las dos
                                // filas sin decir nada.
                                key={`item-${i}`}
                                disabled={item.disabled}
                                title={item.hint ?? item.label}
                                onClick={() => {
                                    setOpen(false)
                                    item.onSelect()
                                }}
                                onContextMenu={
                                    item.onContext
                                        ? (e) => {
                                              e.preventDefault()
                                              e.stopPropagation()
                                              setOpen(false)
                                              item.onContext?.()
                                          }
                                        : undefined
                                }
                                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs disabled:opacity-40 ${
                                    item.danger
                                        ? 'text-error hover:bg-error-container/40'
                                        : 'text-on-surface hover:bg-surface-variant'
                                }`}
                            >
                                {item.icon && <Icon name={item.icon} size={15} className="shrink-0 opacity-70" />}
                                <span className="shrink-0 font-mono">{item.label}</span>
                                {item.hint && (
                                    <span className="ml-auto truncate text-ui-10 text-on-surface-variant/70">{item.hint}</span>
                                )}
                            </button>
                        ),
                    )}
                </div>
            </>,
            document.body,
        )
    }

    return (
        <>
            <button
                ref={buttonRef}
                onClick={toggle}
                disabled={disabled}
                title={title}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-on-surface hover:bg-surface-variant disabled:opacity-40"
            >
                {icon && <Icon name={icon} size={16} />}
                <span>{label}</span>
                <Icon name="arrow_drop_down" size={16} className="opacity-70" />
            </button>
            {content}
        </>
    )
}
