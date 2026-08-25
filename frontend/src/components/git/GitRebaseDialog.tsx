import {useEffect, useState} from 'react'
import {GitRebaseApply, GitRebaseTodo} from '../../../wailsjs/go/main/App'
import {git} from '../../../wailsjs/go/models'
import Icon from '../Icon'

const ACTIONS: {value: string; label: string; hint: string}[] = [
    {value: 'pick', label: 'pick — dejarlo como está', hint: 'Aplica el commit sin cambios'},
    {value: 'reword', label: 'reword — cambiar el mensaje', hint: 'Aplica el commit y frena para que edites su mensaje'},
    {value: 'edit', label: 'edit — frenar para editarlo', hint: 'Aplica el commit y frena el rebase para que modifiques el contenido'},
    {value: 'squash', label: 'squash — combinar con el anterior', hint: 'Funde este commit en el de arriba, conservando los dos mensajes'},
    {value: 'fixup', label: 'fixup — combinar y descartar el mensaje', hint: 'Como squash, pero tira el mensaje de este commit'},
    {value: 'drop', label: 'drop — eliminarlo', hint: 'Descarta el commit por completo'},
]

interface GitRebaseDialogProps {
    repoId: string
    // base is the commit the rebase replays onto — everything AFTER it is
    // rewritten.
    base: string
    baseLabel: string
    onClose: () => void
    onDone: () => void
}

