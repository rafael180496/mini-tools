import type {MouseEvent as ReactMouseEvent, ReactNode} from 'react'
import Icon from '../Icon'

// Fila de los árboles de la barra lateral, con la forma de un explorador tipo
// Obsidian: guías verticales por nivel, chevron solo donde hay algo que
// desplegar, ícono del tipo de elemento y el nombre.
//
// Las guías las dibuja cada fila para su propia altura (una línea por nivel de
// profundidad), en vez de un borde en el contenedor de los hijos: así valen
// igual para una carpeta con subcarpetas que para las notas que cuelgan de
// otra por enlaces, que son filas planas y no tienen contenedor propio.

export const TREE_INDENT = 14
const CHEVRON = 14
const PAD = 4
// Dónde cae la guía de un nivel: en el centro del chevron del padre. Lo usa
// también quien dibuja guías alrededor de algo que no es una fila (un campo de
// filtro dentro del árbol), para que queden en la misma línea.
export const TREE_GUIDE_OFFSET = PAD + CHEVRON / 2

// Tono de los íconos de contenedor (carpeta, colección). Sale del acento del
// tema y no de un color fijo: con `tertiary` las carpetas eran salmón sobre un
// tema azul, y cada módulo terminaba con su propia paleta. Los elementos van en
// el tono neutro por defecto; el color queda para lo que es estado (la fila
// activa, una sesión viva).
export const TREE_FOLDER_ICON = 'text-primary/75'

export interface TreeRowProps {
    depth: number
    // Nombre de un Material Symbol, o un elemento propio cuando el tipo se
    // dice con otra cosa: el logo del motor de una conexión, el método de una
    // petición HTTP.
    icon: string | ReactNode
    // Clase del ícono (color). Por defecto, el tono atenuado de la barra.
    iconClass?: string
    iconFilled?: boolean
    label: ReactNode
    labelClass?: string
    title?: string
    // undefined = hoja (sin chevron, con el hueco para alinear).
    expanded?: boolean
    onToggle?: () => void
    onClick?: (e: ReactMouseEvent) => void
    onDoubleClick?: (e: ReactMouseEvent) => void
    onContextMenu?: (e: ReactMouseEvent) => void
    active?: boolean
    // A la derecha del nombre, siempre visible (contador, candado, badge).
    trailing?: ReactNode
    // Botones que aparecen al pasar por encima; reemplazan al `trailing`.
    actions?: ReactNode
    // Debajo de la fila (un fragmento de búsqueda, por ejemplo).
    below?: ReactNode
    // Franja de color pegada al borde izquierdo de la fila (clase de fondo):
    // el entorno de una conexión (Producción en rojo…). Va superpuesta y no
    // como `border-l`, que correría el contenido y desalinearía las guías de
    // esta fila con las de sus hermanas.
    stripe?: string
    className?: string
    style?: React.CSSProperties
}

export default function TreeRow({
    depth,
    icon,
    iconClass,
    iconFilled,
    label,
    labelClass,
    title,
    expanded,
    onToggle,
    onClick,
    onDoubleClick,
    onContextMenu,
    active,
    trailing,
    actions,
    below,
    stripe,
    className = '',
    style,
}: TreeRowProps) {
    const branch = expanded !== undefined
    return (
        <div
            data-tree-row
            onContextMenu={onContextMenu}
            className={`group relative mx-1 my-px rounded-md ${active ? 'sidebar-row-active' : 'hover:bg-surface-container-high'} ${className}`}
            style={{paddingLeft: `${depth * TREE_INDENT + PAD}px`, ...style}}
        >
            {Array.from({length: depth}, (_, i) => (
                <span
                    key={i}
                    aria-hidden
                    className="pointer-events-none absolute -inset-y-px w-px bg-on-surface-variant/25 group-hover:bg-on-surface-variant/40"
                    style={{left: `${i * TREE_INDENT + TREE_GUIDE_OFFSET}px`}}
                />
            ))}
            {stripe && <span aria-hidden className={`pointer-events-none absolute inset-y-1 left-0 w-[3px] rounded-full ${stripe}`} />}
            <div className="flex min-h-[28px] items-center gap-2 pr-1.5">
                {branch ? (
                    <button
                        onClick={(e) => {
                            e.stopPropagation()
                            onToggle?.()
                        }}
                        tabIndex={-1}
                        title={expanded ? 'Plegar' : 'Desplegar'}
                        className="flex shrink-0 items-center justify-center rounded text-on-surface-variant/70 hover:text-on-surface"
                        style={{width: CHEVRON}}
                    >
                        <Icon
                            name="chevron_right"
                            size={15}
                            className={`transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
                        />
                    </button>
                ) : (
                    <span className="shrink-0" style={{width: CHEVRON}} />
                )}
                <button
                    onClick={onClick}
                    onDoubleClick={onDoubleClick}
                    title={title}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:underline"
                >
                    {typeof icon === 'string' ? (
                        <Icon
                            name={icon}
                            size={16}
                            filled={iconFilled}
                            className={`shrink-0 ${iconClass ?? (active ? 'text-primary' : 'text-on-surface-variant')}`}
                        />
                    ) : (
                        <span className={`flex shrink-0 items-center ${iconClass ?? ''}`}>{icon}</span>
                    )}
                    <span className={`min-w-0 truncate text-ui-12 ${labelClass ?? (active ? 'text-on-surface' : 'text-on-surface/90')}`}>
                        {label}
                    </span>
                </button>
                {trailing && <span className={`flex shrink-0 items-center gap-1 ${actions ? 'group-hover:hidden' : ''}`}>{trailing}</span>}
                {actions && <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">{actions}</span>}
            </div>
            {below}
        </div>
    )
}
