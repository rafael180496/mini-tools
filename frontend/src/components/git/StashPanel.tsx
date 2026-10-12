import {git} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import {useT} from '../../i18n'

// Lista de stashes en la columna de trabajo.
//
// El contenido del stash seleccionado se ve en el área principal
// (StashPreview). Separarlos es lo que permite que la lista sea una columna
// estrecha y que el parche tenga el ancho que necesita.

interface Props {
    stashes: git.Stash[]
    selected: string | null
    onSelect: (ref: string) => void
    busy: boolean
    onPush: () => void
    onApply: (ref: string, drop: boolean) => void
    // El padre pide la confirmación: borrar un stash no queda en el reflog.
    onDrop: (ref: string) => void
}

export default function StashPanel({stashes, selected, onSelect, busy, onPush, onApply, onDrop}: Props) {
    const t = useT()
    const ts = t.git.stash
    const w = t.git.workbench.stash

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-1 border-b border-outline-variant px-2 py-1.5">
                <span className="text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/80">{ts.title}</span>
                <span className="rounded-full bg-surface-variant px-1.5 py-px text-ui-9 font-semibold text-on-surface-variant">{stashes.length}</span>
                <button
                    onClick={onPush}
                    disabled={busy}
                    title={ts.pushTitle}
                    className="ml-auto flex items-center gap-1 rounded bg-secondary px-2 py-0.5 text-ui-11 font-medium text-on-secondary hover:opacity-90 disabled:opacity-40"
                >
                    <Icon name="add" size={14} />
                    {ts.push}
                </button>
            </div>

            {stashes.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
                    <Icon name="inventory_2" size={30} className="text-on-surface-variant/40" />
                    <p className="text-ui-12 font-medium text-on-surface">{w.emptyTitle}</p>
                    <p className="text-ui-11 text-on-surface-variant/80">{ts.empty}</p>
                </div>
            ) : (
                <div className="min-h-0 flex-1 overflow-y-auto">
                    {stashes.map((s) => (
                        <div
                            key={s.ref}
                            className={`group flex items-start gap-1 border-b border-outline-variant/40 py-1.5 pl-2 pr-1 ${
                                selected === s.ref ? 'bg-primary-container/50' : 'hover:bg-surface-variant/50'
                            }`}
                        >
                            <button
                                onClick={() => onSelect(s.ref)}
                                title={ts.itemTitle({ref: s.ref, branch: s.branch, date: s.date})}
                                className="min-w-0 flex-1 text-left"
                            >
                                <span className="block truncate text-ui-12 text-on-surface">{s.message || w.noMessage}</span>
                                <span className="mt-0.5 flex items-center gap-1.5 text-ui-10 text-on-surface-variant/70">
                                    <span className="font-mono">{s.ref}</span>
                                    <span className="truncate">{s.branch}</span>
                                    <span className="ml-auto shrink-0">{s.date}</span>
                                </span>
                            </button>
                            <span className="flex shrink-0 items-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                                <button
                                    onClick={() => onApply(s.ref, false)}
                                    disabled={busy}
                                    title={ts.applyTitle}
                                    aria-label={ts.apply}
                                    className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-40"
                                >
                                    <Icon name="content_paste" size={14} />
                                </button>
                                <button
                                    onClick={() => onApply(s.ref, true)}
                                    disabled={busy}
                                    title={ts.popTitle}
                                    aria-label={ts.pop}
                                    className="rounded p-0.5 text-primary hover:bg-primary-container/50 disabled:opacity-40"
                                >
                                    <Icon name="content_paste_go" size={14} />
                                </button>
                                <button
                                    onClick={() => onDrop(s.ref)}
                                    disabled={busy}
                                    title={ts.dropTitle}
                                    aria-label={ts.drop}
                                    className="rounded p-0.5 text-error hover:bg-error-container/40 disabled:opacity-40"
                                >
                                    <Icon name="delete" size={14} />
                                </button>
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}
