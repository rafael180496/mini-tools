import type {ReactNode} from 'react'
import Icon from '../Icon'
import {useT} from '../../i18n'

// La columna de trabajo de la pestaña de un repositorio.
//
// Antes la columna interna era «solapas + dos buscadores + árbol de ramas», y
// el árbol repetía el de la barra lateral principal. Ahora es SOLO el panel de
// trabajo que gobiernan sus cuatro solapas:
//
//   Historial  búsqueda y filtros del grafo
//   Cambios    staging + caja de commit (como Source Control de VS Code)
//   Stash      guardar / aplicar / quitar
//   Archivos   el árbol del editor
//
// Lo que cada solapa MUESTRA (el grafo, el diff, el parche del stash, el
// editor) va en el área principal; la columna es lo que se opera.

export type WorkView = 'commits' | 'changes' | 'stash' | 'files'

interface Props {
    // 'conflicts' no es una solapa: es el resolutor, que reemplaza el área
    // principal. La columna sigue mostrando Cambios (los archivos en conflicto
    // son justamente los que hay que preparar).
    view: WorkView | 'conflicts'
    onView: (v: WorkView) => void
    changesCount: number
    stashCount: number
    width: number
    // Acoplada a la barra lateral de la app (ver workHost en GitRepoTab): ocupa
    // todo el ancho de la barra, no se pliega por su cuenta —se pliega con la
    // barra— y dice de qué repositorio es, porque arriba está la lista de
    // TODOS los repositorios.
    docked?: boolean
    // Solo acoplada: plegada a su encabezado (ver Workspace → gitWorkDockCollapsed).
    dockCollapsed?: boolean
    onToggleDockCollapsed?: () => void
    repoName?: string
    collapsed: boolean
    onToggleCollapsed: () => void
    // Contenido de la solapa activa (menos Archivos, que lo monta el editor
    // dentro de `onFilesHost`).
    children: ReactNode
    // Contenedor donde el editor de archivos monta su árbol (portal).
    onFilesHost: (el: HTMLDivElement | null) => void
}

