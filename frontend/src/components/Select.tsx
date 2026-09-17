import {useLayoutEffect, useRef, useState} from 'react'
import type {ReactNode} from 'react'
import {createPortal} from 'react-dom'
import Icon from './Icon'

export interface SelectOption {
    value: string
    label: string
    // Optional secondary line (e.g. an engine name under a connection name).
    hint?: string
    // Optional leading visual, shown both in the menu row and on the trigger
    // once the option is selected. A node rather than an icon name because
    // the callers that need one use real product logos (DbTypeIcon's SVGs),
    // not Material Symbols — a name-based API could not express those.
    icon?: ReactNode
    disabled?: boolean
    // Clases de color para el TEXTO de esta opción, en el disparador y en la
    // fila del menú. Existe para los casos donde el color ES parte del dato y
    // no decoración: los métodos HTTP, que se leen por color en el árbol, en
    // el historial y en la barra de la petición.
    //
    // Va en el <span> del rótulo y no en el botón: una clase propia del
    // elemento le gana al color heredado del padre sin depender del orden en
    // que Tailwind emitió las reglas, que es lo que pasaría si se mezclara con
    // el `text-on-surface` del disparador.
    tone?: string
    // Dibuja una línea debajo de esta opción. Sirve para separar una opción
    // que no es par de las demás —"Sin conexión" no es una conexión más, es
    // desvincular— de la lista real, sin inventar un modelo de grupos que
    // ningún llamador necesita todavía.
    separatorAfter?: boolean
    // Explicación de la opción en un segundo renglón, debajo del nombre. Solo
    // para listas cortas donde elegir mal cuesta —el modo del agente decide
    // si puede tocar archivos—; en una lista de conexiones el `hint` de una
    // línea sigue siendo lo correcto.
    description?: string
    // Opción peligrosa: se pinta en el color de error, en el menú y en el
    // disparador cuando queda elegida.
    danger?: boolean
}

