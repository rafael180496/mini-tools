import {useEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {ListConnections, ListShells} from '../../../wailsjs/go/main/App'
import {localterm} from '../../../wailsjs/go/models'
import {vault} from '../../../wailsjs/go/models'
import ConfirmDialog from '../ConfirmDialog'
import DbTypeIcon from '../DbTypeIcon'
import Icon from '../Icon'
import SidebarSection from './SidebarSection'
import {flattenForMenu} from './MoveToFolderMenu'
import SshRowMenu from './SshRowMenu'
import {buildFolderTree, countConnectionsIn, type FolderNode} from '../../lib/folderTree'
import {environmentStyle} from '../../lib/environments'

// envStyleOf resolves a connection's environment marking to its colours. See
// lib/environments.ts — an unmarked connection renders exactly as before.
function envStyleOf(c: vault.ConnectionSummary) {
    return environmentStyle(c.environment)
}

interface SshConnectionTreeProps {
    onNewConnection: () => void
    onEditConnection: (conn: vault.ConnectionSummary) => void
    // Opens (or focuses) a connection's terminal tab — the only thing to do
    // with an SSH connection besides edit/move/delete, since it has no
    // schema/keys to browse. Reached both from the dedicated row button and
    // from clicking the row itself (unlike ConnectionTree, there's no
    // separate "select to expand a tree" step to distinguish it from).
    onOpenSshTerminal: (conn: vault.ConnectionSummary) => void
    // Abre una terminal del SISTEMA OPERATIVO (la shell de esta máquina) en una
    // pestaña nueva.
    //
    // Vive en este módulo y no en otro porque el trabajo real es el mismo: se
    // mira un log en el servidor, se copia algo a la máquina de uno, se corre
    // un `scp`. Tener que salir de la app para la mitad local partía ese
    // trabajo en dos — y dejaba afuera los snippets y el historial, que hasta
    // ahora solo servían del lado remoto.
    onOpenLocalTerminal: (shellId: string, shellLabel: string) => void
    // Opens (or focuses) the dual-pane SFTP file-transfer explorer seeded with
    // this host — reuses the same saved SSH connection as the terminal.
    onOpenSftp: (conn: vault.ConnectionSummary) => void
    // Opens terminal and files together in one tab. Additive: the two
    // buttons above keep opening their standalone tabs exactly as before.
    onOpenSshHybrid: (conn: vault.ConnectionSummary) => void
    // Highlights whichever row's terminal is the ACTIVE editor tab right
    // now — this module has no "selected connection" concept of its own
    // (see ConnectionTree's selectedId), so it borrows the tab system's own
    // notion of "current" instead.
    activeTabConnectionId: string | null
    onExportConnectionConfig: (connId: string) => void
    // connIds with a live remote session right now. Drives both the dot next
    // to the name and whether the disconnect button exists at all.
    liveConnIds: Set<string>
    onDisconnect: (connId: string) => void
    onDeleteConnection: (connId: string) => void
    reloadToken: number
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
    // Búsqueda global de la barra, dibujada por el marco (Sidebar.tsx) y
    // compartida por los cuatro módulos — ver ConnectionTree.
    filter: string
    // Cuántos elementos coinciden con la búsqueda global. Se informa hacia
    // arriba porque el contador vive en el menú master (SidebarMasterMenu):
    // con un módulo a la vez, es lo único que dice que lo que se busca está
    // en otro módulo y no perdido.
    onMatchCount: (n: number | null) => void
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
    onOpenLocalTerminal,
    onOpenSftp,
    onOpenSshHybrid,
    activeTabConnectionId,
    onExportConnectionConfig,
    liveConnIds,
    onDisconnect,
    onDeleteConnection,
    reloadToken,
    folders,
    onCreateFolder,
    onRenameFolder,
    onDeleteFolder,
    onReorderFolder,
    filter,
    onMatchCount,
    onMoveConnectionToFolder,
}: SshConnectionTreeProps) {
    const [connections, setConnections] = useState<vault.ConnectionSummary[]>([])
    // Intérpretes disponibles en esta máquina, para el menú de terminal local.
    // Se piden al abrir el menú y no al montar la barra: es una lista que solo
    // mira quien va a abrir una terminal, y cuesta un recorrido del PATH.
    const [shells, setShells] = useState<localterm.Shell[]>([])
    const [shellMenu, setShellMenu] = useState(false)
    // Posición del menú de intérpretes, medida desde el botón al abrirlo.
    //
    // **Va en un portal con posición fija y no pegado al botón**: la barra
    // lateral se puede angostar hasta menos que el ancho del menú, y ahí un
    // desplegable posicionado adentro queda recortado por el contenedor —se
    // veía cortado y con el texto encimado. Es la misma técnica que ya usan
    // SshRowMenu y MoveToFolderMenu, y por la misma razón.
    const [shellMenuPos, setShellMenuPos] = useState({top: 0, left: 0})
    const shellBtnRef = useRef<HTMLButtonElement>(null)
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

    const matchCount = q ? rootConnections.length + visibleFolderNodes.length : null
    useEffect(() => {
        onMatchCount(matchCount)
    }, [matchCount, onMatchCount])

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
        const isLive = liveConnIds.has(c.id)
        return (
            <div key={c.id} className="mb-0.5">
                <div
                    style={{paddingLeft: `${8 + depth * 14}px`}}
                    className={`group flex w-full items-center gap-1 py-1.5 pr-3 text-left text-sm transition-colors ${
                        isActive ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-variant'
                    } ${envStyleOf(c)?.border ?? ''}`}
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
                        {isLive && (
                            <span
                                aria-hidden
                                title="Hay una sesión SSH abierta contra este servidor"
                                className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500 dark:bg-emerald-400"
                            />
                        )}
                        {envStyleOf(c) && (
                            <span
                                title={`Entorno: ${envStyleOf(c)!.label}`}
                                className={`shrink-0 rounded px-1 py-px text-ui-9 leading-tight font-semibold tracking-wide ${envStyleOf(c)!.badge}`}
                            >
                                {envStyleOf(c)!.short}
                            </span>
                        )}
                    </button>
                    {/* Only the actions with a distinct verb stay on the row.
                        Everything else moved into SshRowMenu — seven unlabelled
                        icons crammed into a sidebar this narrow were impossible
                        to tell apart, with "eliminar" a few pixels from the one
                        you meant to click. */}
                    <button
                        onClick={(e) => {
                            e.stopPropagation()
                            onOpenSftp(c)
                        }}
                        title="Abrir explorador SFTP — transferir archivos entre hosts"
                        className="hidden shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 group-hover:block"
                    >
                        <Icon name="swap_horiz" size={15} />
                    </button>
                    <button
                        onClick={(e) => {
                            e.stopPropagation()
                            onOpenSshHybrid(c)
                        }}
                        title="Abrir sesión combinada — consola y explorador de archivos del mismo servidor en una sola pestaña, sobre una única conexión SSH (Ctrl+Shift+F muestra u oculta los archivos)"
                        className="hidden shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 group-hover:block"
                    >
                        <Icon name="vertical_split" size={15} />
                    </button>
                    {/* Disconnect only exists while there IS something to
                        disconnect: on a connection with no live session the
                        button did nothing, which made it read as broken. It
                        also stays visible without hovering — a live session is
                        state worth seeing, not just an action. */}
                    {isLive && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation()
                                onDisconnect(c.id)
                            }}
                            title="Cerrar la sesión de terminal abierta contra este servidor — la conexión guardada queda intacta"
                            className="shrink-0 rounded p-0.5 text-error opacity-80 hover:bg-error-container/40 hover:opacity-100"
                        >
                            <Icon name="power_settings_new" size={15} />
                        </button>
                    )}
                    <SshRowMenu
                        flatFolders={flatFoldersForMenu}
                        onOpenTerminal={() => onOpenSshTerminal(c)}
                        onEdit={() => onEditConnection(c)}
                        onMoveToFolder={(folderId) => onMoveConnectionToFolder(c.id, folderId)}
                        onExport={() => onExportConnectionConfig(c.id)}
                        onDelete={() => setConfirmDelete(c)}
                    />
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
        const total = countConnectionsIn(node, connections, connectionMatches)

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
                        <>
                            <span className="min-w-0 flex-1 truncate font-medium">{node.folder.name}</span>
                            {/* Ver ConnectionTree: el contador se esconde al
                                pasar el mouse para dejarle el lugar a los
                                botones de la fila. */}
                            {total > 0 && (
                                <span className="shrink-0 font-mono text-ui-10 tabular-nums text-on-surface-variant/45 group-hover/folder:hidden">
                                    {total}
                                </span>
                            )}
                        </>
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
        <SidebarSection
            title="SSH"
            count={q ? `${rootConnections.length + visibleFolderNodes.length} de ${connections.length}` : connections.length ? String(connections.length) : null}
            actions={
                <>
                    <button
                        onClick={() => startCreateFolder('')}
                        title="Crea una carpeta para agrupar servidores SSH — las carpetas solo organizan, nunca cambian a qué host apunta una conexión"
                        className="rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="create_new_folder" size={16} />
                    </button>
                    {/* Terminal local. Va en este encabezado y no en el
                        toolbar general porque es parte de trabajar acá: la
                        mitad de lo que se hace con un servidor tiene una mitad
                        local (un scp, un kubectl, mirar un archivo que uno
                        acaba de bajar). */}
                    <>
                        <button
                            ref={shellBtnRef}
                            onClick={() => {
                                const rect = shellBtnRef.current?.getBoundingClientRect()
                                if (rect) {
                                    // Se ancla al botón pero se recorta contra
                                    // la ventana: con la barra angosta el menú
                                    // se abre por encima del área de trabajo,
                                    // que es donde hay lugar, y nunca se pasa
                                    // del borde derecho ni de abajo.
                                    const width = 224
                                    setShellMenuPos({
                                        top: Math.min(rect.bottom + 4, Math.max(8, window.innerHeight - 220)),
                                        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
                                    })
                                }
                                setShellMenu((v) => !v)
                                if (shells.length === 0) {
                                    ListShells()
                                        .then((list) => setShells(list ?? []))
                                        .catch(() => setShells([]))
                                }
                            }}
                            title="Abre una terminal de ESTA máquina (PowerShell, zsh, bash…) en una pestaña, con los mismos snippets y su propio historial. No es un servidor: lo que ejecutes corre en tu equipo."
                            className="rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                        >
                            <Icon name="terminal" size={16} />
                        </button>
                        {shellMenu &&
                            createPortal(
                            <>
                                {/* Capa de cierre: un menú que solo se cierra
                                    con su propio botón obliga a volver a
                                    apuntarle. */}
                                <div className="fixed inset-0 z-40" onClick={() => setShellMenu(false)} />
                                <div
                                    style={{position: 'fixed', top: shellMenuPos.top, left: shellMenuPos.left}}
                                    className="z-50 max-h-72 w-56 overflow-y-auto rounded-lg border border-outline-variant bg-surface-container-high py-1 shadow-lg"
                                >
                                    <p className="px-3 py-1 text-ui-10 uppercase tracking-wider text-on-surface-variant/70">
                                        Terminal de esta máquina
                                    </p>
                                    <button
                                        onClick={() => {
                                            setShellMenu(false)
                                            onOpenLocalTerminal('', 'shell por defecto')
                                        }}
                                        title="Abre el intérprete elegido en Configuración → Terminal"
                                        className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs text-on-surface hover:bg-surface-variant"
                                    >
                                        <Icon name="terminal" size={13} className="shrink-0 text-primary" />
                                        Predeterminada
                                    </button>
                                    {shells.map((sh) => (
                                        <button
                                            key={sh.id}
                                            disabled={!sh.available}
                                            onClick={() => {
                                                setShellMenu(false)
                                                onOpenLocalTerminal(sh.id, sh.label)
                                            }}
                                            title={
                                                sh.available
                                                    ? `Abre ${sh.label} (${sh.path}) en una pestaña nueva`
                                                    : `${sh.label} no está instalado en esta máquina`
                                            }
                                            className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs text-on-surface hover:bg-surface-variant disabled:opacity-40 disabled:hover:bg-transparent"
                                        >
                                            <Icon name="terminal" size={13} className="shrink-0 text-on-surface-variant" />
                                            <span className="min-w-0 flex-1 truncate">{sh.label}</span>
                                            {!sh.available && <span className="shrink-0 text-ui-10 text-on-surface-variant/60">falta</span>}
                                        </button>
                                    ))}
                                </div>
                            </>,
                            document.body,
                        )}
                    </>
                    <button
                        onClick={onNewConnection}
                        title="Crea una nueva conexión SSH (host, usuario y clave o llave)"
                        className="rounded p-1 text-primary hover:bg-surface-variant"
                    >
                        <Icon name="add" size={16} />
                    </button>
                </>
            }
        >
            {creatingFolderParentId === '' && <div className="px-3 pt-1">{renderNewFolderInput()}</div>}
            {rootConnections.length === 0 && visibleFolderNodes.length === 0 && (
                <p className="p-3 text-xs text-on-surface-variant/60">
                    {q ? `Sin coincidencias para "${filter}".` : 'Sin conexiones SSH todavía.'}
                </p>
            )}
            {visibleFolderNodes.map((node) => renderFolderNode(node, 0))}
            {rootConnections.map((c) => renderConnectionRow(c, 0))}

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
        </SidebarSection>
    )
}
