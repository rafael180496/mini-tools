import {useState, type RefObject} from 'react'
import {git} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import {useT} from '../../i18n'
import {describeSearch, EMPTY_SEARCH, GIT_SEARCH_HELP, isEmptySearch, parseGitSearch, type GitSearch} from '../../lib/gitSearch'

// Columna de trabajo cuando se mira el HISTORIAL: qué commits ver.
//
// El grafo (o la lista) vive en el área principal; acá están las dos cosas que
// lo acotan: la búsqueda —que la aplica git sobre TODO el historial, no sobre
// lo cargado— y «Solo mi trabajo». Más un atajo a las ramas que importan, para
// no tener que abrir el selector de la barra por cada salto.

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
    // Las ramas que entran en «Solo mi trabajo»: la actual, los troncos que
    // existen y las ancladas. Se listan siempre —no solo con el modo prendido—
    // porque son también los destinos de salto que más se usan.
    quickRefs: git.Branch[]
    pinned: string[]
    selectedBranch: string | null
    busy: boolean
    onRevealBranch: (b: git.Branch) => void
    onCheckout: (b: git.Branch) => void
    onTogglePin: (name: string) => void
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
    quickRefs,
    pinned,
    selectedBranch,
    busy,
    onRevealBranch,
    onCheckout,
    onTogglePin,
}: Props) {
    const t = useT()
    const g = t.git.tab
    const w = t.git.workbench.history
    const [showHelp, setShowHelp] = useState(false)

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

            {/* --- ramas rápidas ------------------------------------------------ */}
            <div className="min-h-0 border-t border-outline-variant">
                <p className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/70">
                    {w.quickRefs}
                    <span className="font-mono text-ui-9 font-normal opacity-70">{quickRefs.length}</span>
                </p>
                {quickRefs.length === 0 && <p className="px-3 py-2 text-ui-11 text-on-surface-variant/60">{w.noQuickRefs}</p>}
                {quickRefs.map((b) => {
                    const isPinned = pinned.includes(b.name)
                    const selected = selectedBranch === b.name
                    return (
                        <div
                            key={b.name}
                            className={`group relative flex items-center gap-1 pl-1.5 pr-1 ${
                                b.isCurrent ? 'bg-primary-container/50 text-on-primary-container' : selected ? 'bg-secondary-container/25 text-on-surface' : 'text-on-surface hover:bg-surface-variant/60'
                            }`}
                        >
                            {selected && <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-secondary" />}
                            <button
                                onClick={() => onTogglePin(b.name)}
                                title={isPinned ? w.unpin({name: b.name}) : w.pin({name: b.name})}
                                aria-label={isPinned ? w.unpin({name: b.name}) : w.pin({name: b.name})}
                                className={`shrink-0 rounded p-0.5 ${isPinned ? 'text-tertiary' : 'text-on-surface-variant/30 opacity-0 group-hover:opacity-100'}`}
                            >
                                <Icon name="star" size={13} filled={isPinned} />
                            </button>
                            <button
                                onClick={() => onRevealBranch(b)}
                                onDoubleClick={() => !b.isCurrent && onCheckout(b)}
                                disabled={busy}
                                title={w.branchTitle({name: b.name, current: b.isCurrent})}
                                className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-ui-12 disabled:opacity-50"
                            >
                                <Icon name={b.isRemote ? 'cloud' : 'account_tree'} size={13} className="shrink-0 opacity-60" />
                                <span className={`truncate ${b.isCurrent ? 'font-semibold' : ''}`}>{b.name}</span>
                                {b.isCurrent && <Icon name="check" size={13} className="shrink-0 text-primary" />}
                                {(b.ahead > 0 || b.behind > 0) && (
                                    <span className="ml-auto shrink-0 font-mono text-ui-9 opacity-70">
                                        {b.ahead > 0 && `↑${b.ahead}`}
                                        {b.behind > 0 && `↓${b.behind}`}
                                    </span>
                                )}
                            </button>
                        </div>
                    )
                })}
                <p className="px-3 py-2 text-ui-10 leading-snug text-on-surface-variant/60">{w.quickRefsHint}</p>
            </div>

            <div className="mt-auto shrink-0 border-t border-outline-variant px-3 py-1.5 text-ui-10 text-on-surface-variant/70">
                {loading ? w.loading : w.loaded({n: commitCount})}
            </div>
        </div>
    )
}
