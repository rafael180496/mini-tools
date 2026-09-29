import {useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode} from 'react'
import {
    GitAddRepo,
    GitInitRepo,
    GitPickFolder,
    GitBranches,
    GitCheckout,
    GitCreateBranch,
    GitCreateTag,
    GitDeleteBranch,
    GitDeleteRemoteTag,
    GitRenameBranch,
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
    GitStashes,
    GitTags,
} from '../../../wailsjs/go/main/App'
import {git, vault} from '../../../wailsjs/go/models'
import ConfirmDialog from '../ConfirmDialog'
import Icon from '../Icon'
import SidebarSection from '../sidebar/SidebarSection'
import TreeRow, {TREE_FOLDER_ICON} from '../sidebar/TreeRow'
import {MenuButton, moveToFolderSubmenu, useTreeMenu, type TreeMenuEntry} from '../sidebar/TreeMenu'
import {flattenForMenu} from '../sidebar/MoveToFolderMenu'
import {buildFolderTree, type FolderNode} from '../../lib/folderTree'
import PromptDialog from './PromptDialog'
import GitCloneDialog from './GitCloneDialog'
import GitSettingsDialog from './GitSettingsDialog'
import {buildBranchTree, countBranches, leafLabel, type BranchTreeNode} from '../../lib/branchTree'

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
    const [repos, setRepos] = useState<vault.GitRepo[]>([])
    const [probe, setProbe] = useState<git.Availability | null>(null)
    const [expanded, setExpanded] = useState<Set<string>>(new Set())
    const [openSections, setOpenSections] = useState<Set<string>>(new Set())
    const [details, setDetails] = useState<Record<string, RepoDetail>>({})
    const [error, setError] = useState<string | null>(null)
    const [localToken, setLocalToken] = useState(0)

    const menu = useTreeMenu()
    const [confirmRemove, setConfirmRemove] = useState<vault.GitRepo | null>(null)
    const [confirmRemoveRemote, setConfirmRemoveRemote] = useState<{repoId: string; name: string} | null>(null)
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
    const [confirmTag, setConfirmTag] = useState<{repoId: string; name: string; remote: boolean} | null>(null)
    // After creating a tag from the sidebar, offer to push it — "crear tags y
    // pushearlo" as one flow, but with the network step kept explicit.
    const [confirmPushTag, setConfirmPushTag] = useState<{repoId: string; name: string} | null>(null)
    const [confirmDeleteBranch, setConfirmDeleteBranch] = useState<{repoId: string; name: string} | null>(null)
    const [confirmStash, setConfirmStash] = useState<{repoId: string; ref: string; message: string} | null>(null)

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

    const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {})

    // Right-click menu for a LOCAL branch in the sidebar — checkout, rename,
    // delete. A trimmed version of the repo tab's branch menu (no merge/
    // upstream here; those belong to the tab's working context).
    function localBranchMenu(e: ReactMouseEvent, repoId: string, b: git.Branch) {
        menu.openAt(e, [
            {
                label: 'Checkout',
                icon: 'check',
                disabled: b.isCurrent,
                title: b.isCurrent ? 'Ya estás en esta rama' : `Cambia el repositorio a "${b.name}" (lo mismo que el doble clic)`,
                onSelect: () => void checkout(repoId, b.name),
            },
            {label: 'Crear rama desde acá…', icon: 'call_split', onSelect: () => startCreateBranch(repoId, b.name)},
            'separator',
            {
                label: 'Cambiar nombre…',
                icon: 'edit',
                onSelect: () =>
                    setPrompt({
                        title: `Renombrar la rama "${b.name}"`,
                        label: 'Nuevo nombre',
                        initial: b.name,
                        description: 'Renombrar solo afecta tu repositorio local (preserva el reflog y el upstream). Si la rama ya está publicada, el nombre viejo sigue en el remoto hasta que lo borres.',
                        onSubmit: async (v) => {
                            try {
                                await GitRenameBranch(repoId, b.name, v)
                                onChanged()
                            } catch (err) {
                                setError(String(err))
                            }
                        },
                    }),
            },
            {label: 'Copiar nombre', icon: 'content_copy', onSelect: () => copy(b.name)},
            'separator',
            {
                label: 'Borrar rama',
                icon: 'delete',
                danger: true,
                disabled: b.isCurrent,
                title: b.isCurrent ? 'No podés borrar la rama en la que estás: cambiá a otra primero' : 'Borra la rama local; la del remoto no se toca',
                onSelect: () => setConfirmDeleteBranch({repoId, name: b.name}),
            },
        ])
    }

    // Una rama remota no tenía menú: solo el doble clic. Con el mismo gesto en
    // todas las filas, dejarla muda se lee como un error.
    function remoteBranchMenu(e: ReactMouseEvent, repoId: string, b: git.Branch) {
        menu.openAt(e, [
            {
                label: 'Checkout',
                icon: 'check',
                title: 'Si no tenés la rama local, se crea siguiendo a esta (lo mismo que el doble clic)',
                onSelect: () => void checkout(repoId, b.name),
            },
            {label: 'Copiar nombre', icon: 'content_copy', onSelect: () => copy(b.name)},
        ])
    }

    // Create a new local branch (optionally from a start point) and check it out.
    function startCreateBranch(repoId: string, from = '') {
        setPrompt({
            title: from ? `Crear rama desde "${from}"` : 'Crear rama',
            label: 'Nombre de la rama',
            placeholder: 'mi-rama',
            confirmLabel: 'Crear y cambiar',
            description: from
                ? `La rama nueva arranca en el commit al que apunta "${from}" y se hace checkout.`
                : 'La rama nueva se crea en el commit actual (HEAD) y se hace checkout.',
            onSubmit: async (name) => {
                try {
                    // startPoint vacío = HEAD, checkout = true
                    await GitCreateBranch(repoId, name, from, true)
                    onChanged()
                } catch (e) {
                    setError(String(e))
                }
            },
        })
    }

    function startCreateTag(repoId: string) {
        setPrompt({
            title: 'Crear tag',
            label: 'Nombre del tag',
            placeholder: 'v1.0.0',
            secondLabel: 'Mensaje (opcional)',
            secondPlaceholder: 'Con mensaje crea un tag anotado; sin mensaje, uno liviano.',
            confirmLabel: 'Crear tag',
            description: 'El tag se crea en el commit actual (HEAD), local. Después te pregunto si querés pushearlo.',
            onSubmit: async (name, msg) => {
                try {
                    // ref vacío = HEAD
                    await GitCreateTag(repoId, name, '', msg)
                    await loadDetail(repoId)
                    setConfirmPushTag({repoId, name})
                } catch (e) {
                    setError(String(e))
                }
            },
        })
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

    // Las tres formas de meter un repositorio en la barra, el mismo trío que
    // ofrece un cliente de Git en su pantalla de inicio. Se usan en el «+» del
    // encabezado y en el clic derecho sobre el fondo del árbol.
    const available = !!probe?.available
    const addEntries: TreeMenuEntry[] = [
        {label: 'Abrir repositorio…', icon: 'folder_open', disabled: !available, title: 'Uno que ya existe en tu disco', onSelect: () => void openRepo()},
        {label: 'Nuevo repositorio…', icon: 'create_new_folder', disabled: !available, title: 'git init en una carpeta', onSelect: () => void newRepo()},
        {label: 'Clonar…', icon: 'cloud_download', disabled: !available, title: 'Desde una URL', onSelect: () => setShowClone(true)},
    ]

    // Remote right-click menu — the actions from the reference client, plus a
    // fetch shortcut since it is the one people reach for most.
    function remoteMenu(e: ReactMouseEvent, repo: vault.GitRepo, remote: git.Remote) {
        const repoId = repo.id
        menu.openAt(e, [
            {
                label: `Fetch de ${remote.name}`,
                icon: 'cloud_download',
                title: 'Trae lo nuevo del remoto sin tocar tus ramas locales',
                onSelect: async () => {
                    try {
                        await GitFetch(repoId, new git.FetchOptions({remote: remote.name}), new git.AuthConfig({}))
                        await loadDetail(repoId)
                    } catch (err) {
                        setError(String(err))
                    }
                },
            },
            'separator',
            {
                label: 'Editar remoto…',
                icon: 'edit',
                title: 'Nombre, URL de fetch y URL de push',
                // Reemplaza a los viejos "Renombrar remoto" y "Cambiar URL",
                // que eran dos prompts de una línea: servían para PEGAR una
                // URL nueva, no para ver la que estaba puesta — que es lo que
                // hace falta cuando el remoto dejó de andar porque el token
                // embebido venció.
                onSelect: () => setSettingsFor({repo, tab: 'remotes'}),
            },
            {
                label: 'Copiar URL',
                icon: 'link',
                onSelect: async () => {
                    try {
                        const url = await GitRemoteURLForCopy(repoId, remote.name)
                        await navigator.clipboard.writeText(url)
                    } catch (err) {
                        setError(String(err))
                    }
                },
            },
            'separator',
            {label: 'Eliminar remoto', icon: 'delete', danger: true, onSelect: () => setConfirmRemoveRemote({repoId, name: remote.name})},
        ])
    }

    // Tag right-click menu. Local and remote deletion are separate entries on
    // purpose: deleting a tag locally leaves it on the server and vice versa,
    // which is the single most common surprise with tags — collapsing them into
    // one "delete" would hide exactly the distinction that trips people up.
    function tagMenu(e: ReactMouseEvent, repoId: string, tag: git.Tag) {
        const guard = async (fn: () => Promise<unknown>) => {
            try {
                await fn()
                onChanged()
            } catch (err) {
                setError(String(err))
            }
        }
        menu.openAt(e, [
            {
                label: 'Checkout',
                icon: 'check',
                title: 'Deja el repo en HEAD desacoplado',
                onSelect: () => void guard(() => GitCheckout(repoId, tag.name)),
            },
            {
                label: 'Crear rama desde acá…',
                icon: 'call_split',
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
            'separator',
            {label: 'Push a origin', icon: 'upload', onSelect: () => void guard(() => GitPushTag(repoId, 'origin', tag.name, new git.AuthConfig({})))},
            {label: 'Copiar nombre', icon: 'content_copy', onSelect: () => copy(tag.name)},
            'separator',
            {label: 'Borrar tag', icon: 'delete', danger: true, hint: 'local', title: 'Solo de tu repositorio: la copia del remoto queda', onSelect: () => setConfirmTag({repoId, name: tag.name, remote: false})},
            {label: 'Borrar de origin', icon: 'delete_forever', danger: true, hint: 'remoto', title: 'Solo del remoto: tu copia local queda', onSelect: () => setConfirmTag({repoId, name: tag.name, remote: true})},
        ])
    }

    function stashMenu(e: ReactMouseEvent, repoId: string, stash: git.Stash) {
        const guard = async (fn: () => Promise<unknown>) => {
            try {
                await fn()
                onChanged()
            } catch (err) {
                setError(String(err))
            }
        }
        menu.openAt(e, [
            {label: 'Aplicar', icon: 'download', title: 'Aplica los cambios y conserva el stash', onSelect: () => void guard(() => GitStashApply(repoId, stash.ref, false))},
            {label: 'Pop', icon: 'move_up', title: 'Aplica los cambios y borra el stash', onSelect: () => void guard(() => GitStashApply(repoId, stash.ref, true))},
            'separator',
            {label: 'Descartar stash', icon: 'delete', danger: true, onSelect: () => setConfirmStash({repoId, ref: stash.ref, message: stash.message})},
        ])
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
            title: parentId ? 'Subcarpeta nueva' : 'Carpeta nueva',
            label: 'Nombre',
            placeholder: 'Trabajo',
            confirmLabel: 'Crear',
            description: 'Las carpetas solo organizan la lista: no mueven nada en tu disco.',
            onSubmit: (name) => onCreateFolder(name, parentId),
        })
    }

    function startRenameFolder(folder: vault.Folder) {
        setPrompt({
            title: 'Cambiar el nombre de la carpeta',
            label: 'Nombre',
            initial: folder.name,
            confirmLabel: 'Guardar',
            onSubmit: (name) => onRenameFolder(folder.id, name),
        })
    }

    const blankMenu = (e: ReactMouseEvent) =>
        menu.openAt(e, [
            ...addEntries,
            'separator',
            {label: 'Carpeta nueva', icon: 'create_new_folder', onSelect: () => startCreateFolder('')},
            'separator',
            {label: 'Desplegar todo', icon: 'unfold_more', disabled: !!q || gitFolders.length === 0, onSelect: expandAll},
            {label: 'Plegar todo', icon: 'unfold_less', disabled: !!q, onSelect: collapseAll},
        ])

    function folderMenu(e: ReactMouseEvent, folder: vault.Folder) {
        const open = isFolderExpanded(folder.id)
        menu.openAt(e, [
            {label: 'Subcarpeta nueva', icon: 'create_new_folder', onSelect: () => startCreateFolder(folder.id)},
            {label: open ? 'Plegar' : 'Desplegar', icon: open ? 'unfold_less' : 'unfold_more', disabled: !!q, onSelect: () => toggleFolder(folder.id)},
            'separator',
            {label: 'Subir', icon: 'arrow_upward', title: 'Sube la carpeta un lugar entre sus hermanas', onSelect: () => onReorderFolder(folder.id, 'up')},
            {label: 'Bajar', icon: 'arrow_downward', title: 'Baja la carpeta un lugar entre sus hermanas', onSelect: () => onReorderFolder(folder.id, 'down')},
            'separator',
            {label: 'Cambiar nombre…', icon: 'edit', onSelect: () => startRenameFolder(folder)},
            'separator',
            {
                label: 'Borrar carpeta',
                icon: 'delete',
                danger: true,
                title: 'Los repositorios que tenga adentro se mueven a la carpeta contenedora: no se quitan ni se borran',
                onSelect: () => setConfirmDeleteFolder(folder),
            },
        ])
    }

    function repoMenu(e: ReactMouseEvent, repo: vault.GitRepo) {
        const open = expanded.has(repo.id)
        menu.openAt(e, [
            {label: 'Abrir en una pestaña', icon: 'open_in_new', hint: 'doble clic', onSelect: () => onOpenRepo(repo)},
            {label: open ? 'Plegar' : 'Ver ramas, remotos y tags', icon: open ? 'unfold_less' : 'unfold_more', onSelect: () => toggleRepo(repo.id)},
            'separator',
            {label: 'Crear rama…', icon: 'call_split', title: 'Rama local nueva en el commit actual (HEAD), con checkout', onSelect: () => startCreateBranch(repo.id)},
            {label: 'Crear tag…', icon: 'sell', title: 'Tag nuevo en el commit actual (HEAD)', onSelect: () => startCreateTag(repo.id)},
            'separator',
            {
                label: 'Configuración de git…',
                icon: 'settings',
                title: 'Identidad (nombre y email, local o global) y tokens de acceso',
                onSelect: () => setSettingsFor({repo, tab: 'identity'}),
            },
            {label: 'Remotos…', icon: 'lan', title: 'Agregar, ver y cambiar la URL (token incluido), renombrar o quitar', onSelect: () => setSettingsFor({repo, tab: 'remotes'})},
            'separator',
            {label: 'Mover a…', icon: 'drive_file_move', submenu: moveToFolderSubmenu(flatFoldersForMenu, repo.folderId ?? '', (f) => onMoveRepoToFolder(repo.id, f))},
            {label: 'Copiar ruta', icon: 'content_copy', title: repo.path, onSelect: () => copy(repo.path)},
            'separator',
            {
                label: 'Quitar de la lista',
                icon: 'playlist_remove',
                danger: true,
                title: 'Saca el repositorio de la barra — no borra nada de tu disco',
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
        return (
            <div key={repo.id}>
                <TreeRow
                    depth={depth}
                    icon="book_2"
                    iconClass={active ? 'text-primary' : undefined}
                    label={repo.name}
                    labelClass={active ? 'text-on-surface font-medium' : 'text-on-surface/90'}
                    title={`${repo.name} — ${repo.path}. Doble clic: abrirlo en una pestaña. Clic derecho: más opciones.`}
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
                        current ? (
                            <span className="max-w-[96px] truncate font-mono text-ui-10 text-on-surface-variant/60" title={`Rama actual: ${current.name}`}>
                                {current.name}
                            </span>
                        ) : undefined
                    }
                    actions={
                        <>
                            <button
                                onClick={(e) => {
                                    e.stopPropagation()
                                    setSettingsFor({repo, tab: 'identity'})
                                }}
                                title="Configuración de git de este repositorio: identidad (nombre y email, local o global), remotos y tokens de acceso"
                                className="sidebar-icon !p-0.5"
                            >
                                <Icon name="settings" size={14} />
                            </button>
                            <MenuButton onOpen={(e) => repoMenu(e, repo)} title="Opciones del repositorio" />
                        </>
                    }
                />
                {isExpanded &&
                    (detail ? (
                        renderRepoDetail(repo, detail, depth + 1)
                    ) : (
                        <TreeRow depth={depth + 1} icon="progress_activity" iconClass="animate-spin text-primary" label="Cargando…" labelClass="text-on-surface-variant" />
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
                    title={`${folder.name} — ${folderRepos.length} ${folderRepos.length === 1 ? 'repositorio' : 'repositorios'}. Clic derecho: más opciones.`}
                    expanded={open}
                    onToggle={() => toggleFolder(folder.id)}
                    onClick={() => toggleFolder(folder.id)}
                    onContextMenu={(e) => folderMenu(e, folder)}
                    trailing={folderRepos.length ? <span className="text-ui-10 tabular-nums text-on-surface-variant/50">{folderRepos.length}</span> : undefined}
                    actions={<MenuButton onOpen={(e) => folderMenu(e, folder)} title="Opciones de la carpeta" />}
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
            count={q ? `${rootRepos.length + visibleFolderNodes.length} de ${repos.length}` : repos.length ? String(repos.length) : null}
            actions={
                <>
                    <button
                        onClick={() => startCreateFolder('')}
                        title="Crea una carpeta para agrupar repositorios — las carpetas solo organizan, nunca mueven nada en tu disco"
                        className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="create_new_folder" size={16} />
                    </button>
                    <button
                        onClick={() => (anyOpen ? collapseAll() : expandAll())}
                        disabled={!!q || (!anyOpen && gitFolders.length === 0)}
                        title={
                            q
                                ? 'Buscando, las carpetas se despliegan solas'
                                : anyOpen
                                  ? 'Plegar todas las carpetas y repositorios'
                                  : gitFolders.length
                                    ? 'Desplegar todas las carpetas (los repositorios se despliegan de a uno: cada uno consulta a git)'
                                    : 'No hay carpetas para desplegar'
                        }
                        className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-40"
                    >
                        <Icon name={anyOpen ? 'unfold_less' : 'unfold_more'} size={16} />
                    </button>
                    <button
                        onClick={(e) => menu.openAt(e, addEntries)}
                        disabled={!available}
                        title={available ? 'Abrir un repositorio que ya existe, crear uno nuevo (git init) o clonar desde una URL' : 'Deshabilitado: el módulo Git usa el git del sistema y no está instalado en este equipo'}
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
                    <p className="font-medium">git no está instalado</p>
                    <p className="mt-0.5 opacity-80">
                        El módulo Git usa el git del sistema. Instalalo (en macOS: <span className="font-mono">xcode-select --install</span>) y reabrí la app.
                    </p>
                </div>
            )}

            {error && (
                <div className="mx-3 mt-2 flex items-start gap-1 rounded bg-error-container/40 p-1.5 text-ui-10 text-on-error-container">
                    <span className="min-w-0 flex-1 break-words">{error}</span>
                    <button onClick={() => setError(null)} title="Cerrar este error" className="shrink-0">
                        <Icon name="close" size={12} />
                    </button>
                </div>
            )}

            <div className="mt-0.5 min-h-0 flex-1 pb-6" onContextMenu={blankMenu}>
                {!hasAnything && q && <p className="p-3 text-xs text-on-surface-variant/60">Sin coincidencias para "{filter}".</p>}
                {/* Empty state: the three ways to add a repository, as a
                    standalone Git client offers on its start screen. */}
                {!hasAnything && !q && available && (
                    <div className="space-y-1.5 px-3 py-2">
                        <p className="pb-1 text-ui-11 text-on-surface-variant/70">Todavía no agregaste ningún repositorio.</p>
                        <EmptyAction icon="folder_open" label="Abrir repositorio" desc="Uno que ya existe en tu disco" onClick={() => void openRepo()} />
                        <EmptyAction icon="create_new_folder" label="Nuevo repositorio" desc="git init en una carpeta" onClick={() => void newRepo()} />
                        <EmptyAction icon="cloud_download" label="Clonar…" desc="Desde una URL" onClick={() => setShowClone(true)} />
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
                    title="Eliminar carpeta"
                    description={`Esto elimina la carpeta "${confirmDeleteFolder.name}". Los repositorios y subcarpetas que tenga adentro se mueven a la carpeta contenedora (o a la raíz) — nunca se quitan de la lista ni se borran de tu disco.`}
                    confirmLabel="Eliminar"
                    danger
                    onConfirm={() => onDeleteFolder(confirmDeleteFolder.id)}
                    onClose={() => setConfirmDeleteFolder(null)}
                />
            )}

            {renderDialogs()}
        </SidebarSection>
    )

    // renderRepoDetail es lo que cuelga de un repositorio desplegado: ramas,
    // remotos, tags y stashes, cada grupo una fila plegable con su contador.
    // Se abre de a un grupo y no todo junto: un repositorio con cuarenta tags
    // taparía las ramas, que es lo que casi siempre se viene a mirar.
    function renderRepoDetail(repo: vault.GitRepo, detail: RepoDetail, depth: number) {
        const local = detail.branches.filter((b) => !b.isRemote)
        const key = (s: string) => `${repo.id}:${s}`
        return (
            <>
                <GroupRow
                    depth={depth}
                    icon="account_tree"
                    label="Ramas"
                    count={local.length}
                    open={openSections.has(key('branches'))}
                    onToggle={() => toggleSection(key('branches'))}
                    add={{title: 'Crear una rama local nueva en el commit actual (HEAD)', onClick: () => startCreateBranch(repo.id)}}
                    onMenu={(e) => menu.openAt(e, [{label: 'Crear rama…', icon: 'call_split', onSelect: () => startCreateBranch(repo.id)}])}
                >
                    <SidebarBranchTree
                        node={buildBranchTree(local)}
                        depth={depth + 1}
                        isOpen={(path) => openSections.has(key(`bf:${path}`))}
                        onToggle={(path) => toggleSection(key(`bf:${path}`))}
                        renderBranch={(b, folderPath, d) => (
                            <TreeRow
                                key={b.name}
                                depth={d}
                                icon={b.isCurrent ? 'radio_button_checked' : 'call_split'}
                                iconClass={b.isCurrent ? 'text-primary' : 'text-on-surface-variant/80'}
                                label={leafLabel(b, folderPath)}
                                labelClass={b.isCurrent ? 'font-semibold text-primary' : 'text-on-surface/85'}
                                title={
                                    b.isCurrent
                                        ? `"${b.name}" es la rama actual${b.upstream ? ` — sigue a ${b.upstream}` : ''}. Clic derecho para renombrar o borrar`
                                        : `Doble clic para hacer checkout de "${b.name}"${b.upstream ? ` — sigue a ${b.upstream}` : ' — sin upstream configurado'}. Clic derecho para más acciones`
                                }
                                onDoubleClick={() => void checkout(repo.id, b.name)}
                                onContextMenu={(e) => localBranchMenu(e, repo.id, b)}
                                trailing={<AheadBehind branch={b} />}
                                actions={<MenuButton onOpen={(e) => localBranchMenu(e, repo.id, b)} title="Opciones de la rama" />}
                            />
                        )}
                    />
                </GroupRow>
                <GroupRow
                    depth={depth}
                    icon="lan"
                    label="Remotos"
                    count={detail.remotes.length}
                    open={openSections.has(key('remotes'))}
                    onToggle={() => toggleSection(key('remotes'))}
                    add={{
                        icon: 'settings',
                        title: 'Administrar los remotos de este repositorio: agregar uno, ver y cambiar su URL (token incluido), renombrarlo o quitarlo',
                        onClick: () => setSettingsFor({repo, tab: 'remotes'}),
                    }}
                    onMenu={(e) => menu.openAt(e, [{label: 'Administrar remotos…', icon: 'settings', onSelect: () => setSettingsFor({repo, tab: 'remotes'})}])}
                >
                    {detail.remotes.map((r) => {
                        const remoteBranches = detail.branches.filter((b) => b.isRemote && b.name.startsWith(`${r.name}/`))
                        // Guarda lo PLEGADO: las ramas de un remoto se veían
                        // siempre, y así sigue siendo hasta que se lo pliegue.
                        const closedKey = key(`rc:${r.name}`)
                        const open = !openSections.has(closedKey)
                        return (
                            <div key={r.name}>
                                <TreeRow
                                    depth={depth + 1}
                                    icon="cloud"
                                    iconClass="text-on-surface-variant/80"
                                    label={r.name}
                                    title={`${r.fetchUrl} — clic derecho para fetch, editar la URL, copiarla o quitar el remoto`}
                                    expanded={remoteBranches.length ? open : undefined}
                                    onToggle={() => toggleSection(closedKey)}
                                    onClick={() => remoteBranches.length && toggleSection(closedKey)}
                                    onContextMenu={(e) => remoteMenu(e, repo, r)}
                                    trailing={<Count n={remoteBranches.length} />}
                                    actions={<MenuButton onOpen={(e) => remoteMenu(e, repo, r)} title="Opciones del remoto" />}
                                />
                                {open && (
                                    <SidebarBranchTree
                                        node={buildBranchTree(remoteBranches, r.name)}
                                        depth={depth + 2}
                                        isOpen={(path) => openSections.has(key(`rbf:${r.name}:${path}`))}
                                        onToggle={(path) => toggleSection(key(`rbf:${r.name}:${path}`))}
                                        renderBranch={(b, folderPath, d) => (
                                            <TreeRow
                                                key={b.name}
                                                depth={d}
                                                icon="call_split"
                                                iconClass="text-on-surface-variant/60"
                                                label={leafLabel(b, folderPath, r.name)}
                                                labelClass="text-on-surface-variant"
                                                title={`Doble clic para hacer checkout de "${b.name}" — si no tenés la rama local, se crea siguiendo a esta`}
                                                onDoubleClick={() => void checkout(repo.id, b.name)}
                                                onContextMenu={(e) => remoteBranchMenu(e, repo.id, b)}
                                                actions={<MenuButton onOpen={(e) => remoteBranchMenu(e, repo.id, b)} title="Opciones de la rama remota" />}
                                            />
                                        )}
                                    />
                                )}
                            </div>
                        )
                    })}
                </GroupRow>
                <GroupRow
                    depth={depth}
                    icon="sell"
                    label="Tags"
                    count={detail.tags.length}
                    open={openSections.has(key('tags'))}
                    onToggle={() => toggleSection(key('tags'))}
                    add={{title: 'Crear un tag nuevo en el commit actual (HEAD)', onClick: () => startCreateTag(repo.id)}}
                    onMenu={(e) => menu.openAt(e, [{label: 'Crear tag…', icon: 'sell', onSelect: () => startCreateTag(repo.id)}])}
                >
                    {detail.tags.map((t) => (
                        <TreeRow
                            key={t.name}
                            depth={depth + 1}
                            icon="sell"
                            iconClass="text-on-surface-variant/80"
                            label={t.name}
                            title={`${t.annotated ? 'Tag anotado' : 'Tag liviano'} — ${t.hash.slice(0, 8)}. Clic derecho para crear rama, checkout, push o borrar`}
                            onContextMenu={(e) => tagMenu(e, repo.id, t)}
                            trailing={<span className="font-mono text-ui-10 text-on-surface-variant/50">{t.hash.slice(0, 7)}</span>}
                            actions={<MenuButton onOpen={(e) => tagMenu(e, repo.id, t)} title="Opciones del tag" />}
                        />
                    ))}
                </GroupRow>
                <GroupRow
                    depth={depth}
                    icon="inventory_2"
                    label="Stashes"
                    count={detail.stashes.length}
                    open={openSections.has(key('stashes'))}
                    onToggle={() => toggleSection(key('stashes'))}
                >
                    {detail.stashes.map((st) => (
                        <TreeRow
                            key={st.ref}
                            depth={depth + 1}
                            icon="inventory_2"
                            iconClass="text-on-surface-variant/80"
                            label={st.message}
                            title={`${st.ref} — guardado el ${st.date}. Clic derecho para aplicar, hacer pop o descartar`}
                            onContextMenu={(e) => stashMenu(e, repo.id, st)}
                            actions={<MenuButton onOpen={(e) => stashMenu(e, repo.id, st)} title="Opciones del stash" />}
                        />
                    ))}
                </GroupRow>
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

            {confirmDeleteBranch && (
                <ConfirmDialog
                    title="Borrar rama local"
                    description={`Esto borra la rama "${confirmDeleteBranch.name}" de tu repositorio local. Si tiene commits que no están en ninguna otra rama, quedan accesibles solo por el reflog hasta que expire. La copia en el remoto (si la hay) no se toca.`}
                    confirmLabel="Borrar"
                    danger
                    onConfirm={async () => {
                        try {
                            await GitDeleteBranch(confirmDeleteBranch.repoId, confirmDeleteBranch.name, true)
                            onChanged()
                        } catch (e) {
                            setError(String(e))
                        }
                    }}
                    onClose={() => setConfirmDeleteBranch(null)}
                />
            )}

            {confirmPushTag && (
                <ConfirmDialog
                    title="Pushear tag"
                    description={`Se creó el tag "${confirmPushTag.name}" localmente. ¿Pushearlo a origin ahora? (Se usa el token guardado del host si hay uno; si no, git resuelve las credenciales como siempre.)`}
                    confirmLabel="Pushear"
                    onConfirm={async () => {
                        try {
                            await GitPushTag(confirmPushTag.repoId, 'origin', confirmPushTag.name, new git.AuthConfig({}))
                            await loadDetail(confirmPushTag.repoId)
                        } catch (e) {
                            setError(String(e))
                        }
                    }}
                    onClose={() => setConfirmPushTag(null)}
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
                <span className="block truncate text-ui-10 text-on-surface-variant/70">{desc}</span>
            </span>
        </button>
    )
}

function Count({n}: {n: number}) {
    return <span className="text-ui-10 tabular-nums text-on-surface-variant/50">{n}</span>
}

// Commits por delante / por detrás del upstream. Se quedan siempre a la vista
// (no solo en el title): "tengo 8 commits sin pushear" es justo lo que se
// busca de un vistazo antes de cambiar de rama.
function AheadBehind({branch}: {branch: git.Branch}) {
    if (!branch.ahead && !branch.behind) return null
    return (
        <span
            className="flex items-center gap-1 font-mono text-ui-10 tabular-nums text-on-surface-variant/70"
            title={`${branch.ahead} ${branch.ahead === 1 ? 'commit' : 'commits'} por delante y ${branch.behind} por detrás de ${branch.upstream || 'su upstream'}`}
        >
            {branch.ahead > 0 && (
                <span className="flex items-center text-primary">
                    <Icon name="arrow_upward" size={11} />
                    {branch.ahead}
                </span>
            )}
            {branch.behind > 0 && (
                <span className="flex items-center text-tertiary">
                    <Icon name="arrow_downward" size={11} />
                    {branch.behind}
                </span>
            )}
        </span>
    )
}

// GroupRow es un grupo del detalle de un repositorio (Ramas, Remotos, Tags,
// Stashes). Antes era un rótulo en mayúsculas con su propia sangría; ahora es
// una fila más del árbol, con la guía de su nivel, para que el detalle se lea
// como parte del repositorio y no como otra lista pegada debajo.
function GroupRow({
    depth,
    icon,
    label,
    count,
    open,
    onToggle,
    add,
    onMenu,
    children,
}: {
    depth: number
    icon: string
    label: string
    count: number
    open: boolean
    onToggle: () => void
    // La acción principal del grupo (crear rama, crear tag), a la vista al
    // pasar el mouse. Es la única: lo demás está en el menú.
    add?: {icon?: string; title: string; onClick: () => void}
    onMenu?: (e: ReactMouseEvent) => void
    children: ReactNode
}) {
    // Sin elementos no hay nada que desplegar: el chevron prometería algo.
    const branch = count > 0
    return (
        <>
            <TreeRow
                depth={depth}
                icon={icon}
                iconClass="text-on-surface-variant/70"
                label={label}
                labelClass="text-on-surface-variant"
                title={branch ? (open ? `Plegar ${label.toLowerCase()}` : `Ver ${label.toLowerCase()} (${count})`) : `Sin ${label.toLowerCase()}`}
                expanded={branch ? open : undefined}
                onToggle={onToggle}
                onClick={() => branch && onToggle()}
                onContextMenu={onMenu}
                trailing={<Count n={count} />}
                actions={
                    add || onMenu ? (
                        <>
                            {add && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        add.onClick()
                                    }}
                                    title={add.title}
                                    className="sidebar-icon !p-0.5"
                                >
                                    <Icon name={add.icon ?? 'add'} size={14} />
                                </button>
                            )}
                            {onMenu && <MenuButton onOpen={onMenu} title={`Opciones de ${label.toLowerCase()}`} />}
                        </>
                    ) : undefined
                }
            />
            {branch && open && children}
        </>
    )
}

// Recorre el árbol de ramas (`feature/`, `fix/`…) dibujando carpetas y
// delegando las ramas en renderBranch, igual que su gemela de GitRepoTab — el
// árbol no conoce el diseño de la fila.
function SidebarBranchTree({
    node,
    depth,
    isOpen,
    onToggle,
    renderBranch,
}: {
    node: BranchTreeNode
    depth: number
    isOpen: (path: string) => boolean
    onToggle: (path: string) => void
    renderBranch: (branch: git.Branch, folderPath: string, depth: number) => ReactNode
}) {
    return (
        <>
            {node.folders.map((folder) => {
                const open = isOpen(folder.path)
                const total = countBranches(folder)
                return (
                    <div key={folder.path}>
                        {/* Carpeta de ramas, no de la barra: mismo ícono pero sin
                            el tono terciario, que es el de las carpetas que
                            organiza el usuario. */}
                        <TreeRow
                            depth={depth}
                            icon={open ? 'folder_open' : 'folder'}
                            iconClass="text-on-surface-variant/70"
                            label={folder.label}
                            labelClass="text-on-surface-variant"
                            title={
                                open
                                    ? `Plegar "${folder.path}" — sus ${total} ramas dejan de ocupar la lista`
                                    : `Desplegar "${folder.path}" — tiene ${total} ${total === 1 ? 'rama' : 'ramas'}`
                            }
                            expanded={open}
                            onToggle={() => onToggle(folder.path)}
                            onClick={() => onToggle(folder.path)}
                            trailing={<Count n={total} />}
                        />
                        {open && <SidebarBranchTree node={folder} depth={depth + 1} isOpen={isOpen} onToggle={onToggle} renderBranch={renderBranch} />}
                    </div>
                )
            })}
            {node.branches.map((b) => renderBranch(b, node.path, depth))}
        </>
    )
}