export default function GitWorkPanel({view, onView, changesCount, stashCount, width, docked, dockCollapsed, onToggleDockCollapsed, repoName, collapsed, onToggleCollapsed, children, onFilesHost}: Props) {
    const t = useT()
    const w = t.git.workbench.panel
    const g = t.git.tab

    const tabs: {id: WorkView; icon: string; label: string; title: string; badge?: number}[] = [
        {id: 'commits', icon: 'history', label: w.history, title: g.views.commitsTitle},
        {id: 'changes', icon: 'edit_note', label: g.views.changes, title: g.views.changesTitle, badge: changesCount},
        {id: 'stash', icon: 'inventory_2', label: g.views.stash, title: g.views.stashTitle, badge: stashCount},
        {id: 'files', icon: 'edit_document', label: g.views.files, title: g.views.filesTitle},
    ]
    const compact = width < 300

    // Acoplada a la barra de la app. El encabezado entero es el botón de
    // plegar: es el blanco más grande y más obvio, y el chevron solo dice hacia
    // dónde va. Plegado queda ÚNICAMENTE esa fila; el cuerpo (solapas y
    // contenido) se oculta con `hidden` en vez de desmontarse, para no tirar el
    // estado de la solapa activa ni volver a pedir los datos al desplegar.
    if (docked) {
        const dockTitle = dockCollapsed ? w.dockShow : w.dockHide
        return (
            <div className={`flex min-h-0 flex-col overflow-hidden bg-surface-container-low ${dockCollapsed ? 'shrink-0' : 'flex-1'}`}>
                <button
                    onClick={onToggleDockCollapsed}
                    title={dockTitle}
                    aria-label={dockTitle}
                    aria-expanded={!dockCollapsed}
                    className="flex shrink-0 items-center gap-1.5 px-2.5 py-1.5 text-left text-ui-11 font-semibold uppercase tracking-wider text-on-surface-variant transition-colors hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="folder_code" size={13} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate" title={w.dockedTitle({repo: repoName ?? ''})}>
                        {repoName}
                    </span>
                    <Icon name={dockCollapsed ? 'expand_more' : 'expand_less'} size={16} className="shrink-0" />
                </button>
                <div className={dockCollapsed ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
                    {/* Fila segmentada: ícono + rótulo al lado. Con la barra
                        angosta los cuatro rótulos no entran (se cortaban en
                        «Hist…»), así que por container query —según el ancho de
                        ESTA fila, no de la ventana— se quedan solo los íconos;
                        el title de cada solapa dice cuál es. */}
                    <div role="tablist" className="@container flex shrink-0 items-center gap-0.5 border-b border-outline-variant px-1.5 pb-1.5">
                        {tabs.map((tab) => (
                            <button
                                key={tab.id}
                                role="tab"
                                onClick={() => onView(tab.id)}
                                title={tab.title}
                                aria-label={tab.label}
                                aria-selected={view === tab.id}
                                className={`flex min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-1 py-1 text-ui-11 transition-colors ${
                                    view === tab.id ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
                                }`}
                            >
                                <Icon name={tab.icon} size={15} className="shrink-0" />
                                <span className="hidden min-w-0 truncate @[300px]:inline">{tab.label}</span>
                                {!!tab.badge && tab.badge > 0 && (
                                    <span className="shrink-0 rounded-full bg-secondary px-1 text-ui-10 font-medium leading-4 text-on-secondary">{tab.badge > 99 ? '99+' : tab.badge}</span>
                                )}
                            </button>
                        ))}
                    </div>
                    {view === 'files' ? <div ref={onFilesHost} className="flex min-h-0 flex-1 flex-col" /> : children}
                </div>
            </div>
        )
    }

    if (collapsed) {
        return (
            <div className="flex w-9 shrink-0 flex-col items-center gap-0.5 border-r border-outline-variant bg-surface-container-lowest py-1">
                <button onClick={onToggleCollapsed} title={w.expand} aria-label={w.expand} className="mb-1 rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface">
                    <Icon name="left_panel_open" size={17} />
                </button>
                {tabs.map((tab) => (
                    <button
                        key={tab.id}
                        onClick={() => {
                            onView(tab.id)
                            onToggleCollapsed()
                        }}
                        title={tab.title}
                        aria-label={tab.label}
                        className={`relative rounded p-1.5 ${view === tab.id ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'}`}
                    >
                        <Icon name={tab.icon} size={17} />
                        {!!tab.badge && tab.badge > 0 && (
                            <span className="absolute -right-0.5 -top-0.5 min-w-3.5 rounded-full bg-secondary px-0.5 text-center text-ui-9 font-medium leading-3.5 text-on-secondary">{tab.badge > 99 ? '99+' : tab.badge}</span>
                        )}
                    </button>
                ))}
            </div>
        )
    }

    return (
        // overflow-hidden no es cosmético: `width` fija el ancho de la columna
        // pero sus hijos conservan min-width:auto, y una fila que no pueda
        // encogerse se dibujaría PASADO el borde, encima del grafo.
        <div style={{width}} className="flex shrink-0 flex-col overflow-hidden border-r border-outline-variant bg-surface-container-lowest">
            <div className="flex shrink-0 items-center gap-0.5 border-b border-outline-variant p-1">
                {tabs.map((tab) => (
                    <button
                        key={tab.id}
                        onClick={() => onView(tab.id)}
                        title={tab.title}
                        aria-label={tab.label}
                        aria-pressed={view === tab.id}
                        // min-w-0 anula el min-width:auto de los ítems flex: sin
                        // él `flex-1` no sirve y los cuatro desbordan la columna.
                        className={`flex min-w-0 flex-1 items-center justify-center gap-1 rounded px-1.5 py-1 text-ui-11 transition-colors ${
                            view === tab.id ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
                        }`}
                    >
                        <Icon name={tab.icon} size={16} className="shrink-0" />
                        {!compact && <span className="truncate">{tab.label}</span>}
                        {/* secondary es el rol de commit/éxito: un conteo vivo de
                            cambios pendientes se lee como «hay trabajo acá», no
                            como un error. */}
                        {!!tab.badge && tab.badge > 0 && (
                            <span className="shrink-0 rounded-full bg-secondary px-1.5 text-ui-10 font-medium leading-4 text-on-secondary">{tab.badge}</span>
                        )}
                    </button>
                ))}
                <button onClick={onToggleCollapsed} title={w.collapse} aria-label={w.collapse} className="shrink-0 rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface">
                    <Icon name="left_panel_close" size={16} />
                </button>
            </div>

            {view === 'files' ? <div ref={onFilesHost} className="flex min-h-0 flex-1 flex-col" /> : children}
        </div>
    )
}
