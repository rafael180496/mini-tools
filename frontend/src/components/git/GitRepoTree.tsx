import {useCallback, useEffect, useRef, useState} from 'react'
import {
    GitAddRemote,
    GitAddRepo,
    GitInitRepo,
    GitPickFolder,
    GitBranches,
    GitCheckout,
    GitCreateBranch,
    GitDeleteRemoteTag,
    GitDeleteTag,
    GitFetch,
    GitPushTag,
    GitStashApply,
    GitStashDrop,
    GitListRepos,
    GitPickRepoFolder,
    GitProbe,
    GitRemoteURLForCopy,
    GitRemotes,
    GitRemoveRemote,
    GitRemoveRepo,
    GitRenameRemote,
    GitSetRemoteURL,
    GitStashes,
    GitTags,
} from '../../../wailsjs/go/main/App'
import {git, vault} from '../../../wailsjs/go/models'
import ConfirmDialog from '../ConfirmDialog'
import Icon from '../Icon'
import SidebarModule from '../sidebar/SidebarModule'
import MoveToFolderMenu, {flattenForMenu} from '../sidebar/MoveToFolderMenu'
import {buildFolderTree, type FolderNode} from '../../lib/folderTree'
import ContextMenu from './ContextMenu'
import PromptDialog from './PromptDialog'
import GitCloneDialog from './GitCloneDialog'
import type {DropdownItem} from './DropdownMenu'

interface GitRepoTreeProps {
    moduleCollapsed: boolean
    onToggleModuleCollapsed: () => void
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
    onMoveRepoToFolder: (repoId: string, folderId: string) => void
}

// Expandable per-repository detail sections, mirroring the reference client's
// sidebar (BRANCHES / REMOTES / TAGS / STASHES).
type Section = 'branches' | 'remotes' | 'tags' | 'stashes'

// Everything PromptDialog takes except onClose — this component owns closing
// (it clears the state), so carrying it in the spec would be redundant.
interface PromptSpec {
    title: string
    label: string
    initial?: string
    placeholder?: string
    confirmLabel?: string
    secondLabel?: string
    secondPlaceholder?: string
    description?: string
    onSubmit: (value: string, second: string) => void
}

interface RepoDetail {
    branches: git.Branch[]
    remotes: git.Remote[]
    tags: git.Tag[]
    stashes: git.Stash[]
}

