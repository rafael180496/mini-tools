import {useEffect, useState, type ReactNode} from 'react'
import {ListConnections} from '../../../wailsjs/go/main/App'
import {vault, db} from '../../../wailsjs/go/models'
import logo from '../../assets/logo.png'
import ConfirmDialog from '../ConfirmDialog'
import DbTypeIcon from '../DbTypeIcon'
import Icon from '../Icon'
import RedisKeyTree from '../redis/RedisKeyTree'
import MongoCollectionTree from '../mongo/MongoCollectionTree'
import SidebarModule from './SidebarModule'
import SchemaObjectsList from './SchemaObjectsList'
import MoveToFolderMenu, {flattenForMenu} from './MoveToFolderMenu'
import type {DDLObjectType} from '../DDLViewerModal'
import {likeToRegExp} from '../../lib/likePattern'
import {buildFolderTree, type FolderNode} from '../../lib/folderTree'

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
    // Opens the DDL viewer modal for a scanned procedure/function/trigger/
    // package (see SchemaObjectsList) — single click, unlike onOpenTable's
    // double-click-to-insert-query (these objects have no query to insert).
    onOpenObjectDDL: (connId: string, params: {objectType: DDLObjectType; schema: string; name: string; oid: number}) => void
    // Redis connections have no tables/schemas — double-clicking a key in
    // RedisKeyTree (rendered instead of the table list below when
    // c.dbType === 'redis') opens the value inspector via this instead of
    // onOpenTable.
    onOpenRedisKey: (connId: string, key: string) => void
    onOpenMongoCollection: (connId: string, database: string, collection: string) => void
    onSelectMongoDatabase: (connId: string, database: string) => void
    onOpenMongoBrowser: (conn: vault.ConnectionSummary) => void
    // Opens (or focuses) the Redis Browser tab (full-tab key list + editable
    // detail panel, see RedisBrowserTab.tsx) for a Redis connection —
    // additive to the inline RedisKeyTree already shown below when this row
    // is expanded, not a replacement for it.
    onOpenRedisBrowser: (conn: vault.ConnectionSummary) => void
    // Which connection the ACTIVE editor tab is bound to, if any — passed
    // through to RedisKeyTree so it only feeds the command editor's key
    // suggestions when it's showing that same connection (see
    // RedisKeyTree's isActiveTabConnection prop).
    activeTabConnectionId: string | null
    onExportConnectionConfig: (connId: string) => void
    onExportTableDDL: (table: string, schema?: string) => void
    onExportSchemaDDL: (connId: string) => void
    onDisconnect: (connId: string) => void
    // Permanently removes the saved connection from the vault — destructive,
    // gated behind a ConfirmDialog here (never window.confirm, see
    // .claude/rules/conventions.md). Any editor tab bound to this connId
    // loses only the binding, never its content (see Workspace.tsx's
    // deleteConnection).
    onDeleteConnection: (connId: string) => void
    onConfigureSchemas: (conn: vault.ConnectionSummary) => void
    collapsed: boolean
    onToggleCollapsed: () => void
    // True while GetSchemaMetadata is in flight for the selected connection
    // — without this, the table list under a freshly-selected connection
    // just looks empty/broken until the fetch resolves.
    metadataLoading: boolean
    // Folder tree (organizational only — never affects which connection is
    // "selected"/active). moduleCollapsed/onToggleModuleCollapsed is the
    // "Conexiones" accordion header (SidebarModule) — distinct from
    // collapsed/onToggleCollapsed above, which is the whole-sidebar
    // icon-only rail mode.
    folders: vault.Folder[]
    moduleCollapsed: boolean
    onToggleModuleCollapsed: () => void
    onCreateFolder: (name: string, parentId: string) => void
    onRenameFolder: (id: string, name: string) => void
    onDeleteFolder: (id: string) => void
    onReorderFolder: (id: string, direction: 'up' | 'down') => void
    onMoveConnectionToFolder: (connId: string, folderId: string) => void
    // SSH connections get their own sidebar module (SshConnectionTree.tsx) —
    // a fundamentally different interaction (open a terminal, not browse a
    // schema) that doesn't belong mixed into "Conexiones". Rendered here, as
    // a sibling SidebarModule below "Conexiones" inside the same <aside>, so
    // both share this component's header/rail-mode chrome instead of
    // duplicating it. Only shown in the expanded (non-rail) sidebar — the
    // icon-only collapsed rail below still lists every connection type
    // together (see the `collapsed` branch), same as before this module
    // existed.
    extraModules?: ReactNode
}

