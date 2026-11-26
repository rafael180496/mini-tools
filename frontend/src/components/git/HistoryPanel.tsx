import {useMemo, useState, type MouseEvent as ReactMouseEvent, type RefObject} from 'react'
import {git} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import {useT} from '../../i18n'
import {describeSearch, EMPTY_SEARCH, GIT_SEARCH_HELP, isEmptySearch, parseGitSearch, type GitSearch} from '../../lib/gitSearch'

// Columna de trabajo cuando se mira el HISTORIAL: búsqueda de commits, «Solo mi
// trabajo» y el árbol completo de Git (Ramas con crear/menú, Remotos, Tags y
// acceso a Stashes) — paridad total con el antiguo árbol de repositorios.

interface Props {
    searchText: string
    onSearchText: (v: string) => void
    search: GitSearch
    onSearch: (s: GitSearch) => void
    inputRef: RefObject<HTMLInputElement | null>
    focusMode: boolean
    onFocusMode: (v: boolean) => void
    commitCount: number
    loading: boolean
    quickRefs: git.Branch[]
    branches: git.Branch[]
    tags: git.Tag[]
    stashCount: number
    pinned: string[]
    selectedBranch: string | null
    busy: boolean
    onRevealBranch: (b: git.Branch) => void
    onCheckout: (b: git.Branch) => void
    onTogglePin: (name: string) => void
    onBranchMenu: (b: git.Branch, e: ReactMouseEvent) => void
    onRevealTag: (tg: git.Tag) => void
    onTagMenu: (tg: git.Tag, e: ReactMouseEvent) => void
    onCreateBranch: () => void
    onCreateTag: () => void
    onManageRemotes: () => void
    onOpenStashes: () => void
}

