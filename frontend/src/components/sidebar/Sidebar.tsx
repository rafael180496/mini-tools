import {useEffect, useState} from 'react'
import type {MouseEvent as ReactMouseEvent, ReactNode} from 'react'
import logo from '../../assets/logo.png'
import {AppVersion} from '../../../wailsjs/go/main/App'
import {BrowserOpenURL} from '../../../wailsjs/runtime'
import Icon from '../Icon'
import SidebarMasterMenu, {type SidebarModuleDef, type SidebarModuleId} from './SidebarMasterMenu'

// La barra lateral entera: identidad, menú master, búsqueda y el árbol del
// módulo abierto.
//
// Antes esta estructura vivía dentro de ConnectionTree, que además de dibujar
// el árbol de conexiones era el contenedor de los otros tres módulos (los
// recibía por una prop `extraModules`). Funcionaba, pero significaba que
// tocar el marco de la barra era editar el componente de conexiones, y que
// SSH, Git y Notas dependieran de un componente con el que no tienen nada que
// ver. Acá el marco es su propio componente y cada árbol vuelve a ser solo un
// árbol.
//
// Los cuatro módulos se montan siempre y se muestra uno: alternar entre ellos
// no vuelve a pedir datos ni pierde qué carpetas estaban abiertas, que es lo
// que haría desmontarlos. Es el mismo trato que Workspace ya le da a las
// pestañas del editor.

interface SidebarProps {
    modules: SidebarModuleDef[]
    activeModule: SidebarModuleId
    onSelectModule: (id: SidebarModuleId) => void
    // Barra oculta: el editor se queda con todo el ancho. Sigue existiendo
    // una columna angosta con el menú master, así que volver es un clic y no
    // hay que recordar dónde estaba el botón.
    collapsed: boolean
    onToggleCollapsed: () => void
    // Búsqueda global: filtra los cuatro módulos a la vez, y el menú master
    // muestra en cuál cayó cada coincidencia.
    filter: string
    onFilterChange: (value: string) => void
    bodies: Record<SidebarModuleId, ReactNode>
    // Ancho arrastrado, en píxeles. Lo maneja Workspace (que también lo
    // persiste al soltar), igual que el alto del editor: la barra dibuja el
    // tirador, no el estado.
    width: number
    onStartResize: (e: ReactMouseEvent) => void
    // Versión nueva disponible, si la hay. El pie de la barra es donde se
    // avisa: es el lugar donde ya está escrita la versión que se está
    // usando, así que es donde la comparación tiene sentido.
    updateAvailable: string | null
    // Nombre del archivo que se va a descargar al hacer clic en el aviso
    // ("mini-tools-v2.4.0.dmg"). null cuando no se pudo determinar y el clic
    // lleva a la página del release en vez de al archivo.
    updateDownloadName: string | null
    onOpenRepo: () => void
}

// La documentación pública del proyecto. Vive acá y en un solo lugar: es la
// misma dirección que promociona el README y la que abre el botón de ayuda,
// y tenerla repetida en dos archivos es tenerla desactualizada en uno.
export const DOCS_URL = 'https://rafael180496.github.io/mini-tools/'

// Botón de ayuda: abre la documentación en el navegador del sistema.
//
// Va en el PIE de la barra lateral y no en la fila de acciones de arriba por un
// motivo concreto: esa fila desaparece en las pestañas que no son del editor
// —una nota, una terminal local, una petición HTTP—, y la ayuda tiene que estar
// justamente cuando alguien no sabe dónde está parado.
function HelpButton({compact}: {compact?: boolean}) {
    return (
        <button
            onClick={() => BrowserOpenURL(DOCS_URL)}
            title="Abrir la documentación en el navegador: qué hace cada módulo, ejemplos de uso y recetas de principio a fin"
            className={`shrink-0 rounded text-on-surface-variant transition-colors hover:bg-surface-variant hover:text-on-surface ${
                compact ? 'p-1' : 'p-0.5'
            }`}
        >
            <Icon name="help" size={compact ? 16 : 14} />
        </button>
    )
}

