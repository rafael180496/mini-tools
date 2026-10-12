import {useMemo, type MouseEvent as ReactMouseEvent, type ReactNode} from 'react'
import {git} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import {useT} from '../../i18n'
import TreeRow, {TREE_GUIDE_OFFSET, TREE_INDENT} from '../sidebar/TreeRow'
import {MenuButton} from '../sidebar/TreeMenu'
import {buildBranchTree, countBranches, leafLabel, type BranchTreeNode} from '../../lib/branchTree'
import {matchesRef, shortDate, splitPinned} from '../../lib/gitRefs'
import {groupTags} from '../../lib/tagGroups'
import type {RepoCtx, RepoRefActions} from './useRepoRefActions'

// Estado de interfaz de un repositorio desplegado en la barra: qué grupos y
// carpetas están abiertos, el filtro y la fila marcada. Lo guarda quien dibuja
// la lista de repositorios (sobrevive a plegar y desplegar el repositorio); este
// componente solo lo lee.
export interface RepoRefsUi {
    isOpen: (key: string) => boolean
    toggle: (key: string) => void
    filter: string
    setFilter: (v: string) => void
    // El campo de filtro está a la vista. Con texto escrito lo está siempre.
    filterOpen: boolean
    closeFilter: () => void
    // Clave de la fila marcada: `b:<rama>` o `t:<tag>`.
    selected: string | null
    select: (key: string) => void
}

interface RepoRefsTreeProps {
    ctx: RepoCtx
    depth: number
    pinned: string[]
    ui: RepoRefsUi
    actions: RepoRefActions
    onTogglePin: (name: string) => void
    onManageRemotes: () => void
}

