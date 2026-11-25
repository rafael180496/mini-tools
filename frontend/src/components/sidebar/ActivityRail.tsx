import type {ReactNode} from 'react'
import Icon from '../Icon'
import {useT} from '../../i18n'

export type SidebarModuleId = 'connections' | 'ssh' | 'git' | 'notes' | 'http' | 'utilities'

const MODULE_IDS: readonly string[] = ['connections', 'ssh', 'git', 'notes', 'http', 'utilities']

export function sidebarModuleFromSettings(saved: string): SidebarModuleId {
    if (MODULE_IDS.includes(saved)) return saved as SidebarModuleId
    return saved === 'ai' ? 'utilities' : 'connections'
}

export interface SidebarModuleDef {
    id: SidebarModuleId
    icon: string
    label: string
    hint: string
    matchCount: number | null
    badge?: {count: number; title: string; tone: 'primary' | 'tertiary'}
}

interface ActivityRailProps {
    modules: SidebarModuleDef[]
    activeModule: SidebarModuleId
    collapsed: boolean
    onToggleCollapsed: () => void
    onSelectModule: (id: SidebarModuleId) => void
    footer: ReactNode
}

// Rail vertical fijo de la izquierda (Fase 2 ADE — inspirado en Deck/Herdr).
// Reemplaza la barra colapsada separada y el menú horizontal superior del
// explorador: los 6 módulos + Spaces/Agents viven siempre a un clic.
export default function ActivityRail({
    modules,
    activeModule,
    collapsed,
    onToggleCollapsed,
    onSelectModule,
    footer,
}: ActivityRailProps) {
    const t = useT()

    return (
        <nav
            aria-label={t.shell.ade.rail.spacesAgents}
            className="ade-pane flex h-full w-11 shrink-0 flex-col items-center py-2 text-on-surface"
        >
            <button
                type="button"
                onClick={onToggleCollapsed}
                title={collapsed ? t.shell.sidebar.expand : t.shell.sidebar.collapse}
                className="ade-rail-btn mb-1.5"
            >
                <Icon name={collapsed ? 'left_panel_open' : 'left_panel_close'} size={18} />
            </button>

            <div className="mb-1.5 h-px w-6 bg-outline-variant/70" />

            {/* Los 6 módulos originales de mini-tools */}
            <div className="flex flex-col items-center gap-1">
                {modules.map((m) => {
                    const isActive = !collapsed && m.id === activeModule
                    const hasMatches = m.matchCount != null && m.matchCount > 0
                    return (
                        <button
                            key={m.id}
                            type="button"
                            data-active={isActive ? 'true' : undefined}
                            onClick={() => onSelectModule(m.id)}
                            title={
                                (isActive
                                    ? t.shell.masterMenu.activeTitle({label: m.label, hint: m.hint})
                                    : m.matchCount != null
                                      ? t.shell.masterMenu.matchesTitle({label: m.label, hint: m.hint, count: m.matchCount})
                                      : t.shell.masterMenu.title({label: m.label, hint: m.hint})) +
                                (m.badge && m.badge.count > 0 ? `. ${m.badge.title}` : '')
                            }
                            className="ade-rail-btn relative"
                        >
                            <Icon name={m.icon} size={18} />
                            {hasMatches && (
                                <span className="absolute -right-0.5 -top-0.5 min-w-3.5 rounded-full bg-primary px-1 text-center font-mono text-ui-9 font-bold leading-tight text-on-primary">
                                    {m.matchCount! > 99 ? '99+' : m.matchCount}
                                </span>
                            )}
                            {m.matchCount === 0 && (
                                <span aria-hidden className="pointer-events-none absolute inset-0 rounded-xl bg-surface-container-low/55" />
                            )}
                            {m.badge && m.badge.count > 0 && !hasMatches && (
                                <span
                                    data-module-badge={m.id}
                                    title={m.badge.title}
                                    className={`absolute -right-0.5 -top-0.5 min-w-3.5 rounded-full px-1 text-center font-mono text-ui-9 font-bold leading-tight ${
                                        m.badge.tone === 'tertiary'
                                            ? 'bg-tertiary text-on-tertiary'
                                            : 'bg-primary text-on-primary'
                                    }`}
                                >
                                    {m.badge.count > 99 ? '99+' : m.badge.count}
                                </span>
                            )}
                        </button>
                    )
                })}

                <div className="my-1 h-px w-6 bg-outline-variant/70" />
            </div>

            <div className="mt-auto flex flex-col items-center gap-0.5 pt-2">{footer}</div>
        </nav>
    )
}
