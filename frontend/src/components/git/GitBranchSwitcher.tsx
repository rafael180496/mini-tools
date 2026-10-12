import {useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent} from 'react'
import {createPortal} from 'react-dom'
import {git} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import {useT} from '../../i18n'

// Selector rápido de rama: el chip de la barra, que al hacer clic abre una
// lista con buscador.
//
// Reemplaza al árbol RAMAS / REMOTAS / TAGS que vivía en la columna interna de
// la pestaña. Ese árbol repetía lo que ya muestra la barra lateral principal
// (repo → Ramas, Remotos, Tags), pero tenía tres cosas que la barra no puede
// hacer porque no ve el grafo: revelar una punta, anclar, y el menú completo
// (merge, rebase, upstream). Acá siguen todas, pero detrás de UN clic en vez de
// ocupar media columna de forma permanente.
//
// Clic en una fila de rama = cambiar a ella (es lo que hace un selector);
// el ícono de mira la revela en el grafo (lo que antes hacía el clic simple);
// el botón derecho abre el menú completo de la rama.

// Cuántas filas se dibujan. En un repo con cientos de remotas, dibujarlas todas
// para después filtrar es la lista plana ilegible que el buscador vino a
// evitar: se muestran las primeras y se pide afinar la búsqueda.
const MAX_ROWS = 120

type Row =
    | {kind: 'branch'; branch: git.Branch; pinned: boolean}
    | {kind: 'tag'; tag: git.Tag}

interface Props {
    label: string
    // HEAD sin rama: el chip se pinta distinto para que no se confunda con una
    // rama llamada igual que el texto.
    detached: boolean
    chipTitle: string
    branches: git.Branch[]
    tags: git.Tag[]
    pinned: string[]
    busy: boolean
    onCheckout: (b: git.Branch) => void
    onReveal: (b: git.Branch) => void
    onTogglePin: (name: string) => void
    onBranchMenu: (b: git.Branch, e: ReactMouseEvent) => void
    onTagReveal: (tag: git.Tag) => void
    onTagMenu: (tag: git.Tag, e: ReactMouseEvent) => void
    onCreateBranch: () => void
    onCreateTag: () => void
    onManageRemotes: () => void
}