// Lo que cuelga de un repositorio desplegado: ramas (con las ancladas arriba y
// carpetas por prefijo), remotos con sus ramas, tags agrupados por versión y
// stashes. Cada grupo es una fila plegable con su contador.
//
// Se abre de a un grupo y no todo junto: un repositorio con cuarenta tags
// taparía las ramas, que es lo que casi siempre se viene a mirar. Las ramas
// arrancan abiertas por esa misma razón.
//
// Esta lista es el ÚNICO lugar donde se ven las ramas de un repositorio (la
// pestaña solo muestra el grafo), por eso trae lo que antes tenía el árbol
// interno de la pestaña: filtro, anclas, menús completos, clic que lleva el
// grafo hasta el commit.
export default function RepoRefsTree({ctx, depth, pinned, ui, actions, onTogglePin, onManageRemotes}: RepoRefsTreeProps) {
    const t = useT()
    const tg = t.sidebar.git
    const tr = t.sidebar.gitRefs
    const {repo, detail} = ctx
    const q = ui.filter.trim()
    const filtering = q !== ''
    // Con filtro escrito todo se muestra abierto: buscar una rama y que el
    // resultado quede dentro de una carpeta plegada haría parecer que no existe.
    const key = (s: string) => `${repo.id}:${s}`
    const open = (s: string) => filtering || ui.isOpen(key(s))

    const local = useMemo(() => detail.branches.filter((b) => !b.isRemote && matchesRef(b.name, q)), [detail.branches, q])
    const remoteAll = useMemo(() => detail.branches.filter((b) => b.isRemote && matchesRef(b.name, q)), [detail.branches, q])
    const tags = useMemo(() => detail.tags.filter((tag) => matchesRef(tag.name, q)), [detail.tags, q])
    const stashes = useMemo(() => detail.stashes.filter((s) => matchesRef(s.message, q)), [detail.stashes, q])

    const localSplit = useMemo(() => splitPinned(local, pinned), [local, pinned])
    const localTree = useMemo(() => buildBranchTree(localSplit.rest), [localSplit.rest])
    const tagGroups = useMemo(() => groupTags(tags), [tags])

    // Remotos visibles: sin filtro, todos (un remoto sin ramas sigue siendo un
    // remoto); con filtro, solo los que tienen alguna rama que coincida.
    const remotes = detail.remotes.filter((r) => !filtering || remoteAll.some((b) => b.name.startsWith(`${r.name}/`)))

    const nothing = filtering && local.length === 0 && remoteAll.length === 0 && tags.length === 0 && stashes.length === 0

    const branchRow = (b: git.Branch, label: string, d: number, opts: {remote?: boolean; isPinned: boolean}) => {
        const selectedKey = `b:${b.name}`
        const selected = ui.selected === selectedKey
        const upstream = b.upstream ?? ''
        return (
            <TreeRow
                key={b.name}
                depth={d}
                icon={opts.isPinned ? 'star' : b.isCurrent ? 'radio_button_checked' : 'call_split'}
                iconFilled={opts.isPinned}
                iconClass={opts.isPinned ? 'text-tertiary' : b.isCurrent ? 'text-primary' : opts.remote ? 'text-on-surface-variant/60' : 'text-on-surface-variant/80'}
                label={label}
                labelClass={b.isCurrent ? 'font-semibold text-primary' : opts.remote ? 'text-on-surface-variant' : 'text-on-surface/85'}
                title={opts.remote ? tr.remoteBranchTitle({name: b.name}) : b.isCurrent ? tr.currentBranchTitle({name: b.name, upstream}) : tr.branchTitle({name: b.name, upstream})}
                // La rama actual lleva su propio fondo suave; la marcada (la que
                // el grafo muestra) usa el resaltado de fila activa. Son dos
                // cosas distintas y tienen que distinguirse de un vistazo.
                active={selected}
                className={b.isCurrent && !selected ? 'bg-primary/10' : ''}
                // El segundo clic de un doble clic no vuelve a pedir el grafo.
                onClick={(e) => {
                    if (e.detail >= 2) return
                    ui.select(selectedKey)
                    actions.revealBranch(repo, b)
                }}
                onDoubleClick={() => void actions.checkout(repo, b)}
                onContextMenu={(e) => (b.isRemote ? actions.remoteBranchMenu(e, ctx, b) : actions.localBranchMenu(e, ctx, b))}
                trailing={<AheadBehind branch={b} />}
                actions={
                    <>
                        <button
                            onClick={(e) => {
                                e.stopPropagation()
                                onTogglePin(b.name)
                            }}
                            title={opts.isPinned ? tr.unpin({name: b.name}) : tr.pin({name: b.name})}
                            className={`sidebar-icon !p-0.5 ${opts.isPinned ? '!text-tertiary' : ''}`}
                        >
                            <Icon name="star" size={14} filled={opts.isPinned} />
                        </button>
                        <MenuButton
                            onOpen={(e) => (b.isRemote ? actions.remoteBranchMenu(e, ctx, b) : actions.localBranchMenu(e, ctx, b))}
                            title={b.isRemote ? tg.remoteBranchOptions : tg.branchOptions}
                        />
                    </>
                }
            />
        )
    }

    const tagRow = (tag: git.Tag, d: number) => {
        const selectedKey = `t:${tag.name}`
        const date = shortDate(tag.taggerDate)
        return (
            <TreeRow
                key={tag.name}
                depth={d}
                icon="sell"
                iconClass="text-on-surface-variant/80"
                label={tag.name}
                active={ui.selected === selectedKey}
                title={tr.tagTitle({name: tag.name, hash: tag.hash.slice(0, 8), annotated: tag.annotated, message: tag.message})}
                onClick={() => {
                    ui.select(selectedKey)
                    actions.revealCommit(repo, tag.hash)
                }}
                onContextMenu={(e) => actions.tagMenu(e, ctx, tag)}
                trailing={<span className="font-mono text-ui-10 tabular-nums text-on-surface-variant/50">{date || tag.hash.slice(0, 7)}</span>}
                actions={<MenuButton onOpen={(e) => actions.tagMenu(e, ctx, tag)} title={tg.tagOptions} />}
            />
        )
    }

    return (
        <>
            {(ui.filterOpen || filtering) && <FilterRow depth={depth} repoName={repo.name} ui={ui} />}

            {nothing && (
                <Guided depth={depth}>
                    <p className="py-1 pl-[26px] pr-2 text-ui-11 text-on-surface-variant/60">{tr.noMatch({filter: ui.filter})}</p>
                </Guided>
            )}

            {(!filtering || local.length > 0) && (
                <GroupRow
                    depth={depth}
                    icon="account_tree"
                    label={tg.branches}
                    title={tr.branchesHint}
                    count={local.length}
                    open={open('branches')}
                    onToggle={() => ui.toggle(key('branches'))}
                    add={{title: tg.addBranchTitle, onClick: () => actions.startCreateBranch(repo)}}
                    onMenu={(e) =>
                        actions.groupMenu(e, [
                            {label: tg.createBranchEllipsis, icon: 'call_split', title: tg.createBranchMenuTitle, onSelect: () => actions.startCreateBranch(repo)},
                        ])
                    }
                >
                    {localSplit.pinned.length > 0 && (
                        <>
                            {/* Las ancladas van planas y arriba de todo: anclar
                                existe justamente para sacarlas del montón. */}
                            {localSplit.pinned.map((b) => branchRow(b, b.name, depth + 1, {isPinned: true}))}
                        </>
                    )}
                    <BranchFolders
                        node={localTree}
                        depth={depth + 1}
                        isOpen={(path) => filtering || ui.isOpen(key(`bf:${path}`))}
                        onToggle={(path) => ui.toggle(key(`bf:${path}`))}
                        onFolderMenu={(e, path) => actions.branchFolderMenu(e, repo, path)}
                        renderBranch={(b, folderPath, d) => branchRow(b, leafLabel(b, folderPath), d, {isPinned: false})}
                    />
                </GroupRow>
            )}

            {(!filtering || remotes.length > 0) && (
                <GroupRow
                    depth={depth}
                    icon="lan"
                    label={tg.remotes}
                    count={remotes.length}
                    open={open('remotes')}
                    onToggle={() => ui.toggle(key('remotes'))}
                    add={{icon: 'settings', title: tg.manageRemotesTitle, onClick: onManageRemotes}}
                    onMenu={(e) => actions.groupMenu(e, [{label: tg.manageRemotes, icon: 'settings', title: tg.manageRemotesTitle, onSelect: onManageRemotes}])}
                >
                    {remotes.map((r) => {
                        const branches = remoteAll.filter((b) => b.name.startsWith(`${r.name}/`))
                        const split = splitPinned(branches, pinned)
                        // Guarda lo PLEGADO: las ramas de un remoto se veían
                        // siempre, y así siguen hasta que se lo pliegue.
                        const closedKey = key(`rc:${r.name}`)
                        const isOpen = filtering || !ui.isOpen(closedKey)
                        return (
                            <div key={r.name}>
                                <TreeRow
                                    depth={depth + 1}
                                    icon="cloud"
                                    iconClass="text-on-surface-variant/80"
                                    label={r.name}
                                    title={tg.remoteTitle({url: r.fetchUrl})}
                                    expanded={branches.length ? isOpen : undefined}
                                    onToggle={() => ui.toggle(closedKey)}
                                    onClick={() => branches.length && ui.toggle(closedKey)}
                                    onContextMenu={(e) => actions.remoteMenu(e, repo, r)}
                                    trailing={<Count n={branches.length} />}
                                    actions={<MenuButton onOpen={(e) => actions.remoteMenu(e, repo, r)} title={tg.remoteOptions} />}
                                />
                                {isOpen && (
                                    <>
                                        {split.pinned.map((b) => branchRow(b, b.name.slice(r.name.length + 1), depth + 2, {remote: true, isPinned: true}))}
                                        <BranchFolders
                                            node={buildBranchTree(split.rest, r.name)}
                                            depth={depth + 2}
                                            isOpen={(path) => filtering || ui.isOpen(key(`rbf:${r.name}:${path}`))}
                                            onToggle={(path) => ui.toggle(key(`rbf:${r.name}:${path}`))}
                                            onFolderMenu={(e, path) => actions.remoteFolderMenu(e, r.name, path)}
                                            renderBranch={(b, folderPath, d) => branchRow(b, leafLabel(b, folderPath, r.name), d, {remote: true, isPinned: false})}
                                        />
                                    </>
                                )}
                            </div>
                        )
                    })}
                </GroupRow>
            )}

            {(!filtering || tags.length > 0) && (
                <GroupRow
                    depth={depth}
                    icon="sell"
                    label={tg.tags}
                    title={tr.tagsHint}
                    count={tags.length}
                    open={open('tags')}
                    onToggle={() => ui.toggle(key('tags'))}
                    add={{title: tg.addTagTitle, onClick: () => actions.startCreateTag(repo)}}
                    onMenu={(e) =>
                        actions.groupMenu(e, [{label: tg.createTagEllipsis, icon: 'sell', title: tg.createTagMenuTitle, onSelect: () => actions.startCreateTag(repo)}])
                    }
                >
                    {tagGroups.groups.map((group) => {
                        const gKey = key(`tg:${group.key}`)
                        const isOpen = filtering || ui.isOpen(gKey)
                        return (
                            <div key={gKey}>
                                <TreeRow
                                    depth={depth + 1}
                                    icon={isOpen ? 'folder_open' : 'folder'}
                                    iconClass="text-on-surface-variant/70"
                                    label={group.key}
                                    labelClass="text-on-surface-variant"
                                    title={isOpen ? tr.tagGroupCollapse({group: group.key, count: group.tags.length}) : tr.tagGroupExpand({group: group.key, count: group.tags.length})}
                                    expanded={isOpen}
                                    onToggle={() => ui.toggle(gKey)}
                                    onClick={() => ui.toggle(gKey)}
                                    trailing={<Count n={group.tags.length} />}
                                />
                                {isOpen && group.tags.map((tag) => tagRow(tag, depth + 2))}
                            </div>
                        )
                    })}
                    {tagGroups.loose.map((tag) => tagRow(tag, depth + 1))}
                </GroupRow>
            )}

            {(!filtering || stashes.length > 0) && (
                <GroupRow
                    depth={depth}
                    icon="inventory_2"
                    label={tg.stashes}
                    count={stashes.length}
                    open={open('stashes')}
                    onToggle={() => ui.toggle(key('stashes'))}
                >
                    {stashes.map((st) => (
                        <TreeRow
                            key={st.ref}
                            depth={depth + 1}
                            icon="inventory_2"
                            iconClass="text-on-surface-variant/80"
                            label={st.message}
                            title={tg.stashTitle({ref: st.ref, date: st.date})}
                            onContextMenu={(e) => actions.stashMenu(e, repo, st)}
                            actions={<MenuButton onOpen={(e) => actions.stashMenu(e, repo, st)} title={tg.stashOptions} />}
                        />
                    ))}
                </GroupRow>
            )}
        </>
    )
}

