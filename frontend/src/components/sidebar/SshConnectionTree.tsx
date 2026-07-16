import {useEffect, useState} from 'react'
import {ListConnections} from '../../../wailsjs/go/main/App'
import {vault} from '../../../wailsjs/go/models'
import ConfirmDialog from '../ConfirmDialog'
import DbTypeIcon from '../DbTypeIcon'
import Icon from '../Icon'
import SidebarModule from './SidebarModule'
import MoveToFolderMenu, {flattenForMenu} from './MoveToFolderMenu'
import {buildFolderTree, type FolderNode} from '../../lib/folderTree'

interface SshConnectionTreeProps {
    onNewConnection: () => void
    onEditConnection: (conn: vault.ConnectionSummary) => void
    // Opens (or focuses) a connection's terminal tab — the only thing to do
    // with an SSH connection besides edit/move/delete, since it has no
    // schema/keys to browse. Reached both from the dedicated row button and
    // from clicking the row itself (unlike ConnectionTree, there's no
    // separate "select to expand a tree" step to distinguish it from).
    onOpenSshTerminal: (conn: vault.ConnectionSummary) => void
    // Highlights whichever row's terminal is the ACTIVE editor tab right
    // now — this module has no "selected connection" concept of its own
    // (see ConnectionTree's selectedId), so it borrows the tab system's own
    // notion of "current" instead.
    activeTabConnectionId: string | null
    onExportConnectionConfig: (connId: string) => void
    onDisconnect: (connId: string) => void
    onDeleteConnection: (connId: string) => void
    reloadToken: number
    moduleCollapsed: boolean
    onToggleModuleCollapsed: () => void
    // Full flat list (both scopes) — filtered internally to scope==='ssh'
    // (vault.Folder.Scope), same "unfiltered prop, component filters its
    // own slice" pattern ConnectionTree.tsx uses for `connections`. This
    // module's folder tree is entirely independent of ConnectionTree's —
    // never the same folder instances, even if named identically.
    folders: vault.Folder[]
    onCreateFolder: (name: string, parentId: string) => void
    onRenameFolder: (id: string, name: string) => void
    onDeleteFolder: (id: string) => void
    onReorderFolder: (id: string, direction: 'up' | 'down') => void
    onMoveConnectionToFolder: (connId: string, folderId: string) => void
}

