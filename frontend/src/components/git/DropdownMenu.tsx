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
}

interface DropdownMenuProps {
    label: string
    icon?: string
    title: string
    items: (DropdownItem | 'separator')[]
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
                    {items.map((item, i) =>
                        item === 'separator' ? (
                            <div key={`sep-${i}`} className="my-1 border-t border-outline-variant" />
                        ) : (
                            <button
                                key={item.label}
                                disabled={item.disabled}
                                title={item.hint ?? item.label}
                                onClick={() => {
                                    setOpen(false)
                                    item.onSelect()
                                }}
                                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs disabled:opacity-40 ${
                                    item.danger
                                        ? 'text-error hover:bg-error-container/40'
                                        : 'text-on-surface hover:bg-surface-variant'
                                }`}
                            >
                                {item.icon && <Icon name={item.icon} size={15} className="shrink-0 opacity-70" />}
                                <span className="shrink-0 font-mono">{item.label}</span>
                                {item.hint && (
                                    <span className="ml-auto truncate text-[10px] text-on-surface-variant/70">{item.hint}</span>
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
