import {useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent} from 'react'
import {git, osopen} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import {useT} from '../../i18n'
import DropdownMenu, {type DropdownItem} from './DropdownMenu'
import GitBranchSwitcher from './GitBranchSwitcher'

// La barra ÚNICA de la pestaña de un repositorio.
//
// Antes eran dos filas: nombre, rama y Fetch/Pull/Push arriba; PR, Agente,
// Vista, Abrir en… abajo. Dos filas son dos lugares donde buscar y media
// pantalla de alto fijo antes del primer commit. Acá todo vive en una:
//
//   izquierda  repo · rama (clic = selector rápido) · acciones del repo
//   derecha    Fetch / Pull / Push partidos · recargar · Abrir en… · Agentes · ajustes
//
// Son íconos con tooltip: el ancho sobra para eso y no para doce etiquetas. Y se
// degrada por anchos medidos (ResizeObserver, no media queries: lo que importa
// es el ancho de ESTA pestaña, no el de la ventana) hacia un menú «⋯».

type MenuItem = DropdownItem | 'separator'

interface Props {
    repoName: string
    // --- rama
    branchLabel: string
    detached: boolean
    branchTitle: string
    ahead: number
    behind: number
    branches: git.Branch[]
    tags: git.Tag[]
    pinned: string[]
    onCheckout: (b: git.Branch) => void
    onRevealBranch: (b: git.Branch) => void
    onTogglePin: (name: string) => void
    onBranchMenu: (b: git.Branch, e: ReactMouseEvent) => void
    onRevealTag: (tag: git.Tag) => void
    onTagMenu: (tag: git.Tag, e: ReactMouseEvent) => void
    onCreateBranch: () => void
    onCreateTag: () => void
    onManageRemotes: () => void
    // --- ramas ocultas del grafo
    hiddenNames: string[]
    onUnhide: () => void
    // --- sincronización
    busy: boolean
    fetchItems: MenuItem[]
    pullItems: MenuItem[]
    pushItems: MenuItem[]
    onFetch: () => void
    onPull: () => void
    onPush: () => void
    onReload: () => void
    onSettings: () => void
    // --- acciones del repo
    forge: {provider: string; compareUrl: string} | null
    onCreatePr: () => void
    onDescribePr: () => void
    agentMode?: boolean
    onToggleAgentMode?: () => void
    viewItems: MenuItem[]
    // --- abrir en…
    editors: osopen.Editor[]
    onOpenEditor: (id: string) => void
    onOpenFolder: () => void
    onOpenTerminal: () => void
    // El panel de abajo (terminal / agentes) ya está abierto: no hace falta
    // ofrecer abrirlo otra vez.
    panelOpen: boolean
    onOpenAgentsPanel: () => void
    // Vista central activa (Commits / Cambios / Archivos) siempre a un clic.
    activeView?: 'commits' | 'changes' | 'stash' | 'files' | 'conflicts'
    changesCount?: number
    onSelectView?: (v: 'commits' | 'changes' | 'files') => void
}

// Umbrales medidos contra el contenido real: ver el cálculo en cada nivel.
// Con menos de WIDE no entran las etiquetas de Fetch/Pull/Push; con menos de
// MEDIUM las acciones del repo pasan al «⋯»; con menos de NARROW, también el
// resto de la derecha.
const WIDE = 940
const MEDIUM = 700
const NARROW = 520

