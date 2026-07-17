import {useLayoutEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import Icon from './Icon'

export interface SelectOption {
    value: string
    label: string
    // Optional secondary line (e.g. an engine name under a connection name).
    hint?: string
    disabled?: boolean
}

interface SelectProps {
    value: string
    options: SelectOption[]
    onChange: (value: string) => void
    placeholder?: string
    disabled?: boolean
    // 'md' (default) for forms/dialogs, 'sm' for compact toolbar controls.
    size?: 'sm' | 'md'
    // Extra classes for the trigger button (width, etc.).
    className?: string
    ariaLabel?: string
    title?: string
}

// Themed dropdown replacing the native <select> everywhere in the app — the
// native control never respects the app's dark/light theme and looks foreign.
// The menu is rendered in a portal to document.body positioned over the
// trigger, so it is never clipped by a parent's overflow (modals, scroll
// panes) and works even when the trigger lives inside another portal or a
// dnd-kit draggable. onPointerDown stopPropagation on the portal is REQUIRED
// for the latter: React portals bubble events via the React tree, so without
// it a pointerdown here would reach an ancestor draggable and start a drag
// (see the EditorTabs tab-chip bug). Keyboard: Escape closes.
export default function Select({value, options, onChange, placeholder, disabled, size = 'md', className, ariaLabel, title}: SelectProps) {
    const sizeClasses = size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm'
    const [open, setOpen] = useState(false)
    const [pos, setPos] = useState({top: 0, left: 0, width: 0})
    const btnRef = useRef<HTMLButtonElement>(null)

    function place() {
        const r = btnRef.current?.getBoundingClientRect()
        if (r) setPos({top: r.bottom + 6, left: r.left, width: r.width})
    }

    // Keep the menu glued to the trigger if the layout shifts while it's open.
    useLayoutEffect(() => {
        if (!open) return
        place()
        function onScrollOrResize() {
            place()
        }
        window.addEventListener('resize', onScrollOrResize)
        window.addEventListener('scroll', onScrollOrResize, true)
        return () => {
            window.removeEventListener('resize', onScrollOrResize)
            window.removeEventListener('scroll', onScrollOrResize, true)
        }
    }, [open])

    function toggle() {
        if (disabled) return
        place()
        setOpen((v) => !v)
    }

    const current = options.find((o) => o.value === value)
    const label = current?.label ?? placeholder ?? ''

    return (
        <>
            <button
                ref={btnRef}
                type="button"
                onClick={toggle}
                disabled={disabled}
                aria-label={ariaLabel}
                title={title}
                aria-haspopup="listbox"
                aria-expanded={open}
                className={`flex items-center gap-2 rounded-md border border-outline-variant bg-surface text-on-surface transition-colors hover:border-primary/60 disabled:cursor-not-allowed disabled:opacity-50 ${sizeClasses} ${className ?? ''}`}
            >
                <span className={`min-w-0 flex-1 truncate text-left ${current ? '' : 'text-on-surface-variant'}`}>{label}</span>
                <Icon name="expand_more" size={18} className={`shrink-0 text-on-surface-variant transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
            {open &&
                createPortal(
                    <>
                        <div
                            className="fixed inset-0 z-50"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => setOpen(false)}
                            onContextMenu={(e) => {
                                e.preventDefault()
                                setOpen(false)
                            }}
                        />
                        <div
                            role="listbox"
                            style={{position: 'fixed', top: pos.top, left: pos.left, minWidth: pos.width}}
                            onPointerDown={(e) => e.stopPropagation()}
                            className="z-50 max-h-72 min-w-44 overflow-y-auto rounded-lg border border-outline-variant bg-surface-container-highest p-1 text-on-surface shadow-lg"
                        >
                            {options.map((o) => (
                                <button
                                    key={o.value}
                                    type="button"
                                    role="option"
                                    aria-selected={o.value === value}
                                    disabled={o.disabled}
                                    onClick={() => {
                                        onChange(o.value)
                                        setOpen(false)
                                    }}
                                    className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50 ${
                                        o.value === value ? 'bg-primary/15 text-primary' : 'hover:bg-surface-variant'
                                    }`}
                                >
                                    <Icon name="check" size={16} className={`shrink-0 ${o.value === value ? '' : 'invisible'}`} />
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate">{o.label}</span>
                                        {o.hint && <span className="block truncate text-xs text-on-surface-variant">{o.hint}</span>}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </>,
                    document.body,
                )}
        </>
    )
}
