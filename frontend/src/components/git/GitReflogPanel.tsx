import {useCallback, useEffect, useState} from 'react'
import {GitCreateBranch, GitReflog, GitReset} from '../../../wailsjs/go/main/App'
import {git} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import ConfirmDialog from '../ConfirmDialog'
import PromptDialog from './PromptDialog'
import {formatDateTime, useT} from '../../i18n'

// El reflog: por dónde estuvo HEAD, y la única forma de volver.
//
// **Por qué esta vista existe.** La pestaña ya sabe hacer las operaciones que
// borran trabajo — `reset --hard`, rebase, cambiar de rama con cambios encima,
// `push --force`. El reflog es la red debajo de todas: el commit que
// «desapareció» sigue estando y esto es lo único que lo encuentra. Sin esta
// vista, la salida de un reset equivocado es la línea de comandos, que es
// justamente de lo que este módulo pretende sacar al usuario.
//
// **Recuperar sin volver a romper.** La acción que se ofrece primero es *crear
// una rama* en esa posición: no mueve nada, no toca el árbol de trabajo y deja
// el commit perdido con nombre propio. El `reset --hard` también está, pero
// detrás de una confirmación que dice lo que se pierde — recuperar algo pisando
// otra cosa es el error que sigue al error.

interface Props {
    repoId: string
    onChanged: () => void
    onOpenCommit?: (hash: string) => void
}

// Acciones cuyo nombre ya dice que hubo reescritura: se marcan para que salten
// a la vista cuando uno viene buscando «qué pasó recién».
const DESTRUCTIVAS = new Set(['reset', 'rebase', 'am', 'filter-branch'])

function fecha(iso: string): string {
    if (!iso) return ''
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return formatDateTime(d, {day: '2-digit', month: '2-digit'}) + ' ' + formatDateTime(d, {hour: '2-digit', minute: '2-digit'})
}

export default function GitReflogPanel({repoId, onChanged, onOpenCommit}: Props) {
    const tr = useT().git.reflog
    const [entries, setEntries] = useState<git.ReflogEntry[]>([])
    const [filter, setFilter] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')
    const [branchFrom, setBranchFrom] = useState<git.ReflogEntry | null>(null)
    const [resetTo, setResetTo] = useState<git.ReflogEntry | null>(null)

    const load = useCallback(async () => {
        setLoading(true)
        setError('')
        try {
            setEntries((await GitReflog(repoId, 200)) ?? [])
        } catch (e) {
            setError(String(e))
        } finally {
            setLoading(false)
        }
    }, [repoId])

    useEffect(() => {
        void load()
    }, [load])

    const q = filter.trim().toLowerCase()
    const rows = q
        ? entries.filter(
              (e) =>
                  e.subject.toLowerCase().includes(q) ||
                  e.action.toLowerCase().includes(q) ||
                  e.detail.toLowerCase().includes(q) ||
                  e.short.toLowerCase().includes(q),
          )
        : entries

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-2 py-1">
                <Icon name="search" size={13} className="text-on-surface-variant" />
                <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder={tr.filterPlaceholder}
                    className="min-w-0 flex-1 bg-transparent text-ui-11 text-on-surface outline-none placeholder:text-on-surface-variant/50"
                />
                <span className="shrink-0 text-ui-10 text-on-surface-variant">{rows.length}</span>
                <button
                    onClick={() => void load()}
                    title={tr.reloadTitle}
                    className="shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="refresh" size={13} />
                </button>
            </div>

            {error && <p className="shrink-0 bg-error-container px-2 py-1 text-ui-11 text-on-error-container">{error}</p>}

            <div className="min-h-0 flex-1 overflow-y-auto">
                {loading && rows.length === 0 && <p className="px-2 py-3 text-ui-11 text-on-surface-variant">{tr.loading}</p>}
                {!loading && rows.length === 0 && (
                    <p className="px-2 py-3 text-ui-11 leading-relaxed text-on-surface-variant">
                        {entries.length === 0 ? tr.empty : tr.noMatch}
                    </p>
                )}
                {rows.map((e) => (
                    <div key={e.selector} className="group flex items-start gap-2 border-b border-outline-variant/40 px-2 py-1 text-ui-11 hover:bg-surface-variant/50">
                        <span className="mt-px w-16 shrink-0 font-mono text-ui-10 text-on-surface-variant/60">{e.selector}</span>
                        <button
                            onClick={() => onOpenCommit?.(e.hash)}
                            title={tr.openCommit({hash: e.short})}
                            className="mt-px w-16 shrink-0 text-left font-mono text-ui-10 text-primary hover:underline"
                        >
                            {e.short}
                        </button>
                        <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                                <span
                                    className={`shrink-0 rounded px-1 text-ui-10 ${
                                        DESTRUCTIVAS.has(e.action) ? 'bg-error-container text-on-error-container' : 'bg-surface-variant text-on-surface-variant'
                                    }`}
                                    title={DESTRUCTIVAS.has(e.action) ? tr.destructiveTitle : undefined}
                                >
                                    {e.action}
                                </span>
                                <span className="min-w-0 truncate text-on-surface" title={e.subject}>
                                    {e.subject}
                                </span>
                            </span>
                            {e.detail && (
                                <span className="block truncate text-ui-10 text-on-surface-variant/70" title={e.detail}>
                                    {e.detail}
                                </span>
                            )}
                        </span>
                        <span className="mt-px shrink-0 font-mono text-ui-10 tabular-nums text-on-surface-variant/60">{fecha(e.date)}</span>
                        <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                            <button
                                onClick={() => setBranchFrom(e)}
                                title={tr.branchTitle}
                                className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                            >
                                <Icon name="add_circle" size={13} />
                            </button>
                            <button
                                onClick={() => setResetTo(e)}
                                title={tr.resetTitle}
                                className="rounded p-0.5 text-on-surface-variant hover:bg-error-container hover:text-on-error-container"
                            >
                                <Icon name="undo" size={13} />
                            </button>
                        </span>
                    </div>
                ))}
            </div>

            <p className="shrink-0 border-t border-outline-variant px-2 py-1.5 text-ui-10 leading-relaxed text-on-surface-variant/70">
                {tr.footer.before}
                <span className="font-medium">{tr.footer.strong}</span>
                {tr.footer.after}
            </p>

            {branchFrom && (
                <PromptDialog
                    title={tr.branchDialog.title}
                    label={tr.branchDialog.label}
                    initial={tr.branchDialog.initial({hash: branchFrom.short})}
                    confirmLabel={tr.branchDialog.confirm}
                    onSubmit={(value) => {
                        const target = branchFrom
                        setBranchFrom(null)
                        if (!value.trim()) return
                        void GitCreateBranch(repoId, value.trim(), target.hash, false)
                            .then(onChanged)
                            .catch((err) => setError(String(err)))
                    }}
                    onClose={() => setBranchFrom(null)}
                />
            )}

            {resetTo && (
                <ConfirmDialog
                    title={tr.resetDialog.title}
                    description={tr.resetDialog.description({hash: resetTo.short, subject: resetTo.subject})}
                    confirmLabel={tr.resetDialog.confirm}
                    danger
                    onConfirm={() => {
                        void GitReset(repoId, resetTo.hash, 'hard')
                            .then(() => {
                                onChanged()
                                return load()
                            })
                            .catch((err) => setError(String(err)))
                    }}
                    onClose={() => setResetTo(null)}
                />
            )}
        </div>
    )
}
