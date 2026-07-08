import {useEffect, useState} from 'react'
import {ListConnections} from '../../../wailsjs/go/main/App'
import {vault, db} from '../../../wailsjs/go/models'
import logo from '../../assets/logo.png'
import Icon from '../Icon'

interface ConnectionTreeProps {
    selectedId: string | null
    onSelect: (conn: vault.ConnectionSummary) => void
    onNewConnection: () => void
    onEditConnection: (conn: vault.ConnectionSummary) => void
    reloadToken: number
    metadata: db.SchemaMetadata | null
    // Every schema visible across metadata.tables (empty for SQLite, or for
    // Postgres/Oracle connections with no schema restriction configured —
    // see backend/db/metadata.go) and which one Workspace.tsx currently
    // treats as "active" for autocomplete/CLAUDE.md generation.
    schemas: string[]
    activeSchema: string | null
    onSelectSchema: (schema: string) => void
    onSyncSchema: (connId: string, schema: string) => Promise<void>
    onOpenTable: (table: string, schema?: string) => void
    onExportConnectionConfig: (connId: string) => void
    onExportTableDDL: (table: string, schema?: string) => void
    onDisconnect: (connId: string) => void
    onConfigureSchemas: (conn: vault.ConnectionSummary) => void
    collapsed: boolean
    onToggleCollapsed: () => void
    // True while GetSchemaMetadata is in flight for the selected connection
    // — without this, the table list under a freshly-selected connection
    // just looks empty/broken until the fetch resolves.
    metadataLoading: boolean
}