interface SelectProps {
    value: string
    options: SelectOption[]
    onChange: (value: string) => void
    placeholder?: string
    disabled?: boolean
    // 'md' (default) for forms/dialogs, 'sm' for compact toolbar controls.
    size?: 'sm' | 'md'
    // 'outlined' (default) for forms/dialogs, where the box is what tells you
    // it's editable. 'ghost' drops the border/background until hover, for a
    // dense toolbar row where a boxed control reads as heavier than the plain
    // text around it — see Workspace's context row (schema / Mongo database).
    variant?: 'outlined' | 'ghost'
    // Extra classes for the trigger button (width, etc.).
    className?: string
    ariaLabel?: string
    title?: string
    // Ícono de Material Symbols delante del valor en el disparador, para las
    // opciones que no traen su propio `icon`.
    leadingIcon?: string
    // Ancho mínimo del menú en px. Por defecto el del disparador; un disparador
    // compacto con opciones descriptas necesita más que su propio ancho.
    menuMinWidth?: number
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
}: SelectProps) {
    const sizeClasses = size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm'
    const variantClasses =
        variant === 'ghost'
            ? 'border border-transparent bg-transparent hover:bg-surface-variant'
            : 'border border-outline-variant bg-surface hover:border-primary/60'
    const [open, setOpen] = useState(false)
    const [pos, setPos] = useState({top: 0, left: 0, width: 0})
    const btnRef = useRef<HTMLButtonElement>(null)
    const menuRef = useRef<HTMLDivElement>(null)

    // Abajo del disparador si entra; si no, arriba. Un selector al pie de un
    // panel —el modo y el modelo del chat, pegados a la caja de texto— abría
    // su menú fuera de la ventana. También se corre a la izquierda si se pasa
    // del borde derecho.
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
                className={`flex items-center gap-2 rounded-md text-on-surface transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${variantClasses} ${sizeClasses} ${className ?? ''}`}
            >
                {current?.icon ?? (leadingIcon && <Icon name={leadingIcon} size={14} className="shrink-0 text-on-surface-variant" />)}
                <span
                    className={`min-w-0 flex-1 truncate text-left ${
                        current ? (current.danger ? 'text-error' : (current.tone ?? '')) : 'text-on-surface-variant'
                    }`}
                >
                    {label}
                </span>
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
                            ref={(el) => {
                                menuRef.current = el
                                // Primera medición: la posición inicial se calculó
                                // sin conocer el alto del menú.
                                if (el && !el.dataset.placed) {
                                    el.dataset.placed = '1'
                                    requestAnimationFrame(place)
                                }
                            }}
                            role="listbox"
                            style={{position: 'fixed', top: pos.top, left: pos.left, minWidth: Math.max(pos.width, menuMinWidth ?? 0)}}
                            onPointerDown={(e) => e.stopPropagation()}
                            className="z-50 max-h-72 min-w-52 max-w-[22rem] overflow-y-auto rounded-lg border border-outline-variant bg-surface-container-highest p-1 text-on-surface shadow-lg"
                        >
                            {options.map((o) => {
                                const selected = o.value === value
                                const row = (
                                    <button
                                        key={o.value}
                                        type="button"
                                        role="option"
                                        aria-selected={selected}
                                        disabled={o.disabled}
                                        onClick={() => {
                                            onChange(o.value)
                                            setOpen(false)
                                        }}
                                        // Una línea por opción, no dos. La pista
                                        // (el motor de la conexión, el formato de
                                        // un tema) iba abajo del nombre, y eso
                                        // duplicaba el alto de cada fila: una
                                        // lista de ocho conexiones no entraba en
                                        // pantalla y el ojo tenía que saltar dos
                                        // renglones por opción para leer los
                                        // nombres, que es lo único que se está
                                        // buscando. Ahora el nombre manda y la
                                        // pista lo acompaña a la derecha, tenue,
                                        // alineada en su propia columna.
                                        className={`flex w-full items-center gap-2 rounded px-2 text-left text-ui-13 disabled:cursor-not-allowed disabled:opacity-50 ${
                                            o.description ? 'py-1.5' : 'py-1'
                                        } ${selected ? 'bg-primary/12 text-primary' : 'hover:bg-surface-variant'}`}
                                    >
                                        {o.icon && (
                                            <span className={`flex h-4 w-4 shrink-0 items-center justify-center ${o.description ? 'self-start mt-0.5' : ''}`}>
                                                {o.icon}
                                            </span>
                                        )}
                                        {o.description ? (
                                            <span className="min-w-0 flex-1">
                                                <span className={`block truncate ${o.danger ? 'text-error' : (o.tone ?? '')}`}>{o.label}</span>
                                                <span className="block text-ui-11 leading-snug whitespace-normal text-on-surface-variant/70">
                                                    {o.description}
                                                </span>
                                            </span>
                                        ) : (
                                            <span className={`min-w-0 flex-1 truncate ${o.danger ? 'text-error' : (o.tone ?? '')}`}>{o.label}</span>
                                        )}
                                        {o.hint && (
                                            <span className={`shrink-0 truncate text-ui-11 ${selected ? 'text-primary/70' : 'text-on-surface-variant/60'}`}>
                                                {o.hint}
                                            </span>
                                        )}
                                        {/* El check ocupa lugar solo cuando marca
                                            algo: reservarle una columna a la
                                            izquierda de TODAS las filas —como
                                            estaba— corría los nombres 22px hacia
                                            adentro para señalar una sola. */}
                                        <Icon name="check" size={14} className={`shrink-0 ${selected ? '' : 'invisible'}`} />
                                    </button>
                                )
                                return o.separatorAfter ? (
                                    <div key={o.value}>
                                        {row}
                                        <div className="my-1 border-t border-outline-variant" />
                                    </div>
                                ) : (
                                    row
                                )
                            })}
                        </div>
                    </>,
                    document.body,
                )}
        </>
    )
}