// Git's own sidebar module, sibling to "Conexiones" and "SSH".
//
// Detail (branches/remotes/tags/stashes) is loaded lazily, only when a
// repository row is expanded, and only once per expansion: a user with a dozen
// registered repositories would otherwise pay four git invocations per
// repository on every sidebar render.
export default function GitRepoTree({
    moduleCollapsed,
    onToggleModuleCollapsed,
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
    onMoveRepoToFolder,
}: GitRepoTreeProps) {
    const [repos, setRepos] = useState<vault.GitRepo[]>([])
    const [probe, setProbe] = useState<git.Availability | null>(null)
    const [filter, setFilter] = useState('')
    const [expanded, setExpanded] = useState<Set<string>>(new Set())
    const [openSections, setOpenSections] = useState<Set<string>>(new Set())
    const [details, setDetails] = useState<Record<string, RepoDetail>>({})
    const [error, setError] = useState<string | null>(null)
    const [localToken, setLocalToken] = useState(0)

    const [menu, setMenu] = useState<{x: number; y: number; items: (DropdownItem | 'separator')[]} | null>(null)
    const [confirmRemove, setConfirmRemove] = useState<vault.GitRepo | null>(null)
    const [confirmRemoveRemote, setConfirmRemoveRemote] = useState<{repoId: string; name: string} | null>(null)
    const [prompt, setPrompt] = useState<PromptSpec | null>(null)
    const [confirmTag, setConfirmTag] = useState<{repoId: string; name: string; remote: boolean} | null>(null)
    const [confirmStash, setConfirmStash] = useState<{repoId: string; ref: string; message: string} | null>(null)

    // Folder UI state, mirroring SshConnectionTree's.
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
    const [creatingFolderParentId, setCreatingFolderParentId] = useState<string | null>(null)
    const [newFolderName, setNewFolderName] = useState('')
    const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)
    const [renameFolderName, setRenameFolderName] = useState('')
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

    // checkout from the sidebar, matching the repo tab's double-click.
    async function checkout(repoId: string, name: string) {
        setError(null)
        try {
            await GitCheckout(repoId, name)
            onChanged()
        } catch (e) {
            setError(String(e))
        }
    }

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
            const path = await GitPickFolder('Elegir la carpeta del repositorio nuevo')
            if (!path) return
            await GitInitRepo(path)
            refresh()
        } catch (e) {
            setError(String(e))
        }
    }

    // The "+" menu: the three ways to get a repository into the sidebar, same
    // trio a standalone Git client offers on its start screen.
    const addMenuItems: DropdownItem[] = [
        {label: 'Abrir repositorio…', icon: 'folder_open', hint: 'Uno que ya existe en tu disco', onSelect: () => void openRepo()},
        {label: 'Nuevo repositorio…', icon: 'create_new_folder', hint: 'git init en una carpeta', onSelect: () => void newRepo()},
        {label: 'Clonar…', icon: 'cloud_download', hint: 'Desde una URL', onSelect: () => setShowClone(true)},
    ]

    // Remote right-click menu — the actions from the reference client, plus a
    // fetch shortcut since it is the one people reach for most.
    function remoteMenuItems(repoId: string, remote: git.Remote): (DropdownItem | 'separator')[] {
        return [
            {
                label: `Fetch from ${remote.name}`,
                icon: 'cloud_download',
                onSelect: async () => {
                    try {
                        await GitFetch(repoId, new git.FetchOptions({remote: remote.name}), new git.AuthConfig({}))
                        await loadDetail(repoId)
                    } catch (e) {
                        setError(String(e))
                    }
                },
            },
            'separator',
            {
                label: 'Renombrar remoto',
                icon: 'edit',
                onSelect: () =>
                    setPrompt({
                        title: `Renombrar "${remote.name}"`,
                        label: 'Nuevo nombre',
                        initial: remote.name,
                        onSubmit: async (v: string) => {
                            try {
                                await GitRenameRemote(repoId, remote.name, v)
                                await loadDetail(repoId)
                            } catch (e) {
                                setError(String(e))
                            }
                        },
                    }),
            },
            {
                label: 'Cambiar URL',
                icon: 'link',
                onSelect: () =>
                    setPrompt({
                        title: `URL de "${remote.name}"`,
                        label: 'Nueva URL',
                        // The redacted URL is shown rather than the real one on
                        // purpose — if the remote embeds a token, prefilling it
                        // would put the secret back on screen. The user types a
                        // fresh URL.
                        initial: remote.fetchUrl,
                        onSubmit: async (v: string) => {
                            try {
                                await GitSetRemoteURL(repoId, remote.name, v)
                                await loadDetail(repoId)
                            } catch (e) {
                                setError(String(e))
                            }
                        },
                    }),
            },
            {
                label: 'Copiar URL',
                icon: 'content_copy',
                onSelect: async () => {
                    try {
                        // Fetched unredacted only for this clipboard write —
                        // GitRemotes (what the UI renders) stays redacted.
                        const url = await GitRemoteURLForCopy(repoId, remote.name)
                        await navigator.clipboard.writeText(url)
                    } catch (e) {
                        setError(String(e))
                    }
                },
            },
            'separator',
            {label: 'Eliminar remoto', icon: 'delete', danger: true, onSelect: () => setConfirmRemoveRemote({repoId, name: remote.name})},
        ]
    }

    // Tag right-click menu. Local and remote deletion are separate entries on
    // purpose: deleting a tag locally leaves it on the server and vice versa,
    // which is the single most common surprise with tags — collapsing them into
    // one "delete" would hide exactly the distinction that trips people up.
    function tagMenuItems(repoId: string, tag: git.Tag): (DropdownItem | 'separator')[] {
        const guard = async (fn: () => Promise<unknown>) => {
            try {
                await fn()
                onChanged()
            } catch (e) {
                setError(String(e))
            }
        }
        return [
            {
                label: `Crear rama desde ${tag.name}…`,
                icon: 'account_tree',
                onSelect: () =>
                    setPrompt({
                        title: `Crear rama desde el tag "${tag.name}"`,
                        label: 'Nombre de la rama',
                        placeholder: 'mi-rama',
                        confirmLabel: 'Crear y cambiar',
                        description: `La rama nueva arranca en el commit ${tag.hash.slice(0, 8)}, al que apunta el tag. El tag no se modifica.`,
                        onSubmit: (v) => void guard(() => GitCreateBranch(repoId, v, tag.name, true)),
                    }),
            },
            {
                label: `Checkout ${tag.name}`,
                icon: 'check',
                hint: 'Deja el repo en HEAD desacoplado',
                onSelect: () => void guard(() => GitCheckout(repoId, tag.name)),
            },
            {label: `Copiar '${tag.name}'`, icon: 'content_copy', onSelect: () => void navigator.clipboard.writeText(tag.name)},
            'separator',
            {label: `Push ${tag.name}`, icon: 'upload', onSelect: () => void guard(() => GitPushTag(repoId, 'origin', tag.name, new git.AuthConfig({})))},
            {label: `Borrar ${tag.name}`, icon: 'delete', danger: true, hint: 'Solo local', onSelect: () => setConfirmTag({repoId, name: tag.name, remote: false})},
            {label: `Borrar ${tag.name} de origin`, icon: 'delete_forever', danger: true, hint: 'Solo en el remoto', onSelect: () => setConfirmTag({repoId, name: tag.name, remote: true})},
        ]
    }

    function stashMenuItems(repoId: string, stash: git.Stash): (DropdownItem | 'separator')[] {
        const guard = async (fn: () => Promise<unknown>) => {
            try {
                await fn()
                onChanged()
            } catch (e) {
                setError(String(e))
            }
        }
        return [
            {label: 'Aplicar (y conservar)', icon: 'download', onSelect: () => void guard(() => GitStashApply(repoId, stash.ref, false))},
            {label: 'Pop (aplicar y borrar)', icon: 'move_up', onSelect: () => void guard(() => GitStashApply(repoId, stash.ref, true))},
            'separator',
            {label: 'Descartar este stash', icon: 'delete', danger: true, onSelect: () => setConfirmStash({repoId, ref: stash.ref, message: stash.message})},
        ]
    }

    const q = filter.trim().toLowerCase()
    const repoMatches = (r: vault.GitRepo) => !q || r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)

    // Git's own folder slice, independent of the DB/SSH trees (see the prop
    // doc). Same "flat rows in, tree built client-side" approach as the others.
    const gitFolders = folders.filter((f) => f.scope === 'git')
    const folderTree = buildFolderTree(gitFolders)
    const flatFoldersForMenu = flattenForMenu(folderTree)
    const folderNameMatches = (f: vault.Folder) => !q || f.name.toLowerCase().includes(q)

    function folderHasVisibleContent(node: FolderNode): boolean {
        if (creatingFolderParentId === node.folder.id) return true
        if (folderNameMatches(node.folder)) return true
        if (repos.some((r) => r.folderId === node.folder.id && repoMatches(r))) return true
        return node.children.some(folderHasVisibleContent)
    }

    const isFolderExpanded = (id: string) => (q ? true : expandedFolders.has(id))
    const rootRepos = repos.filter((r) => !r.folderId && repoMatches(r))
    const visibleFolderNodes = folderTree.filter((node) => !q || folderHasVisibleContent(node))
    const hasAnything = rootRepos.length > 0 || visibleFolderNodes.length > 0

    function toggleFolder(id: string) {
        setExpandedFolders((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    function startCreateFolder(parentId: string) {
        if (parentId) setExpandedFolders((prev) => new Set(prev).add(parentId))
        setCreatingFolderParentId(parentId)
        setNewFolderName('')
    }

    function commitCreateFolder() {
        const name = newFolderName.trim()
        if (name && creatingFolderParentId !== null) onCreateFolder(name, creatingFolderParentId)
        setCreatingFolderParentId(null)
        setNewFolderName('')
    }

    function commitRenameFolder() {
        const name = renameFolderName.trim()
        if (name && renamingFolderId) onRenameFolder(renamingFolderId, name)
        setRenamingFolderId(null)
    }

    function newFolderInput() {
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

    // One repository row, indented by depth (its position in the folder tree).
    function renderRepoRow(repo: vault.GitRepo, depth: number) {
        const isExpanded = expanded.has(repo.id)
        const detail = details[repo.id]
        return (
            <div key={repo.id}>
                <div
                    style={{paddingLeft: `${8 + depth * 14}px`}}
                    className={`group flex items-center gap-1 py-1 pr-2 text-xs ${
                        activeTabRepoId === repo.id ? 'bg-primary-container/60 text-on-primary-container' : 'text-on-surface hover:bg-surface-variant/50'
                    }`}
                >
                    <button
                        onClick={() => toggleRepo(repo.id)}
                        title={isExpanded ? 'Colapsar ramas, remotos, tags y stashes' : 'Ver ramas, remotos, tags y stashes de este repositorio'}
                        className="shrink-0 rounded p-0.5 hover:bg-surface-variant"
                    >
                        <Icon name={isExpanded ? 'expand_more' : 'chevron_right'} size={14} className="opacity-70" />
                    </button>
                    <button
                        onDoubleClick={() => onOpenRepo(repo)}
                        title={`Doble click para abrir "${repo.name}" en una pestaña — ${repo.path}`}
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    >
                        <Icon name="source" size={14} className="shrink-0 opacity-70" />
                        <span className="truncate">{repo.name}</span>
                    </button>
                    {flatFoldersForMenu.length > 0 && (
                        <MoveToFolderMenu connId={repo.id} flatFolders={flatFoldersForMenu} onMove={onMoveRepoToFolder} />
                    )}
                    <button
                        onClick={() => setConfirmRemove(repo)}
                        title="Quitar este repositorio de la lista — no borra nada de tu disco"
                        className="shrink-0 rounded p-0.5 text-on-surface-variant opacity-0 hover:bg-surface-variant group-hover:opacity-100"
                    >
                        <Icon name="close" size={13} />
                    </button>
                </div>

                {isExpanded && (
                    <div className="pb-1" style={{paddingLeft: `${depth * 14}px`}}>
                        {!detail && (
                            <p className="flex items-center gap-1.5 py-1 pl-8 text-[10px] text-primary">
                                <span aria-hidden className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-2 border-t-transparent border-primary" />
                                Cargando…
                            </p>
                        )}
                        {detail && renderRepoDetail(repo, detail)}
                    </div>
                )}
            </div>
        )
    }

    // A folder node and everything under it: subfolders first, then the repos
    // that live directly in this folder. Recursion mirrors SshConnectionTree.
    function renderFolderNode(node: FolderNode, depth: number) {
        const {folder} = node
        const expanded = isFolderExpanded(folder.id)
        const folderRepos = repos.filter((r) => r.folderId === folder.id && repoMatches(r))
        return (
            <div key={folder.id}>
                <div
                    style={{paddingLeft: `${4 + depth * 14}px`}}
                    className="group flex items-center gap-1 py-1 pr-2 text-xs text-on-surface-variant hover:bg-surface-variant/50 hover:text-on-surface"
                >
                    {/* Chevron toggle then a separate folder icon, matching
                        ConnectionTree/SshConnectionTree's folder rows so all
                        three sidebar modules read the same. */}
                    <button onClick={() => toggleFolder(folder.id)} title={expanded ? 'Contraer carpeta' : 'Expandir carpeta'} className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100">
                        <Icon name={expanded ? 'expand_more' : 'chevron_right'} size={16} />
                    </button>
                    <Icon name={expanded ? 'folder_open' : 'folder'} size={15} className="shrink-0 opacity-70" />
                    {renamingFolderId === folder.id ? (
                        <input
                            autoFocus
                            value={renameFolderName}
                            onChange={(e) => setRenameFolderName(e.target.value)}
                            onBlur={commitRenameFolder}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') commitRenameFolder()
                                if (e.key === 'Escape') setRenamingFolderId(null)
                            }}
                            className="min-w-0 flex-1 rounded border-none bg-surface-container-highest px-1 py-0.5 text-xs text-on-surface outline-none focus:ring-1 focus:ring-primary"
                        />
                    ) : (
                        <button onClick={() => toggleFolder(folder.id)} className="flex min-w-0 flex-1 items-center text-left" title={`Carpeta "${folder.name}"`}>
                            <span className="truncate">{folder.name}</span>
                            <span className="ml-1.5 shrink-0 text-[10px] text-on-surface-variant/50">{folderRepos.length || ''}</span>
                        </button>
                    )}
                    <div className="flex shrink-0 items-center opacity-0 group-hover:opacity-100">
                        <button onClick={() => onReorderFolder(folder.id, 'up')} title="Subir la carpeta" className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant">
                            <Icon name="keyboard_arrow_up" size={13} />
                        </button>
                        <button onClick={() => onReorderFolder(folder.id, 'down')} title="Bajar la carpeta" className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant">
                            <Icon name="keyboard_arrow_down" size={13} />
                        </button>
                        <button onClick={() => startCreateFolder(folder.id)} title="Nueva subcarpeta acá" className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant">
                            <Icon name="create_new_folder" size={13} />
                        </button>
                        <button
                            onClick={() => {
                                setRenamingFolderId(folder.id)
                                setRenameFolderName(folder.name)
                            }}
                            title="Renombrar la carpeta"
                            className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant"
                        >
                            <Icon name="edit" size={13} />
                        </button>
                        <button onClick={() => setConfirmDeleteFolder(folder)} title="Eliminar la carpeta (los repos que tenga adentro se mueven a la carpeta contenedora, no se quitan)" className="rounded p-0.5 text-error hover:bg-error-container/40">
                            <Icon name="delete" size={13} />
                        </button>
                    </div>
                </div>
                {expanded && (
                    <div>
                        {creatingFolderParentId === folder.id && <div style={{paddingLeft: `${8 + (depth + 1) * 14}px`}} className="pr-2">{newFolderInput()}</div>}
                        {node.children.filter((n) => !q || folderHasVisibleContent(n)).map((child) => renderFolderNode(child, depth + 1))}
                        {folderRepos.map((r) => renderRepoRow(r, depth + 1))}
                    </div>
                )}
            </div>
        )
    }

    return (
        <>
            <SidebarModule
                title="Git"
                collapsed={moduleCollapsed}
                onToggleCollapsed={onToggleModuleCollapsed}
                actions={
                    <div className="flex shrink-0 items-center gap-0.5">
                        <button
                            onClick={() => startCreateFolder('')}
                            title="Nueva carpeta para organizar los repositorios"
                            className="rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                        >
                            <Icon name="create_new_folder" size={18} />
                        </button>
                        <button
                            onClick={(e) => {
                                const r = e.currentTarget.getBoundingClientRect()
                                setMenu({x: r.right - 200, y: r.bottom + 4, items: addMenuItems})
                            }}
                            disabled={!probe?.available}
                            title={probe?.available ? 'Abrir, crear (init) o clonar un repositorio' : 'Requiere que git esté instalado'}
                            className="rounded p-1 text-primary hover:bg-surface-variant disabled:opacity-40"
                        >
                            <Icon name="add" size={18} />
                        </button>
                    </div>
                }
            >
                {/* git missing is a first-class state, not a per-operation
                    failure — see backend/git's package doc on the exec tradeoff. */}
                {probe && !probe.available && (
                    <div className="mx-3 mb-2 rounded border border-outline-variant bg-error-container/40 p-2 text-[11px] text-on-error-container">
                        <p className="font-medium">git no está instalado</p>
                        <p className="mt-0.5 opacity-80">
                            El módulo Git usa el git del sistema. Instalalo (en macOS: <span className="font-mono">xcode-select --install</span>) y reabrí la app.
                        </p>
                    </div>
                )}

                <div className="px-3">
                    <input
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        placeholder="Buscar..."
                        title="Busca por nombre de repositorio o por ruta en disco"
                        className="w-full rounded-lg border-none bg-surface-container-highest px-3 py-1.5 text-xs text-on-surface outline-none placeholder:text-on-surface-variant/60 focus:ring-1 focus:ring-primary"
                    />
                </div>

                {error && (
                    <div className="mx-3 mt-2 flex items-start gap-1 rounded bg-error-container/40 p-1.5 text-[10px] text-on-error-container">
                        <span className="min-w-0 flex-1 break-words">{error}</span>
                        <button onClick={() => setError(null)} title="Cerrar este error" className="shrink-0">
                            <Icon name="close" size={12} />
                        </button>
                    </div>
                )}

                {creatingFolderParentId === '' && <div className="px-3 pt-1">{newFolderInput()}</div>}

                <div className="mt-2 flex-1 overflow-y-auto py-1">
                    {!hasAnything && q && <p className="p-3 text-xs text-on-surface-variant/60">Sin coincidencias para "{filter}".</p>}
                    {/* Empty state: the three ways to add a repository, as a
                        standalone Git client offers on its start screen. */}
                    {!hasAnything && !q && probe?.available && (
                        <div className="space-y-1.5 px-3 py-2">
                            <p className="pb-1 text-[11px] text-on-surface-variant/70">Todavía no agregaste ningún repositorio.</p>
                            <EmptyAction icon="folder_open" label="Abrir repositorio" desc="Uno que ya existe en tu disco" onClick={() => void openRepo()} />
                            <EmptyAction icon="create_new_folder" label="Nuevo repositorio" desc="git init en una carpeta" onClick={() => void newRepo()} />
                            <EmptyAction icon="cloud_download" label="Clonar…" desc="Desde una URL" onClick={() => setShowClone(true)} />
                        </div>
                    )}
                    {visibleFolderNodes.map((node) => renderFolderNode(node, 0))}
                    {rootRepos.map((repo) => renderRepoRow(repo, 0))}
                </div>
            </SidebarModule>

            {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

            {confirmDeleteFolder && (
                <ConfirmDialog
                    title="Eliminar carpeta"
                    description={`Esto elimina la carpeta "${confirmDeleteFolder.name}". Los repositorios y subcarpetas que tenga adentro se mueven a la carpeta contenedora (o a la raíz) — nunca se quitan de la lista ni se borran de tu disco.`}
                    confirmLabel="Eliminar"
                    danger
                    onConfirm={() => onDeleteFolder(confirmDeleteFolder.id)}
                    onClose={() => setConfirmDeleteFolder(null)}
                />
            )}

            {renderDialogs()}
        </>
    )

    // renderRepoDetail is the branches/remotes/tags/stashes block for an
    // expanded repository — unchanged from before, just lifted into a function
    // so renderRepoRow can call it from any folder depth.
    function renderRepoDetail(repo: vault.GitRepo, detail: RepoDetail) {
        return (
            <>
                <TreeSection
                    label="Ramas"
                                                    icon="account_tree"
                                                    count={detail.branches.filter((b) => !b.isRemote).length}
                                                    open={openSections.has(`${repo.id}:branches`)}
                                                    onToggle={() => toggleSection(`${repo.id}:branches`)}
                                                >
                                                    {detail.branches
                                                        .filter((b) => !b.isRemote)
                                                        .map((b) => (
                                                            <TreeLeaf
                                                                key={b.name}
                                                                label={b.name}
                                                                title={
                                                                    b.isCurrent
                                                                        ? `"${b.name}" es la rama actual${b.upstream ? ` — sigue a ${b.upstream}` : ''}`
                                                                        : `Doble click para hacer checkout de "${b.name}"${b.upstream ? ` — sigue a ${b.upstream}` : ' — sin upstream configurado'}`
                                                                }
                                                                bold={b.isCurrent}
                                                                onDoubleClick={() => void checkout(repo.id, b.name)}
                                                            />
                                                        ))}
                                                </TreeSection>
                                                <TreeSection
                                                    label="Remotos"
                                                    icon="cloud"
                                                    count={detail.remotes.length}
                                                    open={openSections.has(`${repo.id}:remotes`)}
                                                    onToggle={() => toggleSection(`${repo.id}:remotes`)}
                                                    action={{
                                                        icon: 'add',
                                                        title: 'Agregar un remoto nuevo a este repositorio',
                                                        onClick: () =>
                                                            setPrompt({
                                                                title: 'Agregar remoto',
                                                                label: 'Nombre',
                                                                initial: 'origin',
                                                                secondLabel: 'URL',
                                                                secondPlaceholder: 'https://github.com/usuario/repo.git',
                                                                confirmLabel: 'Agregar',
                                                                onSubmit: async (name, url) => {
                                                                    try {
                                                                        await GitAddRemote(repo.id, name, url)
                                                                        await loadDetail(repo.id)
                                                                    } catch (e) {
                                                                        setError(String(e))
                                                                    }
                                                                },
                                                            }),
                                                    }}
                                                >
                                                    {detail.remotes.map((r) => {
                                                        const remoteBranches = detail.branches.filter(
                                                            (b) => b.isRemote && b.name.startsWith(`${r.name}/`),
                                                        )
                                                        return (
                                                            <div key={r.name}>
                                                                <TreeLeaf
                                                                    label={`${r.name} (${remoteBranches.length})`}
                                                                    title={`${r.fetchUrl} — click derecho para fetch, renombrar, cambiar o copiar la URL`}
                                                                    onContextMenu={(e) => {
                                                                        e.preventDefault()
                                                                        setMenu({x: e.clientX, y: e.clientY, items: remoteMenuItems(repo.id, r)})
                                                                    }}
                                                                />
                                                                {remoteBranches.map((b) => (
                                                                    <TreeLeaf
                                                                        key={b.name}
                                                                        label={b.name.slice(r.name.length + 1)}
                                                                        indent
                                                                        title={`Doble click para hacer checkout de "${b.name}" — crea una rama local que la sigue`}
                                                                        onDoubleClick={() => void checkout(repo.id, b.name)}
                                                                    />
                                                                ))}
                                                            </div>
                                                        )
                                                    })}
                                                </TreeSection>
                                                <TreeSection
                                                    label="Tags"
                                                    icon="sell"
                                                    count={detail.tags.length}
                                                    open={openSections.has(`${repo.id}:tags`)}
                                                    onToggle={() => toggleSection(`${repo.id}:tags`)}
                                                >
                                                    {detail.tags.map((t) => (
                                                        <TreeLeaf
                                                            key={t.name}
                                                            label={t.name}
                                                            title={`${t.annotated ? 'Tag anotado' : 'Tag liviano'} — ${t.hash.slice(0, 8)}. Click derecho para crear rama, checkout, push o borrar`}
                                                            onContextMenu={(e) => {
                                                                e.preventDefault()
                                                                setMenu({x: e.clientX, y: e.clientY, items: tagMenuItems(repo.id, t)})
                                                            }}
                                                        />
                                                    ))}
                                                </TreeSection>
                                                <TreeSection
                                                    label="Stashes"
                                                    icon="archive"
                                                    count={detail.stashes.length}
                                                    open={openSections.has(`${repo.id}:stashes`)}
                                                    onToggle={() => toggleSection(`${repo.id}:stashes`)}
                                                >
                                                    {detail.stashes.map((st) => (
                                                        <TreeLeaf
                                                            key={st.ref}
                                                            label={st.message}
                                                            title={`${st.ref} — guardado el ${st.date}. Click derecho para aplicar, hacer pop o descartar`}
                                                            onContextMenu={(e) => {
                                                                e.preventDefault()
                                                                setMenu({x: e.clientX, y: e.clientY, items: stashMenuItems(repo.id, st)})
                                                            }}
                                                        />
                                                    ))}
                </TreeSection>
            </>
        )
    }

    // renderDialogs holds every modal this module can raise, grouped so the
    // main return stays about the tree. All are rendered inside the top-level
    // fragment via {renderDialogs()}.
    function renderDialogs() {
        return (
            <>
            {confirmRemove && (
                <ConfirmDialog
                    title="Quitar repositorio"
                    description={`Esto quita "${confirmRemove.name}" de la lista del sidebar. La carpeta ${confirmRemove.path} y todo su contenido quedan intactos en tu disco — no se borra nada.`}
                    confirmLabel="Quitar"
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

            {confirmRemoveRemote && (
                <ConfirmDialog
                    title="Eliminar remoto"
                    description={`Esto elimina el remoto "${confirmRemoveRemote.name}" de la configuración local del repositorio. No borra nada en el servidor, pero las ramas remotas que lo seguían dejan de estar disponibles hasta que lo vuelvas a agregar.`}
                    confirmLabel="Eliminar"
                    danger
                    onConfirm={async () => {
                        try {
                            await GitRemoveRemote(confirmRemoveRemote.repoId, confirmRemoveRemote.name)
                            await loadDetail(confirmRemoveRemote.repoId)
                        } catch (e) {
                            setError(String(e))
                        }
                    }}
                    onClose={() => setConfirmRemoveRemote(null)}
                />
            )}

            {confirmTag && (
                <ConfirmDialog
                    title={confirmTag.remote ? 'Borrar tag del remoto' : 'Borrar tag local'}
                    description={
                        confirmTag.remote
                            ? `Esto borra el tag "${confirmTag.name}" de origin. Tu copia local se conserva. Ojo: quien ya lo haya traído sigue teniéndolo, y si después recreás el tag en otro commit, distintas personas van a tener ideas distintas de a qué apunta.`
                            : `Esto borra el tag "${confirmTag.name}" solo de tu repositorio local. La copia en el remoto (si la hay) queda intacta — para esa usá "Borrar de origin".`
                    }
                    confirmLabel="Borrar"
                    danger
                    onConfirm={async () => {
                        try {
                            if (confirmTag.remote) await GitDeleteRemoteTag(confirmTag.repoId, 'origin', confirmTag.name, new git.AuthConfig({}))
                            else await GitDeleteTag(confirmTag.repoId, confirmTag.name)
                            await loadDetail(confirmTag.repoId)
                        } catch (e) {
                            setError(String(e))
                        }
                    }}
                    onClose={() => setConfirmTag(null)}
                />
            )}

            {confirmStash && (
                <ConfirmDialog
                    title="Descartar stash"
                    description={`Esto borra el stash "${confirmStash.message}" sin aplicarlo. Los cambios que tenía guardados se pierden y no quedan en el reflog: no hay forma de recuperarlos después.`}
                    confirmLabel="Descartar"
                    danger
                    onConfirm={async () => {
                        try {
                            await GitStashDrop(confirmStash.repoId, confirmStash.ref)
                            await loadDetail(confirmStash.repoId)
                        } catch (e) {
                            setError(String(e))
                        }
                    }}
                    onClose={() => setConfirmStash(null)}
                />
            )}

            {prompt && <PromptDialog {...prompt} onClose={() => setPrompt(null)} />}
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
                <span className="block truncate text-[10px] text-on-surface-variant/70">{desc}</span>
            </span>
        </button>
    )
}

function TreeSection({label, icon, count, open, onToggle, children, action}: {label: string; icon: string; count: number; open: boolean; onToggle: () => void; children: React.ReactNode; action?: {icon: string; title: string; onClick: () => void}}) {
    return (
        <div className="group/section">
            <div className="flex items-center pr-1 hover:bg-surface-variant/40">
                <button
                    onClick={onToggle}
                    title={open ? `Colapsar ${label.toLowerCase()}` : `Ver ${label.toLowerCase()} (${count})`}
                    className="flex min-w-0 flex-1 items-center gap-1 py-0.5 pl-6 pr-2 text-left text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant/70"
                >
                    <Icon name={open ? 'expand_more' : 'chevron_right'} size={12} className="shrink-0" />
                    <Icon name={icon} size={12} className="shrink-0" />
                    <span className="truncate">{label}</span>
                    <span className="ml-auto shrink-0 opacity-60">{count}</span>
                </button>
                {action && (
                    <button
                        onClick={action.onClick}
                        title={action.title}
                        className="shrink-0 rounded p-0.5 text-on-surface-variant opacity-0 hover:bg-surface-variant group-hover/section:opacity-100"
                    >
                        <Icon name={action.icon} size={13} />
                    </button>
                )}
            </div>
            {open && <div>{children}</div>}
        </div>
    )
}

function TreeLeaf({
    label,
    title,
    bold,
    indent,
    onContextMenu,
    onDoubleClick,
}: {
    label: string
    title: string
    bold?: boolean
    // One extra level, for a remote's branches nested under the remote itself.
    indent?: boolean
    onContextMenu?: (e: React.MouseEvent) => void
    onDoubleClick?: () => void
}) {
    return (
        <div
            onContextMenu={onContextMenu}
            onDoubleClick={onDoubleClick}
            title={title}
            className={`truncate py-0.5 pr-2 text-[11px] hover:bg-surface-variant/40 ${indent ? 'pl-16' : 'pl-12'} ${
                bold ? 'font-semibold text-primary' : 'text-on-surface-variant'
            } ${onDoubleClick ? 'cursor-pointer' : ''}`}
        >
            {label}
        </div>
    )
}