export default function GitToolbar(p: Props) {
    const t = useT()
    const tb = t.git.workbench.toolbar
    const wp = t.git.workbench.panel
    const g = t.git.tab
    const ref = useRef<HTMLDivElement>(null)
    const [width, setWidth] = useState(1200)

    useLayoutEffect(() => {
        const el = ref.current
        if (!el) return
        setWidth(el.clientWidth)
        const ro = new ResizeObserver(() => setWidth(el.clientWidth))
        ro.observe(el)
        return () => ro.disconnect()
    }, [])

    const labels = width >= WIDE
    const repoActionsInline = width >= MEDIUM
    const rightExtrasInline = width >= NARROW

    const btn = 'flex shrink-0 items-center justify-center rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-40'

    // Las mismas acciones del repo, como filas de menú — para el «⋯».
    const repoActionItems: MenuItem[] = [
        ...(p.forge
            ? ([
                  {label: tb.createPr, icon: 'call_merge', hint: tb.createPrHint({provider: p.forge.provider}), onSelect: p.onCreatePr},
                  {label: tb.describePr, icon: 'auto_awesome', hint: tb.describePrHint, onSelect: p.onDescribePr},
                  'separator',
              ] as MenuItem[])
            : []),
        ...p.viewItems,
    ]

    const openInItems: MenuItem[] = [
        ...p.editors.map(
            (e): DropdownItem => ({
                label: e.label,
                icon: 'code_blocks',
                hint: tb.openInEditorHint,
                onSelect: () => p.onOpenEditor(e.id),
            }),
        ),
        {label: tb.folder, icon: 'folder_open', hint: tb.folderHint, onSelect: p.onOpenFolder},
        {label: tb.terminal, icon: 'terminal', hint: tb.terminalHint, onSelect: p.onOpenTerminal},
    ]

    // Lo de la derecha que, estrecho, pasa a ser filas del «⋯».
    const extrasItems: MenuItem[] = [
        {label: tb.reload, icon: 'refresh', hint: tb.reloadHint, disabled: p.busy, onSelect: p.onReload},
        {label: tb.agents, icon: 'smart_toy', hint: tb.agentsHint, onSelect: p.onOpenAgentsPanel},
        {label: tb.settings, icon: 'settings', hint: tb.settingsHint, onSelect: p.onSettings},
        'separator',
        ...openInItems,
    ]

    const overflowItems: MenuItem[] = [...(repoActionsInline ? [] : repoActionItems), ...(rightExtrasInline ? [] : (['separator', ...extrasItems] as MenuItem[]))]

    return (
        <div ref={ref} className="flex shrink-0 items-center gap-1 border-b border-outline-variant bg-surface-container-low px-2 py-1">
            {/* --- izquierda: dónde estoy ----------------------------------- */}
            <span className="flex min-w-0 shrink items-center gap-1 pr-1 text-ui-12 font-medium text-on-surface" title={p.repoName}>
                <Icon name="folder_open" size={16} className="shrink-0 opacity-70" />
                <span className="truncate">{p.repoName}</span>
            </span>

            <GitBranchSwitcher
                label={p.branchLabel}
                detached={p.detached}
                chipTitle={p.branchTitle}
                branches={p.branches}
                tags={p.tags}
                pinned={p.pinned}
                busy={p.busy}
                onCheckout={p.onCheckout}
                onReveal={p.onRevealBranch}
                onTogglePin={p.onTogglePin}
                onBranchMenu={p.onBranchMenu}
                onTagReveal={p.onRevealTag}
                onTagMenu={p.onTagMenu}
                onCreateBranch={p.onCreateBranch}
                onCreateTag={p.onCreateTag}
                onManageRemotes={p.onManageRemotes}
            />

            {p.onSelectView && (
                <div className="flex shrink-0 items-center rounded-lg border border-outline-variant/70 bg-surface-container p-0.5">
                    {(
                        [
                            ['commits', 'history', wp.history, g.views.commitsTitle, 0],
                            ['changes', 'edit_note', g.views.changes, g.views.changesTitle, p.changesCount ?? 0],
                            ['files', 'edit_document', g.views.files, g.views.filesTitle, 0],
                        ] as const
                    ).map(([id, icon, label, title, count]) => {
                        const active = p.activeView === id
                        return (
                            <button
                                key={id}
                                type="button"
                                onClick={() => p.onSelectView?.(id)}
                                title={title}
                                className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-ui-11 font-medium transition-colors ${
                                    active
                                        ? 'bg-primary-container text-on-primary-container'
                                        : 'text-on-surface-variant hover:text-on-surface'
                                }`}
                            >
                                <Icon name={icon} size={13} />
                                {labels && <span>{label}</span>}
                                {count > 0 && (
                                    <span
                                        className={`rounded-full px-1 font-mono text-ui-9 ${
                                            active ? 'bg-on-primary-container/15 text-on-primary-container' : 'bg-surface-container-highest text-on-surface-variant'
                                        }`}
                                    >
                                        {count}
                                    </span>
                                )}
                            </button>
                        )
                    })}
                </div>
            )}

            {p.hiddenNames.length > 0 && (
                <button
                    onClick={p.onUnhide}
                    title={g.toolbar.unhideTitle({names: p.hiddenNames.join(', ')})}
                    className="flex shrink-0 items-center gap-1 rounded bg-tertiary-container px-1.5 py-0.5 text-ui-11 text-on-tertiary-container hover:opacity-90"
                >
                    <Icon name="visibility_off" size={13} />
                    {p.hiddenNames.length}
                </button>
            )}

            {/* --- acciones del repo ---------------------------------------- */}
            {repoActionsInline && (
                <>
                    <span className="mx-1 h-4 w-px shrink-0 bg-outline-variant" />
                    {p.forge && (
                        <>
                            <button onClick={p.onCreatePr} title={g.bar.createPrTitle({provider: p.forge.provider, branch: p.branchLabel})} aria-label={tb.createPr} className={`${btn} text-primary hover:text-primary`}>
                                <Icon name="call_merge" size={17} />
                            </button>
                            {/* Describir el PR va al lado de crearlo, que es
                                donde uno se queda mirando el formulario vacío. */}
                            <button onClick={p.onDescribePr} title={g.bar.describePrTitle} aria-label={tb.describePr} className={btn}>
                                <Icon name="auto_awesome" size={17} />
                            </button>
                        </>
                    )}
                    <DropdownMenu label="" icon="visibility" iconOnly title={g.viewMenu.title} width={300} items={p.viewItems} />
                </>
            )}

            {(!repoActionsInline || !rightExtrasInline) && (
                <DropdownMenu label="" icon="more_horiz" iconOnly title={tb.moreTitle} width={320} items={overflowItems} />
            )}

            {/* --- derecha: sincronizar, abrir, ajustes ---------------------- */}
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
                <DropdownMenu
                    label={labels ? g.toolbar.fetch : ''}
                    icon="cloud_download"
                    title={g.toolbar.fetchTitle}
                    mainTitle={tb.fetchMain}
                    onMain={p.onFetch}
                    items={p.fetchItems}
                    disabled={p.busy}
                    align="right"
                    iconOnly={!labels}
                />
                <DropdownMenu
                    label={labels ? g.toolbar.pull : ''}
                    icon="download"
                    title={g.toolbar.pullTitle}
                    mainTitle={p.behind > 0 ? tb.pullMainBehind({n: p.behind}) : tb.pullMain}
                    onMain={p.onPull}
                    items={p.pullItems}
                    disabled={p.busy}
                    badge={p.behind}
                    align="right"
                    iconOnly={!labels}
                />
                <DropdownMenu
                    label={labels ? g.toolbar.push : ''}
                    icon="upload"
                    title={g.toolbar.pushTitle}
                    mainTitle={p.ahead > 0 ? tb.pushMainAhead({n: p.ahead}) : tb.pushMain}
                    onMain={p.onPush}
                    items={p.pushItems}
                    disabled={p.busy}
                    badge={p.ahead}
                    align="right"
                    iconOnly={!labels}
                />

                {rightExtrasInline && (
                    <>
                        <span className="mx-1 h-4 w-px shrink-0 bg-outline-variant" />
                        <button onClick={p.onReload} disabled={p.busy} title={g.toolbar.reloadTitle} aria-label={tb.reload} className={btn}>
                            <Icon name="refresh" size={17} />
                        </button>
                        <DropdownMenu label="" icon="open_in_new" iconOnly title={tb.openInTitle} width={300} items={openInItems} align="right" />
                        {!p.panelOpen && (
                            <button onClick={p.onOpenAgentsPanel} data-open-agents title={g.bar.agentsTitle} aria-label={tb.agents} className={btn}>
                                <Icon name="forum" size={17} />
                            </button>
                        )}
                        <button onClick={p.onSettings} title={g.toolbar.settingsTitle} aria-label={tb.settings} className={btn}>
                            <Icon name="settings" size={17} />
                        </button>
                    </>
                )}
            </div>
        </div>
    )
}
