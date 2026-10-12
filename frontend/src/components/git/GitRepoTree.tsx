import {useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent} from 'react'
import {
    GitAddRepo,
    GitInitRepo,
    GitPickFolder,
    GitBranches,
    GitListRepos,
    GitPickRepoFolder,
    GitProbe,
    GitRemotes,
    GitRemoveRepo,
    GitSetPinnedBranches,
    GitStashes,
    GitTags,
} from '../../../wailsjs/go/main/App'
import {git, vault} from '../../../wailsjs/go/models'
import ConfirmDialog from '../ConfirmDialog'
import {useT} from '../../i18n'
import Icon from '../Icon'
import SidebarSection from '../sidebar/SidebarSection'
import TreeRow, {TREE_FOLDER_ICON} from '../sidebar/TreeRow'
import {MenuButton, moveToFolderSubmenu, useTreeMenu, type TreeMenuEntry} from '../sidebar/TreeMenu'
import {flattenForMenu} from '../sidebar/MoveToFolderMenu'
import {buildFolderTree, type FolderNode} from '../../lib/folderTree'
import {foldersToOpenFor} from '../../lib/gitRefs'
import {requestGit} from '../../lib/gitBus'
import PromptDialog from './PromptDialog'
import GitCloneDialog from './GitCloneDialog'
import GitSettingsDialog from './GitSettingsDialog'
import RepoRefsTree, {AheadBehind, type RepoRefsUi} from './RepoRefsTree'
import {useRepoRefActions, type PromptSpec, type RepoDetail} from './useRepoRefActions'

interface GitRepoTreeProps {
    // Opens (or focuses) a repository's tab — double-click on a row, matching
    // SshConnectionTree's single action-per-row model.
    onOpenRepo: (repo: vault.GitRepo) => void
    // Highlights the row whose tab is currently active. Like SshConnectionTree,
    // this module has no "selected repo" concept of its own — it borrows the
    // tab system's notion of current.
    activeTabRepoId: string | null
    // Bumped by Workspace after any mutation elsewhere that should invalidate
    // this list, same reloadToken pattern the other sidebar modules use.
    reloadToken: number
    // Bumped after any Git mutation anywhere — including inside a repo tab.
    // Expanded repositories reload their detail off it, so a checkout done in a
    // tab is reflected here without this component knowing tabs exist.
    syncToken: number
    // Called after this module mutates a repository, so tabs reload too.
    onChanged: () => void
    // Full flat folder list (all scopes) — filtered internally to scope 'git',
    // same "unfiltered prop, filter own slice" pattern as ConnectionTree/
    // SshConnectionTree. Git's folder tree is independent of the DB/SSH ones
    // even if a folder shares a name.
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
    onMoveRepoToFolder: (repoId: string, folderId: string) => void
}