function Count({n}: {n: number}) {
    return <span className="text-ui-10 tabular-nums text-on-surface-variant/50">{n}</span>
}

// Guided envuelve lo que cuelga del árbol sin ser una fila (el campo de filtro,
// un aviso) con las mismas guías verticales que TreeRow: sin esto la línea del
// repositorio se corta justo ahí y el contenido parece suelto.
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

// El campo de filtro de un repositorio. Un solo filtro para ramas locales,
// remotas y tags a propósito: buscar «1.31» o «TIGOCHAT» sin decidir de antemano
// si es una rama o un tag es justo lo que se quiere de un buscador de
// referencias. Esc borra el texto y, ya vacío, cierra el campo.
function FilterRow({depth, repoName, ui}: {depth: number; repoName: string; ui: RepoRefsUi}) {
    const tr = useT().sidebar.gitRefs
    return (
        <Guided depth={depth}>
            <div className="my-0.5 ml-5 flex items-center gap-1 rounded bg-surface-container-highest px-1.5 py-1 focus-within:ring-1 focus-within:ring-primary">
                <Icon name="search" size={13} className="shrink-0 text-on-surface-variant/60" />
                <input
                    autoFocus
                    value={ui.filter}
                    onChange={(e) => ui.setFilter(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key !== 'Escape') return
                        e.stopPropagation()
                        if (ui.filter) ui.setFilter('')
                        else ui.closeFilter()
                    }}
                    // Un clic derecho en el campo no debe abrir el menú del árbol.
                    onContextMenu={(e) => e.stopPropagation()}
                    placeholder={tr.filterPlaceholder}
                    title={`${tr.filterButton({name: repoName})}. ${tr.filterTitle}`}
                    className="min-w-0 flex-1 bg-transparent text-ui-11 text-on-surface outline-none placeholder:text-on-surface-variant/60"
                />
                <button
                    onClick={() => (ui.filter ? ui.setFilter('') : ui.closeFilter())}
                    title={tr.clearFilter}
                    className="shrink-0 rounded text-on-surface-variant/60 hover:text-on-surface"
                >
                    <Icon name="close" size={13} />
                </button>
            </div>
        </Guided>
    )
}

