import {useEffect, useState} from 'react'
import type {MouseEvent as ReactMouseEvent, ReactNode} from 'react'
import logo from '../../assets/logo.png'
import {AppVersion} from '../../../wailsjs/go/main/App'
import {BrowserOpenURL} from '../../../wailsjs/runtime'
import Icon from '../Icon'
import ResizeHandle from '../ResizeHandle'
import ActivityRail, {type SidebarModuleDef, type SidebarModuleId} from './ActivityRail'
import type {Theme} from '../../hooks/useTheme'
import {useLang, useT, type Lang} from '../../i18n'

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
    // API moderna de ResizeHandle (Fase 2 ADE): soporta teclado y reset a auto size.
    onResizeWidth?: (px: number) => void
    onCommitWidth?: (px: number) => void
    isAutoWidth?: boolean
    onResetAutoWidth?: () => void
    // Versión nueva disponible, si la hay. El pie de la barra es donde se
    // avisa: es el lugar donde ya está escrita la versión que se está
    // usando, así que es donde la comparación tiene sentido.
    updateAvailable: string | null
    // Nombre del archivo que se va a descargar al hacer clic en el aviso
    // ("mini-tools-v2.4.0.dmg"). null cuando no se pudo determinar y el clic
    // lleva a la página del release en vez de al archivo.
    updateDownloadName: string | null
    onOpenRepo: () => void
    // Tema y configuración: dos ajustes de la APLICACIÓN, no de la pestaña.
    //
    // Vivían en la barra de contexto del editor SQL, arriba a la derecha, y de
    // ahí se mudaron acá. El motivo es el mismo por el que la ayuda ya estaba
    // en este pie: esa barra **desaparece** en una nota, una terminal, una
    // petición HTTP o un repositorio, así que dos ajustes que valen para toda
    // la app dejaban de existir según qué pestaña tuvieras abierta — y para
    // cambiar el tema había que abrir una consulta primero. El pie de la barra
    // lateral está siempre, en todos los módulos, y ya es donde vive lo que es
    // de la app entera y no de lo que estás mirando: la versión y la ayuda.
    theme: Theme
    onToggleTheme: () => void
    onOpenSettings: () => void
}

// La documentación pública del proyecto. Vive acá y en un solo lugar: es la
// misma dirección que promociona el README y la que abre el botón de ayuda,
// y tenerla repetida en dos archivos es tenerla desactualizada en uno.
export const DOCS_URL = 'https://rafael180496.github.io/mini-tools/'

// docsUrl es la ayuda en el idioma de la interfaz: la inglesa en la raíz y la
// española en `es/`. Las anclas (`#tema`) son las mismas en las dos páginas,
// así que un enlace profundo se arma igual: `docsUrl(lang) + '#tema'`.
export function docsUrl(lang: Lang): string {
    return lang === 'es' ? `${DOCS_URL}es/` : DOCS_URL
}

