import {useState, type MouseEvent as ReactMouseEvent, type ReactNode} from 'react'
import {db} from '../../../wailsjs/go/models'
import type {DDLObjectType} from '../DDLViewerModal'
import TreeRow from './TreeRow'
import {MenuButton, type TreeMenuEntry} from './TreeMenu'
import {useT} from '../../i18n'

export interface OpenDDLParams {
    objectType: DDLObjectType
    schema: string
    name: string
    oid: number
}

interface SchemaObjectsListProps {
    procedures: db.Procedure[]
    functions: db.Function[]
    triggers: db.Trigger[]
    packages: db.Package[]
    onOpenDDL: (params: OpenDDLParams) => void
    // Profundidad de las categorías en el árbol de ConnectionTree: cuelgan
    // del esquema (o de la conexión, sin esquemas) y sus objetos un nivel más
    // adentro. Las guías verticales salen de ahí.
    depth: number
    // El menú contextual es el del árbol entero (useTreeMenu en
    // ConnectionTree): uno solo abierto a la vez, se abra desde donde se abra.
    openMenu: (e: ReactMouseEvent, items: TreeMenuEntry[]) => void
    // True while ConnectionTree.tsx's object filter is non-empty — every
    // category with a surviving match shows expanded automatically, same
    // "search flattens, no manual expand needed" principle already used
    // for folders and the flat table list there.
    forceExpanded?: boolean
}

type Category = 'procedures' | 'functions' | 'triggers' | 'packages'

const CATEGORY_ICONS: Record<Category, string> = {
    procedures: 'terminal',
    functions: 'functions',
    triggers: 'bolt',
    packages: 'inventory_2',
}

interface ObjectRow {
    key: string
    params: OpenDDLParams
    // Dato corto a la derecha: el tipo que devuelve una función, la tabla de
    // un trigger. Es lo que distingue dos objetos de nombre parecido.
    hint?: string
}

const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {})

// Renders the procedures/functions/triggers/packages scanned alongside a
// connection's tables (backend/db/metadata.go) as 4 collapsible categories
// — same chevron+icon+count rows ConnectionTree.tsx uses for its per-schema
// table grouping. A category with 0 elements renders nothing at all (most
// engines/schemas won't have all 4 — SQLite only ever has triggers,
// Postgres never has packages). One click opens the DDL viewer (unlike
// table rows, which double-click to insert a query — these objects have no
// equivalent "run" action, so a single click for their one and only action
// is the more direct interaction, no ambiguity to avoid). Has no search of
// its own — ConnectionTree.tsx's objectFilter already filters them before
// they ever reach this component; forceExpanded is how it's told a filter is
// active, so a category with a surviving match doesn't stay collapsed behind
// a manual click.
export default function SchemaObjectsList({procedures, functions, triggers, packages, onOpenDDL, depth, openMenu, forceExpanded}: SchemaObjectsListProps) {
    const t = useT()
    const o = t.sidebar.connections.objects
    const [expanded, setExpanded] = useState<Set<Category>>(new Set())

    function toggle(category: Category) {
        setExpanded((prev) => {
            const next = new Set(prev)
            if (next.has(category)) next.delete(category)
            else next.add(category)
            return next
        })
    }

    const objectMenu = (e: ReactMouseEvent, p: OpenDDLParams) => {
        const qualified = p.schema ? `${p.schema}.${p.name}` : p.name
        openMenu(e, [
            {label: o.viewDDL, icon: 'code', onSelect: () => onOpenDDL(p)},
            'separator',
            {label: o.copyName, icon: 'content_copy', onSelect: () => copy(p.name)},
            ...(p.schema
                ? [{label: o.copyQualified, icon: 'content_copy', hint: qualified, title: o.copyQualifiedTitle({name: qualified}), onSelect: () => copy(qualified)}]
                : []),
        ])
    }

    function renderCategory(category: Category, rows: ObjectRow[]): ReactNode {
        if (rows.length === 0) return null
        const isExpanded = forceExpanded || expanded.has(category)
        const label = o.categories[category]
        return (
            <div key={category}>
                <TreeRow
                    depth={depth}
                    icon={CATEGORY_ICONS[category]}
                    label={label}
                    title={o.categoryTitle({expanded: isExpanded, label, count: rows.length})}
                    expanded={isExpanded}
                    onToggle={() => toggle(category)}
                    onClick={() => toggle(category)}
                    onContextMenu={(e) =>
                        openMenu(e, [
                            {
                                label: isExpanded ? t.common.collapse : t.common.expand,
                                icon: isExpanded ? 'unfold_less' : 'unfold_more',
                                disabled: forceExpanded,
                                title: forceExpanded ? o.filterKeepsOpen : undefined,
                                onSelect: () => toggle(category),
                            },
                        ])
                    }
                    trailing={<span className="text-ui-10 tabular-nums text-on-surface-variant/50">{rows.length}</span>}
                />
                {isExpanded &&
                    rows.map((r) => (
                        <TreeRow
                            key={r.key}
                            depth={depth + 1}
                            icon={CATEGORY_ICONS[category]}
                            iconClass="text-on-surface-variant/70"
                            label={r.params.name}
                            labelClass="text-on-surface-variant"
                            title={o.objectTitle({name: `${r.params.schema ? `${r.params.schema}.` : ''}${r.params.name}`})}
                            onClick={() => onOpenDDL(r.params)}
                            onContextMenu={(e) => objectMenu(e, r.params)}
                            trailing={r.hint ? <span className="max-w-[90px] truncate text-ui-10 text-on-surface-variant/50">→ {r.hint}</span> : undefined}
                            actions={<MenuButton onOpen={(e) => objectMenu(e, r.params)} title={o.objectOptions} />}
                        />
                    ))}
            </div>
        )
    }

    return (
        <>
            {renderCategory(
                'procedures',
                procedures.map((p) => ({
                    key: `${p.schema ?? ''}.${p.name}`,
                    params: {objectType: 'procedure', schema: p.schema ?? '', name: p.name, oid: p.oid ?? 0},
                })),
            )}
            {renderCategory(
                'functions',
                functions.map((f) => ({
                    key: `${f.schema ?? ''}.${f.name}.${f.oid ?? 0}`,
                    params: {objectType: 'function', schema: f.schema ?? '', name: f.name, oid: f.oid ?? 0},
                    hint: f.returnType || undefined,
                })),
            )}
            {renderCategory(
                'triggers',
                triggers.map((tr) => ({
                    key: `${tr.schema ?? ''}.${tr.name}`,
                    params: {objectType: 'trigger', schema: tr.schema ?? '', name: tr.name, oid: tr.oid ?? 0},
                    hint: tr.table || undefined,
                })),
            )}
            {renderCategory(
                'packages',
                packages.map((pkg) => ({
                    key: `${pkg.schema ?? ''}.${pkg.name}`,
                    params: {objectType: 'package', schema: pkg.schema ?? '', name: pkg.name, oid: 0},
                })),
            )}
        </>
    )
}
