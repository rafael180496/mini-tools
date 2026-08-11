import type {ReactNode} from 'react'
import Icon from '../Icon'
import {environmentStyle} from '../../lib/environments'

// La barra lateral minimizada.
//
// Minimizar la barra servía para recuperar ancho, pero costaba casi todo lo
// demás: quedaba una columna de íconos de una sola sección —las conexiones de
// base— y los módulos SSH y Git desaparecían enteros, así que trabajar
// minimizado significaba expandir de nuevo cada vez que hacía falta una
// terminal o un repositorio. Y entre dos conexiones Oracle el ícono es el
// mismo, sin nombre ni color: la única forma de distinguirlas era apuntar con
// el mouse y esperar el tooltip del sistema.
//
// Estas piezas resuelven las dos cosas: cada módulo dibuja su propio grupo en
// el rail (así los tres siguen presentes) y cada fila conserva las señales que
// distinguen una conexión de otra — el color que le pusiste y, sobre todo, el
// entorno: saber que estás por abrir producción no es algo que pueda depender
// de que la barra esté expandida.

export function RailGroup({icon, title, count, children}: {icon: string; title: string; count?: number; children: ReactNode}) {
    return (
        <div className="mt-1 border-t border-outline-variant pt-1 first:mt-0 first:border-t-0 first:pt-0">
            {/* Encabezado del grupo: ícono del módulo y cuántos hay. No es un
                botón —en 56px no entra un control más que no haga nada—, pero
                sí lleva su propio tooltip, porque es lo único que dice qué son
                los íconos de abajo. El contador importa más de lo que parece:
                con la barra minimizada la lista se corta con el alto de la
                ventana y no hay forma de saber que abajo hay más. */}
            <div title={title} className="flex flex-col items-center gap-px py-1 text-on-surface-variant/60">
                <Icon name={icon} size={14} />
                {count != null && <span className="font-mono text-[8px] leading-none tabular-nums opacity-70">{count}</span>}
            </div>
            {children}
        </div>
    )
}

// RailMonogram: dos letras en lugar de un ícono, para cuando el ícono no
// distingue nada.
//
// Los repositorios Git son el caso claro: ocho repos daban ocho íconos de
// commit idénticos, una columna que no se puede leer ni recordar — hay que
// apuntar con el mouse a cada uno hasta encontrar el que se busca. Con las
// iniciales, la fila vuelve a ser identificable de un vistazo. Las conexiones
// de base y las SSH no lo necesitan: su ícono ya dice el motor, que es la
// distinción que importa entre ellas.
export function RailMonogram({name}: {name: string}) {
    // Iniciales de las dos primeras palabras ("chatwoot-clone" → CC), o las
    // dos primeras letras cuando es una sola palabra ("mini" → MI).
    const words = name.split(/[\s._/-]+/).filter(Boolean)
    const text = words.length >= 2 ? (words[0][0] + words[1][0]).toUpperCase() : name.slice(0, 2).toUpperCase()
    return <span className="font-mono text-[11px] font-bold leading-none tracking-tight">{text}</span>
}

export function RailItem({
    title,
    active,
    live,
    color,
    environment,
    onClick,
    onContextMenu,
    onDoubleClick,
    children,
}: {
    title: string
    // La que está seleccionada / vinculada a la pestaña activa.
    active?: boolean
    // Conectada ahora mismo.
    live?: boolean
    // Color libre que el usuario le asignó a la conexión.
    color?: string
    // Marca de entorno ('prod' | 'staging' | 'dev'), la señal que menos se
    // puede permitir perder al minimizar.
    environment?: string
    onClick: () => void
    onContextMenu?: (e: React.MouseEvent) => void
    onDoubleClick?: () => void
    children: ReactNode
}) {
    const env = environmentStyle(environment)
    return (
        <div className="relative px-1.5 py-px">
            <button
                onClick={onClick}
                onContextMenu={onContextMenu}
                onDoubleClick={onDoubleClick}
                title={title}
                className={`relative flex h-8 w-full items-center justify-center rounded-lg transition-colors ${
                    active ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-variant'
                }`}
            >
                {children}

                {/* Entorno: una franja en el borde izquierdo, igual que la
                    fila expandida, en vez de un punto más. Un punto compite
                    con el del color libre y en 36px los dos juntos no se
                    distinguen; una franja se lee de reojo. */}
                {env && <span aria-hidden className={`absolute inset-y-1 left-0 w-1 rounded-full ${env.dot}`} />}

                {/* Color libre de la conexión, abajo a la derecha. */}
                {color && (
                    <span
                        aria-hidden
                        className="absolute bottom-0.5 right-0.5 h-1.5 w-1.5 rounded-full ring-1 ring-surface-container-low"
                        style={{backgroundColor: color}}
                    />
                )}

                {/* Conectada: un punto en la esquina de arriba. Distinto lugar
                    y distinto significado que el color — uno es estado, el
                    otro es una etiqueta que le pusiste vos. */}
                {live && <span aria-hidden className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-primary ring-1 ring-surface-container-low" />}
            </button>
        </div>
    )
}