// Los tres botones del pie —tema, configuración y ayuda— comparten forma,
// tamaño de área clickeable y respuesta al hover desde acá.
//
// Antes cada uno tenía la suya: la ayuda era un `p-0.5` de 14px en el pie y la
// configuración un `p-1` de 18px en otra barra, así que juntarlos tal cual
// habría dado tres botones de tres tamaños distintos en una fila de 20px de
// alto. Un ícono suelto de 14px además es un blanco difícil: el área mínima
// cómoda es de 28px, y eso es lo que da `p-1.5` alrededor de un ícono de 16.
function FooterIconButton({
    icon,
    title,
    onClick,
    filled,
    badge,
}: {
    icon: string
    title: string
    onClick: () => void
    filled?: boolean
    // Punto de aviso en la esquina, para lo que no puede esperar a que alguien
    // lea el tooltip.
    badge?: boolean
}) {
    return (
        <button
            onClick={onClick}
            title={title}
            className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-on-surface-variant transition-colors hover:bg-surface-variant hover:text-on-surface"
        >
            <Icon name={icon} size={16} filled={filled} />
            {badge && <span aria-hidden className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" />}
        </button>
    )
}

// La documentación pública, en el navegador del sistema.
//
// Va en el PIE de la barra lateral y no en la fila de acciones de arriba por un
// motivo concreto: esa fila desaparece en las pestañas que no son del editor
// —una nota, una terminal local, una petición HTTP—, y la ayuda tiene que estar
// justamente cuando alguien no sabe dónde está parado. Es el mismo motivo por
// el que ahora la acompañan el tema y la configuración.
function HelpButton() {
    const t = useT()
    const lang = useLang()
    return (
        <FooterIconButton
            icon="help"
            onClick={() => BrowserOpenURL(docsUrl(lang))}
            title={t.shell.sidebar.helpTitle}
        />
    )
}

// Tema claro/oscuro. El ícono muestra a DÓNDE lleva el clic, no dónde estás:
// en oscuro se ve el sol, que es lo que vas a obtener.
function ThemeButton({theme, onToggle}: {theme: Theme; onToggle: () => void}) {
    const t = useT()
    return (
        <FooterIconButton
            icon={theme === 'dark' ? 'light_mode' : 'dark_mode'}
            onClick={onToggle}
            title={
                theme === 'dark'
                    ? t.shell.sidebar.themeToLight
                    : t.shell.sidebar.themeToDark
            }
        />
    )
}

// Configuración de la app: apariencia, vault, terminal y agentes.
function SettingsButton({onOpen, updateAvailable}: {onOpen: () => void; updateAvailable: string | null}) {
    const t = useT()
    return (
        <FooterIconButton
            icon="settings"
            onClick={onOpen}
            badge={Boolean(updateAvailable)}
            title={
                updateAvailable
                    ? t.shell.sidebar.settingsUpdateTitle({latest: updateAvailable})
                    : t.shell.sidebar.settingsTitle
            }
        />
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
    const t = useT()
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
                        ? t.shell.sidebar.markUpdateDownload({current: version || '—', latest: updateAvailable, file: updateDownloadName})
                        : t.shell.sidebar.markUpdatePage({current: version || '—', latest: updateAvailable})
                    : t.shell.sidebar.versionTitle({version: version ? `v${version}` : '—'})
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

export default function Sidebar({
    modules,
    activeModule,
    onSelectModule,
    collapsed,
    onToggleCollapsed,
    filter,
    onFilterChange,
    bodies,
    width,
    onStartResize,
    onResizeWidth,
    onCommitWidth,
    isAutoWidth,
    onResetAutoWidth,
    updateAvailable,
    updateDownloadName,
    onOpenRepo,
    theme,
    onToggleTheme,
    onOpenSettings,
}: SidebarProps) {
    const t = useT()
    const active = modules.find((m) => m.id === activeModule) ?? modules[0]

    function handleRailSelectModule(id: SidebarModuleId) {
        onSelectModule(id)
        if (collapsed) onToggleCollapsed()
    }

    return (
        <div className="flex h-full shrink-0 gap-1.5">
            <ActivityRail
                modules={modules}
                activeModule={activeModule}
                collapsed={collapsed}
                onToggleCollapsed={onToggleCollapsed}
                onSelectModule={handleRailSelectModule}
                footer={
                    <>
                        <ThemeButton theme={theme} onToggle={onToggleTheme} />
                        <HelpButton />
                        <SettingsButton onOpen={onOpenSettings} updateAvailable={updateAvailable} />
                        <SidebarFooterMark
                            updateAvailable={updateAvailable}
                            updateDownloadName={updateDownloadName}
                            onOpenRepo={onOpenRepo}
                        />
                    </>
                }
            />

            {!collapsed && (
                <aside
                    className="ade-pane relative flex h-full shrink-0 flex-col overflow-hidden text-on-surface"
                    style={{width}}
                >
                    {/* Encabezado limpio del panel Explorador */}
                    <div className="flex h-9 shrink-0 items-center justify-between border-b border-outline-variant/70 px-3">
                        <span className="truncate text-ui-11 font-semibold uppercase tracking-wider text-on-surface-variant">
                            {active.label}
                        </span>
                    </div>

                    <div className="shrink-0 px-3 pt-2">
                        <div className="flex items-center gap-1.5 rounded-lg bg-surface-container-highest px-2.5 py-1.5 focus-within:ring-1 focus-within:ring-primary">
                            <Icon name="search" size={14} className="shrink-0 text-on-surface-variant/60" />
                            <input
                                value={filter}
                                onChange={(e) => onFilterChange(e.target.value)}
                                placeholder={t.shell.sidebar.searchPlaceholder}
                                title={t.shell.sidebar.searchTitle}
                                className="min-w-0 flex-1 bg-transparent text-xs text-on-surface outline-none placeholder:text-on-surface-variant/60"
                            />
                            {filter && (
                                <button
                                    onClick={() => onFilterChange('')}
                                    title={t.shell.sidebar.clearSearch}
                                    className="shrink-0 rounded text-on-surface-variant/60 hover:text-on-surface"
                                >
                                    <Icon name="close" size={14} />
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Los seis módulos siguen montados para no perder estado al alternar */}
                    {modules.map((m) => (
                        <div
                            key={m.id}
                            className="flex min-h-0 flex-1 flex-col"
                            style={{display: m.id === active.id ? undefined : 'none'}}
                        >
                            {bodies[m.id]}
                        </div>
                    ))}

                    {onResizeWidth ? (
                        <ResizeHandle
                            value={width}
                            min={180}
                            max={520}
                            defaultValue={256}
                            orientation="vertical"
                            edge="right"
                            isAuto={isAutoWidth}
                            onResetAuto={onResetAutoWidth}
                            onChange={onResizeWidth}
                            onCommit={onCommitWidth}
                            label={t.shell.sidebar.resize}
                            title={t.shell.ade.rail.resizeTitle}
                        />
                    ) : (
                        <div
                            onMouseDown={onStartResize}
                            title={t.shell.sidebar.resize}
                            className="absolute inset-y-0 -right-0.5 z-10 w-1.5 cursor-col-resize hover:bg-primary/30"
                        />
                    )}
                </aside>
            )}
        </div>
    )
}