// Conexiones → carpetas (árbol de proyecto) → schemas → tablas/vistas.
// Folders are purely organizational (never affect selection/execution) —
// see backend/vault/folders_repo.go. Schemas only render as their own
// expandable level when there's more than one to show (schemas.length > 0
// — Postgres/Oracle with a restriction configured); otherwise falls back to
// the flat table list this always had (SQLite, or an unrestricted
// connection with a single implicit schema).
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
    onOpenObjectDDL,
    onOpenRedisKey,
    onOpenMongoCollection,
    onSelectMongoDatabase,
    onOpenMongoBrowser,
    onOpenRedisBrowser,
    activeTabConnectionId,
    onExportConnectionConfig,
    onExportTableDDL,
    onExportSchemaDDL,
    onDisconnect,
    onDeleteConnection,
    onConfigureSchemas,
    collapsed,
    onToggleCollapsed,
    metadataLoading,
    folders,
    moduleCollapsed,
    onToggleModuleCollapsed,
    onCreateFolder,
    onRenameFolder,
    onDeleteFolder,
    onReorderFolder,
    onMoveConnectionToFolder,
    extraModules,
}: ConnectionTreeProps) {
    const [connections, setConnections] = useState<vault.ConnectionSummary[]>([])
    const [filter, setFilter] = useState('')
    // Which connection is pending a delete confirmation — a themed
    // ConfirmDialog (never window.confirm), holds the connection so its
    // name can be shown in the confirmation text.
    const [confirmDelete, setConfirmDelete] = useState<vault.ConnectionSummary | null>(null)
    const [confirmDeleteFolder, setConfirmDeleteFolder] = useState<vault.Folder | null>(null)
    // Which connection's table list is manually collapsed, independent of
    // which one is selected/active — lets you hide a long table list
    // without switching away from that connection. Cleared whenever a
    // different connection is selected, so selecting always shows its
    // tables by default.
    const [collapsedId, setCollapsedId] = useState<string | null>(null)
    // Filters the expanded connection's tables AND scanned procedures/
    // functions/triggers/packages (see SchemaObjectsList) by name or
    // schema — only one connection can be expanded at a time, so a single
    // shared piece of state is enough (no need to key it per-connection).
    const [objectFilter, setObjectFilter] = useState('')
    // Which schema nodes are expanded, and which one has a sync in flight
    // (shows a spinner on just that row) — both reset when a different
    // connection is selected, same as collapsedId/objectFilter above.
    const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set())
    const [syncingSchema, setSyncingSchema] = useState<string | null>(null)
    // Which schemas' "Tablas" category is manually collapsed — a schema
    // with hundreds of tables (this is real, not hypothetical: a 342-table
    // `public` schema is what prompted this) otherwise buries the
    // procedures/functions/triggers/packages categories below it in an
    // unavoidable wall of table rows. Empty by default (expanded, same as
    // before this existed) — collapsing is opt-in per schema, same
    // "collapsed" framing (not "expanded") as SchemaObjectsList's own
    // per-category state, and reset on connection change same as
    // expandedSchemas above.
    const [collapsedTableSchemas, setCollapsedTableSchemas] = useState<Set<string>>(new Set())
    // Which folder nodes are manually expanded — overridden (everything
    // relevant force-shown) while a search is active, same "flatten while
    // searching" behavior the table filter below already has.
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
    // "" = creating a folder at root, a folder id = creating a subfolder
    // inside it, null = not creating.
    const [creatingFolderParentId, setCreatingFolderParentId] = useState<string | null>(null)
    const [newFolderName, setNewFolderName] = useState('')
    const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)
    const [renameFolderName, setRenameFolderName] = useState('')

    useEffect(() => {
        ListConnections().then(setConnections)
    }, [reloadToken])

    // This module is DB connections only — SSH has its own sidebar module
    // (SshConnectionTree.tsx, rendered via extraModules below) with its own
    // independent folder tree (vault.Folder.Scope — see the doc comment on
    // that field). Only the collapsed icon-rail branch further down still
    // uses the unfiltered `connections` (it has no module boundaries at
    // all, see its own comment).
    const dbConnections = connections.filter((c) => c.dbType !== 'ssh')
    const dbFolders = folders.filter((f) => f.scope === 'db')

    const q = filter.trim().toLowerCase()
    const connectionMatches = (c: vault.ConnectionSummary) => !q || c.name.toLowerCase().includes(q)
    const folderNameMatches = (f: vault.Folder) => !q || f.name.toLowerCase().includes(q)
    const folderTree = buildFolderTree(dbFolders)
    const flatFoldersForMenu = flattenForMenu(folderTree)

    // Tables + every scanned schema object type together — drives both
    // whether the object filter input shows at all (a connection with few
    // tables but many procedures still needs to be able to filter) and the
    // "no objects at all" empty state below.
    const totalObjectCount = metadata
        ? metadata.tables.length +
          (metadata.procedures?.length ?? 0) +
          (metadata.functions?.length ?? 0) +
          (metadata.triggers?.length ?? 0) +
          (metadata.packages?.length ?? 0)
        : 0

    function folderHasVisibleContent(node: FolderNode): boolean {
        // A folder mid-creation of a new subfolder must stay visible even if
        // it doesn't itself match an active search filter — otherwise
        // starting "Nueva subcarpeta" on a filtered-out folder makes both
        // the folder and the input you're typing into vanish immediately.
        if (creatingFolderParentId === node.folder.id) return true
        if (folderNameMatches(node.folder)) return true
        if (dbConnections.some((c) => c.folderId === node.folder.id && connectionMatches(c))) return true
        return node.children.some(folderHasVisibleContent)
    }

    function isFolderExpanded(id: string): boolean {
        if (q) return true
        return expandedFolders.has(id)
    }

    const rootConnections = dbConnections.filter((c) => !c.folderId && connectionMatches(c))
    const visibleFolderNodes = folderTree.filter((node) => !q || folderHasVisibleContent(node))

    function selectConnection(c: vault.ConnectionSummary) {
        if (c.id !== selectedId) {
            setCollapsedId(null)
            setObjectFilter('')
            setExpandedSchemas(new Set())
            setSyncingSchema(null)
            setCollapsedTableSchemas(new Set())
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

    function toggleTableCategory(schema: string) {
        setCollapsedTableSchemas((prev) => {
            const next = new Set(prev)
            if (next.has(schema)) next.delete(schema)
            else next.add(schema)
            return next
        })
    }

    async function syncSchema(connId: string, schema: string) {
        setSyncingSchema(schema)
        try {
            await onSyncSchema(connId, schema)
        } finally {
            setSyncingSchema(null)
        }
    }

    function toggleFolder(id: string) {
        setExpandedFolders((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    function startCreateFolder(parentId: string) {
        setExpandedFolders((prev) => (parentId ? new Set(prev).add(parentId) : prev))
        setCreatingFolderParentId(parentId)
        setNewFolderName('')
    }

    function commitCreateFolder() {
        const name = newFolderName.trim()
        if (name && creatingFolderParentId !== null) {
            onCreateFolder(name, creatingFolderParentId)
        }
        setCreatingFolderParentId(null)
        setNewFolderName('')
    }

    function startRenameFolder(f: vault.Folder) {
        setRenamingFolderId(f.id)
        setRenameFolderName(f.name)
    }

    function commitRenameFolder() {
        const name = renameFolderName.trim()
        if (name && renamingFolderId) {
            onRenameFolder(renamingFolderId, name)
        }
        setRenamingFolderId(null)
    }

    function renderNewFolderInput() {
        return (
            <input
                autoFocus
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onBlur={commitCreateFolder}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') commitCreateFolder()
                    if (e.key === 'Escape') {
                        setCreatingFolderParentId(null)
                        setNewFolderName('')
                    }
                }}
                placeholder="Nombre de la carpeta..."
                className="mb-1 w-full rounded border-none bg-surface-container-highest px-2 py-1 text-xs text-on-surface outline-none placeholder:text-on-surface-variant/60 focus:ring-1 focus:ring-primary"
            />
        )
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

    function renderConnectionRow(c: vault.ConnectionSummary, depth: number) {
        const isSelected = c.id === selectedId
        const isExpanded = !collapsed && isSelected && collapsedId !== c.id
        return (
            <div key={c.id} className="mb-0.5">
                {collapsed ? (
                    <button
                        onClick={() => selectConnection(c)}
                        title={`${c.name} (${c.dbType}) — conectar y trabajar con esta conexión`}
                        className={`flex w-full items-center justify-center py-2 transition-colors ${
                            isSelected ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-variant'
                        }`}
                    >
                        <DbTypeIcon dbType={c.dbType} size={18} />
                    </button>
                ) : (
                    <div
                        style={{paddingLeft: `${8 + depth * 14}px`}}
                        className={`group flex w-full items-center gap-1 py-1.5 pr-3 text-left text-sm transition-colors ${
                            isSelected ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-variant'
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
                            onDoubleClick={() => {
                                if (c.dbType === 'redis') onOpenRedisBrowser(c)
                                else if (c.dbType === 'mongodb') onOpenMongoBrowser(c)
                            }}
                            title={
                                c.dbType === 'redis'
                                    ? `Click: seleccionar "${c.name}" y ver sus keys acá abajo. Doble click: abrir el Redis Browser en una pestaña completa.`
                                    : c.dbType === 'mongodb'
                                      ? `Click: seleccionar "${c.name}" y ver sus bases/colecciones acá abajo. Doble click: abrir el MongoDB Browser en una pestaña completa.`
                                      : `Conectar y trabajar con "${c.name}" — se conecta si hace falta y la marca como conexión activa`
                            }
                            className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        >
                            <DbTypeIcon dbType={c.dbType} size={16} />
                            {c.color && (
                                <span
                                    aria-hidden
                                    title="Color de esta conexión"
                                    className="h-2 w-2 shrink-0 rounded-full"
                                    style={{backgroundColor: c.color}}
                                />
                            )}
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
                        <MoveToFolderMenu connId={c.id} flatFolders={flatFoldersForMenu} onMove={onMoveConnectionToFolder} />
                        <button
                            onClick={() => onExportConnectionConfig(c.id)}
                            title="Exportar configuración (sin password)"
                            className="hidden shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 group-hover:block"
                        >
                            <Icon name="output" size={15} />
                        </button>
                        {c.dbType === 'redis' && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation()
                                    onOpenRedisBrowser(c)
                                }}
                                title="Abrir en una pestaña — explorador de keys en modo ventana completa, con edición de valores y exportación masiva"
                                className="hidden shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 group-hover:block"
                            >
                                <Icon name="open_in_new" size={15} />
                            </button>
                        )}
                        {c.dbType === 'mongodb' && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation()
                                    onOpenMongoBrowser(c)
                                }}
                                title="Abrir el MongoDB Browser en una pestaña — explorador de documentos con filtro, asistente y edición"
                                className="hidden shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 group-hover:block"
                            >
                                <Icon name="open_in_new" size={15} />
                            </button>
                        )}
                        {isSelected && c.dbType !== 'redis' && c.dbType !== 'mongodb' && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation()
                                    onExportSchemaDDL(c.id)
                                }}
                                title="Exporta a un archivo el DDL (CREATE TABLE, etc.) del schema activo de esta conexión"
                                className="hidden shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 group-hover:block"
                            >
                                <Icon name="code" size={15} />
                            </button>
                        )}
                        {(c.dbType === 'postgres' || c.dbType === 'oracle' || c.dbType === 'sqlserver') && (
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
                        <button
                            onClick={(e) => {
                                e.stopPropagation()
                                setConfirmDelete(c)
                            }}
                            title="Eliminar esta conexión guardada permanentemente — las pestañas del editor vinculadas a ella quedan sin conexión, pero su contenido no se toca"
                            className="hidden shrink-0 rounded p-0.5 opacity-70 hover:text-error hover:opacity-100 group-hover:block"
                        >
                            <Icon name="delete" size={15} />
                        </button>
                    </div>
                )}

                {isExpanded && c.dbType === 'redis' && (
                    <RedisKeyTree
                        connId={c.id}
                        reloadToken={reloadToken}
                        onOpenKey={(key) => onOpenRedisKey(c.id, key)}
                        isActiveTabConnection={c.id === activeTabConnectionId}
                    />
                )}

                {isExpanded && c.dbType === 'mongodb' && (
                    <MongoCollectionTree
                        connId={c.id}
                        reloadToken={reloadToken}
                        onOpenCollection={(database, collection) => onOpenMongoCollection(c.id, database, collection)}
                        onSelectDatabase={(database) => onSelectMongoDatabase(c.id, database)}
                        isActiveTabConnection={c.id === activeTabConnectionId}
                    />
                )}

                {isExpanded && c.dbType !== 'redis' && c.dbType !== 'mongodb' && metadataLoading && (
                    <div className="flex items-center gap-2 py-2 pl-7 text-xs text-on-surface-variant">
                        <span aria-hidden className="h-3 w-3 animate-spin rounded-full border-2 border-t-transparent border-primary" />
                        Cargando tablas…
                    </div>
                )}

                {isExpanded && c.dbType !== 'redis' && c.dbType !== 'mongodb' && !metadataLoading && metadata && (
                    <div className="pb-1 pl-7 pr-2">
                        {totalObjectCount > 4 && (
                            <input
                                value={objectFilter}
                                onChange={(e) => setObjectFilter(e.target.value)}
                                placeholder="Filtrar tablas, procedures, functions... (soporta % _ como LIKE)"
                                title='Filtra tablas, procedures, functions, triggers y packages de esta conexión por nombre o esquema — escribí texto simple para "contiene", o usá % / _ estilo SQL LIKE (% = cualquier texto, _ = un carácter)'
                                className="mb-1 w-full rounded border-none bg-surface-container-highest px-2 py-1 text-xs text-on-surface outline-none placeholder:text-on-surface-variant/60 focus:ring-1 focus:ring-primary"
                            />
                        )}
                        {(() => {
                            if (totalObjectCount === 0) {
                                return <p className="px-2 py-1 text-xs text-on-surface-variant/60">Sin tablas.</p>
                            }

                            const tq = objectFilter.trim()

                            // Searching flattens across schemas — grouping only makes sense
                            // when browsing everything, not when you already know what you
                            // want. Same fallback for connections with no schema grouping
                            // (SQLite, or unrestricted Oracle/Postgres). Procedures/functions/
                            // triggers/packages are filtered by the SAME term here (against
                            // name AND schema, same as tables) instead of hiding —
                            // SchemaObjectsList shows only what survives, auto-expanded via
                            // forceExpanded so a match isn't hidden behind a manual click.
                            if (tq || schemas.length === 0) {
                                const pattern = tq ? likeToRegExp(tq) : null
                                const matches = (name: string, schema?: string) => !pattern || pattern.test(name) || pattern.test(schema ?? '')

                                const visibleTables = metadata.tables
                                    .filter((t) => matches(t.name, t.schema))
                                    .sort((a, b) => a.name.localeCompare(b.name))
                                const visibleProcedures = (metadata.procedures ?? []).filter((p) => matches(p.name, p.schema))
                                const visibleFunctions = (metadata.functions ?? []).filter((f) => matches(f.name, f.schema))
                                const visibleTriggers = (metadata.triggers ?? []).filter((t) => matches(t.name, t.schema))
                                const visiblePackages = (metadata.packages ?? []).filter((p) => matches(p.name, p.schema))
                                const totalVisible =
                                    visibleTables.length +
                                    visibleProcedures.length +
                                    visibleFunctions.length +
                                    visibleTriggers.length +
                                    visiblePackages.length

                                if (totalVisible === 0) {
                                    return (
                                        <p className="px-2 py-1 text-xs text-on-surface-variant/60">
                                            {tq ? `Sin coincidencias para "${objectFilter}".` : 'Sin tablas.'}
                                        </p>
                                    )
                                }

                                return (
                                    <>
                                        {visibleTables.map((t) => renderTableRow(t))}
                                        <SchemaObjectsList
                                            procedures={visibleProcedures}
                                            functions={visibleFunctions}
                                            triggers={visibleTriggers}
                                            packages={visiblePackages}
                                            forceExpanded={!!tq}
                                            onOpenDDL={(params) => onOpenObjectDDL(c.id, params)}
                                        />
                                    </>
                                )
                            }

                            return schemas.map((schema) => {
                                const schemaExpanded = expandedSchemas.has(schema)
                                // Always alphabetical regardless of what
                                // order the backend/merge happened to
                                // return — a real 342-table schema is
                                // unusable to scan through otherwise.
                                const schemaTables = metadata.tables
                                    .filter((t) => t.schema === schema)
                                    .sort((a, b) => a.name.localeCompare(b.name))
                                const tablesCollapsed = collapsedTableSchemas.has(schema)
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
                                                <Icon name="sync" size={13} className={syncingSchema === schema ? 'animate-spin' : ''} />
                                            </button>
                                        </div>
                                        {schemaExpanded && (
                                            <div className="pl-4">
                                                {schemaTables.length === 0 ? (
                                                    <p className="px-2 py-1 text-xs text-on-surface-variant/60">Sin tablas.</p>
                                                ) : (
                                                    <div className="mb-0.5">
                                                        <button
                                                            onClick={() => toggleTableCategory(schema)}
                                                            title={`${tablesCollapsed ? 'Ver' : 'Ocultar'} tablas`}
                                                            className="group/objcat flex w-full items-center gap-1 rounded px-1 py-1 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                                                        >
                                                            <Icon name={tablesCollapsed ? 'chevron_right' : 'expand_more'} size={14} className="shrink-0" />
                                                            <Icon name="table_chart" size={14} className="shrink-0 opacity-70" />
                                                            <span className="truncate">Tablas</span>
                                                            <span className="shrink-0 opacity-60">({schemaTables.length})</span>
                                                        </button>
                                                        {!tablesCollapsed && <div className="pl-4">{schemaTables.map((t) => renderTableRow(t))}</div>}
                                                    </div>
                                                )}
                                                <SchemaObjectsList
                                                    procedures={(metadata.procedures ?? []).filter((p) => p.schema === schema)}
                                                    functions={(metadata.functions ?? []).filter((f) => f.schema === schema)}
                                                    triggers={(metadata.triggers ?? []).filter((t) => t.schema === schema)}
                                                    packages={(metadata.packages ?? []).filter((pkg) => pkg.schema === schema)}
                                                    onOpenDDL={(params) => onOpenObjectDDL(c.id, params)}
                                                />
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
    }

    function renderFolderNode(node: FolderNode, depth: number) {
        if (q && !folderHasVisibleContent(node)) return null

        const expanded = isFolderExpanded(node.folder.id)
        const isRenaming = renamingFolderId === node.folder.id
        const ownConnections = dbConnections.filter((c) => c.folderId === node.folder.id && connectionMatches(c))
        const isCreatingHere = creatingFolderParentId === node.folder.id

        return (
            <div key={node.folder.id} className="mb-0.5">
                <div
                    style={{paddingLeft: `${4 + depth * 14}px`}}
                    className="group/folder flex items-center gap-1 rounded py-1 pr-2 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <button
                        onClick={() => toggleFolder(node.folder.id)}
                        title={expanded ? 'Contraer carpeta' : 'Expandir carpeta'}
                        className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100"
                    >
                        <Icon name={expanded ? 'expand_more' : 'chevron_right'} size={16} />
                    </button>
                    <Icon name={expanded ? 'folder_open' : 'folder'} size={15} className="shrink-0 opacity-70" />
                    {isRenaming ? (
                        <input
                            autoFocus
                            value={renameFolderName}
                            onChange={(e) => setRenameFolderName(e.target.value)}
                            onBlur={commitRenameFolder}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') commitRenameFolder()
                                if (e.key === 'Escape') setRenamingFolderId(null)
                            }}
                            className="min-w-0 flex-1 rounded border-none bg-surface-container-highest px-1 py-0.5 text-xs text-on-surface outline-none"
                        />
                    ) : (
                        <span className="min-w-0 flex-1 truncate font-medium">{node.folder.name}</span>
                    )}
                    {!isRenaming && (
                        <>
                            <button
                                onClick={(e) => {
                                    e.stopPropagation()
                                    startCreateFolder(node.folder.id)
                                }}
                                title="Nueva subcarpeta"
                                className="hidden shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 group-hover/folder:block"
                            >
                                <Icon name="create_new_folder" size={14} />
                            </button>
                            <button
                                onClick={(e) => {
                                    e.stopPropagation()
                                    onReorderFolder(node.folder.id, 'up')
                                }}
                                title="Mover arriba"
                                className="hidden shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 group-hover/folder:block"
                            >
                                <Icon name="arrow_upward" size={13} />
                            </button>
                            <button
                                onClick={(e) => {
                                    e.stopPropagation()
                                    onReorderFolder(node.folder.id, 'down')
                                }}
                                title="Mover abajo"
                                className="hidden shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 group-hover/folder:block"
                            >
                                <Icon name="arrow_downward" size={13} />
                            </button>
                            <button
                                onClick={(e) => {
                                    e.stopPropagation()
                                    startRenameFolder(node.folder)
                                }}
                                title="Renombrar carpeta"
                                className="hidden shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 group-hover/folder:block"
                            >
                                <Icon name="edit" size={13} />
                            </button>
                            <button
                                onClick={(e) => {
                                    e.stopPropagation()
                                    setConfirmDeleteFolder(node.folder)
                                }}
                                title="Eliminar carpeta — su contenido se mueve a la carpeta contenedora, nunca se borra"
                                className="hidden shrink-0 rounded p-0.5 opacity-70 hover:text-error hover:opacity-100 group-hover/folder:block"
                            >
                                <Icon name="delete" size={13} />
                            </button>
                        </>
                    )}
                </div>
                {expanded && (
                    <div>
                        {isCreatingHere && (
                            <div style={{paddingLeft: `${18 + depth * 14}px`, paddingRight: '8px'}}>{renderNewFolderInput()}</div>
                        )}
                        {node.children.map((child) => renderFolderNode(child, depth + 1))}
                        {ownConnections.map((c) => renderConnectionRow(c, depth + 1))}
                        {/* Uses search-visible counts (not raw node.children/
                            ownConnections) — otherwise a folder whose children
                            are ALL filtered out by an active search would render
                            an unexplained blank gap instead of this message,
                            since node.children.length stays >0 even though
                            every child recursively returns null. */}
                        {!isCreatingHere &&
                            (q ? node.children.filter(folderHasVisibleContent).length : node.children.length) === 0 &&
                            ownConnections.length === 0 && (
                                <p style={{paddingLeft: `${18 + depth * 14}px`}} className="py-1 text-xs text-on-surface-variant/60">
                                    {q ? 'Sin coincidencias.' : 'Carpeta vacía.'}
                                </p>
                            )}
                    </div>
                )}
            </div>
        )
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

            {collapsed ? (
                <>
                    <div className="flex justify-center p-3 pb-2">
                        <button
                            onClick={onNewConnection}
                            title="Crea una nueva conexión a una base de datos (PostgreSQL, Oracle o SQLite)"
                            className="rounded p-1 text-primary hover:bg-surface-variant"
                        >
                            <Icon name="add" size={18} />
                        </button>
                    </div>
                    <div className="mt-2 flex-1 overflow-y-auto py-1">{connections.map((c) => renderConnectionRow(c, 0))}</div>
                </>
            ) : (
                <SidebarModule
                    title="Conexiones"
                    collapsed={moduleCollapsed}
                    onToggleCollapsed={onToggleModuleCollapsed}
                    actions={
                        <div className="flex shrink-0 items-center gap-0.5">
                            <button
                                onClick={() => startCreateFolder('')}
                                title="Nueva carpeta"
                                className="rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                            >
                                <Icon name="create_new_folder" size={18} />
                            </button>
                            <button
                                onClick={onNewConnection}
                                title="Crea una nueva conexión a una base de datos (PostgreSQL, Oracle o SQLite)"
                                className="rounded p-1 text-primary hover:bg-surface-variant"
                            >
                                <Icon name="add" size={18} />
                            </button>
                        </div>
                    }
                >
                    <div className="px-3">
                        <input
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                            placeholder="Buscar..."
                            title="Busca por nombre de conexión o de carpeta — una carpeta que contenga una coincidencia se expande automáticamente"
                            className="w-full rounded-lg border-none bg-surface-container-highest px-3 py-1.5 text-xs text-on-surface outline-none placeholder:text-on-surface-variant/60 focus:ring-1 focus:ring-primary"
                        />
                    </div>
                    {creatingFolderParentId === '' && <div className="px-3 pt-1">{renderNewFolderInput()}</div>}
                    <div className="mt-2 flex-1 overflow-y-auto py-1">
                        {rootConnections.length === 0 && visibleFolderNodes.length === 0 && (
                            <p className="p-3 text-xs text-on-surface-variant/60">
                                {q ? `Sin coincidencias para "${filter}".` : 'Sin conexiones todavía.'}
                            </p>
                        )}
                        {visibleFolderNodes.map((node) => renderFolderNode(node, 0))}
                        {rootConnections.map((c) => renderConnectionRow(c, 0))}
                    </div>
                </SidebarModule>
            )}

            {!collapsed && extraModules}

            {confirmDelete && (
                <ConfirmDialog
                    title="Eliminar conexión"
                    description={`Esto elimina "${confirmDelete.name}" del vault de forma permanente. Las pestañas del editor que estén vinculadas a ella quedan sin conexión (su contenido no se toca). No se puede deshacer.`}
                    confirmLabel="Eliminar"
                    danger
                    onConfirm={() => onDeleteConnection(confirmDelete.id)}
                    onClose={() => setConfirmDelete(null)}
                />
            )}
            {confirmDeleteFolder && (
                <ConfirmDialog
                    title="Eliminar carpeta"
                    description={`Esto elimina la carpeta "${confirmDeleteFolder.name}". Las conexiones y subcarpetas que tenga adentro se mueven a la carpeta contenedora (o a la raíz) — nunca se borran.`}
                    confirmLabel="Eliminar"
                    danger
                    onConfirm={() => onDeleteFolder(confirmDeleteFolder.id)}
                    onClose={() => setConfirmDeleteFolder(null)}
                />
            )}
        </aside>
    )
}