// Git's own sidebar module, sibling to "Conexiones" and "SSH".
//
// Detail (branches/remotes/tags/stashes) is loaded lazily, only when a
// repository row is expanded, and only once per expansion: a user with a dozen
// registered repositories would otherwise pay four git invocations per
// repository on every sidebar render.
//
// Las filas son las de TreeRow y el menú el de TreeMenu, igual que Notas: el
// mismo clic derecho abre el mismo menú en los cinco módulos. Cada fila deja a
// la vista una o dos acciones como mucho; todo lo demás vive en ese menú (y en
// el «⋯», para quien no sabe que existe el clic derecho). Antes un repositorio
// tenía cuatro íconos al pasar el mouse y una carpeta seis, y la fila se leía
// como una barra de herramientas y no como un nombre.
export default function GitRepoTree({
    onOpenRepo,
    activeTabRepoId,
    reloadToken,
    syncToken,
    onChanged,
    folders,
    onCreateFolder,
    onRenameFolder,
    onDeleteFolder,
    onReorderFolder,
    filter,
    onMatchCount,
    onMoveRepoToFolder,
}: GitRepoTreeProps) {
    const t = useT()
    const tg = t.sidebar.git
    const tf = t.sidebar.folders
    const [repos, setRepos] = useState<vault.GitRepo[]>([])
    const [probe, setProbe] = useState<git.Availability | null>(null)
    const [expanded, setExpanded] = useState<Set<string>>(new Set())
    const [openSections, setOpenSections] = useState<Set<string>>(new Set())
    const [details, setDetails] = useState<Record<string, RepoDetail>>({})
    const [error, setError] = useState<string | null>(null)
    const [localToken, setLocalToken] = useState(0)

    const menu = useTreeMenu()
    const [confirmRemove, setConfirmRemove] = useState<vault.GitRepo | null>(null)
    // Repositorio cuya configuración de git está abierta, y con qué pestaña
    // abre. Guarda el repo entero porque el diálogo muestra su nombre en el
    // título — abrirlo desde varios lugares y no saber sobre cuál se está
    // trabajando es el tipo de ambigüedad que termina en un set-url en el
    // repositorio equivocado.
    //
    // Hasta ahora la identidad y los tokens solo se podían tocar desde la
    // pestaña abierta del repositorio: para arreglar el email con el que se
    // firman los commits había que abrirlo primero.
    const [settingsFor, setSettingsFor] = useState<{repo: vault.GitRepo; tab: 'identity' | 'remotes'} | null>(null)
    const [prompt, setPrompt] = useState<PromptSpec | null>(null)
    // Estado de interfaz por repositorio, aparte del detalle (que se recarga):
    // el filtro escrito, si su campo está a la vista y la fila marcada. Sobrevive
    // a plegar el repositorio y a recargar el detalle.
    const [filters, setFilters] = useState<Record<string, string>>({})
    const [filterOpen, setFilterOpen] = useState<Set<string>>(new Set())
    const [selectedRef, setSelectedRef] = useState<Record<string, string>>({})
    // Repositorios cuyo detalle ya se sembró (ramas abiertas, carpeta de la rama
    // actual abierta): se hace una vez por repositorio y no en cada recarga, o
    // volvería a abrir lo que el usuario cerró a mano.
    const seededRef = useRef<Set<string>>(new Set())

    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
    const [confirmDeleteFolder, setConfirmDeleteFolder] = useState<vault.Folder | null>(null)
    const [showClone, setShowClone] = useState(false)

    useEffect(() => {
        GitProbe().then(setProbe).catch(() => setProbe(null))
    }, [])

    useEffect(() => {
        GitListRepos()
            .then((r) => setRepos(r ?? []))
            .catch((e) => setError(String(e)))
    }, [reloadToken, localToken])

    const refresh = useCallback(() => setLocalToken((n) => n + 1), [])

    const loadDetail = useCallback(async (repoId: string) => {
        try {
            const [branches, remotes, tags, stashes] = await Promise.all([
                GitBranches(repoId, true),
                GitRemotes(repoId),
                GitTags(repoId),
                GitStashes(repoId),
            ])
            setDetails((prev) => ({
                ...prev,
                [repoId]: {branches: branches ?? [], remotes: remotes ?? [], tags: tags ?? [], stashes: stashes ?? []},
            }))
            // Las ramas son lo que casi siempre se viene a mirar: el grupo
            // arranca abierto y con las carpetas que llevan a la rama actual
            // desplegadas, para que no quede escondida detrás de un prefijo
            // plegado (`claude/…`, `feature/…`).
            if (!seededRef.current.has(repoId)) {
                seededRef.current.add(repoId)
                const local = (branches ?? []).filter((b) => !b.isRemote)
                const current = local.find((b) => b.isCurrent)
                setOpenSections((prev) => {
                    const next = new Set(prev)
                    next.add(`${repoId}:branches`)
                    if (current) for (const path of foldersToOpenFor(local, current.name)) next.add(`${repoId}:bf:${path}`)
                    return next
                })
            }
        } catch (e) {
            setError(String(e))
        }
    }, [])

    // Refresh whatever is already expanded whenever anything Git-related
    // changed. Only expanded repositories are refetched — collapsed ones have
    // no detail loaded and will fetch fresh when opened.
    const firstSyncRef = useRef(true)
    useEffect(() => {
        if (firstSyncRef.current) {
            firstSyncRef.current = false
            return
        }
        for (const repoId of expanded) void loadDetail(repoId)
        // `expanded` is deliberately not a dependency: this must run when the
        // token changes, not every time a row is expanded (that path already
        // loads its own detail).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [syncToken, loadDetail])

    const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {})

    function toggleRepo(repoId: string) {
        setExpanded((prev) => {
            const next = new Set(prev)
            if (next.has(repoId)) {
                next.delete(repoId)
            } else {
                next.add(repoId)
                void loadDetail(repoId)
            }
            return next
        })
    }

    function toggleSection(key: string) {
        setOpenSections((prev) => {
            const next = new Set(prev)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
        })
    }

    // Anclar o soltar una rama. Las anclas viven en el vault, por repositorio
    // («develop» es el tronco en un proyecto y no existe en otro), y se
    // actualizan antes de que conteste el backend: si falla, se deshace para no
    // dejar la estrella mostrando un estado que el vault no tiene.
    async function togglePin(repo: vault.GitRepo, name: string) {
        const current = repos.find((r) => r.id === repo.id)?.pinnedBranches ?? []
        const next = current.includes(name) ? current.filter((p) => p !== name) : [...current, name]
        const apply = (list: string[]) => setRepos((prev) => prev.map((r) => (r.id === repo.id ? ({...r, pinnedBranches: list} as vault.GitRepo) : r)))
        apply(next)
        try {
            await GitSetPinnedBranches(repo.id, next)
            // Las anclas también alimentan el «Modo foco» del grafo de la pestaña.
            requestGit({repoId: repo.id, kind: 'pinned-changed', pinned: next})
        } catch (e) {
            apply(current)
            setError(String(e))
        }
    }

    const pinnedOf = (repoId: string) => repos.find((r) => r.id === repoId)?.pinnedBranches ?? []

    const actions = useRepoRefActions({
        menu,
        onChanged,
        setError,
        onOpenRepo,
        openSettings: (repo, tab) => setSettingsFor({repo, tab}),
        togglePin: (repo, name) => void togglePin(repo, name),
        isPinned: (repo, name) => pinnedOf(repo.id).includes(name),
    })

    function refsUiFor(repoId: string): RepoRefsUi {
        return {
            isOpen: (key) => openSections.has(key),
            toggle: toggleSection,
            filter: filters[repoId] ?? '',
            setFilter: (v) => setFilters((prev) => ({...prev, [repoId]: v})),
            filterOpen: filterOpen.has(repoId),
            closeFilter: () =>
                setFilterOpen((prev) => {
                    const next = new Set(prev)
                    next.delete(repoId)
                    return next
                }),
            selected: selectedRef[repoId] ?? null,
            select: (key) => setSelectedRef((prev) => ({...prev, [repoId]: key})),
        }
    }

    // El botón de la lupa de la fila de un repositorio: lo despliega (si no lo
    // estaba) y deja el campo de filtro a la vista, con el foco.
    function openFilter(repoId: string) {
        setFilterOpen((prev) => new Set(prev).add(repoId))
        if (!expanded.has(repoId)) toggleRepo(repoId)
    }

    // Open an existing repository already on disk.
    async function openRepo() {
        setError(null)
        try {
            const path = await GitPickRepoFolder()
            if (!path) return
            await GitAddRepo(path)
            refresh()
        } catch (e) {
            setError(String(e))
        }
    }

    // Create a brand-new repository (`git init`) in a chosen folder.
    async function newRepo() {
        setError(null)
        try {
            const path = await GitPickFolder(tg.pickNewRepoFolder)
            if (!path) return
            await GitInitRepo(path)
            refresh()
        } catch (e) {
            setError(String(e))
        }
    }

    // Las tres formas de meter un repositorio en la barra, el mismo trío que
    // ofrece un cliente de Git en su pantalla de inicio. Se usan en el «+» del
    // encabezado y en el clic derecho sobre el fondo del árbol.
    const available = !!probe?.available
    const addEntries: TreeMenuEntry[] = [
        {label: tg.openRepoEllipsis, icon: 'folder_open', disabled: !available, title: tg.openRepoDesc, onSelect: () => void openRepo()},
        {label: tg.newRepoEllipsis, icon: 'create_new_folder', disabled: !available, title: tg.newRepoDesc, onSelect: () => void newRepo()},
        {label: tg.clone, icon: 'cloud_download', disabled: !available, title: tg.cloneDesc, onSelect: () => setShowClone(true)},
    ]

    const q = filter.trim().toLowerCase()
    const repoMatches = (r: vault.GitRepo) => !q || r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)

    // Git's own folder slice, independent of the DB/SSH trees (see the prop
    // doc). Same "flat rows in, tree built client-side" approach as the others.
    const gitFolders = folders.filter((f) => f.scope === 'git')
    const folderTree = buildFolderTree(gitFolders)
    const flatFoldersForMenu = flattenForMenu(folderTree)
    const folderNameMatches = (f: vault.Folder) => !q || f.name.toLowerCase().includes(q)

    function folderHasVisibleContent(node: FolderNode): boolean {
        if (folderNameMatches(node.folder)) return true
        if (repos.some((r) => r.folderId === node.folder.id && repoMatches(r))) return true
        return node.children.some(folderHasVisibleContent)
    }

    const isFolderExpanded = (id: string) => (q ? true : expandedFolders.has(id))
    const rootRepos = repos.filter((r) => !r.folderId && repoMatches(r))
    const visibleFolderNodes = folderTree.filter((node) => !q || folderHasVisibleContent(node))

    const matchCount = q ? rootRepos.length + visibleFolderNodes.length : null
    useEffect(() => {
        onMatchCount(matchCount)
    }, [matchCount, onMatchCount])
    const hasAnything = rootRepos.length > 0 || visibleFolderNodes.length > 0

    function toggleFolder(id: string) {
        setExpandedFolders((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    // Desplegar todo abre las carpetas y NO los repositorios: abrir un
    // repositorio son cuatro llamadas a git, y con una docena registrados el
    // botón costaría medio centenar de procesos para mirar una lista. Plegar
    // sí cierra los dos, que es barato.
    const expandAll = () => setExpandedFolders(new Set(gitFolders.map((f) => f.id)))
    const collapseAll = () => {
        setExpandedFolders(new Set())
        setExpanded(new Set())
    }
    const anyOpen = expandedFolders.size > 0 || expanded.size > 0

    // Carpeta nueva con el diálogo de la app, como en Notas. Antes era un
    // input dentro de la lista que se confirmaba al perder el foco: un clic
    // afuera creaba la carpeta con lo que hubiera escrito a medias.
    function startCreateFolder(parentId: string) {
        if (parentId) setExpandedFolders((prev) => new Set(prev).add(parentId))
        setPrompt({
            title: parentId ? tf.newSubfolder : tf.newFolder,
            label: tf.nameLabel,
            placeholder: tg.folderPlaceholder,
            confirmLabel: tf.create,
            description: tg.foldersOnlyOrganize,
            onSubmit: (name) => onCreateFolder(name, parentId),
        })
    }

    function startRenameFolder(folder: vault.Folder) {
        setPrompt({
            title: tf.renameTitle,
            label: tf.nameLabel,
            initial: folder.name,
            confirmLabel: t.common.save,
            onSubmit: (name) => onRenameFolder(folder.id, name),
        })
    }

    const blankMenu = (e: ReactMouseEvent) =>
        menu.openAt(e, [
            ...addEntries,
            'separator',
            {label: tf.newFolder, icon: 'create_new_folder', onSelect: () => startCreateFolder('')},
            'separator',
            {label: tf.expandAll, icon: 'unfold_more', disabled: !!q || gitFolders.length === 0, onSelect: expandAll},
            {label: tf.collapseAll, icon: 'unfold_less', disabled: !!q, onSelect: collapseAll},
        ])

    function folderMenu(e: ReactMouseEvent, folder: vault.Folder) {
        const open = isFolderExpanded(folder.id)
        menu.openAt(e, [
            {label: tf.newSubfolder, icon: 'create_new_folder', onSelect: () => startCreateFolder(folder.id)},
            {label: open ? t.common.collapse : t.common.expand, icon: open ? 'unfold_less' : 'unfold_more', disabled: !!q, onSelect: () => toggleFolder(folder.id)},
            'separator',
            {label: tf.moveUp, icon: 'arrow_upward', title: tg.moveUpTitle, onSelect: () => onReorderFolder(folder.id, 'up')},
            {label: tf.moveDown, icon: 'arrow_downward', title: tg.moveDownTitle, onSelect: () => onReorderFolder(folder.id, 'down')},
            'separator',
            {label: tg.renameEllipsis, icon: 'edit', onSelect: () => startRenameFolder(folder)},
            'separator',
            {
                label: tg.deleteFolder,
                icon: 'delete',
                danger: true,
                title: tg.deleteFolderTitle,
                onSelect: () => setConfirmDeleteFolder(folder),
            },
        ])
    }

    function repoMenu(e: ReactMouseEvent, repo: vault.GitRepo) {
        const open = expanded.has(repo.id)
        menu.openAt(e, [
            {label: tg.openInTab, icon: 'open_in_new', hint: t.sidebar.connections.doubleClick, onSelect: () => onOpenRepo(repo)},
            {label: open ? t.common.collapse : tg.showDetail, icon: open ? 'unfold_less' : 'unfold_more', onSelect: () => toggleRepo(repo.id)},
            {label: t.sidebar.gitRefs.filterMenu, icon: 'search', title: t.sidebar.gitRefs.filterButton({name: repo.name}), onSelect: () => openFilter(repo.id)},
            'separator',
            {label: tg.createBranchEllipsis, icon: 'call_split', title: tg.createBranchMenuTitle, onSelect: () => actions.startCreateBranch(repo)},
            {label: tg.createTagEllipsis, icon: 'sell', title: tg.createTagMenuTitle, onSelect: () => actions.startCreateTag(repo)},
            'separator',
            {
                label: tg.gitSettings,
                icon: 'settings',
                title: tg.gitSettingsTitle,
                onSelect: () => setSettingsFor({repo, tab: 'identity'}),
            },
            {label: tg.remotesEllipsis, icon: 'lan', title: tg.remotesMenuTitle, onSelect: () => setSettingsFor({repo, tab: 'remotes'})},
            'separator',
            {label: tf.moveTo, icon: 'drive_file_move', submenu: moveToFolderSubmenu(flatFoldersForMenu, repo.folderId ?? '', (f) => onMoveRepoToFolder(repo.id, f))},
            {label: tg.copyPath, icon: 'content_copy', title: repo.path, onSelect: () => copy(repo.path)},
            'separator',
            {
                label: tg.removeFromList,
                icon: 'playlist_remove',
                danger: true,
                title: tg.removeFromListTitle,
                onSelect: () => setConfirmRemove(repo),
            },
        ])
    }

    // One repository row, indented by depth (its position in the folder tree).
    function renderRepoRow(repo: vault.GitRepo, depth: number) {
        const isExpanded = expanded.has(repo.id)
        const detail = details[repo.id]
        const active = activeTabRepoId === repo.id
        // La rama actual solo se conoce con el detalle cargado (al desplegar):
        // pedirla para cada repositorio de la lista es el costo que el
        // detalle perezoso existe para evitar.
        const current = detail?.branches.find((b) => b.isCurrent && !b.isRemote)
        const repoFilter = (filters[repo.id] ?? '').trim()
        return (
            <div key={repo.id}>
                <TreeRow
                    depth={depth}
                    icon="book_2"
                    iconClass={active ? 'text-primary' : undefined}
                    label={repo.name}
                    labelClass={active ? 'text-on-surface font-medium' : 'text-on-surface/90'}
                    title={tg.repoTitle({name: repo.name, path: repo.path})}
                    active={active}
                    expanded={isExpanded}
                    onToggle={() => toggleRepo(repo.id)}
                    // El segundo clic de un doble clic no vuelve a plegar: el
                    // doble clic abre la pestaña y el repositorio queda
                    // desplegado, que es lo que se quería ver.
                    onClick={(e) => e.detail < 2 && toggleRepo(repo.id)}
                    onDoubleClick={() => onOpenRepo(repo)}
                    onContextMenu={(e) => repoMenu(e, repo)}
                    trailing={
                        <>
                            {repoFilter && <Icon name="filter_alt" size={12} className="shrink-0 text-primary" />}
                            {current && <AheadBehind branch={current} />}
                            {current && (
                                <span className="max-w-[96px] truncate font-mono text-ui-10 text-on-surface-variant/60" title={tg.currentBranch({name: current.name})}>
                                    {current.name}
                                </span>
                            )}
                        </>
                    }
                    actions={
                        <>
                            {/* La lupa: el filtro de ramas y tags de ESTE repositorio.
                                Con la lista de ramas sacada de la pestaña, es lo
                                que permite encontrar una entre cientos. */}
                            <button
                                onClick={(e) => {
                                    e.stopPropagation()
                                    openFilter(repo.id)
                                }}
                                title={repoFilter ? t.sidebar.gitRefs.filterButtonActive({name: repo.name, filter: repoFilter}) : t.sidebar.gitRefs.filterButton({name: repo.name})}
                                className={`sidebar-icon !p-0.5 ${repoFilter ? '!text-primary' : ''}`}
                            >
                                <Icon name="search" size={14} />
                            </button>
                            <MenuButton onOpen={(e) => repoMenu(e, repo)} title={tg.repoOptions} />
                        </>
                    }
                />
                {isExpanded &&
                    (detail ? (
                        <RepoRefsTree
                            ctx={{repo, detail}}
                            depth={depth + 1}
                            pinned={repos.find((r) => r.id === repo.id)?.pinnedBranches ?? []}
                            ui={refsUiFor(repo.id)}
                            actions={actions}
                            onTogglePin={(name) => void togglePin(repo, name)}
                            onManageRemotes={() => setSettingsFor({repo, tab: 'remotes'})}
                        />
                    ) : (
                        <TreeRow depth={depth + 1} icon="progress_activity" iconClass="animate-spin text-primary" label={t.common.loading} labelClass="text-on-surface-variant" />
                    ))}
            </div>
        )
    }

    // A folder node and everything under it: subfolders first, then the repos
    // that live directly in this folder.
    function renderFolderNode(node: FolderNode, depth: number) {
        const {folder} = node
        const open = isFolderExpanded(folder.id)
        const folderRepos = repos.filter((r) => r.folderId === folder.id && repoMatches(r))
        return (
            <div key={folder.id}>
                <TreeRow
                    depth={depth}
                    icon={open ? 'folder_open' : 'folder'}
                    iconClass={TREE_FOLDER_ICON}
                    iconFilled={!open}
                    label={folder.name}
                    labelClass="text-on-surface font-medium"
                    title={tg.folderTitle({name: folder.name, count: folderRepos.length})}
                    expanded={open}
                    onToggle={() => toggleFolder(folder.id)}
                    onClick={() => toggleFolder(folder.id)}
                    onContextMenu={(e) => folderMenu(e, folder)}
                    trailing={folderRepos.length ? <span className="text-ui-10 tabular-nums text-on-surface-variant/50">{folderRepos.length}</span> : undefined}
                    actions={<MenuButton onOpen={(e) => folderMenu(e, folder)} title={tf.folderOptions} />}
                />
                {open && (
                    <>
                        {node.children.filter((n) => !q || folderHasVisibleContent(n)).map((child) => renderFolderNode(child, depth + 1))}
                        {folderRepos.map((r) => renderRepoRow(r, depth + 1))}
                    </>
                )}
            </div>
        )
    }

    return (
        <SidebarSection
            title="Git"
            count={q ? tf.countOf({shown: rootRepos.length + visibleFolderNodes.length, total: repos.length}) : repos.length ? String(repos.length) : null}
            actions={
                <>
                    <button
                        onClick={() => startCreateFolder('')}
                        title={tg.newFolderTitle}
                        className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="create_new_folder" size={16} />
                    </button>
                    <button
                        onClick={() => (anyOpen ? collapseAll() : expandAll())}
                        disabled={!!q || (!anyOpen && gitFolders.length === 0)}
                        title={
                            q
                                ? tg.searchKeepsOpen
                                : anyOpen
                                  ? tg.collapseAllTitle
                                  : gitFolders.length
                                    ? tg.expandAllTitle
                                    : tg.noFoldersToExpand
                        }
                        className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-40"
                    >
                        <Icon name={anyOpen ? 'unfold_less' : 'unfold_more'} size={16} />
                    </button>
                    <button
                        onClick={(e) => menu.openAt(e, addEntries)}
                        disabled={!available}
                        title={available ? tg.addTitle : tg.addDisabledTitle}
                        className="rounded p-0.5 text-primary hover:bg-surface-variant disabled:opacity-40"
                    >
                        <Icon name="add" size={16} />
                    </button>
                </>
            }
        >
            {/* git missing is a first-class state, not a per-operation
                failure — see backend/git's package doc on the exec tradeoff. */}
            {probe && !probe.available && (
                <div className="mx-3 mb-2 rounded border border-outline-variant bg-error-container/40 p-2 text-ui-11 text-on-error-container">
                    <p className="font-medium">{tg.notInstalled}</p>
                    <p className="mt-0.5 opacity-80">
                        {tg.notInstalledBefore}
                        <span className="font-mono">{XCODE_INSTALL_CMD}</span>
                        {tg.notInstalledAfter}
                    </p>
                </div>
            )}

            {error && (
                <div className="mx-3 mt-2 flex items-start gap-1 rounded bg-error-container/40 p-1.5 text-ui-10 text-on-error-container">
                    <span className="min-w-0 flex-1 break-words">{error}</span>
                    <button onClick={() => setError(null)} title={tg.closeError} className="shrink-0">
                        <Icon name="close" size={12} />
                    </button>
                </div>
            )}

            <div className="mt-0.5 min-h-0 flex-1 pb-6" onContextMenu={blankMenu}>
                {!hasAnything && q && <p className="p-3 text-xs text-on-surface-variant/60">{tf.noMatchesFor({query: filter})}</p>}
                {/* Empty state: the three ways to add a repository, as a
                    standalone Git client offers on its start screen. */}
                {!hasAnything && !q && available && (
                    <div className="space-y-1.5 px-3 py-2">
                        <p className="pb-1 text-ui-11 text-on-surface-variant/70">{tg.empty}</p>
                        <EmptyAction icon="folder_open" label={tg.openRepo} desc={tg.openRepoDesc} onClick={() => void openRepo()} />
                        <EmptyAction icon="create_new_folder" label={tg.newRepo} desc={tg.newRepoDesc} onClick={() => void newRepo()} />
                        <EmptyAction icon="cloud_download" label={tg.clone} desc={tg.cloneDesc} onClick={() => setShowClone(true)} />
                    </div>
                )}
                {/* Carpetas primero y después los repositorios sueltos, el
                    orden de cualquier explorador de archivos. */}
                {visibleFolderNodes.map((node) => renderFolderNode(node, 0))}
                {rootRepos.map((repo) => renderRepoRow(repo, 0))}
            </div>

            {menu.element}

            {confirmDeleteFolder && (
                <ConfirmDialog
                    title={tf.deleteFolder}
                    description={tg.deleteFolderDesc({name: confirmDeleteFolder.name})}
                    confirmLabel={tf.deleteAction}
                    danger
                    onConfirm={() => onDeleteFolder(confirmDeleteFolder.id)}
                    onClose={() => setConfirmDeleteFolder(null)}
                />
            )}

            {renderDialogs()}
        </SidebarSection>
    )

    // renderDialogs holds every modal this module can raise, grouped so the
    // main return stays about the tree. All are rendered inside the top-level
    // fragment via {renderDialogs()}.
    function renderDialogs() {
        return (
            <>
            {confirmRemove && (
                <ConfirmDialog
                    title={tg.removeRepo}
                    description={tg.removeRepoDesc({name: confirmRemove.name, path: confirmRemove.path})}
                    confirmLabel={tg.remove}
                    onConfirm={async () => {
                        try {
                            await GitRemoveRepo(confirmRemove.id)
                            refresh()
                        } catch (e) {
                            setError(String(e))
                        }
                    }}
                    onClose={() => setConfirmRemove(null)}
                />
            )}

            {settingsFor && (
                <GitSettingsDialog
                    repoId={settingsFor.repo.id}
                    repoName={settingsFor.repo.name}
                    initialTab={settingsFor.tab}
                    onClose={() => setSettingsFor(null)}
                    onChanged={() => {
                        void loadDetail(settingsFor.repo.id)
                        onChanged()
                    }}
                />
            )}

            {prompt && <PromptDialog {...prompt} onClose={() => setPrompt(null)} />}
            {actions.dialogs}
            {showClone && (
                <GitCloneDialog
                    onClose={() => setShowClone(false)}
                    onCloned={(repo) => {
                        refresh()
                        onOpenRepo(repo)
                    }}
                />
            )}
            </>
        )
    }
}

// Comando, no texto: se muestra igual en todos los idiomas.
const XCODE_INSTALL_CMD = 'xcode-select --install'

// EmptyAction is one row of the empty-state start screen — an icon, a label
// and a one-line description, the same shape a standalone Git client uses for
// Open / New / Clone.
function EmptyAction({icon, label, desc, onClick}: {icon: string; label: string; desc: string; onClick: () => void}) {
    return (
        <button
            onClick={onClick}
            title={`${label} — ${desc}`}
            className="flex w-full items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-lowest px-2.5 py-2 text-left hover:bg-surface-variant/50"
        >
            <Icon name={icon} size={18} className="shrink-0 text-primary" />
            <span className="min-w-0">
                <span className="block truncate text-xs text-on-surface">{label}</span>
                <span className="block truncate text-ui-10 text-on-surface-variant/70">{desc}</span>
            </span>
        </button>
    )
}