export default function HistoryPanel({
    searchText,
    onSearchText,
    search,
    onSearch,
    inputRef,
    focusMode,
    onFocusMode,
    commitCount,
    loading,
    branches,
    tags,
    stashCount,
    pinned,
    selectedBranch,
    busy,
    onRevealBranch,
    onCheckout,
    onTogglePin,
    onBranchMenu,
    onRevealTag,
    onTagMenu,
    onCreateBranch,
    onCreateTag,
    onManageRemotes,
    onOpenStashes,
}: Props) {
    const t = useT()
    const g = t.git.tab
    const w = t.git.workbench.history
    const sw = t.git.workbench.switcher
    const gt = t.sidebar.git
    const [showHelp, setShowHelp] = useState(false)
    const [branchesOpen, setBranchesOpen] = useState(true)
    const [remotesOpen, setRemotesOpen] = useState(false)
    const [openRemote, setOpenRemote] = useState<Record<string, boolean>>({})
    const [tagsOpen, setTagsOpen] = useState(false)

    const localBranches = useMemo(() => {
        const locals = branches.filter((b) => !b.isRemote)
        const pinnedSet = new Set(pinned)
        return [...locals].sort((a, b) => {
            if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
            const ap = pinnedSet.has(a.name)
            const bp = pinnedSet.has(b.name)
            if (ap !== bp) return ap ? -1 : 1
            return a.name.localeCompare(b.name)
        })
    }, [branches, pinned])

    const remoteGroups = useMemo(() => {
        const groups = new Map<string, git.Branch[]>()
        for (const b of branches) {
            if (!b.isRemote) continue
            const slash = b.name.indexOf('/')
            const remote = slash > 0 ? b.name.slice(0, slash) : 'origin'
            const list = groups.get(remote) ?? []
            list.push(b)
            groups.set(remote, list)
        }
        return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    }, [branches])

    const clear = () => {
        onSearchText('')
        onSearch(EMPTY_SEARCH)
    }

    // Un prefijo se agrega al final del texto y deja el cursor ahí: es la
    // forma de descubrir la sintaxis sin leer la ayuda.
    const addPrefix = (prefix: string) => {
        const text = searchText && !searchText.endsWith(' ') ? `${searchText} ${prefix}` : `${searchText}${prefix}`
        onSearchText(text)
        requestAnimationFrame(() => {
            const el = inputRef.current
            if (!el) return
            el.focus()
            el.setSelectionRange(text.length, text.length)
        })
    }

    const prefixes = [w.prefixAuthor, w.prefixMessage, w.prefixFile, w.prefixSince, w.prefixUntil]

    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {/* --- búsqueda ----------------------------------------------------
                Distinta de cualquier filtro de ramas: ésta va a git y acota el
                HISTORIAL. Confundirlas es concluir que un commit no existe
                cuando solo no está en esta página. */}
            <div className="shrink-0 space-y-1.5 p-2">
                <div className="flex items-center gap-1 rounded bg-surface-container px-1.5 py-1 focus-within:ring-1 focus-within:ring-primary">
                    <Icon name="manage_search" size={15} className="shrink-0 text-on-surface-variant/70" />
                    <input
                        ref={inputRef}
                        value={searchText}
                        onChange={(e) => onSearchText(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') onSearch(parseGitSearch(searchText))
                            if (e.key === 'Escape') clear()
                        }}
                        onBlur={() => onSearch(parseGitSearch(searchText))}
                        placeholder={g.search.placeholder}
                        title={g.search.inputTitle({help: GIT_SEARCH_HELP()})}
                        className="min-w-0 flex-1 bg-transparent text-ui-12 text-on-surface outline-none placeholder:text-on-surface-variant/50"
                    />
                    {searchText && (
                        <button onClick={clear} title={g.search.clearTitle} aria-label={g.search.clearTitle} className="shrink-0 rounded text-on-surface-variant/70 hover:text-on-surface">
                            <Icon name="close" size={14} />
                        </button>
                    )}
                    <button
                        onClick={() => setShowHelp((v) => !v)}
                        title={g.search.helpTitle}
                        aria-label={g.search.helpTitle}
                        aria-pressed={showHelp}
                        className={`shrink-0 rounded ${showHelp ? 'text-primary' : 'text-on-surface-variant/70 hover:text-on-surface'}`}
                    >
                        <Icon name="help" size={14} />
                    </button>
                </div>

                <div className="flex flex-wrap items-center gap-1">
                    {prefixes.map((p) => (
                        <button
                            key={p}
                            onClick={() => addPrefix(p)}
                            title={w.prefixTitle({prefix: p})}
                            className="rounded-full border border-outline-variant px-2 py-px font-mono text-ui-10 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                        >
                            {p}
                        </button>
                    ))}
                </div>

                {showHelp && (
                    <pre className="whitespace-pre-wrap rounded bg-surface-container px-2 py-1.5 text-ui-10 leading-relaxed text-on-surface-variant">{GIT_SEARCH_HELP()}</pre>
                )}

                {/* El filtro activo, dicho en voz alta: una búsqueda que acota
                    el historial en silencio es como alguien concluye que un
                    commit desapareció. */}
                {!isEmptySearch(search) && (
                    <p className="flex items-start gap-1 rounded bg-tertiary-container/40 px-2 py-1 text-ui-10 text-on-tertiary-container">
                        <Icon name="filter_alt" size={12} className="mt-px shrink-0" />
                        <span className="min-w-0 flex-1">{g.search.filteredBy({filter: describeSearch(search)})}</span>
                        <button onClick={clear} title={g.search.clearTitle} aria-label={g.search.clearTitle} className="shrink-0 rounded hover:opacity-70">
                            <Icon name="close" size={12} />
                        </button>
                    </p>
                )}

                {/* «Solo mi trabajo»: la rama actual, los troncos y las ancladas.
                    En un repo con cientos de remotas es la diferencia entre un
                    grafo legible y una pared de carriles. */}
                <button
                    role="switch"
                    aria-checked={focusMode}
                    onClick={() => onFocusMode(!focusMode)}
                    title={g.search.focusTitle}
                    className={`flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left transition-colors ${
                        focusMode ? 'border-transparent bg-primary-container text-on-primary-container' : 'border-outline-variant text-on-surface hover:bg-surface-variant'
                    }`}
                >
                    <Icon name="center_focus_strong" size={16} className="shrink-0" />
                    <span className="min-w-0 flex-1">
                        <span className="block text-ui-12 font-medium">{g.search.focus}</span>
                        <span className="block text-ui-10 opacity-70">{w.focusHint}</span>
                    </span>
                    <span
                        aria-hidden
                        className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${focusMode ? 'bg-primary' : 'bg-outline-variant'}`}
                    >
                        <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-surface transition-all ${focusMode ? 'left-3.5' : 'left-0.5'}`} />
                    </span>
                </button>
            </div>

            {/* --- árbol Git completo: Ramas / Remotos / Tags / Stashes ------- */}
            <div className="min-h-0 flex-1 border-t border-outline-variant py-1">
                {/* Ramas locales */}
                <div className="group flex items-center gap-1 px-1.5 py-1 hover:bg-surface-variant/40">
                    <button
                        type="button"
                        onClick={() => setBranchesOpen((v) => !v)}
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-medium text-on-surface"
                    >
                        <Icon name={branchesOpen ? 'expand_more' : 'chevron_right'} size={14} className="shrink-0 text-on-surface-variant" />
                        <Icon name="account_tree" size={14} className="shrink-0 text-primary" />
                        <span className="truncate">{gt.branches}</span>
                        <span className="ml-auto font-mono text-ui-10 text-on-surface-variant/75">{localBranches.length}</span>
                    </button>
                    <button
                        type="button"
                        onClick={onCreateBranch}
                        disabled={busy}
                        title={gt.addBranchTitle}
                        aria-label={sw.newBranch}
                        className="shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-40"
                    >
                        <Icon name="add" size={14} />
                    </button>
                </div>

                {branchesOpen && (
                    <div className="pb-1">
                        {localBranches.length === 0 && (
                            <p className="px-6 py-1 text-ui-11 text-on-surface-variant/60">{w.noQuickRefs}</p>
                        )}
                        {localBranches.map((b) => {
                            const isPinned = pinned.includes(b.name)
                            const selected = selectedBranch === b.name
                            return (
                                <div
                                    key={b.name}
                                    onContextMenu={(e) => {
                                        e.preventDefault()
                                        onBranchMenu(b, e)
                                    }}
                                    className={`group relative flex items-center gap-1 pl-4 pr-1 ${
                                        b.isCurrent
                                            ? 'bg-primary-container/45 text-on-primary-container'
                                            : selected
                                              ? 'bg-secondary-container/25 text-on-surface'
                                              : 'text-on-surface hover:bg-surface-variant/60'
                                    }`}
                                >
                                    {selected && <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-secondary" />}
                                    <button
                                        type="button"
                                        onClick={() => onTogglePin(b.name)}
                                        title={isPinned ? w.unpin({name: b.name}) : w.pin({name: b.name})}
                                        aria-label={isPinned ? w.unpin({name: b.name}) : w.pin({name: b.name})}
                                        className={`shrink-0 rounded p-0.5 ${isPinned ? 'text-tertiary' : 'text-on-surface-variant/30 opacity-0 group-hover:opacity-100'}`}
                                    >
                                        <Icon name="star" size={13} filled={isPinned} />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => onRevealBranch(b)}
                                        onDoubleClick={() => !b.isCurrent && onCheckout(b)}
                                        disabled={busy}
                                        title={w.branchTitle({name: b.name, current: b.isCurrent})}
                                        className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-ui-12 disabled:opacity-50"
                                    >
                                        <Icon name="account_tree" size={13} className="shrink-0 opacity-60" />
                                        <span className={`truncate ${b.isCurrent ? 'font-semibold' : ''}`}>{b.name}</span>
                                        {b.isCurrent && <Icon name="check" size={13} className="shrink-0 text-primary" />}
                                        {(b.ahead > 0 || b.behind > 0) && (
                                            <span className="ml-auto shrink-0 font-mono text-ui-9 opacity-70">
                                                {b.ahead > 0 && `↑${b.ahead}`}
                                                {b.behind > 0 && `↓${b.behind}`}
                                            </span>
                                        )}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            onBranchMenu(b, e)
                                        }}
                                        title={gt.branchOptions}
                                        aria-label={gt.branchOptions}
                                        className="shrink-0 rounded p-0.5 text-on-surface-variant opacity-0 transition-opacity hover:bg-surface-variant hover:text-on-surface group-hover:opacity-100"
                                    >
                                        <Icon name="more_horiz" size={14} />
                                    </button>
                                </div>
                            )
                        })}
                    </div>
                )}

                {/* Remotos */}
                <div className="group flex items-center gap-1 px-1.5 py-1 hover:bg-surface-variant/40">
                    <button
                        type="button"
                        onClick={() => setRemotesOpen((v) => !v)}
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-medium text-on-surface"
                    >
                        <Icon name={remotesOpen ? 'expand_more' : 'chevron_right'} size={14} className="shrink-0 text-on-surface-variant" />
                        <Icon name="cloud" size={14} className="shrink-0 text-on-surface-variant" />
                        <span className="truncate">{gt.remotes}</span>
                        <span className="ml-auto font-mono text-ui-10 text-on-surface-variant/75">{remoteGroups.length}</span>
                    </button>
                    <button
                        type="button"
                        onClick={onManageRemotes}
                        title={gt.manageRemotesTitle}
                        aria-label={gt.manageRemotes}
                        className="shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="settings" size={13} />
                    </button>
                </div>

                {remotesOpen && (
                    <div className="pb-1">
                        {remoteGroups.map(([remote, list]) => {
                            const isOpen = openRemote[remote] ?? remoteGroups.length === 1
                            return (
                                <div key={remote}>
                                    <button
                                        type="button"
                                        onClick={() => setOpenRemote((prev) => ({...prev, [remote]: !isOpen}))}
                                        className="flex w-full items-center gap-1.5 py-1 pl-5 pr-2 text-left text-ui-11 font-medium text-on-surface-variant hover:bg-surface-variant/50 hover:text-on-surface"
                                    >
                                        <Icon name={isOpen ? 'expand_more' : 'chevron_right'} size={13} className="shrink-0" />
                                        <span className="truncate">{remote}</span>
                                        <span className="ml-auto font-mono text-ui-9 opacity-70">{list.length}</span>
                                    </button>
                                    {isOpen &&
                                        list.map((b) => {
                                            const shortName = b.name.startsWith(`${remote}/`) ? b.name.slice(remote.length + 1) : b.name
                                            return (
                                                <div
                                                    key={b.name}
                                                    onContextMenu={(e) => {
                                                        e.preventDefault()
                                                        onBranchMenu(b, e)
                                                    }}
                                                    className="group flex items-center gap-1 pl-8 pr-1 text-on-surface-variant hover:bg-surface-variant/60 hover:text-on-surface"
                                                >
                                                    <button
                                                        type="button"
                                                        onClick={() => onRevealBranch(b)}
                                                        onDoubleClick={() => onCheckout(b)}
                                                        disabled={busy}
                                                        title={gt.remoteBranchTitle({name: b.name})}
                                                        className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-ui-11 disabled:opacity-50"
                                                    >
                                                        <Icon name="cloud" size={12} className="shrink-0 opacity-60" />
                                                        <span className="truncate">{shortName}</span>
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={(e) => {
                                                            e.stopPropagation()
                                                            onBranchMenu(b, e)
                                                        }}
                                                        title={gt.remoteBranchOptions}
                                                        aria-label={gt.remoteBranchOptions}
                                                        className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-surface-variant group-hover:opacity-100"
                                                    >
                                                        <Icon name="more_horiz" size={13} />
                                                    </button>
                                                </div>
                                            )
                                        })}
                                </div>
                            )
                        })}
                    </div>
                )}

                {/* Tags */}
                <div className="group flex items-center gap-1 px-1.5 py-1 hover:bg-surface-variant/40">
                    <button
                        type="button"
                        onClick={() => setTagsOpen((v) => !v)}
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-medium text-on-surface"
                    >
                        <Icon name={tagsOpen ? 'expand_more' : 'chevron_right'} size={14} className="shrink-0 text-on-surface-variant" />
                        <Icon name="sell" size={14} className="shrink-0 text-on-surface-variant" />
                        <span className="truncate">{gt.tags}</span>
                        <span className="ml-auto font-mono text-ui-10 text-on-surface-variant/75">{tags.length}</span>
                    </button>
                    <button
                        type="button"
                        onClick={onCreateTag}
                        disabled={busy}
                        title={gt.addTagTitle}
                        aria-label={sw.newTag}
                        className="shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-40"
                    >
                        <Icon name="add" size={14} />
                    </button>
                </div>

                {tagsOpen && (
                    <div className="pb-1">
                        {tags.map((tg) => (
                            <div
                                key={tg.name}
                                onContextMenu={(e) => {
                                    e.preventDefault()
                                    onTagMenu(tg, e)
                                }}
                                className="group flex items-center gap-1 pl-6 pr-1 text-on-surface-variant hover:bg-surface-variant/60 hover:text-on-surface"
                            >
                                <button
                                    type="button"
                                    onClick={() => onRevealTag(tg)}
                                    title={sw.tagTitle({name: tg.name, hash: tg.hash.slice(0, 7)})}
                                    className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-ui-11"
                                >
                                    <Icon name="sell" size={12} className="shrink-0 opacity-60" />
                                    <span className="truncate font-mono">{tg.name}</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        onTagMenu(tg, e)
                                    }}
                                    title={gt.tagOptions}
                                    aria-label={gt.tagOptions}
                                    className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-surface-variant group-hover:opacity-100"
                                >
                                    <Icon name="more_horiz" size={13} />
                                </button>
                            </div>
                        ))}
                    </div>
                )}

                {/* Acceso directo a Stashes */}
                <button
                    type="button"
                    onClick={onOpenStashes}
                    className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-xs font-medium text-on-surface hover:bg-surface-variant/40"
                >
                    <Icon name="inventory_2" size={14} className="shrink-0 text-on-surface-variant" />
                    <span className="truncate">{gt.stashes}</span>
                    <span className="ml-auto font-mono text-ui-10 text-on-surface-variant/75">{stashCount}</span>
                </button>
            </div>

            <div className="mt-auto shrink-0 border-t border-outline-variant px-3 py-1.5 text-ui-10 text-on-surface-variant/70">
                {loading ? w.loading : w.loaded({n: commitCount})}
            </div>
        </div>
    )
}