// SSH's own sidebar module, sibling to "Conexiones" (ConnectionTree.tsx) —
// same folder organization, search, and row actions (edit/move/export/
// disconnect/delete), but none of ConnectionTree's schema-browsing surface
// (no expand chevron, no metadata, no RedisKeyTree-equivalent): an SSH
// connection's only real action is opening its terminal tab.
export default function SshConnectionTree({
    onNewConnection,
    onEditConnection,
    onOpenSshTerminal,
    activeTabConnectionId,
    onExportConnectionConfig,
    onDisconnect,
    onDeleteConnection,
    reloadToken,
    moduleCollapsed,
    onToggleModuleCollapsed,
    folders,
    onCreateFolder,
    onRenameFolder,
    onDeleteFolder,
    onReorderFolder,
    onMoveConnectionToFolder,
}: SshConnectionTreeProps) {
    const [connections, setConnections] = useState<vault.ConnectionSummary[]>([])
    const [filter, setFilter] = useState('')
    const [confirmDelete, setConfirmDelete] = useState<vault.ConnectionSummary | null>(null)
    const [confirmDeleteFolder, setConfirmDeleteFolder] = useState<vault.Folder | null>(null)
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
    const [creatingFolderParentId, setCreatingFolderParentId] = useState<string | null>(null)
    const [newFolderName, setNewFolderName] = useState('')
    const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)
    const [renameFolderName, setRenameFolderName] = useState('')

    useEffect(() => {
        ListConnections().then((all) => setConnections(all.filter((c) => c.dbType === 'ssh')))
    }, [reloadToken])

    // Independent from ConnectionTree's folder tree — same shape, own
    // scope (vault.Folder.Scope, schema_migrations version 12), never the
    // same folder instances even if named identically.
    const sshFolders = folders.filter((f) => f.scope === 'ssh')

    const q = filter.trim().toLowerCase()
    const connectionMatches = (c: vault.ConnectionSummary) => !q || c.name.toLowerCase().includes(q)
    const folderNameMatches = (f: vault.Folder) => !q || f.name.toLowerCase().includes(q)
    const folderTree = buildFolderTree(sshFolders)
    const flatFoldersForMenu = flattenForMenu(folderTree)

    function folderHasVisibleContent(node: FolderNode): boolean {
        if (creatingFolderParentId === node.folder.id) return true
        if (folderNameMatches(node.folder)) return true
        if (connections.some((c) => c.folderId === node.folder.id && connectionMatches(c))) return true
        return node.children.some(folderHasVisibleContent)
    }

    function isFolderExpanded(id: string): boolean {
        if (q) return true
        return expandedFolders.has(id)
    }

    const rootConnections = connections.filter((c) => !c.folderId && connectionMatches(c))
    const visibleFolderNodes = folderTree.filter((node) => !q || folderHasVisibleContent(node))

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

    function renderConnectionRow(c: vault.ConnectionSummary, depth: number) {
        const isActive = c.id === activeTabConnectionId
        return (
            <div key={c.id} className="mb-0.5">
                <div
                    style={{paddingLeft: `${8 + depth * 14}px`}}
                    className={`group flex w-full items-center gap-1 py-1.5 pr-3 text-left text-sm transition-colors ${
                        isActive ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-variant'
                    }`}
                >
                    {/* No schema/keys to browse for an SSH connection — no
                        expand chevron, just a same-size spacer so the row's
                        icon/name align with folder rows above/below it. */}
                    <span className="shrink-0 p-0.5 opacity-0" aria-hidden>
                        <Icon name="chevron_right" size={18} />
                    </span>
                    <button
                        onClick={() => onOpenSshTerminal(c)}
                        title={`Abrir terminal — conecta por SSH a "${c.name}" en una pestaña nueva (o la enfoca si ya está abierta)`}
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
                    <button
                        onClick={(e) => {
                            e.stopPropagation()
                            onOpenSshTerminal(c)
                        }}
                        title="Abrir en una pestaña — terminal interactiva SSH"
                        className="hidden shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 group-hover:block"
                    >
                        <Icon name="open_in_new" size={15} />
                    </button>
                    <button
                        onClick={(e) => {
                            e.stopPropagation()
                            onDisconnect(c.id)
                        }}
                        title="Cerrar la terminal activa (mantiene la conexión guardada)"
                        className="hidden shrink-0 rounded p-0.5 opacity-70 hover:text-error hover:opacity-100 group-hover:block"
                    >
                        <Icon name="power_settings_new" size={15} />
                    </button>
                    <button
                        onClick={(e) => {
                            e.stopPropagation()
                            setConfirmDelete(c)
                        }}
                        title="Eliminar esta conexión guardada permanentemente — cualquier terminal abierta contra ella se cierra"
                        className="hidden shrink-0 rounded p-0.5 opacity-70 hover:text-error hover:opacity-100 group-hover:block"
                    >
                        <Icon name="delete" size={15} />
                    </button>
                </div>
            </div>
        )
    }

    function renderFolderNode(node: FolderNode, depth: number) {
        if (q && !folderHasVisibleContent(node)) return null

        const expanded = isFolderExpanded(node.folder.id)
        const isRenaming = renamingFolderId === node.folder.id
        const ownConnections = connections.filter((c) => c.folderId === node.folder.id && connectionMatches(c))
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
        <>
            <SidebarModule
                title="SSH"
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
                            title="Crea una nueva conexión SSH"
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
                        title="Busca por nombre de conexión SSH o de carpeta — una carpeta que contenga una coincidencia se expande automáticamente"
                        className="w-full rounded-lg border-none bg-surface-container-highest px-3 py-1.5 text-xs text-on-surface outline-none placeholder:text-on-surface-variant/60 focus:ring-1 focus:ring-primary"
                    />
                </div>
                {creatingFolderParentId === '' && <div className="px-3 pt-1">{renderNewFolderInput()}</div>}
                <div className="mt-2 flex-1 overflow-y-auto py-1">
                    {rootConnections.length === 0 && visibleFolderNodes.length === 0 && (
                        <p className="p-3 text-xs text-on-surface-variant/60">
                            {q ? `Sin coincidencias para "${filter}".` : 'Sin conexiones SSH todavía.'}
                        </p>
                    )}
                    {visibleFolderNodes.map((node) => renderFolderNode(node, 0))}
                    {rootConnections.map((c) => renderConnectionRow(c, 0))}
                </div>
            </SidebarModule>

            {confirmDelete && (
                <ConfirmDialog
                    title="Eliminar conexión"
                    description={`Esto elimina "${confirmDelete.name}" del vault de forma permanente. Cualquier terminal abierta contra ella se cierra. No se puede deshacer.`}
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
        </>
    )
}