// Commits por delante / por detrás del upstream. Se quedan siempre a la vista
// (no solo en el title): «tengo 8 commits sin pushear» es justo lo que se busca
// de un vistazo antes de cambiar de rama.
export function AheadBehind({branch}: {branch: git.Branch}) {
    const t = useT()
    if (!branch.ahead && !branch.behind) return null
    return (
        <span
            className="flex items-center gap-1 font-mono text-ui-10 tabular-nums text-on-surface-variant/70"
            title={t.sidebar.git.aheadBehind({ahead: branch.ahead, behind: branch.behind, upstream: branch.upstream ?? ''})}
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
// Stashes): una fila más del árbol, con la guía de su nivel, para que el detalle
// se lea como parte del repositorio y no como otra lista pegada debajo.
function GroupRow({
    depth,
    icon,
    label,
    title,
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
    title?: string
    count: number
    open: boolean
    onToggle: () => void
    // La acción principal del grupo (crear rama, crear tag), a la vista al
    // pasar el mouse. Es la única: lo demás está en el menú.
    add?: {icon?: string; title: string; onClick: () => void}
    onMenu?: (e: ReactMouseEvent) => void
    children: ReactNode
}) {
    const t = useT()
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
                title={
                    (branch
                        ? open
                            ? t.sidebar.git.groupCollapse({label})
                            : t.sidebar.git.groupShow({label, count})
                        : t.sidebar.git.groupEmpty({label})) + (title ? `. ${title}` : '')
                }
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
                            {onMenu && <MenuButton onOpen={onMenu} title={t.sidebar.git.groupOptions({label})} />}
                        </>
                    ) : undefined
                }
            />
            {branch && open && children}
        </>
    )
}

