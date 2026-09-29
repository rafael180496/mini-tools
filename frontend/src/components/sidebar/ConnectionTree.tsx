import {useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode} from 'react'
import {ListConnections} from '../../../wailsjs/go/main/App'
import {vault, db} from '../../../wailsjs/go/models'
import ConfirmDialog from '../ConfirmDialog'
import DbTypeIcon, {dbTypeLabel} from '../DbTypeIcon'
import Icon from '../Icon'
import PromptDialog from '../git/PromptDialog'
import RedisKeyTree from '../redis/RedisKeyTree'
import MongoCollectionTree from '../mongo/MongoCollectionTree'
import SidebarSection from './SidebarSection'
import SchemaObjectsList from './SchemaObjectsList'
import TreeRow, {TREE_FOLDER_ICON, TREE_GUIDE_OFFSET, TREE_INDENT} from './TreeRow'
import {MenuButton, moveToFolderSubmenu, useTreeMenu, type TreeMenuEntry} from './TreeMenu'
import {flattenForMenu} from './MoveToFolderMenu'
import type {DDLObjectType} from '../DDLViewerModal'
import {likeToRegExp} from '../../lib/likePattern'
import {buildFolderTree, countConnectionsIn, type FolderNode} from '../../lib/folderTree'
import {environmentStyle} from '../../lib/environments'