// Conexiones → schemas → tablas (spec: "árbol conexiones → schemas →
// tablas/vistas"). Schemas only render as their own expandable level when
// there's more than one to show (schemas.length > 0 — Postgres/Oracle with
// a restriction configured); otherwise falls back to the flat table list
// this always had (SQLite, or an unrestricted connection with a single
// implicit schema).
export default function ConnectionTree({
    selectedId,
    onSelect,
    onNewConnection,
    onEditConnection,
    reloadToken,
    metadata,
    schemas,
    activeSchema,
    onSelectSchema,
    onSyncSchema,
    onOpenTable,
    onExportConnectionConfig,
    onExportTableDDL,
    onDisconnect,
    onConfigureSchemas,
    collapsed,
    onToggleCollapsed,
    metadataLoading,
}: ConnectionTreeProps) {
    const [connections, setConnections] = useState<vault.ConnectionSummary[]>([])
    const [filter, setFilter] = useState('')
    // Which connection's table list is manually collapsed, independent of
    // which one is selected/active — lets you hide a long table list
    // without switching away from that connection. Cleared whenever a
    // different connection is selected, so selecting always shows its
    // tables by default.
    const [collapsedId, setCollapsedId] = useState<string | null>(null)
    // Filters the expanded connection's table list by name or schema — only
    // one connection can be expanded at a time, so a single shared piece of
    // state is enough (no need to key it per-connection).
    const [tableFilter, setTableFilter] = useState('')
    // Which schema nodes are expanded, and which one has a sync in flight
    // (shows a spinner on just that row) — both reset when a different
    // connection is selected, same as collapsedId/tableFilter above.
    const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set())
    const [syncingSchema, setSyncingSchema] = useState<string | null>(null)

    useEffect(() => {
        ListConnections().then(setConnections)
    }, [reloadToken])

    const filtered = connections.filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()))

    function selectConnection(c: vault.ConnectionSummary) {
        if (c.id !== selectedId) {
            setCollapsedId(null)
            setTableFilter('')
            setExpandedSchemas(new Set())
            setSyncingSchema(null)
        }
        onSelect(c)
    }

    function toggleSchema(schema: string) {
        setExpandedSchemas((prev) => {
            const next = new Set(prev)
            if (next.has(schema)) next.delete(schema)
            else next.add(schema)
            return next
        })
        onSelectSchema(schema)
    }

    async function syncSchema(connId: string, schema: string) {
        setSyncingSchema(schema)
        try {
            await onSyncSchema(connId, schema)
        } finally {
            setSyncingSchema(null)
        }
    }

    function renderTableRow(t: db.Table) {
        return (
            <div
                key={`${t.schema ?? ''}.${t.name}`}
                onDoubleClick={() => onOpenTable(t.name, t.schema)}
                title="Doble click: SELECT * LIMIT 100"
                className="group/table flex items-center gap-2 rounded px-2 py-1 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
            >
                <Icon name="table_chart" size={14} className="shrink-0 opacity-60" />
                <span className="truncate">{t.schema ? `${t.schema}.${t.name}` : t.name}</span>
                <div className="flex-1" />
                <button
                    onClick={(e) => {
                        e.stopPropagation()
                        onExportTableDDL(t.name, t.schema)
                    }}
                    title="Exportar DDL de la tabla"
                    className="hidden shrink-0 opacity-70 hover:opacity-100 group-hover/table:block"
                >
                    <Icon name="code" size={14} />
                </button>
            </div>
        )
    }

    function toggleExpand(c: vault.ConnectionSummary) {
        if (c.id !== selectedId) {
            selectConnection(c)
            return
        }
        setCollapsedId((prev) => (prev === c.id ? null : c.id))
    }

    return (
        <aside
            className={`flex h-full shrink-0 flex-col border-r border-outline-variant bg-surface-container-low text-on-surface transition-[width] duration-150 ${
                collapsed ? 'w-14' : 'w-64'
            }`}
        >
            <div className={`flex items-center border-b border-outline-variant p-3 ${collapsed ? 'justify-center' : 'gap-2'}`}>
                {!collapsed && (
                    <>
                        <img src={logo} alt="mini-tools" className="h-7 w-7 object-contain" />
                        <span className="flex-1 text-sm font-bold text-primary">mini-tools</span>
                    </>
                )}
                <button
                    onClick={onToggleCollapsed}
                    title={collapsed ? 'Expandir la barra de conexiones' : 'Minimizar la barra de conexiones (queda solo con íconos)'}
                    className="shrink-0 rounded p-1 text-on-surface-variant hover:bg-surface-variant"
                >
                    <Icon name={collapsed ? 'menu' : 'menu_open'} size={18} />
                </button>
            </div>
            <div className={`flex items-center p-3 pb-2 ${collapsed ? 'justify-center' : 'justify-between'}`}>
                {!collapsed && (
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">Conexiones</span>
                )}
                <button
                    onClick={onNewConnection}
                    title="Crea una nueva conexión a una base de datos (PostgreSQL, Oracle o SQLite)"
                    className="rounded p-1 text-primary hover:bg-surface-variant"
                >
                    <Icon name="add" size={18} />
                </button>
            </div>
            {!collapsed && (
                <div className="px-3">
                    <input
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        placeholder="Buscar..."
                        className="w-full rounded-lg border-none bg-surface-container-highest px-3 py-1.5 text-xs text-on-surface outline-none placeholder:text-on-surface-variant/60 focus:ring-1 focus:ring-primary"
                    />
                </div>
            )}
            <div className="mt-2 flex-1 overflow-y-auto py-1">
                {filtered.length === 0 && !collapsed && <p className="p-3 text-xs text-on-surface-variant/60">Sin conexiones todavía.</p>}
                {filtered.map((c) => {
                    const isSelected = c.id === selectedId
                    const isExpanded = !collapsed && isSelected && collapsedId !== c.id
                    return (
                        <div key={c.id} className="mb-0.5">
                            {collapsed ? (
                                <button
                                    onClick={() => selectConnection(c)}
                                    title={`${c.name} (${c.dbType}) — conectar y trabajar con esta conexión`}
                                    className={`flex w-full items-center justify-center py-2 transition-colors ${
                                        isSelected
                                            ? 'bg-primary-container text-on-primary-container'
                                            : 'text-on-surface-variant hover:bg-surface-variant'
                                    }`}
                                >
                                    <Icon name="storage" size={18} />
                                </button>
                            ) : (
                                <div
                                    className={`group flex w-full items-center gap-1 py-1.5 pl-2 pr-3 text-left text-sm transition-colors ${
                                        isSelected
                                            ? 'bg-primary-container text-on-primary-container'
                                            : 'text-on-surface-variant hover:bg-surface-variant'
                                    }`}
                                >
                                    <button
                                        onClick={() => toggleExpand(c)}
                                        title={isExpanded ? 'Contraer' : 'Expandir'}
                                        className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100"
                                    >
                                        <Icon name={isExpanded ? 'expand_more' : 'chevron_right'} size={18} />
                                    </button>
                                    <button
                                        onClick={() => selectConnection(c)}
                                        title={`Conectar y trabajar con "${c.name}" — se conecta si hace falta y la marca como conexión activa`}
                                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                    >
                                        <Icon name="storage" size={16} className="shrink-0 opacity-70" />
                                        <span className="truncate font-medium">{c.name}</span>
                                    </button>
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            onEditConnection(c)
                                        }}
                                        title="Editar conexión"
                                        className="hidden shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 group-hover:block"
                                    >
                                        <Icon name="edit" size={15} />
                                    </button>
                                    <button
                                        onClick={() => onExportConnectionConfig(c.id)}
                                        title="Exportar configuración (sin password)"
                                        className="hidden shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 group-hover:block"
                                    >
                                        <Icon name="output" size={15} />
                                    </button>
                                    {(c.dbType === 'postgres' || c.dbType === 'oracle') && (
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation()
                                                onConfigureSchemas(c)
                                            }}
                                            title="Elegir qué esquemas escanear"
                                            className="hidden shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 group-hover:block"
                                        >
                                            <Icon name="schema" size={15} />
                                        </button>
                                    )}
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            onDisconnect(c.id)
                                        }}
                                        title="Desconectar (mantiene la conexión guardada)"
                                        className="hidden shrink-0 rounded p-0.5 opacity-70 hover:text-error hover:opacity-100 group-hover:block"
                                    >
                                        <Icon name="power_settings_new" size={15} />
                                    </button>
                                </div>
                            )}

                            {isExpanded && metadataLoading && (
                                <div className="flex items-center gap-2 py-2 pl-7 text-xs text-on-surface-variant">
                                    <span
                                        aria-hidden
                                        className="h-3 w-3 animate-spin rounded-full border-2 border-t-transparent border-primary"
                                    />
                                    Cargando tablas…
                                </div>
                            )}

                            {isExpanded && !metadataLoading && metadata && (
                                <div className="pb-1 pl-7 pr-2">
                                    {metadata.tables.length > 4 && (
                                        <input
                                            value={tableFilter}
                                            onChange={(e) => setTableFilter(e.target.value)}
                                            placeholder="Filtrar tablas o esquema..."
                                            title="Filtra la lista de tablas de esta conexión por nombre o esquema"
                                            className="mb-1 w-full rounded border-none bg-surface-container-highest px-2 py-1 text-xs text-on-surface outline-none placeholder:text-on-surface-variant/60 focus:ring-1 focus:ring-primary"
                                        />
                                    )}
                                    {(() => {
                                        if (metadata.tables.length === 0) {
                                            return <p className="px-2 py-1 text-xs text-on-surface-variant/60">Sin tablas.</p>
                                        }

                                        const q = tableFilter.trim().toLowerCase()

                                        // Searching flattens across schemas — grouping only makes sense
                                        // when browsing everything, not when you already know what you
                                        // want. Same fallback for connections with no schema grouping
                                        // (SQLite, or unrestricted Oracle/Postgres).
                                        if (q || schemas.length === 0) {
                                            const visible = q
                                                ? metadata.tables.filter(
                                                      (t) => t.name.toLowerCase().includes(q) || (t.schema ?? '').toLowerCase().includes(q),
                                                  )
                                                : metadata.tables
                                            if (visible.length === 0) {
                                                return <p className="px-2 py-1 text-xs text-on-surface-variant/60">Sin coincidencias para "{tableFilter}".</p>
                                            }
                                            return visible.map((t) => renderTableRow(t))
                                        }

                                        return schemas.map((schema) => {
                                            const schemaExpanded = expandedSchemas.has(schema)
                                            const schemaTables = metadata.tables.filter((t) => t.schema === schema)
                                            return (
                                                <div key={schema} className="mb-0.5">
                                                    <div
                                                        className={`group/schema flex items-center gap-1 rounded px-1 py-1 text-xs ${
                                                            schema === activeSchema
                                                                ? 'font-semibold text-primary'
                                                                : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
                                                        }`}
                                                    >
                                                        <button
                                                            onClick={() => toggleSchema(schema)}
                                                            title={
                                                                schema === activeSchema
                                                                    ? `"${schema}" es el esquema activo (autocomplete/CLAUDE.md)`
                                                                    : `Ver tablas de "${schema}" y fijarlo como esquema activo`
                                                            }
                                                            className="flex min-w-0 flex-1 items-center gap-1 text-left"
                                                        >
                                                            <Icon name={schemaExpanded ? 'expand_more' : 'chevron_right'} size={14} className="shrink-0" />
                                                            <Icon name="schema" size={14} className="shrink-0 opacity-70" />
                                                            <span className="truncate">{schema}</span>
                                                            <span className="shrink-0 opacity-60">({schemaTables.length})</span>
                                                        </button>
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation()
                                                                void syncSchema(c.id, schema)
                                                            }}
                                                            disabled={syncingSchema === schema}
                                                            title={`Sincroniza solo el esquema "${schema}" contra la base de datos — no toca los demás esquemas ya cargados`}
                                                            className="hidden shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 disabled:opacity-40 group-hover/schema:block"
                                                        >
                                                            <Icon
                                                                name="sync"
                                                                size={13}
                                                                className={syncingSchema === schema ? 'animate-spin' : ''}
                                                            />
                                                        </button>
                                                    </div>
                                                    {schemaExpanded && (
                                                        <div className="pl-4">
                                                            {schemaTables.length === 0 ? (
                                                                <p className="px-2 py-1 text-xs text-on-surface-variant/60">Sin tablas.</p>
                                                            ) : (
                                                                schemaTables.map((t) => renderTableRow(t))
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            )
                                        })
                                    })()}
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>
        </aside>
    )
}
