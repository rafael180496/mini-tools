import {useEffect, useRef, useState, type MouseEvent as ReactMouseEvent} from 'react'
import {ListConnections, ListShells} from '../../../wailsjs/go/main/App'
import {localterm} from '../../../wailsjs/go/models'
import {vault} from '../../../wailsjs/go/models'
import ConfirmDialog from '../ConfirmDialog'
import Icon from '../Icon'
import PromptDialog from '../git/PromptDialog'
import SidebarSection from './SidebarSection'
import TreeRow, {TREE_FOLDER_ICON, TREE_INDENT} from './TreeRow'
import {MenuButton, menuAnchor, moveToFolderSubmenu, useTreeMenu, type TreeMenuEntry} from './TreeMenu'
import {flattenForMenu} from './MoveToFolderMenu'
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
    // schema/keys to browse. Reached both from the context menu and from
    // clicking the row itself (unlike ConnectionTree, there's no separate
    // "select to expand a tree" step to distinguish it from).
    onOpenSshTerminal: (conn: vault.ConnectionSummary) => void
    // Abre SIEMPRE una sesión más contra el servidor, aunque ya haya una
    // pestaña abierta. Separado del anterior a propósito: el clic en el nombre
    // es también cómo se vuelve a la terminal de siempre, y si abriera una
    // sesión nueva cada vez, navegar el árbol acumularía shells contra
    // producción. Las N comparten una única conexión SSH.
    onOpenSshTerminalSession: (conn: vault.ConnectionSummary) => void
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
    // entries above keep opening their standalone tabs exactly as before.
    onOpenSshHybrid: (conn: vault.ConnectionSummary) => void
    // Highlights whichever row's terminal is the ACTIVE editor tab right
    // now — this module has no "selected connection" concept of its own
    // (see ConnectionTree's selectedId), so it borrows the tab system's own
    // notion of "current" instead.
    activeTabConnectionId: string | null
    onExportConnectionConfig: (connId: string) => void
    // connIds con al menos UNA sesión remota viva ahora mismo. Decide el punto
    // al lado del nombre y si la acción de desconectar existe.
    liveConnIds: Set<string>
    // Cuántas sesiones vivas tiene cada conexión. Solo se dibuja a partir de
    // dos: con una, el número no agrega nada al punto verde.
    liveSessionCounts: Map<string, number>
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
// same folder organization and search, but none of ConnectionTree's
// schema-browsing surface: an SSH connection is a leaf, and its real action
// is opening its terminal tab.
//
// Las filas son las de TreeRow (guías por nivel, chevron solo en carpetas) y
// casi todo lo que se hace con un servidor vive en el menú contextual —clic
// derecho o «⋯»—, con palabras al lado de cada ícono. La fila llegó a cargar
// cinco íconos sin rótulo al pasar el mouse, con «eliminar» a pocos píxeles
// del que se quería; ahora en la fila solo queda lo que se repite con una
// sesión abierta: otra terminal y desconectar.
export default function SshConnectionTree({
    onNewConnection,
    onEditConnection,
    onOpenSshTerminal,
    onOpenSshTerminalSession,
    onOpenLocalTerminal,
    onOpenSftp,
    onOpenSshHybrid,
    activeTabConnectionId,
    onExportConnectionConfig,
    liveConnIds,
    liveSessionCounts,
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
    const shellsRef = useRef<localterm.Shell[] | null>(null)
    const [confirmDelete, setConfirmDelete] = useState<vault.ConnectionSummary | null>(null)
    const [confirmDeleteFolder, setConfirmDeleteFolder] = useState<vault.Folder | null>(null)
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
    // Carpeta nueva: id del padre ('' = raíz) mientras el diálogo está abierto.
    const [creatingFolderIn, setCreatingFolderIn] = useState<string | null>(null)
    const [renamingFolder, setRenamingFolder] = useState<vault.Folder | null>(null)
    const menu = useTreeMenu()

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
        if (folderNameMatches(node.folder)) return true
        if (connections.some((c) => c.folderId === node.folder.id && connectionMatches(c))) return true
        return node.children.some(folderHasVisibleContent)
    }

    // Con una búsqueda activa todo se despliega: una coincidencia escondida
    // dentro de una carpeta plegada es una coincidencia que no se ve.
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

    const expandAll = () => setExpandedFolders(new Set(sshFolders.map((f) => f.id)))
    const collapseAll = () => setExpandedFolders(new Set())

    function startCreateFolder(parentId: string) {
        if (parentId) setExpandedFolders((prev) => new Set(prev).add(parentId))
        setCreatingFolderIn(parentId)
    }

    // openWithShells abre un menú que necesita la lista de intérpretes, que se
    // pide recién la primera vez (ver shellsRef). El menú se abre al volver la
    // lista, así que el ancla se toma antes: React ya no sostiene
    // `currentTarget` después de que el handler terminó.
    function openWithShells(e: ReactMouseEvent, build: (shells: localterm.Shell[]) => TreeMenuEntry[]) {
        const anchor = menuAnchor(e)
        e.preventDefault()
        e.stopPropagation()
        const load = shellsRef.current
            ? Promise.resolve(shellsRef.current)
            : ListShells()
                  .then((list) => list ?? [])
                  .catch(() => [] as localterm.Shell[])
        void load.then((list) => {
            shellsRef.current = list
            menu.openAtPoint(anchor, build(list))
        })
    }

    const shellItems = (shells: localterm.Shell[]): TreeMenuEntry[] => [
        {
            label: 'Predeterminada',
            icon: 'terminal',
            title: 'Abre el intérprete elegido en Configuración → Terminal',
            onSelect: () => onOpenLocalTerminal('', 'shell por defecto'),
        },
        ...(shells.length ? (['separator'] as TreeMenuEntry[]) : []),
        ...shells.map(
            (sh): TreeMenuEntry => ({
                label: sh.label,
                icon: 'terminal',
                hint: sh.available ? undefined : 'falta',
                disabled: !sh.available,
                title: sh.available ? `Abre ${sh.label} (${sh.path}) en una pestaña nueva` : `${sh.label} no está instalado en esta máquina`,
                onSelect: () => onOpenLocalTerminal(sh.id, sh.label),
            }),
        ),
    ]

    const connectionMenu = (e: ReactMouseEvent, c: vault.ConnectionSummary) => {
        const liveCount = liveSessionCounts.get(c.id) ?? 0
        const isLive = liveConnIds.has(c.id)
        menu.openAt(e, [
            {label: 'Abrir terminal', icon: 'terminal', hint: 'clic', title: 'Abre la terminal de este servidor, o la enfoca si ya está abierta', onSelect: () => onOpenSshTerminal(c)},
            {
                label: 'Nueva terminal',
                icon: 'add',
                title: 'Abre otra sesión contra este servidor, además de las que ya estén abiertas. Todas comparten una sola conexión SSH: no se autentica de nuevo',
                onSelect: () => onOpenSshTerminalSession(c),
            },
            {label: 'Explorador SFTP', icon: 'swap_horiz', title: 'Transferir archivos entre esta máquina y el servidor', onSelect: () => onOpenSftp(c)},
            {
                label: 'Sesión combinada',
                icon: 'vertical_split',
                title: 'Consola y explorador de archivos del mismo servidor en una sola pestaña, sobre una única conexión SSH (Ctrl+Shift+F muestra u oculta los archivos)',
                onSelect: () => onOpenSshHybrid(c),
            },
            'separator',
            {label: 'Editar conexión', icon: 'edit', onSelect: () => onEditConnection(c)},
            {label: 'Mover a…', icon: 'drive_file_move', submenu: moveToFolderSubmenu(flatFoldersForMenu, c.folderId ?? '', (f) => onMoveConnectionToFolder(c.id, f))},
            {
                label: 'Exportar configuración',
                icon: 'output',
                title: 'Guarda host, puerto y usuario en un archivo — nunca la contraseña ni la llave privada',
                onSelect: () => onExportConnectionConfig(c.id),
            },
            'separator',
            // Desconectar solo aparece si hay algo que desconectar: sin sesión
            // viva no hacía nada y se leía como roto.
            ...(isLive
                ? [
                      {
                          label: liveCount > 1 ? `Desconectar (${liveCount} sesiones)` : 'Desconectar',
                          icon: 'power_settings_new',
                          title: 'Cierra las sesiones de terminal abiertas contra este servidor — la conexión guardada queda intacta',
                          onSelect: () => onDisconnect(c.id),
                      } as TreeMenuEntry,
                  ]
                : []),
            {label: 'Eliminar conexión', icon: 'delete', danger: true, onSelect: () => setConfirmDelete(c)},
        ])
    }

    const folderMenu = (e: ReactMouseEvent, node: FolderNode) => {
        const f = node.folder
        const open = isFolderExpanded(f.id)
        menu.openAt(e, [
            {label: 'Subcarpeta nueva', icon: 'create_new_folder', onSelect: () => startCreateFolder(f.id)},
            'separator',
            {label: open ? 'Plegar' : 'Desplegar', icon: open ? 'unfold_less' : 'unfold_more', disabled: !!q, onSelect: () => toggleFolder(f.id)},
            'separator',
            {label: 'Cambiar nombre', icon: 'edit', onSelect: () => setRenamingFolder(f)},
            {label: 'Subir', icon: 'arrow_upward', title: 'Mueve la carpeta un lugar hacia arriba entre sus hermanas', onSelect: () => onReorderFolder(f.id, 'up')},
            {label: 'Bajar', icon: 'arrow_downward', title: 'Mueve la carpeta un lugar hacia abajo entre sus hermanas', onSelect: () => onReorderFolder(f.id, 'down')},
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
        openWithShells(e, (shells) => [
            {label: 'Conexión SSH nueva', icon: 'add', onSelect: onNewConnection},
            {label: 'Carpeta nueva', icon: 'create_new_folder', onSelect: () => startCreateFolder('')},
            'separator',
            {label: 'Terminal de esta máquina', icon: 'terminal', submenu: shellItems(shells)},
            'separator',
            {label: 'Desplegar todo', icon: 'unfold_more', disabled: !!q || sshFolders.length === 0, onSelect: expandAll},
            {label: 'Plegar todo', icon: 'unfold_less', disabled: !!q || sshFolders.length === 0, onSelect: collapseAll},
        ])

    function renderConnectionRow(c: vault.ConnectionSummary, depth: number) {
        const isActive = c.id === activeTabConnectionId
        const isLive = liveConnIds.has(c.id)
        const liveCount = liveSessionCounts.get(c.id) ?? 0
        const env = envStyleOf(c)
        return (
            <TreeRow
                key={c.id}
                depth={depth}
                // El ícono cambia de tono con una sesión viva: es lo que se
                // busca de un vistazo en una lista de servidores.
                icon="dns"
                iconFilled={isLive}
                iconClass={isActive ? 'text-primary' : isLive ? 'text-secondary' : undefined}
                label={
                    <>
                        {c.color && (
                            <span
                                aria-hidden
                                className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
                                style={{backgroundColor: c.color}}
                            />
                        )}
                        {c.name}
                    </>
                }
                labelClass={isActive ? 'text-on-surface font-medium' : undefined}
                title={
                    c.name +
                    (env ? ` · ${env.label}` : '') +
                    (isLive ? ` · ${liveCount > 1 ? `${liveCount} sesiones abiertas` : 'sesión abierta'}` : '') +
                    '. Clic: abrir su terminal (o enfocarla). Clic derecho: más opciones.'
                }
                onClick={() => onOpenSshTerminal(c)}
                onContextMenu={(e) => connectionMenu(e, c)}
                active={isActive}
                stripe={env?.dot}
                trailing={
                    isLive ? (
                        liveCount > 1 ? (
                            <span
                                title={`${liveCount} sesiones SSH abiertas contra este servidor`}
                                className="rounded-full bg-secondary/15 px-1 text-ui-9 leading-tight font-semibold tabular-nums text-secondary"
                            >
                                {liveCount}
                            </span>
                        ) : (
                            <span
                                aria-hidden
                                title="Hay una sesión SSH abierta contra este servidor"
                                className="h-1.5 w-1.5 rounded-full bg-secondary"
                            />
                        )
                    ) : undefined
                }
                actions={
                    <>
                        {/* Con una sesión viva, lo que se repite es abrir
                            otra y cerrarlas: van en la fila. Sin sesión, el
                            clic ya abre la terminal y el resto es menú. */}
                        {isLive && (
                            <>
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        onOpenSshTerminalSession(c)
                                    }}
                                    title="Nueva terminal — abre otra sesión contra este servidor. Todas comparten una sola conexión SSH: no se autentica de nuevo"
                                    className="sidebar-icon p-0.5!"
                                >
                                    <Icon name="add" size={14} />
                                </button>
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        onDisconnect(c.id)
                                    }}
                                    title={
                                        liveCount > 1
                                            ? `Cerrar las ${liveCount} sesiones de terminal abiertas contra este servidor — la conexión guardada queda intacta`
                                            : 'Cerrar la sesión de terminal abierta contra este servidor — la conexión guardada queda intacta'
                                    }
                                    className="rounded p-0.5 text-error hover:bg-error-container/40"
                                >
                                    <Icon name="power_settings_new" size={14} />
                                </button>
                            </>
                        )}
                        <MenuButton onOpen={(e) => connectionMenu(e, c)} title="Opciones del servidor: terminal, SFTP, editar, mover, exportar, eliminar" />
                    </>
                }
            />
        )
    }

    function renderFolderNode(node: FolderNode, depth: number) {
        if (q && !folderHasVisibleContent(node)) return null

        const expanded = isFolderExpanded(node.folder.id)
        const ownConnections = connections.filter((c) => c.folderId === node.folder.id && connectionMatches(c))
        const total = countConnectionsIn(node, connections, connectionMatches)
        const visibleChildren = q ? node.children.filter(folderHasVisibleContent) : node.children

        return (
            <div key={node.folder.id}>
                <TreeRow
                    depth={depth}
                    icon={expanded ? 'folder_open' : 'folder'}
                    iconClass={TREE_FOLDER_ICON}
                    iconFilled={!expanded}
                    label={node.folder.name}
                    labelClass="text-on-surface font-medium"
                    title={`${node.folder.name} — ${total} ${total === 1 ? 'servidor' : 'servidores'}. Clic derecho: más opciones.`}
                    expanded={expanded}
                    onToggle={() => toggleFolder(node.folder.id)}
                    onClick={() => toggleFolder(node.folder.id)}
                    onContextMenu={(e) => folderMenu(e, node)}
                    trailing={total > 0 ? <span className="text-ui-10 tabular-nums text-on-surface-variant/50">{total}</span> : undefined}
                    actions={<MenuButton onOpen={(e) => folderMenu(e, node)} title="Opciones de la carpeta" />}
                />
                {expanded && (
                    <>
                        {visibleChildren.map((child) => renderFolderNode(child, depth + 1))}
                        {ownConnections.map((c) => renderConnectionRow(c, depth + 1))}
                        {visibleChildren.length === 0 && ownConnections.length === 0 && (
                            <p
                                style={{paddingLeft: `${(depth + 1) * TREE_INDENT + 28}px`}}
                                className="py-0.5 text-ui-11 text-on-surface-variant/60"
                            >
                                {q ? 'Sin coincidencias.' : 'Carpeta vacía.'}
                            </p>
                        )}
                    </>
                )}
            </div>
        )
    }

    const headerBtn = 'rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-40'

    return (
        <SidebarSection
            title="SSH"
            count={q ? `${rootConnections.length + visibleFolderNodes.length} de ${connections.length}` : connections.length ? String(connections.length) : null}
            actions={
                <>
                    <button
                        onClick={() => startCreateFolder('')}
                        title="Crea una carpeta para agrupar servidores SSH — las carpetas solo organizan, nunca cambian a qué host apunta una conexión"
                        className={headerBtn}
                    >
                        <Icon name="create_new_folder" size={16} />
                    </button>
                    <button
                        onClick={() => (expandedFolders.size > 0 ? collapseAll() : expandAll())}
                        disabled={!!q || sshFolders.length === 0}
                        title={
                            q
                                ? 'Con una búsqueda activa las carpetas ya están desplegadas'
                                : sshFolders.length === 0
                                  ? 'Todavía no hay carpetas que desplegar'
                                  : expandedFolders.size > 0
                                    ? 'Plegar todas las carpetas'
                                    : 'Desplegar todas las carpetas'
                        }
                        className={headerBtn}
                    >
                        <Icon name={expandedFolders.size > 0 ? 'unfold_less' : 'unfold_more'} size={16} />
                    </button>
                    {/* Terminal local. Va en este encabezado y no en el
                        toolbar general porque es parte de trabajar acá: la
                        mitad de lo que se hace con un servidor tiene una mitad
                        local (un scp, un kubectl, mirar un archivo que uno
                        acaba de bajar). */}
                    <button
                        onClick={(e) => openWithShells(e, shellItems)}
                        title="Abre una terminal de ESTA máquina (PowerShell, zsh, bash…) en una pestaña, con los mismos snippets y su propio historial. No es un servidor: lo que ejecutes corre en tu equipo."
                        className={headerBtn}
                    >
                        <Icon name="terminal" size={16} />
                    </button>
                    <button onClick={onNewConnection} title="Crea una nueva conexión SSH (host, usuario y clave o llave)" className={headerBtn}>
                        <Icon name="add" size={16} />
                    </button>
                </>
            }
        >
            {/* El área vacía debajo de las filas también responde al clic
                derecho (conexión nueva, carpeta, terminal local, plegar), como
                en cualquier explorador. */}
            <div className="min-h-0 flex-1 pb-6" onContextMenu={blankMenu}>
                {rootConnections.length === 0 && visibleFolderNodes.length === 0 && (
                    <p className="p-3 text-xs text-on-surface-variant/60">
                        {q ? `Sin coincidencias para "${filter}".` : 'Sin conexiones SSH todavía.'}
                    </p>
                )}
                {visibleFolderNodes.map((node) => renderFolderNode(node, 0))}
                {rootConnections.map((c) => renderConnectionRow(c, 0))}
            </div>

            {menu.element}

            {creatingFolderIn !== null && (
                <PromptDialog
                    title={creatingFolderIn ? 'Subcarpeta nueva' : 'Carpeta nueva'}
                    label="Nombre"
                    placeholder="Nombre de la carpeta..."
                    confirmLabel="Crear"
                    description="Las carpetas solo organizan: nunca cambian a qué host apunta una conexión."
                    onSubmit={(value) => {
                        const parent = creatingFolderIn
                        setCreatingFolderIn(null)
                        if (value.trim()) onCreateFolder(value.trim(), parent)
                    }}
                    onClose={() => setCreatingFolderIn(null)}
                />
            )}
            {renamingFolder && (
                <PromptDialog
                    title="Cambiar el nombre de la carpeta"
                    label="Nombre"
                    initial={renamingFolder.name}
                    confirmLabel="Guardar"
                    onSubmit={(value) => {
                        const id = renamingFolder.id
                        setRenamingFolder(null)
                        if (value.trim()) onRenameFolder(id, value.trim())
                    }}
                    onClose={() => setRenamingFolder(null)}
                />
            )}
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