// Recorre el árbol de ramas (`feature/`, `claude/`…) dibujando carpetas y
// delegando las ramas en renderBranch: el árbol no conoce el diseño de la fila.
function BranchFolders({
    node,
    depth,
    isOpen,
    onToggle,
    onFolderMenu,
    renderBranch,
}: {
    node: BranchTreeNode
    depth: number
    isOpen: (path: string) => boolean
    onToggle: (path: string) => void
    onFolderMenu: (e: ReactMouseEvent, path: string) => void
    renderBranch: (branch: git.Branch, folderPath: string, depth: number) => ReactNode
}) {
    const t = useT()
    return (
        <>
            {node.folders.map((folder) => {
                const open = isOpen(folder.path)
                const total = countBranches(folder)
                return (
                    <div key={folder.path}>
                        {/* Carpeta de ramas, no de la barra: mismo ícono pero sin
                            el tono de las carpetas que organiza el usuario. */}
                        <TreeRow
                            depth={depth}
                            icon={open ? 'folder_open' : 'folder'}
                            iconClass="text-on-surface-variant/70"
                            label={folder.label}
                            labelClass="text-on-surface-variant"
                            title={
                                open
                                    ? t.sidebar.git.branchFolderCollapse({path: folder.path, count: total})
                                    : t.sidebar.git.branchFolderExpand({path: folder.path, count: total})
                            }
                            expanded={open}
                            onToggle={() => onToggle(folder.path)}
                            onClick={() => onToggle(folder.path)}
                            onContextMenu={(e) => onFolderMenu(e, folder.path)}
                            trailing={<Count n={total} />}
                            actions={<MenuButton onOpen={(e) => onFolderMenu(e, folder.path)} title={t.sidebar.gitRefs.folderOptions} />}
                        />
                        {open && (
                            <BranchFolders node={folder} depth={depth + 1} isOpen={isOpen} onToggle={onToggle} onFolderMenu={onFolderMenu} renderBranch={renderBranch} />
                        )}
                    </div>
                )
            })}
            {node.branches.map((b) => renderBranch(b, node.path, depth))}
        </>
    )
}