// envStyleOf resolves a connection's environment marking to its colours. See
// lib/environments.ts — an unmarked connection renders exactly as before.
function envStyleOf(c: vault.ConnectionSummary) {
    return environmentStyle(c.environment)
}

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
    onExportSchemaDDL: (connId: string) => void
    // connIds with an open pool/client right now (App.ActiveConnectionIds).
    // Drives both the dot next to the name and whether the disconnect button
    // exists at all.
    liveConnIds: Set<string>
    onDisconnect: (connId: string) => void
    // Permanently removes the saved connection from the vault — destructive,
    // gated behind a ConfirmDialog here (never window.confirm, see
    // .claude/rules/conventions.md). Any editor tab bound to this connId
    // loses only the binding, never its content (see Workspace.tsx's
    // deleteConnection).
    onDeleteConnection: (connId: string) => void
    onConfigureSchemas: (conn: vault.ConnectionSummary) => void
    // True while GetSchemaMetadata is in flight for the selected connection
    // — without this, the table list under a freshly-selected connection
    // just looks empty/broken until the fetch resolves.
    metadataLoading: boolean
    // Folder tree (organizational only — never affects which connection is
    // "selected"/active).
    folders: vault.Folder[]
    onCreateFolder: (name: string, parentId: string) => void
    onRenameFolder: (id: string, name: string) => void
    onDeleteFolder: (id: string) => void
    onReorderFolder: (id: string, direction: 'up' | 'down') => void
    onMoveConnectionToFolder: (connId: string, folderId: string) => void
    // Búsqueda global de la barra, la misma para los cuatro módulos — la
    // dibuja el marco (Sidebar.tsx), no el árbol. El módulo solo la lee: no
    // tiene ninguna razón para cambiarla, y cuando cada uno tenía su propia
    // caja "Buscar…" había que decidir de antemano en cuál de los cuatro
    // estaba lo que uno recuerda nada más que por el nombre.
    filter: string
    // Cuántos elementos coinciden con la búsqueda global. Se informa hacia
    // arriba porque el contador vive en el menú master (SidebarMasterMenu):
    // con un módulo a la vez, es lo único que dice que lo que se busca está
    // en otro módulo y no perdido.
    onMatchCount: (n: number | null) => void
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
    onExportSchemaDDL,
    liveConnIds,
    onDisconnect,
    onDeleteConnection,
    onConfigureSchemas,
    metadataLoading,
    folders,
    onCreateFolder,
    onRenameFolder,
    onDeleteFolder,
    onReorderFolder,
    onMoveConnectionToFolder,
    filter,
    onMatchCount,
}: ConnectionTreeProps) {
    const [connections, setConnections] = useState<vault.ConnectionSummary[]>([])
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
    // before this existed) — collapsing is opt-in per schema, and reset on
    // connection change same as expandedSchemas above.
    const [collapsedTableSchemas, setCollapsedTableSchemas] = useState<Set<string>>(new Set())
    // Which folder nodes are manually expanded — overridden (everything
    // relevant force-shown) while a search is active, same "flatten while
    // searching" behavior the table filter below already has.
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
    // Crear y renombrar carpetas pasan por el diálogo de la app. Antes eran
    // un input metido en la fila, pero la fila ahora es un TreeRow —un botón
    // entero—, y un input adentro de un botón no se puede ni seleccionar con
    // el mouse. Un diálogo además deja claro dónde se va a crear.
    const [folderPrompt, setFolderPrompt] = useState<{mode: 'create'; parentId: string} | {mode: 'rename'; folder: vault.Folder} | null>(null)
    const menu = useTreeMenu()

    useEffect(() => {
        ListConnections().then(setConnections)
    }, [reloadToken])

    // This module is DB connections only — SSH has its own sidebar module
    // (SshConnectionTree.tsx) with its own independent folder tree
    // (vault.Folder.Scope — see the doc comment on that field).
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

    const matchCount = q ? rootConnections.length + visibleFolderNodes.length : null
    useEffect(() => {
        onMatchCount(matchCount)
    }, [matchCount, onMatchCount])

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

    // «Desplegar todo» abre las carpetas, no las conexiones: solo una conexión
    // muestra sus tablas a la vez (la seleccionada), así que desplegar las
    // demás sería conectarse a todas. Lo que sí hace es volver a mostrar las
    // tablas de la seleccionada si se habían plegado a mano.
    const anyFolderOpen = expandedFolders.size > 0
    const expandAll = () => {
        setExpandedFolders(new Set(dbFolders.map((f) => f.id)))
        setCollapsedId(null)
    }
    const collapseAll = () => {
        setExpandedFolders(new Set())
        setCollapsedId(selectedId)
    }

    function toggleExpand(c: vault.ConnectionSummary) {
        if (c.id !== selectedId) {
            selectConnection(c)
            return
        }
        setCollapsedId((prev) => (prev === c.id ? null : c.id))
    }

    const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {})

    // Redis y MongoDB tienen su propio explorador en una pestaña; para el
    // resto de los motores no hay nada que "abrir" más allá de seleccionar.
    const openBrowser = (c: vault.ConnectionSummary) => {
        if (c.dbType === 'redis') onOpenRedisBrowser(c)
        else if (c.dbType === 'mongodb') onOpenMongoBrowser(c)
    }
    const hasBrowser = (c: vault.ConnectionSummary) => c.dbType === 'redis' || c.dbType === 'mongodb'

    const connectionMenu = (e: ReactMouseEvent, c: vault.ConnectionSummary) => {
        const isSelected = c.id === selectedId
        const isLive = liveConnIds.has(c.id)
        const sqlEngine = !hasBrowser(c)
        const items: TreeMenuEntry[] = [
            {
                label: isSelected ? 'Conexión activa' : 'Conectar',
                icon: 'power',
                disabled: isSelected,
                title: isSelected
                    ? 'Ya es la conexión activa del editor'
                    : 'Se conecta si hace falta y la marca como conexión activa — lo mismo que un clic en la fila',
                onSelect: () => selectConnection(c),
            },
            ...(hasBrowser(c)
                ? [
                      {
                          label: c.dbType === 'redis' ? 'Abrir Redis Browser' : 'Abrir MongoDB Browser',
                          icon: 'open_in_new',
                          hint: 'doble clic',
                          title:
                              c.dbType === 'redis'
                                  ? 'Explorador de keys en una pestaña completa, con edición de valores y exportación masiva'
                                  : 'Explorador de documentos en una pestaña completa, con filtro, asistente y edición',
                          onSelect: () => openBrowser(c),
                      },
                  ]
                : []),
            'separator',
            {label: 'Editar conexión', icon: 'edit', onSelect: () => onEditConnection(c)},
            ...(c.dbType === 'postgres' || c.dbType === 'oracle' || c.dbType === 'sqlserver'
                ? [
                      {
                          label: 'Elegir qué esquemas escanear',
                          icon: 'schema',
                          title: 'Limita qué esquemas se cargan en el árbol y en el autocompletado',
                          onSelect: () => onConfigureSchemas(c),
                      },
                  ]
                : []),
            {label: 'Mover a…', icon: 'drive_file_move', submenu: moveToFolderSubmenu(flatFoldersForMenu, c.folderId ?? '', (f) => onMoveConnectionToFolder(c.id, f))},
            'separator',
            {
                label: 'Exportar configuración',
                icon: 'output',
                title: 'Guarda host, puerto y usuario en un archivo — nunca la contraseña',
                onSelect: () => onExportConnectionConfig(c.id),
            },
            ...(sqlEngine
                ? [
                      {
                          label: 'Exportar DDL del esquema',
                          icon: 'code',
                          disabled: !isSelected,
                          title: isSelected
                              ? 'Exporta a un archivo el DDL (CREATE TABLE, etc.) del esquema activo de esta conexión'
                              : 'Primero seleccioná la conexión: el DDL que se exporta es el del esquema activo',
                          onSelect: () => onExportSchemaDDL(c.id),
                      },
                  ]
                : []),
            {label: 'Copiar nombre', icon: 'content_copy', onSelect: () => copy(c.name)},
            'separator',
            ...(isLive
                ? [
                      {
                          label: 'Desconectar',
                          icon: 'power_settings_new',
                          title: 'Cierra la conexión abierta contra este servidor — la conexión guardada queda intacta',
                          onSelect: () => onDisconnect(c.id),
                      },
                  ]
                : []),
            {
                label: 'Eliminar conexión',
                icon: 'delete',
                danger: true,
                title: 'Las pestañas del editor vinculadas a ella quedan sin conexión, pero su contenido no se toca',
                onSelect: () => setConfirmDelete(c),
            },
        ]
        menu.openAt(e, items)
    }

    const folderMenu = (e: ReactMouseEvent, f: vault.Folder) => {
        const open = isFolderExpanded(f.id)
        menu.openAt(e, [
            {label: 'Subcarpeta nueva', icon: 'create_new_folder', onSelect: () => setFolderPrompt({mode: 'create', parentId: f.id})},
            'separator',
            {label: open ? 'Plegar' : 'Desplegar', icon: open ? 'unfold_less' : 'unfold_more', disabled: !!q, onSelect: () => toggleFolder(f.id)},
            {label: 'Subir', icon: 'arrow_upward', title: 'Mueve la carpeta un lugar hacia arriba entre sus hermanas', onSelect: () => onReorderFolder(f.id, 'up')},
            {label: 'Bajar', icon: 'arrow_downward', title: 'Mueve la carpeta un lugar hacia abajo entre sus hermanas', onSelect: () => onReorderFolder(f.id, 'down')},
            'separator',
            {label: 'Cambiar nombre', icon: 'edit', onSelect: () => setFolderPrompt({mode: 'rename', folder: f})},
            'separator',
            {
                label: 'Eliminar carpeta',
                icon: 'delete',
                danger: true,
                title: 'Su contenido se mueve a la carpeta contenedora, nunca se borra',
                onSelect: () => setConfirmDeleteFolder(f),
            },
        ])
    }

    const blankMenu = (e: ReactMouseEvent) =>
        menu.openAt(e, [
            {label: 'Conexión nueva', icon: 'add', onSelect: onNewConnection},
            {label: 'Carpeta nueva', icon: 'create_new_folder', onSelect: () => setFolderPrompt({mode: 'create', parentId: ''})},
            'separator',
            {label: 'Desplegar todo', icon: 'unfold_more', disabled: !!q || dbFolders.length === 0, onSelect: expandAll},
            {label: 'Plegar todo', icon: 'unfold_less', disabled: !!q, onSelect: collapseAll},
        ])

    const schemaMenu = (e: ReactMouseEvent, connId: string, schema: string) => {
        const open = expandedSchemas.has(schema)
        menu.openAt(e, [
            {label: open ? 'Plegar' : 'Desplegar', icon: open ? 'unfold_less' : 'unfold_more', onSelect: () => toggleSchema(schema)},
            {
                label: 'Usar como esquema activo',
                icon: 'check_circle',
                checked: schema === activeSchema,
                title: 'El que usan el autocompletado y el CLAUDE.md del proyecto',
                disabled: schema === activeSchema,
                onSelect: () => onSelectSchema(schema),
            },
            'separator',
            {
                label: 'Sincronizar esquema',
                icon: 'sync',
                disabled: syncingSchema === schema,
                title: `Vuelve a leer solo "${schema}" de la base — no toca los demás esquemas ya cargados`,
                onSelect: () => void syncSchema(connId, schema),
            },
            {label: 'Copiar nombre', icon: 'content_copy', onSelect: () => copy(schema)},
        ])
    }

    const tableMenu = (e: ReactMouseEvent, t: db.Table, connId: string) => {
        const qualified = t.schema ? `${t.schema}.${t.name}` : t.name
        menu.openAt(e, [
            {label: 'Consultar', icon: 'play_arrow', hint: 'doble clic', title: 'Abre un SELECT * con LIMIT 100 en el editor', onSelect: () => onOpenTable(t.name, t.schema)},
            {
                label: 'Ver CREATE TABLE',
                icon: 'code',
                title: 'Desde el visor se copia entero o se exporta a un .sql',
                onSelect: () => onOpenObjectDDL(connId, {objectType: 'table', schema: t.schema ?? '', name: t.name, oid: 0}),
            },
            'separator',
            {label: 'Copiar nombre', icon: 'content_copy', onSelect: () => copy(t.name)},
            ...(t.schema ? [{label: 'Copiar con esquema', icon: 'content_copy', hint: qualified, onSelect: () => copy(qualified)}] : []),
        ])
    }

    function renderTableRow(t: db.Table, connId: string, depth: number, qualify: boolean) {
        const qualified = t.schema ? `${t.schema}.${t.name}` : t.name
        return (
            <TreeRow
                key={qualified}
                depth={depth}
                icon="table_chart"
                iconClass="text-on-surface-variant/70"
                // Sin agrupar por esquema (búsqueda o motor sin agrupación) el
                // esquema va en el nombre: es lo único que distingue dos tablas
                // iguales. Adentro de su esquema sería repetir la fila de arriba.
                label={qualify ? qualified : t.name}
                labelClass="text-on-surface-variant"
                title={`${qualified} — doble clic: SELECT * LIMIT 100. Clic derecho: más opciones.`}
                onDoubleClick={() => onOpenTable(t.name, t.schema)}
                onContextMenu={(e) => tableMenu(e, t, connId)}
                actions={
                    <>
                        {/* Ver el CREATE TABLE, igual que un procedure o un
                            trigger: la tabla es el objeto cuyo DDL más se mira
                            —para copiar una columna, comparar dos entornos o
                            pegarlo en una migración—. Exportar a `.sql` está un
                            clic más adentro, en el propio visor. */}
                        <button
                            onClick={(e) => {
                                e.stopPropagation()
                                onOpenObjectDDL(connId, {objectType: 'table', schema: t.schema ?? '', name: t.name, oid: 0})
                            }}
                            title={`Ver el CREATE TABLE de ${qualified} — desde el visor se copia entero o se exporta a un .sql`}
                            className="sidebar-icon !p-0.5"
                        >
                            <Icon name="code" size={14} />
                        </button>
                        <MenuButton onOpen={(e) => tableMenu(e, t, connId)} title="Opciones de la tabla" />
                    </>
                }
            />
        )
    }

    // Lo que cuelga de una conexión SQL: el filtro de objetos y, debajo, las
    // tablas y los objetos del esquema — agrupados por esquema o planos.
    function renderObjects(c: vault.ConnectionSummary, depth: number): ReactNode {
        if (!metadata) return null
        const inner = depth + 1
        return (
            <>
                {totalObjectCount > 4 && (
                    <Guided depth={inner}>
                        <input
                            value={objectFilter}
                            onChange={(e) => setObjectFilter(e.target.value)}
                            onContextMenu={(e) => e.stopPropagation()}
                            placeholder="Filtrar tablas, procedures… (% _ como LIKE)"
                            title='Filtra tablas, procedures, functions, triggers y packages de esta conexión por nombre o esquema — escribí texto simple para "contiene", o usá % / _ estilo SQL LIKE (% = cualquier texto, _ = un carácter)'
                            className="my-0.5 ml-5 w-[calc(100%-1.5rem)] rounded border-none bg-surface-container-highest px-2 py-1 text-ui-11 text-on-surface outline-none placeholder:text-on-surface-variant/60 focus:ring-1 focus:ring-primary"
                        />
                    </Guided>
                )}
                {(() => {
                    if (totalObjectCount === 0) return <TreeNote depth={inner}>Sin tablas.</TreeNote>

                    const tq = objectFilter.trim()

                    // Searching flattens across schemas — grouping only makes
                    // sense when browsing everything, not when you already
                    // know what you want. Same fallback for connections with
                    // no schema grouping (SQLite, or unrestricted Oracle/
                    // Postgres). Procedures/functions/triggers/packages are
                    // filtered by the SAME term (against name AND schema,
                    // same as tables) — SchemaObjectsList shows only what
                    // survives, auto-expanded via forceExpanded.
                    if (tq || schemas.length === 0) {
                        const pattern = tq ? likeToRegExp(tq) : null
                        const matches = (name: string, schema?: string) => !pattern || pattern.test(name) || pattern.test(schema ?? '')

                        const visibleTables = metadata.tables.filter((t) => matches(t.name, t.schema)).sort((a, b) => a.name.localeCompare(b.name))
                        const visibleProcedures = (metadata.procedures ?? []).filter((p) => matches(p.name, p.schema))
                        const visibleFunctions = (metadata.functions ?? []).filter((f) => matches(f.name, f.schema))
                        const visibleTriggers = (metadata.triggers ?? []).filter((t) => matches(t.name, t.schema))
                        const visiblePackages = (metadata.packages ?? []).filter((p) => matches(p.name, p.schema))
                        const totalVisible =
                            visibleTables.length + visibleProcedures.length + visibleFunctions.length + visibleTriggers.length + visiblePackages.length

                        if (totalVisible === 0) {
                            return <TreeNote depth={inner}>{tq ? `Sin coincidencias para "${objectFilter}".` : 'Sin tablas.'}</TreeNote>
                        }

                        return (
                            <>
                                {visibleTables.map((t) => renderTableRow(t, c.id, inner, true))}
                                <SchemaObjectsList
                                    procedures={visibleProcedures}
                                    functions={visibleFunctions}
                                    triggers={visibleTriggers}
                                    packages={visiblePackages}
                                    forceExpanded={!!tq}
                                    depth={inner}
                                    openMenu={menu.openAt}
                                    onOpenDDL={(params) => onOpenObjectDDL(c.id, params)}
                                />
                            </>
                        )
                    }

                    return schemas.map((schema) => {
                        const schemaExpanded = expandedSchemas.has(schema)
                        const isActive = schema === activeSchema
                        const syncing = syncingSchema === schema
                        // Always alphabetical regardless of what order the
                        // backend/merge happened to return — a real 342-table
                        // schema is unusable to scan through otherwise.
                        const schemaTables = metadata.tables.filter((t) => t.schema === schema).sort((a, b) => a.name.localeCompare(b.name))
                        const tablesCollapsed = collapsedTableSchemas.has(schema)
                        return (
                            <div key={schema}>
                                <TreeRow
                                    depth={inner}
                                    icon="schema"
                                    iconClass={isActive ? 'text-primary' : undefined}
                                    label={schema}
                                    labelClass={isActive ? 'font-semibold text-primary' : undefined}
                                    title={
                                        isActive
                                            ? `"${schema}" es el esquema activo (autocompletado / CLAUDE.md)`
                                            : `Ver tablas de "${schema}" y fijarlo como esquema activo`
                                    }
                                    expanded={schemaExpanded}
                                    onToggle={() => toggleSchema(schema)}
                                    onClick={() => toggleSchema(schema)}
                                    onContextMenu={(e) => schemaMenu(e, c.id, schema)}
                                    // Sincronizando, el giro queda a la vista
                                    // aunque el mouse se haya ido: es lo único
                                    // que dice que algo sigue en curso.
                                    trailing={
                                        syncing ? (
                                            <Icon name="sync" size={13} className="animate-spin text-primary" />
                                        ) : (
                                            <span className="text-ui-10 tabular-nums text-on-surface-variant/50">{schemaTables.length}</span>
                                        )
                                    }
                                    actions={
                                        <>
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation()
                                                    void syncSchema(c.id, schema)
                                                }}
                                                disabled={syncing}
                                                title={
                                                    syncing
                                                        ? `Sincronizando "${schema}"…`
                                                        : `Sincroniza solo el esquema "${schema}" contra la base de datos — no toca los demás esquemas ya cargados`
                                                }
                                                className="sidebar-icon !p-0.5 disabled:opacity-40"
                                            >
                                                <Icon name="sync" size={14} className={syncing ? 'animate-spin' : ''} />
                                            </button>
                                            <MenuButton onOpen={(e) => schemaMenu(e, c.id, schema)} title="Opciones del esquema" />
                                        </>
                                    }
                                />
                                {schemaExpanded && (
                                    <>
                                        {schemaTables.length === 0 ? (
                                            <TreeNote depth={inner + 1}>Sin tablas.</TreeNote>
                                        ) : (
                                            <>
                                                <TreeRow
                                                    depth={inner + 1}
                                                    icon="table_chart"
                                                    label="Tablas"
                                                    title={`${tablesCollapsed ? 'Ver' : 'Ocultar'} las ${schemaTables.length} tablas de "${schema}"`}
                                                    expanded={!tablesCollapsed}
                                                    onToggle={() => toggleTableCategory(schema)}
                                                    onClick={() => toggleTableCategory(schema)}
                                                    onContextMenu={(e) =>
                                                        menu.openAt(e, [
                                                            {
                                                                label: tablesCollapsed ? 'Desplegar' : 'Plegar',
                                                                icon: tablesCollapsed ? 'unfold_more' : 'unfold_less',
                                                                onSelect: () => toggleTableCategory(schema),
                                                            },
                                                        ])
                                                    }
                                                    trailing={<span className="text-ui-10 tabular-nums text-on-surface-variant/50">{schemaTables.length}</span>}
                                                />
                                                {!tablesCollapsed && schemaTables.map((t) => renderTableRow(t, c.id, inner + 2, false))}
                                            </>
                                        )}
                                        <SchemaObjectsList
                                            procedures={(metadata.procedures ?? []).filter((p) => p.schema === schema)}
                                            functions={(metadata.functions ?? []).filter((f) => f.schema === schema)}
                                            triggers={(metadata.triggers ?? []).filter((t) => t.schema === schema)}
                                            packages={(metadata.packages ?? []).filter((pkg) => pkg.schema === schema)}
                                            depth={inner + 1}
                                            openMenu={menu.openAt}
                                            onOpenDDL={(params) => onOpenObjectDDL(c.id, params)}
                                        />
                                    </>
                                )}
                            </div>
                        )
                    })
                })()}
            </>
        )
    }

    function renderConnectionRow(c: vault.ConnectionSummary, depth: number) {
        const isSelected = c.id === selectedId
        const isLive = liveConnIds.has(c.id)
        const isExpanded = isSelected && collapsedId !== c.id
        const env = envStyleOf(c)
        const sqlEngine = !hasBrowser(c)
        return (
            <div key={c.id}>
                <TreeRow
                    depth={depth}
                    // El ícono de una conexión es el logo de su motor: es lo
                    // que distingue un Oracle de un Redis de un vistazo.
                    icon={<DbTypeIcon dbType={c.dbType} size={15} />}
                    label={
                        <span className="flex min-w-0 items-center gap-1.5">
                            {c.color && (
                                <span aria-hidden title="Color de esta conexión" className="h-2 w-2 shrink-0 rounded-full" style={{backgroundColor: c.color}} />
                            )}
                            <span className={`truncate ${isSelected ? 'font-semibold' : ''}`}>{c.name}</span>
                        </span>
                    }
                    labelClass={isSelected ? 'text-on-surface' : 'text-on-surface/90'}
                    title={
                        (c.dbType === 'redis'
                            ? `Clic: seleccionar "${c.name}" y ver sus keys acá abajo. Doble clic: abrir el Redis Browser en una pestaña completa.`
                            : c.dbType === 'mongodb'
                              ? `Clic: seleccionar "${c.name}" y ver sus bases/colecciones acá abajo. Doble clic: abrir el MongoDB Browser en una pestaña completa.`
                              : `${dbTypeLabel(c.dbType)} — clic: conectar y trabajar con "${c.name}" (se conecta si hace falta y la marca como conexión activa)`) +
                        (env ? ` Entorno: ${env.label}.` : '')
                    }
                    expanded={isExpanded}
                    onToggle={() => toggleExpand(c)}
                    onClick={() => selectConnection(c)}
                    onDoubleClick={() => openBrowser(c)}
                    onContextMenu={(e) => connectionMenu(e, c)}
                    active={isSelected}
                    // El punto verde queda a la vista: una conexión abierta es
                    // un estado, no solo una acción. Al pasar el mouse cede su
                    // lugar al botón que la cierra.
                    trailing={
                        isLive ? (
                            <span
                                aria-hidden
                                title="Hay una conexión abierta contra este servidor"
                                className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500 dark:bg-emerald-400"
                            />
                        ) : undefined
                    }
                    actions={
                        <>
                            {hasBrowser(c) && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        openBrowser(c)
                                    }}
                                    title={
                                        c.dbType === 'redis'
                                            ? 'Abrir en una pestaña — explorador de keys en modo ventana completa, con edición de valores y exportación masiva'
                                            : 'Abrir el MongoDB Browser en una pestaña — explorador de documentos con filtro, asistente y edición'
                                    }
                                    className="sidebar-icon !p-0.5"
                                >
                                    <Icon name="open_in_new" size={14} />
                                </button>
                            )}
                            {isLive && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        onDisconnect(c.id)
                                    }}
                                    title="Cerrar la conexión abierta contra este servidor — la conexión guardada queda intacta"
                                    className="sidebar-icon !p-0.5 hover:!text-error"
                                >
                                    <Icon name="power_settings_new" size={14} />
                                </button>
                            )}
                            <MenuButton onOpen={(e) => connectionMenu(e, c)} title="Opciones de la conexión" />
                        </>
                    }
                    // La franja del entorno (Producción en rojo, etc.) es la
                    // única marca del entorno en la fila, la misma que en SSH.
                    stripe={env?.dot}
                />

                {isExpanded && c.dbType === 'redis' && (
                    <Guided depth={depth + 1}>
                        <RedisKeyTree
                            connId={c.id}
                            reloadToken={reloadToken}
                            onOpenKey={(key) => onOpenRedisKey(c.id, key)}
                            isActiveTabConnection={c.id === activeTabConnectionId}
                        />
                    </Guided>
                )}

                {isExpanded && c.dbType === 'mongodb' && (
                    <Guided depth={depth + 1}>
                        <MongoCollectionTree
                            connId={c.id}
                            reloadToken={reloadToken}
                            onOpenCollection={(database, collection) => onOpenMongoCollection(c.id, database, collection)}
                            onSelectDatabase={(database) => onSelectMongoDatabase(c.id, database)}
                            isActiveTabConnection={c.id === activeTabConnectionId}
                        />
                    </Guided>
                )}

                {isExpanded && sqlEngine && metadataLoading && (
                    <TreeNote depth={depth + 1}>
                        <span aria-hidden className="mr-1.5 inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-primary border-t-transparent align-[-1px]" />
                        Cargando tablas…
                    </TreeNote>
                )}

                {isExpanded && sqlEngine && !metadataLoading && renderObjects(c, depth)}
            </div>
        )
    }

    function renderFolderNode(node: FolderNode, depth: number): ReactNode {
        if (q && !folderHasVisibleContent(node)) return null

        const f = node.folder
        const expanded = isFolderExpanded(f.id)
        const ownConnections = dbConnections.filter((c) => c.folderId === f.id && connectionMatches(c))
        // Cuántas conexiones hay adentro contando subcarpetas — es el dato que
        // decide si vale la pena abrir una carpeta plegada, y sin él plegarla
        // esconde justamente eso.
        const total = countConnectionsIn(node, dbConnections, connectionMatches)
        // Uses search-visible counts (not raw node.children/ownConnections) —
        // otherwise a folder whose children are ALL filtered out by an active
        // search would render an unexplained blank gap instead of the note.
        const visibleChildren = q ? node.children.filter(folderHasVisibleContent).length : node.children.length

        return (
            <div key={f.id}>
                <TreeRow
                    depth={depth}
                    icon={expanded ? 'folder_open' : 'folder'}
                    iconClass={TREE_FOLDER_ICON}
                    iconFilled={!expanded}
                    label={f.name}
                    labelClass="text-on-surface font-medium"
                    title={`${f.name} — ${total} ${total === 1 ? 'conexión' : 'conexiones'}. Las carpetas solo organizan: nunca cambian a qué base apunta una conexión. Clic derecho: más opciones.`}
                    expanded={expanded}
                    onToggle={() => toggleFolder(f.id)}
                    onClick={() => toggleFolder(f.id)}
                    onContextMenu={(e) => folderMenu(e, f)}
                    trailing={total > 0 ? <span className="text-ui-10 tabular-nums text-on-surface-variant/50">{total}</span> : undefined}
                    actions={<MenuButton onOpen={(e) => folderMenu(e, f)} title="Opciones de la carpeta" />}
                />
                {expanded && (
                    <>
                        {node.children.map((child) => renderFolderNode(child, depth + 1))}
                        {ownConnections.map((c) => renderConnectionRow(c, depth + 1))}
                        {visibleChildren === 0 && ownConnections.length === 0 && (
                            <TreeNote depth={depth + 1}>{q ? 'Sin coincidencias.' : 'Carpeta vacía.'}</TreeNote>
                        )}
                    </>
                )}
            </div>
        )
    }

    return (
        <SidebarSection
            title="Conexiones"
            count={q ? `${rootConnections.length + visibleFolderNodes.length} de ${dbConnections.length}` : dbConnections.length ? String(dbConnections.length) : null}
            actions={
                <>
                    <button
                        onClick={() => setFolderPrompt({mode: 'create', parentId: ''})}
                        title="Crea una carpeta para agrupar conexiones — las carpetas solo organizan, nunca cambian a qué base apunta una conexión"
                        className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="create_new_folder" size={16} />
                    </button>
                    <button
                        onClick={() => (anyFolderOpen ? collapseAll() : expandAll())}
                        disabled={!!q || dbFolders.length === 0}
                        title={
                            q
                                ? 'Con una búsqueda activa las carpetas con coincidencias ya están abiertas'
                                : dbFolders.length === 0
                                  ? 'No hay carpetas que desplegar'
                                  : anyFolderOpen
                                    ? 'Plegar todas las carpetas (y la lista de tablas de la conexión activa)'
                                    : 'Desplegar todas las carpetas'
                        }
                        className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-40"
                    >
                        <Icon name={anyFolderOpen ? 'unfold_less' : 'unfold_more'} size={16} />
                    </button>
                    <button
                        onClick={onNewConnection}
                        title="Crea una nueva conexión a una base de datos (PostgreSQL, Oracle, SQLite, SQL Server, Redis o MongoDB)"
                        className="rounded p-0.5 text-primary hover:bg-surface-variant"
                    >
                        <Icon name="add" size={16} />
                    </button>
                </>
            }
        >
            <div className="min-h-0 flex-1 pb-6" onContextMenu={blankMenu}>
                {rootConnections.length === 0 && visibleFolderNodes.length === 0 && (
                    <p className="p-3 text-xs text-on-surface-variant/60">{q ? `Sin coincidencias para "${filter}".` : 'Sin conexiones todavía.'}</p>
                )}
                {/* Carpetas primero y después las conexiones sueltas, el orden
                    de cualquier explorador de archivos. */}
                {visibleFolderNodes.map((node) => renderFolderNode(node, 0))}
                {rootConnections.map((c) => renderConnectionRow(c, 0))}
            </div>

            {menu.element}

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
            {folderPrompt && (
                <PromptDialog
                    title={folderPrompt.mode === 'rename' ? 'Cambiar el nombre de la carpeta' : folderPrompt.parentId ? 'Subcarpeta nueva' : 'Carpeta nueva'}
                    label="Nombre"
                    initial={folderPrompt.mode === 'rename' ? folderPrompt.folder.name : ''}
                    placeholder="Nombre de la carpeta…"
                    confirmLabel={folderPrompt.mode === 'rename' ? 'Guardar' : 'Crear'}
                    description={
                        folderPrompt.mode === 'create'
                            ? folderPrompt.parentId
                                ? `Se crea dentro de "${dbFolders.find((f) => f.id === folderPrompt.parentId)?.name ?? ''}".`
                                : 'Se crea en la raíz del árbol de conexiones.'
                            : undefined
                    }
                    onSubmit={(value) => {
                        const name = value.trim()
                        const p = folderPrompt
                        setFolderPrompt(null)
                        if (!name) return
                        if (p.mode === 'rename') {
                            if (name !== p.folder.name) onRenameFolder(p.folder.id, name)
                        } else {
                            // Se abre la carpeta contenedora: crear algo que
                            // queda escondido detrás de un chevron plegado
                            // parece que no funcionó.
                            if (p.parentId) setExpandedFolders((prev) => new Set(prev).add(p.parentId))
                            onCreateFolder(name, p.parentId)
                        }
                    }}
                    onClose={() => setFolderPrompt(null)}
                />
            )}
        </SidebarSection>
    )
}

// Guided envuelve lo que cuelga del árbol sin ser una fila —el filtro de
// objetos, las keys de Redis, las colecciones de Mongo— con las mismas guías
// verticales que TreeRow. Sin esto la línea de la rama se corta justo ahí y
// el contenido parece suelto, no hijo de la conexión.
function Guided({depth, children}: {depth: number; children: ReactNode}) {
    return (
        <div className="relative mx-1" style={{paddingLeft: `${depth * TREE_INDENT}px`}}>
            {Array.from({length: depth}, (_, i) => (
                <span
                    key={i}
                    aria-hidden
                    className="pointer-events-none absolute inset-y-0 w-px bg-on-surface-variant/25"
                    style={{left: `${i * TREE_INDENT + TREE_GUIDE_OFFSET}px`}}
                />
            ))}
            {children}
        </div>
    )
}

// TreeNote es un aviso dentro del árbol ("Sin tablas.", "Carpeta vacía."),
// alineado con los nombres del nivel en el que aparece.
function TreeNote({depth, children}: {depth: number; children: ReactNode}) {
    return (
        <Guided depth={depth}>
            <p className="py-1 pl-[26px] text-ui-11 text-on-surface-variant/60">{children}</p>
        </Guided>
    )
}
