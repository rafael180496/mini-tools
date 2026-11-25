import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react'
import type {ReactNode} from 'react'
import {createPortal} from 'react-dom'
import Icon from './Icon'
import {useT} from '../i18n'

export interface SelectOption {
    value: string
    label: string
    hint?: string
    icon?: ReactNode
    disabled?: boolean
    tone?: string
    separatorAfter?: boolean
    description?: string
    title?: string
    danger?: boolean
}

interface SelectProps {
    value: string
    options: SelectOption[]
    onChange: (value: string) => void
    placeholder?: string
    disabled?: boolean
    size?: 'sm' | 'md'
    variant?: 'outlined' | 'ghost'
    className?: string
    ariaLabel?: string
    title?: string
    leadingIcon?: string
    menuMinWidth?: number
    menuMaxHeight?: number
    // Buscador integrado en el menú. Por defecto se activa automáticamente
    // cuando la lista tiene 8 o más opciones; se puede forzar con true/false.
    searchable?: boolean
    searchPlaceholder?: string
}

function norm(s: string): string {
    return s
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
}

export default function Select({
    value,
    options,
    onChange,
    placeholder,
    disabled,
    size = 'md',
    variant = 'outlined',
    className,
    ariaLabel,
    title,
    leadingIcon,
    menuMinWidth,
    menuMaxHeight,
    searchable,
    searchPlaceholder,
}: SelectProps) {
    const t = useT()
    const sizeClasses = size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm'
    const variantClasses =
        variant === 'ghost'
            ? 'border border-transparent bg-transparent hover:bg-surface-variant/70'
            : 'border border-outline-variant/80 bg-surface-container hover:border-outline hover:bg-surface-container-high'
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    const [activeIdx, setActiveIdx] = useState(0)
    const [pos, setPos] = useState({top: 0, left: 0, width: 0})
    const btnRef = useRef<HTMLButtonElement>(null)
    const menuRef = useRef<HTMLDivElement>(null)
    const searchRef = useRef<HTMLInputElement>(null)

    const showSearch = searchable ?? options.length >= 8

    const filtered = useMemo(() => {
        const q = norm(query.trim())
        if (!showSearch || !q) return options
        return options.filter((o) => norm(`${o.label} ${o.hint ?? ''} ${o.description ?? ''}`).includes(q))
    }, [options, query, showSearch])

    function place() {
        const r = btnRef.current?.getBoundingClientRect()
        if (!r) return
        const menuH = menuRef.current?.offsetHeight ?? 0
        const menuW = menuRef.current?.offsetWidth ?? 0
        const below = r.bottom + 6
        const top = menuH && below + menuH > window.innerHeight - 8 && r.top - 6 - menuH > 8 ? r.top - 6 - menuH : below
        const left = menuW && r.left + menuW > window.innerWidth - 8 ? Math.max(8, window.innerWidth - 8 - menuW) : r.left
        setPos({top, left, width: r.width})
    }

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

    // Lo que el efecto de apertura necesita leer sin depender de ello: si
    // `options` o `value` estuvieran en sus dependencias, cualquier re-render
    // del padre con el menú abierto (un array de opciones nuevo en cada
    // render, un stream de agente…) vaciaba el buscador mientras se escribía.
    const openStateRef = useRef({options, value})
    openStateRef.current = {options, value}

    // Al abrir (y solo al abrir): buscador vacío, opción actual resaltada y foco en el buscador.
    useEffect(() => {
        if (!open) return
        const {options: opts, value: current} = openStateRef.current
        setQuery('')
        setActiveIdx(Math.max(0, opts.findIndex((o) => o.value === current && !o.disabled)))
        if (showSearch) {
            const id = window.requestAnimationFrame(() => searchRef.current?.focus())
            return () => window.cancelAnimationFrame(id)
        }
    }, [open, showSearch])

    // La opción resaltada con las flechas siempre queda a la vista.
    useEffect(() => {
        if (!open || !showSearch) return
        menuRef.current?.querySelector(`[data-idx="${activeIdx}"]`)?.scrollIntoView({block: 'nearest'})
    }, [open, showSearch, activeIdx])

    useEffect(() => {
        if (!open) return
        // La próxima opción habilitada en la dirección dada (las deshabilitadas
        // no se pueden elegir: no tiene sentido pararse en ellas).
        const step = (from: number, dir: 1 | -1) => {
            const n = filtered.length
            for (let k = 1; k <= n; k++) {
                const i = (((from + dir * k) % n) + n) % n
                if (!filtered[i].disabled) return i
            }
            return from
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault()
                setOpen(false)
                btnRef.current?.focus()
                return
            }
            // Sin buscador la navegación es la del foco nativo (Tab entre
            // botones): las flechas solo mueven el resaltado del buscador.
            if (!showSearch || filtered.length === 0) return
            if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActiveIdx((i) => step(i, 1))
            } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActiveIdx((i) => step(i, -1))
            } else if (e.key === 'Enter') {
                const target = filtered[Math.min(activeIdx, filtered.length - 1)]
                if (target && !target.disabled) {
                    e.preventDefault()
                    onChange(target.value)
                    setOpen(false)
                    btnRef.current?.focus()
                }
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [open, filtered, activeIdx, onChange, showSearch])

    function toggle() {
        if (disabled) return
        place()
        setOpen((v) => !v)
    }

    const current = options.find((o) => o.value === value)
    const label = current?.label ?? placeholder ?? ''
    const safeIdx = Math.min(activeIdx, Math.max(0, filtered.length - 1))

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
                className={`flex items-center gap-2 rounded-lg text-on-surface transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${variantClasses} ${sizeClasses} ${className ?? ''}`}
            >
                {current?.icon ?? (leadingIcon && <Icon name={leadingIcon} size={14} className="shrink-0 text-on-surface-variant" />)}
                <span
                    className={`min-w-0 flex-1 truncate text-left ${
                        current ? (current.danger ? 'text-error' : (current.tone ?? '')) : 'text-on-surface-variant'
                    }`}
                >
                    {label}
                </span>
                <Icon
                    name="expand_more"
                    size={16}
                    className={`shrink-0 text-on-surface-variant transition-transform ${open ? 'rotate-180' : ''}`}
                />
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
                            ref={(el) => {
                                menuRef.current = el
                                if (el && !el.dataset.placed) {
                                    el.dataset.placed = '1'
                                    requestAnimationFrame(place)
                                }
                            }}
                            role="listbox"
                            style={{
                                position: 'fixed',
                                top: pos.top,
                                left: pos.left,
                                minWidth: Math.max(pos.width, menuMinWidth ?? 0),
                            }}
                            onPointerDown={(e) => e.stopPropagation()}
                            className="z-50 flex min-w-52 max-w-[22rem] flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface-container-high text-on-surface shadow-2xl"
                        >
                            {showSearch && (
                                <div className="flex shrink-0 items-center gap-1.5 border-b border-outline-variant/70 bg-surface-container px-2.5 py-1.5">
                                    <Icon name="search" size={14} className="shrink-0 text-on-surface-variant/70" />
                                    <input
                                        ref={searchRef}
                                        type="text"
                                        value={query}
                                        onChange={(e) => {
                                            setQuery(e.target.value)
                                            setActiveIdx(0)
                                        }}
                                        placeholder={searchPlaceholder ?? t.shell.ade.select.searchPlaceholder}
                                        className="min-w-0 flex-1 bg-transparent text-xs text-on-surface outline-none placeholder:text-on-surface-variant/60"
                                    />
                                    {query && (
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setQuery('')
                                                setActiveIdx(0)
                                                searchRef.current?.focus()
                                            }}
                                            title={t.shell.ade.select.clearSearch}
                                            className="shrink-0 rounded text-on-surface-variant hover:text-on-surface"
                                        >
                                            <Icon name="close" size={13} />
                                        </button>
                                    )}
                                </div>
                            )}

                            <div
                                style={{maxHeight: menuMaxHeight ?? 288}}
                                className="overflow-y-auto p-1"
                            >
                                {filtered.length === 0 ? (
                                    <div className="px-2.5 py-4 text-center text-ui-11 text-on-surface-variant">
                                        {t.shell.ade.select.empty}
                                    </div>
                                ) : (
                                    filtered.map((o, idx) => {
                                        const selected = o.value === value
                                        const highlighted = showSearch && idx === safeIdx
                                        const row = (
                                            <button
                                                key={o.value}
                                                type="button"
                                                role="option"
                                                data-idx={idx}
                                                aria-selected={selected}
                                                disabled={o.disabled}
                                                title={o.title}
                                                onMouseEnter={() => setActiveIdx(idx)}
                                                onClick={() => {
                                                    onChange(o.value)
                                                    setOpen(false)
                                                }}
                                                className={`flex w-full items-center gap-2 rounded-lg px-2 text-left text-ui-13 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                                                    o.description ? 'py-1.5' : 'py-1'
                                                } ${
                                                    selected
                                                        ? 'bg-primary/14 font-medium text-primary'
                                                        : highlighted
                                                          ? 'bg-surface-variant/80 text-on-surface'
                                                          : 'hover:bg-surface-variant/70'
                                                }`}
                                            >
                                                {o.icon && (
                                                    <span
                                                        className={`flex h-4 w-4 shrink-0 items-center justify-center ${
                                                            o.description ? 'mt-0.5 self-start' : ''
                                                        }`}
                                                    >
                                                        {o.icon}
                                                    </span>
                                                )}
                                                {o.description ? (
                                                    <span className="min-w-0 flex-1">
                                                        <span className={`block truncate ${o.danger ? 'text-error' : (o.tone ?? '')}`}>
                                                            {o.label}
                                                        </span>
                                                        <span className="block whitespace-normal text-ui-11 leading-snug text-on-surface-variant/75">
                                                            {o.description}
                                                        </span>
                                                    </span>
                                                ) : (
                                                    <span className={`min-w-0 flex-1 truncate ${o.danger ? 'text-error' : (o.tone ?? '')}`}>
                                                        {o.label}
                                                    </span>
                                                )}
                                                {o.hint && (
                                                    <span
                                                        className={`shrink-0 truncate text-ui-11 ${
                                                            selected ? 'text-primary/75' : 'text-on-surface-variant/65'
                                                        }`}
                                                    >
                                                        {o.hint}
                                                    </span>
                                                )}
                                                <Icon name="check" size={14} className={`shrink-0 ${selected ? '' : 'invisible'}`} />
                                            </button>
                                        )
                                        return o.separatorAfter ? (
                                            <div key={o.value}>
                                                {row}
                                                <div className="my-1 border-t border-outline-variant/70" />
                                            </div>
                                        ) : (
                                            row
                                        )
                                    })
                                )}
                            </div>
                        </div>
                    </>,
                    document.body,
                )}
        </>
    )
}