// Pie de la barra: quién es esta app y qué versión es.
//
// La identidad estaba arriba, en un encabezado propio, y se fue a la barra
// de título de la ventana cuando esa apareció. El pie es el otro lugar
// clásico —y el mejor para la versión, que es un dato que se consulta una
// vez cada tanto y nunca se busca arriba de todo—, además de darle un final
// a una columna que si no termina en el vacío.
function SidebarFooter({
    updateAvailable,
    updateDownloadName,
    onOpenRepo,
}: {
    updateAvailable: string | null
    updateDownloadName: string | null
    onOpenRepo: () => void
}) {
    const [version, setVersion] = useState('')

    useEffect(() => {
        AppVersion()
            .then(setVersion)
            // Sin versión el pie muestra solo el nombre: es información
            // secundaria y no vale interrumpir nada por ella.
            .catch(() => {})
    }, [])

    const label = version ? `v${version}` : '—'

    if (updateAvailable) {
        // Dos botones hermanos y no uno adentro del otro: un <button> anidado
        // no es HTML válido y el clic de adentro dispara también el de afuera.
        return (
            <div className="flex shrink-0 items-center gap-2 border-t border-outline-variant px-3 py-2">
                <button
                    onClick={onOpenRepo}
                    title={
                        updateDownloadName
                            ? `Estás en la v${version || '—'} y hay una v${updateAvailable} disponible — clic para descargar ${updateDownloadName}`
                            : `Estás en la v${version || '—'} y hay una v${updateAvailable} disponible — clic para abrir su página de descarga`
                    }
                    className="flex min-w-0 flex-1 items-center gap-2 text-left transition-colors hover:opacity-80"
                >
                    <img src={logo} alt="" className="h-4 w-4 shrink-0 object-contain" />
                    <span className="min-w-0 flex-1 truncate text-ui-11 font-medium text-on-surface-variant">mini-tools</span>
                    <span className="flex shrink-0 items-center gap-1 font-mono text-ui-10 text-primary">
                        <Icon name="new_releases" size={12} />
                        v{updateAvailable}
                    </span>
                </button>
                <HelpButton />
            </div>
        )
    }

    return (
        <div className="flex shrink-0 items-center gap-2 border-t border-outline-variant px-3 py-2">
            <img src={logo} alt="" className="h-4 w-4 shrink-0 object-contain" />
            <span
                title={`mini-tools ${label} — la versión instalada en este equipo`}
                className="min-w-0 flex-1 truncate text-ui-11 font-medium text-on-surface-variant"
            >
                mini-tools
            </span>
            <HelpButton />
            <span className="shrink-0 font-mono text-ui-10 tabular-nums text-on-surface-variant/50">{label}</span>
        </div>
    )
}

