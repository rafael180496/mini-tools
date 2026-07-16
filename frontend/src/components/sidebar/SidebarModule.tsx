import type {ReactNode} from 'react'
import Icon from '../Icon'

interface SidebarModuleProps {
    title: string
    collapsed: boolean
    onToggleCollapsed: () => void
    // Extra header controls (e.g. ConnectionTree's "+ nueva conexión"
    // button) rendered to the right of the title, always visible
    // regardless of collapsed state.
    actions?: ReactNode
    children: ReactNode
}

// Thin collapsible accordion wrapper for one sidebar section ("módulo") —
// today only "Conexiones" (ConnectionTree) uses it, but it's deliberately
// generic so a future module (e.g. Git) can reuse it as a sibling without
// any changes here. Distinct from the whole-sidebar icon-only rail mode
// (ConnectionTree's own `collapsed`/`onToggleCollapsed` prop, unrelated) —
// this only hides ONE module's body; the header stays visible so it can be
// re-expanded, which is the whole point ("no se vea saturado" without
// losing discoverability).
export default function SidebarModule({title, collapsed, onToggleCollapsed, actions, children}: SidebarModuleProps) {
    return (
        // flex-1 only while expanded — collapsed, this must shrink to just
        // its header row (shrink-0), not keep claiming an equal flex share
        // of the sidebar's height. Real bug found live: with two modules
        // stacked (Conexiones + SSH), collapsing one still left it holding
        // half the sidebar as dead space above the other's header, reading
        // as a giant blank gap instead of a tight accordion stack.
        <div className={`flex flex-col ${collapsed ? 'shrink-0' : 'min-h-0 flex-1'}`}>
            <div className="flex items-center justify-between gap-1 px-3 pb-2 pt-3">
                <button
                    onClick={onToggleCollapsed}
                    title={collapsed ? `Expandir el módulo "${title}"` : `Colapsar el módulo "${title}"`}
                    className="flex min-w-0 flex-1 items-center gap-1 text-left"
                >
                    <Icon name={collapsed ? 'chevron_right' : 'expand_more'} size={16} className="shrink-0 opacity-70" />
                    <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">{title}</span>
                </button>
                {actions}
            </div>
            {!collapsed && <div className="flex min-h-0 flex-1 flex-col">{children}</div>}
        </div>
    )
}
