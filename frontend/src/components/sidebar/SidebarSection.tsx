import type {ReactNode} from 'react'

// El encabezado del árbol de un módulo: su nombre y sus acciones.
//
// Sustituye a SidebarModule, que era un acordeón. Plegar dejó de tener
// sentido cuando la barra pasó a mostrar un módulo por vez: el único
// contenido visible no se pliega, porque plegarlo deja la barra vacía. Lo que
// queda es lo que el acordeón tenía además del plegado — el nombre del módulo
// y sus botones — sin el chevron que ya no lleva a ningún lado.
//
// Es a propósito una tira de una línea y no un encabezado con aire: el módulo
// que se está viendo ya está señalado arriba, en el menú master, así que acá
// alcanza con un rótulo que diga de qué es el árbol.

interface SidebarSectionProps {
    // Nombre del módulo, en versalitas.
    title: string
    // Cuántos elementos hay, o cuántos coinciden con la búsqueda activa.
    // Se muestra al lado del rótulo: con el árbol filtrado, "3 de 27" es la
    // diferencia entre "no tengo esa conexión" y "la búsqueda la escondió".
    count?: string | null
    // Botones del módulo (nuevo elemento, nueva carpeta, …), alineados a la
    // derecha del rótulo.
    actions?: ReactNode
    children: ReactNode
}

export default function SidebarSection({title, count, actions, children}: SidebarSectionProps) {
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-2 px-3 pb-1 pt-2">
                <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">{title}</span>
                {count && <span className="shrink-0 font-mono text-[10px] tabular-nums text-on-surface-variant/50">{count}</span>}
                <div className="flex flex-1 items-center justify-end gap-0.5">{actions}</div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">{children}</div>
        </div>
    )
}
