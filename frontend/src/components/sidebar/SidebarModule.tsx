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
        // Collapsed: shrink-0, just its header row (see the first bug fixed
        // here — collapsing one module used to still leave it holding an
        // equal flex share of the sidebar as dead space above the next
        // module's header).
        //
        // Expanded: flex-initial (flex: 0 1 auto), NOT flex-1. Real bug
        // found live, round two: flex-1 (flex: 1 1 0%) always grows to fill
        // 100% of whatever space the OTHER module (collapsed, shrink-0)
        // isn't using — so a module with sparse content (a couple of
        // folders) still stretched to consume the sidebar's entire
        // remaining height, shoving the next module's header all the way to
        // the bottom behind a huge blank gap, even though nothing was
        // actually fighting it for space. flex-initial sizes to the
        // module's own content instead, so two sparse modules stack close
        // together and any true leftover space ends up trailing after the
        // LAST module (reads as normal empty space, not a broken gap
        // mid-list) — while still allowing this to shrink (min-h-0 below)
        // and hand off to its children's own overflow-y-auto when content
        // genuinely doesn't fit (a long connection list still scrolls
        // internally instead of blowing out the sidebar's fixed height).
        <div className={`flex flex-col ${collapsed ? 'shrink-0' : 'min-h-0 flex-initial'}`}>
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