// Interactive rebase, as a list you reorder instead of a file you edit.
//
// The list is shown OLDEST FIRST, matching git's own todo file, and the
// header says so. Showing it newest-first like the graph and then quietly
// reversing is the single most destructive way this feature can go wrong:
// "squash into the one above" would mean the opposite of what the screen
// shows.
export default function GitRebaseDialog({repoId, base, baseLabel, onClose, onDone}: GitRebaseDialogProps) {
    const [actions, setActions] = useState<git.RebaseAction[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [applying, setApplying] = useState(false)

    useEffect(() => {
        let cancelled = false
        GitRebaseTodo(repoId, base)
            .then((todo) => {
                if (!cancelled) setActions(todo ?? [])
            })
            .catch((e) => {
                if (!cancelled) setError(String(e))
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [repoId, base])

    function move(i: number, delta: number) {
        const target = i + delta
        if (target < 0 || target >= actions.length) return
        const next = [...actions]
        ;[next[i], next[target]] = [next[target], next[i]]
        setActions(next)
    }

    function setCommand(i: number, command: string) {
        setActions((prev) => prev.map((a, idx) => (idx === i ? new git.RebaseAction({...a, command}) : a)))
    }

    async function apply() {
        setApplying(true)
        setError('')
        try {
            await GitRebaseApply(repoId, base, actions)
            onDone()
            onClose()
        } catch (e) {
            setError(String(e))
        } finally {
            setApplying(false)
        }
    }

    const kept = actions.filter((a) => a.command !== 'drop').length
    // git refuses a todo starting with squash/fixup — there is nothing above
    // to fold into. Surfaced here so the button explains itself instead of
    // failing after the rebase already started.
    const firstIsFold = actions[0] && (actions[0].command === 'squash' || actions[0].command === 'fixup')
    const willStop = actions.some((a) => a.command === 'reword' || a.command === 'edit')

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
            <div
                className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center gap-2 border-b border-outline-variant px-4 py-2.5">
                    <Icon name="low_priority" size={16} className="shrink-0 text-primary" />
                    <h2 className="text-sm font-semibold text-on-surface">Reordenar y combinar commits</h2>
                    <button onClick={onClose} title="Cierra sin cambiar nada" className="ml-auto text-on-surface-variant hover:text-on-surface">
                        <Icon name="close" size={18} />
                    </button>
                </div>

                <div className="border-b border-outline-variant bg-error-container/30 px-4 py-2 text-ui-11 text-on-surface">
                    <p>
                        Esto <strong>reescribe la historia</strong> desde <span className="font-mono">{baseLabel}</span> en adelante: cada commit
                        recibe un hash nuevo. Si la rama ya está publicada, después vas a necesitar un push forzado.
                    </p>
                    <p className="mt-0.5 text-on-surface-variant">
                        La lista va del <strong>más viejo al más nuevo</strong>, igual que el archivo de git — al revés que el grafo. «Combinar con el
                        anterior» se refiere al de arriba.
                    </p>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                    {loading && <p className="text-xs text-on-surface-variant">Cargando los commits…</p>}
                    {!loading && actions.length === 0 && (
                        <p className="text-xs text-on-surface-variant">No hay commits entre {baseLabel} y la rama actual.</p>
                    )}

                    {actions.map((a, i) => (
                        <div
                            key={a.hash}
                            className={`mb-1 flex items-center gap-1.5 rounded border px-1.5 py-1 text-ui-11 ${
                                a.command === 'drop' ? 'border-error/40 bg-error/5 opacity-60' : 'border-outline-variant bg-surface-container-low/40'
                            }`}
                        >
                            <span className="w-5 shrink-0 text-center font-mono text-ui-10 text-on-surface-variant/60">{i + 1}</span>
                            <button
                                onClick={() => move(i, -1)}
                                disabled={i === 0}
                                title="Mover este commit más arriba (más viejo)"
                                className="shrink-0 text-on-surface-variant hover:text-on-surface disabled:opacity-30"
                            >
                                <Icon name="arrow_upward" size={14} />
                            </button>
                            <button
                                onClick={() => move(i, 1)}
                                disabled={i === actions.length - 1}
                                title="Mover este commit más abajo (más nuevo)"
                                className="shrink-0 text-on-surface-variant hover:text-on-surface disabled:opacity-30"
                            >
                                <Icon name="arrow_downward" size={14} />
                            </button>

                            <select
                                value={a.command}
                                onChange={(e) => setCommand(i, e.target.value)}
                                title={ACTIONS.find((x) => x.value === a.command)?.hint}
                                className="w-56 shrink-0 rounded border border-outline-variant bg-surface-container-low px-1 py-0.5 text-on-surface"
                            >
                                {ACTIONS.map((x) => (
                                    <option key={x.value} value={x.value} title={x.hint}>
                                        {x.label}
                                    </option>
                                ))}
                            </select>

                            <span className="shrink-0 font-mono text-ui-10 text-on-surface-variant/70">{a.hash.slice(0, 7)}</span>
                            <span className={`min-w-0 flex-1 truncate ${a.command === 'drop' ? 'line-through' : ''}`} title={a.subject}>
                                {a.subject}
                            </span>
                        </div>
                    ))}
                </div>

                <div className="border-t border-outline-variant p-3 text-xs">
                    {error && <p className="mb-2 whitespace-pre-wrap rounded border border-error/40 bg-error/10 p-2 text-error">{error}</p>}
                    {firstIsFold && (
                        <p className="mb-2 text-tertiary">
                            El primero de la lista no puede combinarse con el anterior: no hay ninguno arriba.
                        </p>
                    )}
                    {willStop && (
                        <p className="mb-2 text-on-surface-variant">
                            Con «reword» o «edit» el rebase va a frenar en ese commit para que hagas el cambio y después continúes.
                        </p>
                    )}

                    <div className="flex items-center gap-2">
                        <span className="text-on-surface-variant">
                            {kept} de {actions.length} commits quedan
                        </span>
                        <div className="ml-auto flex gap-2">
                            <button onClick={onClose} className="rounded px-3 py-1.5 text-on-surface-variant hover:text-on-surface">
                                Cancelar
                            </button>
                            <button
                                onClick={() => void apply()}
                                disabled={applying || loading || actions.length === 0 || firstIsFold}
                                title="Aplica el rebase con esta lista. Si aparece un conflicto, se abre el resolutor."
                                className="rounded bg-primary px-3 py-1.5 text-on-primary disabled:opacity-40"
                            >
                                {applying ? 'Aplicando…' : 'Aplicar'}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}