// La versión colapsada del pie: solo el logo, con todo lo demás en el
// tooltip. Mismo dato, mismo comportamiento al haber actualización.
function SidebarFooterMark({
    updateAvailable,
    updateDownloadName,
    onOpenRepo,
}: {
    updateAvailable: string | null
    updateDownloadName: string | null
    onOpenRepo: () => void
}) {
    const [version, setVersion] = useState('')

    useEffect(() => {
        AppVersion()
            .then(setVersion)
            .catch(() => {})
    }, [])

    return (
        <button
            onClick={updateAvailable ? onOpenRepo : undefined}
            title={
                updateAvailable
                    ? updateDownloadName
                        ? `mini-tools v${version || '—'} — hay una v${updateAvailable} disponible, clic para descargar ${updateDownloadName}`
                        : `mini-tools v${version || '—'} — hay una v${updateAvailable} disponible, clic para abrir su página de descarga`
                    : `mini-tools ${version ? `v${version}` : '—'} — la versión instalada en este equipo`
            }
            className={`relative flex h-9 w-full items-center justify-center border-t border-outline-variant ${
                updateAvailable ? 'hover:bg-surface-variant' : 'cursor-default'
            }`}
        >
            <img src={logo} alt="" className="h-4 w-4 object-contain" />
            {updateAvailable && <span aria-hidden className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-primary" />}
        </button>
    )
}

export default function Sidebar({modules, activeModule, onSelectModule, collapsed, onToggleCollapsed, filter, onFilterChange, bodies, width, onStartResize, updateAvailable, updateDownloadName, onOpenRepo}: SidebarProps) {
    const active = modules.find((m) => m.id === activeModule) ?? modules[0]

    if (collapsed) {
        return (
            <aside className="flex h-full w-11 shrink-0 flex-col items-center border-r border-outline-variant bg-surface-container-low py-2 text-on-surface">
                <button
                    onClick={onToggleCollapsed}
                    title="Mostrar la barra lateral con el árbol de conexiones, servidores, repositorios y notas"
                    className="rounded-lg p-1.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="left_panel_open" size={18} />
                </button>
                <div className="mt-1 w-full border-t border-outline-variant pt-1">
                    {/* Vertical y sin rótulos, pero es el MISMO menú: clickear
                        un módulo acá abre la barra directamente en ese módulo,
                        en vez de obligar a expandir primero y buscar después. */}
                    <SidebarMasterMenu
                        modules={modules}
                        active={activeModule}
                        orientation="vertical"
                        onSelect={(id) => {
                            onSelectModule(id)
                            onToggleCollapsed()
                        }}
                    />
                </div>

                {/* Colapsada no entra ni el nombre ni la versión, pero sí el
                    logo: le da pie a la columna y su tooltip dice las dos
                    cosas, que es lo mismo que se consulta al leerlas. */}
                <div className="mt-auto flex flex-col items-center pt-2">
                    {/* La ayuda también acá: colapsada es cuando menos pistas
                        hay en pantalla, que es justo cuando más se busca. */}
                    <HelpButton compact />
                    <SidebarFooterMark updateAvailable={updateAvailable} updateDownloadName={updateDownloadName} onOpenRepo={onOpenRepo} />
                </div>
            </aside>
        )
    }

    return (
        <aside className="relative flex h-full shrink-0 flex-col border-r border-outline-variant bg-surface-container-low text-on-surface" style={{width}}>
            {/* El logo y el nombre de la app vivían acá, en un encabezado
                propio. Se fueron a la barra de título de la ventana
                (components/TitleBar.tsx), que es donde va la identidad de una
                app de escritorio — y tenerlos en los dos lados era decir dos
                veces lo mismo a 40px de distancia. Lo único que quedaba de
                ese encabezado, el botón de ocultar, se mudó al final de esta
                fila. */}
            <SidebarMasterMenu
                modules={modules}
                active={activeModule}
                onSelect={onSelectModule}
                trailing={
                    <>
                        <div className="mx-1 h-5 w-px shrink-0 bg-outline-variant" />
                        <button
                            onClick={onToggleCollapsed}
                            title="Ocultar la barra lateral y darle todo el ancho al editor — queda una columna con los íconos de los módulos para volver"
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-on-surface-variant transition-colors hover:bg-surface-variant hover:text-on-surface"
                        >
                            <Icon name="left_panel_close" size={18} />
                        </button>
                    </>
                }
            />

            {/* Un solo buscador para los cuatro módulos, y sigue siendo global
                aunque se vea uno solo: la razón por la que existe es no tener
                que decidir de antemano en cuál está lo que uno recuerda nada
                más que por el nombre. Los contadores del menú master son la
                otra mitad — dicen dónde cayeron las coincidencias que este
                módulo no está mostrando. */}
            <div className="shrink-0 px-3 pt-2">
                <div className="flex items-center gap-1.5 rounded-lg bg-surface-container-highest px-2.5 py-1.5 focus-within:ring-1 focus-within:ring-primary">
                    <Icon name="search" size={14} className="shrink-0 text-on-surface-variant/60" />
                    <input
                        value={filter}
                        onChange={(e) => onFilterChange(e.target.value)}
                        placeholder="Buscar en todo…"
                        title="Busca a la vez en conexiones de base de datos, servidores SSH, repositorios Git y notas — por nombre del elemento o de la carpeta que lo contiene. Los íconos de arriba muestran cuántas coincidencias tiene cada módulo"
                        className="min-w-0 flex-1 bg-transparent text-xs text-on-surface outline-none placeholder:text-on-surface-variant/60"
                    />
                    {filter && (
                        <button
                            onClick={() => onFilterChange('')}
                            title="Limpiar la búsqueda y volver a ver el módulo completo"
                            className="shrink-0 rounded text-on-surface-variant/60 hover:text-on-surface"
                        >
                            <Icon name="close" size={14} />
                        </button>
                    )}
                </div>
            </div>

            {/* Los cuatro montados, uno visible — ver el comentario de arriba
                sobre por qué no se desmontan. */}
            {modules.map((m) => (
                <div key={m.id} className="flex min-h-0 flex-1 flex-col" style={{display: m.id === active.id ? undefined : 'none'}}>
                    {bodies[m.id]}
                </div>
            ))}

            <SidebarFooter updateAvailable={updateAvailable} updateDownloadName={updateDownloadName} onOpenRepo={onOpenRepo} />

            {/* Tirador de ancho. Va superpuesto sobre el borde derecho y no
                como una columna más del flex: una columna propia correría el
                contenido y dejaría una franja visible al lado del borde, que
                es exactamente el pixel que uno intenta agarrar. */}
            <div
                onMouseDown={onStartResize}
                title="Arrastrar para cambiar el ancho de la barra lateral — el tamaño queda guardado"
                className="absolute inset-y-0 -right-0.5 z-10 w-1.5 cursor-col-resize hover:bg-primary/30"
            />
        </aside>
    )
}
