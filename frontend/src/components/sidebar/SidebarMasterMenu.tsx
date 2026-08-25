import type {ReactNode} from 'react'
import Icon from '../Icon'

// El menú master: la fila de íconos que elige QUÉ módulo se ve en la barra.
//
// Reemplaza el acordeón de cuatro módulos apilados. El apilado tenía una
// virtud —ver conexiones, servidores, repositorios y notas a la vez— y un
// costo que en la práctica pesaba más: cuatro encabezados fijos comiendo alto
// útil, y el módulo que uno realmente está usando reducido a la franja que
// dejaban libre los otros tres. Con un módulo a la vez, el que está abierto se
// queda con toda la altura de la barra.
//
// Lo que el acordeón resolvía y esto tiene que seguir resolviendo es el
// descubrimiento: con los otros tres módulos fuera de la vista, hay que poder
// ver desde acá que tienen algo. De ahí el contador de coincidencias sobre
// cada ícono cuando hay una búsqueda activa — buscar sigue siendo global, y
// el ícono es lo que dice en cuál de los cuatro cayó lo que se busca.

export type SidebarModuleId = 'connections' | 'ssh' | 'git' | 'notes' | 'http'

export interface SidebarModuleDef {
    id: SidebarModuleId
    // Ligadura de Material Symbols Outlined — los mismos íconos que cada
    // módulo ya usaba para identificarse.
    icon: string
    // Nombre corto, el que encabeza la sección del árbol.
    label: string
    // Qué es el módulo, para el tooltip. Pensado para alguien que abre la app
    // por primera vez: "Git" no dice nada sobre qué se hace acá adentro.
    hint: string
    // Cuántos elementos de este módulo coinciden con la búsqueda activa.
    // null = no hay búsqueda, así que no se muestra nada (un "0" permanente
    // sobre cada ícono sería ruido, no información).
    matchCount: number | null
}

interface SidebarMasterMenuProps {
    modules: SidebarModuleDef[]
    active: SidebarModuleId
    onSelect: (id: SidebarModuleId) => void
    // 'vertical' es la barra oculta: la misma fila girada, sin borde inferior
    // ni reparto de ancho. Es el mismo menú a propósito — dos menús distintos
    // para lo mismo fue exactamente el problema del rail que esto reemplazó.
    orientation?: 'horizontal' | 'vertical'
    // Controles que van al final de la fila, después de los módulos. Hoy es
    // el botón de ocultar la barra: vivía en un encabezado propio junto al
    // logo, y ese encabezado dejó de tener razón de ser cuando el nombre de
    // la app pasó a la barra de título de la ventana. Un renglón entero para
    // un botón es un renglón que le falta al árbol.
    trailing?: ReactNode
}

export default function SidebarMasterMenu({modules, active, onSelect, orientation = 'horizontal', trailing}: SidebarMasterMenuProps) {
    const vertical = orientation === 'vertical'
    return (
        <div
            className={
                vertical
                    ? 'flex shrink-0 flex-col items-center gap-0.5 px-1'
                    : 'flex shrink-0 items-center gap-0.5 border-b border-outline-variant px-2 py-1.5'
            }
        >
            {modules.map((m) => {
                const isActive = m.id === active
                const hasMatches = m.matchCount != null && m.matchCount > 0
                return (
                    <button
                        key={m.id}
                        onClick={() => onSelect(m.id)}
                        title={
                            isActive
                                ? `${m.label} — ${m.hint} (es el módulo que estás viendo)`
                                : m.matchCount != null
                                  ? `${m.label} — ${m.hint}. ${m.matchCount === 0 ? 'Sin coincidencias con la búsqueda actual' : `${m.matchCount} ${m.matchCount === 1 ? 'coincidencia' : 'coincidencias'} con la búsqueda actual`}`
                                  : `${m.label} — ${m.hint}`
                        }
                        className={`relative flex h-8 items-center justify-center rounded-lg transition-colors ${vertical ? 'w-8' : 'flex-1'} ${
                            isActive
                                ? 'bg-primary-container text-on-primary-container'
                                : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
                        }`}
                    >
                        <Icon name={m.icon} size={18} />

                        {/* Contador de coincidencias. Solo aparece con una
                            búsqueda activa, y solo si hay algo: un módulo sin
                            coincidencias se dice apagándolo, no poniéndole un
                            cero encima. */}
                        {hasMatches && (
                            <span className="absolute -top-0.5 right-1 min-w-3 rounded-full bg-primary px-1 text-center font-mono text-ui-9 font-bold leading-tight text-on-primary">
                                {m.matchCount! > 99 ? '99+' : m.matchCount}
                            </span>
                        )}
                        {m.matchCount === 0 && <span aria-hidden className="absolute inset-0 rounded-lg bg-surface-container-low/50" />}
                    </button>
                )
            })}
            {trailing}
        </div>
    )
}
