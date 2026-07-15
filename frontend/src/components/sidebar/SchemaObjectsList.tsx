import {useState, type ReactNode} from 'react'
import {db} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import type {DDLObjectType} from '../DDLViewerModal'

interface OpenDDLParams {
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
    // True while ConnectionTree.tsx's object filter is non-empty — every
    // category with a surviving match shows expanded automatically, same
    // "search flattens, no manual expand needed" principle already used
    // for folders and the flat table list there.
    forceExpanded?: boolean
}

type Category = 'procedures' | 'functions' | 'triggers' | 'packages'

const CATEGORY_LABELS: Record<Category, string> = {
    procedures: 'Procedures',
    functions: 'Functions',
    triggers: 'Triggers',
    packages: 'Packages',
}

const CATEGORY_ICONS: Record<Category, string> = {
    procedures: 'terminal',
    functions: 'functions',
    triggers: 'bolt',
    packages: 'inventory_2',
}

// Renders the procedures/functions/triggers/packages scanned alongside a
// connection's tables (backend/db/metadata.go) as 4 collapsible categories
// — same chevron+icon+count visual pattern ConnectionTree.tsx already uses
// for its per-schema table grouping. A category with 0 elements renders
// nothing at all (most engines/schemas won't have all 4 — SQLite only ever
// has triggers, Postgres never has packages). One click opens the DDL
// viewer (unlike table rows, which double-click to insert a query — these
// objects have no equivalent "run" action, so a single click for their one
// and only action is the more direct interaction, no ambiguity to avoid).
// Has no search/filter of its own — ConnectionTree.tsx's objectFilter
// already filters procedures/functions/triggers/packages before they ever
// reach this component; forceExpanded is how it's told a filter is active,
// so a category with a surviving match doesn't stay collapsed behind a
// manual click.
export default function SchemaObjectsList({procedures, functions, triggers, packages, onOpenDDL, forceExpanded}: SchemaObjectsListProps) {
    const [expanded, setExpanded] = useState<Set<Category>>(new Set())

    function toggle(category: Category) {
        setExpanded((prev) => {
            const next = new Set(prev)
            if (next.has(category)) next.delete(category)
            else next.add(category)
            return next
        })
    }

    function renderCategory(category: Category, count: number, body: ReactNode) {
        if (count === 0) return null
        const isExpanded = forceExpanded || expanded.has(category)
        return (
            <div key={category} className="mb-0.5">
                <button
                    onClick={() => toggle(category)}
                    title={`${isExpanded ? 'Contraer' : 'Ver'} ${CATEGORY_LABELS[category].toLowerCase()}`}
                    className="group/objcat flex w-full items-center gap-1 rounded px-1 py-1 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name={isExpanded ? 'expand_more' : 'chevron_right'} size={14} className="shrink-0" />
                    <Icon name={CATEGORY_ICONS[category]} size={14} className="shrink-0 opacity-70" />
                    <span className="truncate">{CATEGORY_LABELS[category]}</span>
                    <span className="shrink-0 opacity-60">({count})</span>
                </button>
                {isExpanded && <div className="pl-4">{body}</div>}
            </div>
        )
    }

    return (
        <>
            {renderCategory(
                'procedures',
                procedures.length,
                procedures.map((p) => (
                    <div
                        key={`${p.schema ?? ''}.${p.name}`}
                        onClick={() => onOpenDDL({objectType: 'procedure', schema: p.schema ?? '', name: p.name, oid: p.oid ?? 0})}
                        title="Click: ver DDL actual"
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="terminal" size={14} className="shrink-0 opacity-60" />
                        <span className="truncate">{p.name}</span>
                    </div>
                )),
            )}
            {renderCategory(
                'functions',
                functions.length,
                functions.map((f) => (
                    <div
                        key={`${f.schema ?? ''}.${f.name}.${f.oid ?? 0}`}
                        onClick={() => onOpenDDL({objectType: 'function', schema: f.schema ?? '', name: f.name, oid: f.oid ?? 0})}
                        title="Click: ver DDL actual"
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="functions" size={14} className="shrink-0 opacity-60" />
                        <span className="truncate">{f.name}</span>
                        {f.returnType && <span className="shrink-0 opacity-60">→ {f.returnType}</span>}
                    </div>
                )),
            )}
            {renderCategory(
                'triggers',
                triggers.length,
                triggers.map((t) => (
                    <div
                        key={`${t.schema ?? ''}.${t.name}`}
                        onClick={() => onOpenDDL({objectType: 'trigger', schema: t.schema ?? '', name: t.name, oid: t.oid ?? 0})}
                        title="Click: ver DDL actual"
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="bolt" size={14} className="shrink-0 opacity-60" />
                        <span className="truncate">{t.name}</span>
                        {t.table && <span className="shrink-0 truncate opacity-60">→ {t.table}</span>}
                    </div>
                )),
            )}
            {renderCategory(
                'packages',
                packages.length,
                packages.map((pkg) => (
                    <div
                        key={`${pkg.schema ?? ''}.${pkg.name}`}
                        onClick={() => onOpenDDL({objectType: 'package', schema: pkg.schema ?? '', name: pkg.name, oid: 0})}
                        title="Click: ver DDL actual"
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="inventory_2" size={14} className="shrink-0 opacity-60" />
                        <span className="truncate">{pkg.name}</span>
                    </div>
                )),
            )}
        </>
    )
}