export default function GitBranchSwitcher({
    label,
    detached,
    chipTitle,
    branches,
    tags,
    pinned,
    busy,
    onCheckout,
    onReveal,
    onTogglePin,
    onBranchMenu,
    onTagReveal,
    onTagMenu,
    onCreateBranch,
    onCreateTag,
    onManageRemotes,
}: Props) {
    const t = useT().git.workbench.switcher
    const [open, setOpen] = useState(false)
    const [pos, setPos] = useState<{top: number; left: number} | null>(null)
    const [query, setQuery] = useState('')
    const [active, setActive] = useState(0)
    const chipRef = useRef<HTMLButtonElement>(null)
    const inputRef = useRef<HTMLInputElement>(null)

    const close = () => {
        setOpen(false)
        setQuery('')
        setActive(0)
    }

    function toggle() {
        if (open) return close()
        const rect = chipRef.current?.getBoundingClientRect()
        if (rect) setPos({top: rect.bottom + 4, left: Math.max(8, Math.min(rect.left, window.innerWidth - 348))})
        setOpen(true)
    }

    useEffect(() => {
        if (open) requestAnimationFrame(() => inputRef.current?.focus())
    }, [open])

    const q = query.trim().toLowerCase()

    // Locales primero (ancladas arriba), después remotas, después tags. Un solo
    // buscador para las tres: buscar «1.31» sin decidir de antemano si es rama o
    // tag es justo lo que se quiere de un selector.
    const { sections, flat, total } = useMemo(() => {
        const match = (name: string) => !q || name.toLowerCase().includes(q)
        const isPinned = (b: git.Branch) => pinned.includes(b.name)
        const byPin = (a: git.Branch, b: git.Branch) => Number(isPinned(b)) - Number(isPinned(a))
        const local = branches.filter((b) => !b.isRemote && match(b.name)).sort(byPin)
        const remote = branches.filter((b) => b.isRemote && match(b.name)).sort(byPin)
        const tg = tags.filter((x) => match(x.name))
        const total = local.length + remote.length + tg.length

        let budget = MAX_ROWS
        const take = <T,>(list: T[]) => {
            const out = list.slice(0, Math.max(0, budget))
            budget -= out.length
            return out
        }
        const sections: {key: string; title: string; count: number; rows: Row[]}[] = [
            {key: 'local', title: t.local, count: local.length, rows: take(local).map((b) => ({kind: 'branch', branch: b, pinned: isPinned(b)}) as Row)},
            {key: 'remote', title: t.remote, count: remote.length, rows: take(remote).map((b) => ({kind: 'branch', branch: b, pinned: isPinned(b)}) as Row)},
            {key: 'tags', title: t.tags, count: tg.length, rows: take(tg).map((x) => ({kind: 'tag', tag: x}) as Row)},
        ].filter((s) => s.count > 0)
        return {sections, flat: sections.flatMap((s) => s.rows), total}
    }, [branches, tags, pinned, q, t.local, t.remote, t.tags])

    useEffect(() => setActive(0), [q])

    function activate(r: Row) {
        close()
        if (r.kind === 'branch') {
            if (!r.branch.isCurrent) onCheckout(r.branch)
        } else onTagReveal(r.tag)
    }

    function onKey(e: React.KeyboardEvent) {
        if (e.key === 'Escape') return close()
        if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((i) => Math.min(flat.length - 1, i + 1))
        } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((i) => Math.max(0, i - 1))
        } else if (e.key === 'Enter' && flat[active]) {
            e.preventDefault()
            activate(flat[active])
        }
    }

    let index = -1
    return (
        <>
            <button
                ref={chipRef}
                onClick={toggle}
                title={chipTitle}
                aria-haspopup="listbox"
                aria-expanded={open}
                className={`flex min-w-0 max-w-56 items-center gap-1 rounded px-1.5 py-0.5 text-ui-11 font-medium transition-colors ${
                    detached
                        ? 'bg-tertiary-container text-on-tertiary-container'
                        : 'bg-primary-container text-on-primary-container'
                } hover:opacity-90`}
            >
                <Icon name={detached ? 'commit' : 'account_tree'} size={13} className="shrink-0" />
                <span className="truncate">{label}</span>
                <Icon name="expand_more" size={14} className="shrink-0 opacity-70" />
            </button>

            {open &&
                pos &&
                createPortal(
                    <>
                        <div
                            className="fixed inset-0 z-40"
                            onClick={close}
                            onContextMenu={(e) => {
                                e.preventDefault()
                                close()
                            }}
                        />
                        <div
                            style={{position: 'fixed', top: pos.top, left: pos.left, width: 340}}
                            onKeyDown={onKey}
                            className="z-50 flex max-h-[min(70vh,480px)] flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface-container-high shadow-lg"
                        >
                            <div className="shrink-0 border-b border-outline-variant p-1.5">
                                <div className="flex items-center gap-1.5 rounded bg-surface-container px-2 py-1 focus-within:ring-1 focus-within:ring-primary">
                                    <Icon name="search" size={14} className="shrink-0 text-on-surface-variant/70" />
                                    <input
                                        ref={inputRef}
                                        value={query}
                                        onChange={(e) => setQuery(e.target.value)}
                                        placeholder={t.placeholder}
                                        title={t.searchTitle}
                                        className="min-w-0 flex-1 bg-transparent text-ui-12 text-on-surface outline-none placeholder:text-on-surface-variant/50"
                                    />
                                    {query && (
                                        <button onClick={() => setQuery('')} title={t.clear} className="shrink-0 rounded text-on-surface-variant/70 hover:text-on-surface">
                                            <Icon name="close" size={14} />
                                        </button>
                                    )}
                                </div>
                            </div>

                            <div className="min-h-0 flex-1 overflow-y-auto p-1" role="listbox">
                                {sections.length === 0 && (
                                    <p className="px-3 py-6 text-center text-ui-11 text-on-surface-variant/70">{t.noMatch({query})}</p>
                                )}
                                {sections.map((s) => (
                                    <div key={s.key}>
                                        <p className="flex items-center gap-1.5 px-2 pb-0.5 pt-2 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">
                                            {s.title}
                                            <span className="font-mono text-ui-9 font-normal tabular-nums opacity-70">{s.count}</span>
                                        </p>
                                        {s.rows.map((r) => {
                                            index++
                                            const isActive = index === active
                                            const i = index
                                            if (r.kind === 'tag') {
                                                return (
                                                    <button
                                                        key={`t:${r.tag.name}`}
                                                        role="option"
                                                        aria-selected={isActive}
                                                        onMouseEnter={() => setActive(i)}
                                                        onClick={() => activate(r)}
                                                        onContextMenu={(e) => {
                                                            e.preventDefault()
                                                            close()
                                                            onTagMenu(r.tag, e)
                                                        }}
                                                        title={t.tagTitle({name: r.tag.name, hash: r.tag.hash.slice(0, 8)})}
                                                        className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-ui-12 ${
                                                            isActive ? 'bg-surface-variant' : ''
                                                        } text-on-surface`}
                                                    >
                                                        <Icon name="sell" size={14} className="shrink-0 opacity-60" />
                                                        <span className="truncate">{r.tag.name}</span>
                                                        {r.tag.taggerDate && (
                                                            <span className="ml-auto shrink-0 font-mono text-ui-9 tabular-nums opacity-50">{r.tag.taggerDate.slice(0, 10)}</span>
                                                        )}
                                                    </button>
                                                )
                                            }
                                            const b = r.branch
                                            return (
                                                <div
                                                    key={`b:${b.name}`}
                                                    role="option"
                                                    aria-selected={isActive}
                                                    onMouseEnter={() => setActive(i)}
                                                    onContextMenu={(e) => {
                                                        e.preventDefault()
                                                        close()
                                                        onBranchMenu(b, e)
                                                    }}
                                                    className={`group flex items-center gap-1 rounded pr-1 ${isActive ? 'bg-surface-variant' : b.isCurrent ? 'bg-primary-container/30' : ''} text-on-surface`}
                                                >
                                                    <button
                                                        onClick={() => onTogglePin(b.name)}
                                                        title={r.pinned ? t.unpin({name: b.name}) : t.pin({name: b.name})}
                                                        className={`shrink-0 rounded p-1 ${
                                                            r.pinned ? 'text-tertiary' : 'text-on-surface-variant/30 opacity-0 group-hover:opacity-100'
                                                        }`}
                                                    >
                                                        <Icon name="star" size={13} filled={r.pinned} />
                                                    </button>
                                                    <button
                                                        onClick={() => activate(r)}
                                                        disabled={busy}
                                                        title={
                                                            b.isCurrent
                                                                ? t.alreadyCurrent({name: b.name})
                                                                : b.isRemote
                                                                  ? t.checkoutRemote({name: b.name})
                                                                  : t.checkout({name: b.name})
                                                        }
                                                        className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-ui-12 disabled:opacity-50"
                                                    >
                                                        <Icon name={b.isRemote ? 'cloud' : 'account_tree'} size={14} className="shrink-0 opacity-60" />
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
                                                        onClick={() => {
                                                            close()
                                                            onReveal(b)
                                                        }}
                                                        title={t.reveal({name: b.name})}
                                                        className="shrink-0 rounded p-1 text-on-surface-variant opacity-0 hover:bg-surface-container-highest hover:text-on-surface group-hover:opacity-100"
                                                    >
                                                        <Icon name="my_location" size={13} />
                                                    </button>
                                                </div>
                                            )
                                        })}
                                    </div>
                                ))}
                                {total > MAX_ROWS && (
                                    <p className="px-3 py-2 text-center text-ui-10 text-on-surface-variant/70">{t.truncated({shown: MAX_ROWS, total})}</p>
                                )}
                            </div>

                            <div className="flex shrink-0 items-center gap-1 border-t border-outline-variant p-1">
                                <button
                                    onClick={() => {
                                        close()
                                        onCreateBranch()
                                    }}
                                    title={t.newBranchTitle}
                                    className="flex items-center gap-1 rounded px-2 py-1 text-ui-11 text-on-surface hover:bg-surface-variant"
                                >
                                    <Icon name="add" size={14} />
                                    {t.newBranch}
                                </button>
                                <button
                                    onClick={() => {
                                        close()
                                        onCreateTag()
                                    }}
                                    title={t.newTagTitle}
                                    className="flex items-center gap-1 rounded px-2 py-1 text-ui-11 text-on-surface hover:bg-surface-variant"
                                >
                                    <Icon name="sell" size={13} />
                                    {t.newTag}
                                </button>
                                <button
                                    onClick={() => {
                                        close()
                                        onManageRemotes()
                                    }}
                                    title={t.remotesTitle}
                                    className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-ui-11 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                                >
                                    <Icon name="cloud" size={13} />
                                    {t.remotes}
                                </button>
                            </div>
                        </div>
                    </>,
                    document.body,
                )}
        </>
    )
}
