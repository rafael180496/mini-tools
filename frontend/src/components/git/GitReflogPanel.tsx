import {useCallback, useEffect, useState} from 'react'
import {GitCreateBranch, GitReflog, GitReset} from '../../../wailsjs/go/main/App'
import {git} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import ConfirmDialog from '../ConfirmDialog'
import PromptDialog from './PromptDialog'

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
    return d.toLocaleDateString(undefined, {day: '2-digit', month: '2-digit'}) + ' ' +
        d.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'})
}

export default function GitReflogPanel({repoId, onChanged, onOpenCommit}: Props) {
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
                    placeholder="Filtrar por mensaje, acción o hash"
                    className="min-w-0 flex-1 bg-transparent text-[11px] text-on-surface outline-none placeholder:text-on-surface-variant/50"
                />
                <span className="shrink-0 text-[10px] text-on-surface-variant">{rows.length}</span>
                <button
                    onClick={() => void load()}
                    title="Volver a leer el reflog"
                    className="shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="refresh" size={13} />
                </button>
            </div>

            {error && <p className="shrink-0 bg-error-container px-2 py-1 text-[11px] text-on-error-container">{error}</p>}

            <div className="min-h-0 flex-1 overflow-y-auto">
                {loading && rows.length === 0 && <p className="px-2 py-3 text-[11px] text-on-surface-variant">Leyendo…</p>}
                {!loading && rows.length === 0 && (
                    <p className="px-2 py-3 text-[11px] leading-relaxed text-on-surface-variant">
                        {entries.length === 0
                            ? 'Este repositorio todavía no tiene movimientos de HEAD.'
                            : 'Ningún movimiento coincide con el filtro.'}
                    </p>
                )}
                {rows.map((e) => (
                    <div key={e.selector} className="group flex items-start gap-2 border-b border-outline-variant/40 px-2 py-1 text-[11px] hover:bg-surface-variant/50">
                        <span className="mt-px w-16 shrink-0 font-mono text-[10px] text-on-surface-variant/60">{e.selector}</span>
                        <button
                            onClick={() => onOpenCommit?.(e.hash)}
                            title={`Ver el commit ${e.short}`}
                            className="mt-px w-16 shrink-0 text-left font-mono text-[10px] text-primary hover:underline"
                        >
                            {e.short}
                        </button>
                        <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                                <span
                                    className={`shrink-0 rounded px-1 text-[10px] ${
                                        DESTRUCTIVAS.has(e.action) ? 'bg-error-container text-on-error-container' : 'bg-surface-variant text-on-surface-variant'
                                    }`}
                                    title={DESTRUCTIVAS.has(e.action) ? 'Esta acción reescribió historia: es de las que dejan commits sin referencia' : undefined}
                                >
                                    {e.action}
                                </span>
                                <span className="min-w-0 truncate text-on-surface" title={e.subject}>
                                    {e.subject}
                                </span>
                            </span>
                            {e.detail && (
                                <span className="block truncate text-[10px] text-on-surface-variant/70" title={e.detail}>
                                    {e.detail}
                                </span>
                            )}
                        </span>
                        <span className="mt-px shrink-0 font-mono text-[10px] tabular-nums text-on-surface-variant/60">{fecha(e.date)}</span>
                        <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                            <button
                                onClick={() => setBranchFrom(e)}
                                title="Crear una rama en esta posición. Es la forma segura de recuperar: no mueve nada de lo que tenés ahora y le da nombre propio al commit perdido."
                                className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                            >
                                <Icon name="add_circle" size={13} />
                            </button>
                            <button
                                onClick={() => setResetTo(e)}
                                title="Mover la rama actual a esta posición con reset --hard. Recupera esto, pero descarta lo que tengas sin commitear."
                                className="rounded p-0.5 text-on-surface-variant hover:bg-error-container hover:text-on-error-container"
                            >
                                <Icon name="undo" size={13} />
                            </button>
                        </span>
                    </div>
                ))}
            </div>

            <p className="shrink-0 border-t border-outline-variant px-2 py-1.5 text-[10px] leading-relaxed text-on-surface-variant/70">
                El reflog es <span className="font-medium">local y temporal</span>: no se clona, no se empuja, y git lo poda solo (90 días lo alcanzable, 30
                lo que no). Sirve para recuperar lo de ayer, no como historial.
            </p>

            {branchFrom && (
                <PromptDialog
                    title="Crear una rama acá"
                    label="Nombre de la rama"
                    initial={`recupero-${branchFrom.short}`}
                    confirmLabel="Crear"
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
                    title="Mover la rama actual acá"
                    description={`La rama actual va a quedar en ${resetTo.short} («${resetTo.subject}»). Todo lo que tengas sin commitear se pierde, y los commits que queden por delante solo van a ser alcanzables desde este mismo reflog. Si lo único que querés es recuperar ese commit, creá una rama en vez de esto.`}
                    confirmLabel="Reset --hard"
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
