import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {GitConflictedFiles, GitReadConflictFile, GitResolveConflictFile} from '../../../wailsjs/go/main/App'
import Icon from '../Icon'
import {
    conflictCount,
    isFullyResolved,
    parseConflicts,
    renderResolved,
    resolvedCount,
    type ConflictBlock,
    type FileBlock,
} from '../../lib/gitConflict'

interface GitConflictResolverProps {
    repoId: string
    // operation is what GitInProgress reported ("merge", "rebase", …) — it
    // decides both the wording and which --continue to run.
    operation: string
    busy: boolean
    onContinue: () => void
    onAbort: () => void
    onResolved: () => void
    onClose: () => void
    // Le pasa el conflicto abierto al agente, en el chat. Ausente = no hay
    // ningún agente con chat verificado instalado.
    //
    // Deliberadamente NO se le pide al agente el contenido resuelto para
    // volcarlo en el editor: eso exigiría que devuelva el archivo entero,
    // exacto, y un merge mal reconstruido se ve idéntico a uno bien hecho
    // hasta que alguien corre el código. Que explique el conflicto y proponga
    // un criterio es útil; que escriba el resultado sin que nadie lo compare
    // línea por línea, no.
    onAsk?: (path: string) => void
}

// Three-way conflict resolver.
//
// The pane labels are the part that earns its keep. In a MERGE, "ours" is
// the branch you are on; in a REBASE it is the upstream you are replaying
// ONTO, so the sides are swapped relative to what almost everyone expects.
// Getting that backwards means confidently keeping the wrong version, so the
// panes are labelled for the operation actually in progress instead of with
// the raw git words.
export default function GitConflictResolver({
    repoId,
    operation,
    busy,
    onContinue,
    onAbort,
    onResolved,
    onClose,
    onAsk,
}: GitConflictResolverProps) {
    const [files, setFiles] = useState<string[]>([])
    const [path, setPath] = useState<string | null>(null)
    const [blocks, setBlocks] = useState<FileBlock[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')
    const [current, setCurrent] = useState(0)
    const blockRefs = useRef<(HTMLDivElement | null)[]>([])

    const loadFiles = useCallback(async () => {
        try {
            const list = await GitConflictedFiles(repoId)
            setFiles(list ?? [])
            setPath((prev) => (prev && (list ?? []).includes(prev) ? prev : ((list ?? [])[0] ?? null)))
        } catch (e) {
            setError(String(e))
        }
    }, [repoId])

    useEffect(() => {
        void loadFiles()
    }, [loadFiles])

    useEffect(() => {
        if (!path) {
            setBlocks([])
            return
        }
        let cancelled = false
        setLoading(true)
        setError('')
        GitReadConflictFile(repoId, path)
            .then((content) => {
                if (cancelled) return
                setBlocks(parseConflicts(content ?? ''))
                setCurrent(0)
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
    }, [repoId, path])

    const conflicts = useMemo(
        () => blocks.map((b, i) => ({block: b, index: i})).filter((x): x is {block: ConflictBlock; index: number} => x.block.kind === 'conflict'),
        [blocks],
    )
    const total = conflictCount(blocks)
    const done = resolvedCount(blocks)

    function resolve(blockIndex: number, resolution: ConflictBlock['resolution']) {
        setBlocks((prev) => prev.map((b, i) => (i === blockIndex && b.kind === 'conflict' ? {...b, resolution} : b)))
    }

    function goTo(n: number) {
        if (conflicts.length === 0) return
        const clamped = Math.max(0, Math.min(conflicts.length - 1, n))
        setCurrent(clamped)
        blockRefs.current[conflicts[clamped].index]?.scrollIntoView({block: 'center', behavior: 'smooth'})
    }

    // Alt+N / Alt+P jump between conflicts without reaching for the mouse —
    // in a file with a dozen of them, scrolling to find the next one is most
    // of the work.
    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            if (!e.altKey) return
            if (e.key === 'n' || e.key === 'N') {
                e.preventDefault()
                goTo(current + 1)
            }
            if (e.key === 'p' || e.key === 'P') {
                e.preventDefault()
                goTo(current - 1)
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    })

    async function markResolved() {
        if (!path) return
        try {
            await GitResolveConflictFile(repoId, path, renderResolved(blocks))
            await loadFiles()
            onResolved()
        } catch (e) {
            setError(String(e))
        }
    }

    const isRebase = operation === 'rebase'
    // In a rebase the sides are swapped relative to a merge: "ours" is the
    // branch being replayed onto, "theirs" is the commit being replayed.
    const oursLabel = isRebase ? 'La rama sobre la que estás rebasando' : 'Tu rama (actual)'
    const theirsLabel = isRebase ? 'El commit que se está reaplicando' : 'La rama que entra'

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-outline-variant bg-error-container/30 px-3 py-1.5 text-xs">
                <Icon name="merge_type" size={15} className="shrink-0 text-error" />
                <span className="font-semibold text-on-surface">
                    {operation === 'merge' ? 'Merge' : operation === 'rebase' ? 'Rebase' : operation} con conflictos
                </span>
                <span className="text-on-surface-variant">
                    {files.length} {files.length === 1 ? 'archivo' : 'archivos'} sin resolver
                </span>

                <div className="ml-auto flex items-center gap-1.5">
                    <button
                        onClick={onContinue}
                        disabled={busy || files.length > 0}
                        title={
                            files.length > 0
                                ? `Todavía quedan ${files.length} archivo(s) con conflictos. Resolvelos y marcalos para poder continuar.`
                                : `Continúa el ${operation} con las resoluciones ya marcadas`
                        }
                        className="rounded bg-primary px-2.5 py-1 text-on-primary disabled:opacity-40"
                    >
                        Continuar {operation}
                    </button>
                    {onAsk && path && (
                        <button
                            onClick={() => onAsk(path)}
                            title="Le pide al agente que explique este conflicto y proponga un criterio para resolverlo. No escribe el archivo: la resolución la elegís y la marcás vos."
                            className="flex items-center gap-1 rounded px-2 py-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                        >
                            <Icon name="smart_toy" size={14} />
                            Consultar
                        </button>
                    )}
                    <button
                        onClick={onAbort}
                        disabled={busy}
                        title={`Cancela el ${operation} y deja el repositorio como estaba antes de empezarlo`}
                        className="rounded px-2 py-1 text-error hover:bg-error-container disabled:opacity-40"
                    >
                        Abortar
                    </button>
                    <button onClick={onClose} title="Cierra el resolutor" className="rounded p-0.5 text-on-surface-variant hover:text-on-surface">
                        <Icon name="close" size={16} />
                    </button>
                </div>
            </div>

            <div className="flex min-h-0 flex-1">
                <div className="w-56 shrink-0 overflow-y-auto border-r border-outline-variant">
                    {files.length === 0 ? (
                        <p className="p-3 text-ui-11 text-on-surface-variant">
                            No quedan archivos con conflictos. Ya podés continuar el {operation}.
                        </p>
                    ) : (
                        files.map((f) => (
                            <button
                                key={f}
                                onClick={() => setPath(f)}
                                title={f}
                                className={`flex w-full items-center gap-1.5 border-b border-outline-variant/40 px-2 py-1.5 text-left text-ui-11 ${
                                    path === f ? 'bg-error-container/50 text-on-error-container' : 'text-on-surface hover:bg-surface-variant/50'
                                }`}
                            >
                                <Icon name="warning" size={12} className="shrink-0 text-error" />
                                <span className="min-w-0 flex-1 truncate font-mono">{f}</span>
                            </button>
                        ))
                    )}
                </div>

                <div className="flex min-w-0 flex-1 flex-col">
                    {path && (
                        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-outline-variant px-2 py-1 text-ui-11">
                            <span className="min-w-0 truncate font-mono text-on-surface-variant">{path}</span>
                            <span
                                className={done === total ? 'text-secondary' : 'text-tertiary'}
                                title="Bloques de conflicto resueltos sobre el total de este archivo"
                            >
                                Conflicto {total === 0 ? 0 : Math.min(current + 1, total)} de {total} · {done} resueltos
                            </span>
                            <div className="ml-auto flex items-center gap-1">
                                <button
                                    onClick={() => goTo(current - 1)}
                                    disabled={conflicts.length === 0}
                                    title="Conflicto anterior (Alt+P)"
                                    className="rounded p-0.5 text-on-surface-variant hover:text-on-surface disabled:opacity-30"
                                >
                                    <Icon name="arrow_upward" size={14} />
                                </button>
                                <button
                                    onClick={() => goTo(current + 1)}
                                    disabled={conflicts.length === 0}
                                    title="Conflicto siguiente (Alt+N)"
                                    className="rounded p-0.5 text-on-surface-variant hover:text-on-surface disabled:opacity-30"
                                >
                                    <Icon name="arrow_downward" size={14} />
                                </button>
                                <button
                                    onClick={() => void markResolved()}
                                    disabled={busy || !isFullyResolved(blocks)}
                                    title={
                                        isFullyResolved(blocks)
                                            ? 'Guarda el archivo resuelto y lo marca como resuelto (lo agrega al stage)'
                                            : 'Todavía quedan bloques sin decidir. Un archivo guardado con marcadores queda roto y git lo sigue viendo como conflictivo.'
                                    }
                                    className="rounded bg-primary px-2 py-0.5 text-on-primary disabled:opacity-40"
                                >
                                    Marcar como resuelto
                                </button>
                            </div>
                        </div>
                    )}

                    {error && <p className="px-2 py-1 text-ui-11 text-error">{error}</p>}
                    {loading && <p className="px-2 py-2 text-xs text-on-surface-variant">Cargando el archivo…</p>}

                    <div className="min-h-0 flex-1 overflow-auto p-2 font-mono text-ui-11 leading-relaxed">
                        {blocks.map((block, i) =>
                            block.kind === 'text' ? (
                                <pre key={i} className="whitespace-pre-wrap break-all text-on-surface-variant/70">
                                    {block.lines.join('\n')}
                                </pre>
                            ) : (
                                <div
                                    key={i}
                                    ref={(el) => {
                                        blockRefs.current[i] = el
                                    }}
                                    className={`my-2 rounded border ${
                                        block.resolution === 'unresolved' ? 'border-error/50' : 'border-secondary/50'
                                    }`}
                                >
                                    <div className="flex flex-wrap items-center gap-1 border-b border-outline-variant/50 bg-surface-container px-1.5 py-1 font-sans text-ui-10">
                                        <span className={block.resolution === 'unresolved' ? 'text-error' : 'text-secondary'}>
                                            {block.resolution === 'unresolved' ? 'Sin resolver' : 'Resuelto'}
                                        </span>
                                        <div className="ml-auto flex flex-wrap gap-1">
                                            <ChoiceButton
                                                active={block.resolution === 'ours'}
                                                onClick={() => resolve(i, 'ours')}
                                                label="Quedarme con la mía"
                                                title={`Aplica solo ${oursLabel.toLowerCase()}`}
                                            />
                                            <ChoiceButton
                                                active={block.resolution === 'theirs'}
                                                onClick={() => resolve(i, 'theirs')}
                                                label="Aceptar la entrante"
                                                title={`Aplica solo ${theirsLabel.toLowerCase()}`}
                                            />
                                            <ChoiceButton
                                                active={block.resolution === 'both'}
                                                onClick={() => resolve(i, 'both')}
                                                label="Ambas"
                                                title="Conserva los dos bloques, primero el tuyo y después el entrante"
                                            />
                                            {block.resolution !== 'unresolved' && (
                                                <ChoiceButton
                                                    active={false}
                                                    onClick={() => resolve(i, 'unresolved')}
                                                    label="Deshacer"
                                                    title="Vuelve a dejar este bloque sin decidir"
                                                />
                                            )}
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 divide-x divide-outline-variant/40">
                                        <Side
                                            title={oursLabel}
                                            detail={block.oursLabel}
                                            lines={block.ours}
                                            tone="ours"
                                            dimmed={block.resolution === 'theirs'}
                                        />
                                        <Side
                                            title={theirsLabel}
                                            detail={block.theirsLabel}
                                            lines={block.theirs}
                                            tone="theirs"
                                            dimmed={block.resolution === 'ours'}
                                        />
                                    </div>

                                    {block.base.length > 0 && (
                                        <div className="border-t border-outline-variant/40">
                                            <Side title="Ancestro común" detail="antes de que las dos ramas lo tocaran" lines={block.base} tone="base" />
                                        </div>
                                    )}
                                </div>
                            ),
                        )}
                    </div>
                </div>
            </div>
        </div>
    )
}

function ChoiceButton({active, onClick, label, title}: {active: boolean; onClick: () => void; label: string; title: string}) {
    return (
        <button
            onClick={onClick}
            title={title}
            className={`rounded px-1.5 py-0.5 ${active ? 'bg-primary text-on-primary' : 'border border-outline-variant text-on-surface hover:bg-surface-variant'}`}
        >
            {label}
        </button>
    )
}

function Side({
    title,
    detail,
    lines,
    tone,
    dimmed,
}: {
    title: string
    detail: string
    lines: string[]
    tone: 'ours' | 'theirs' | 'base'
    dimmed?: boolean
}) {
    const bg = tone === 'ours' ? 'bg-primary/5' : tone === 'theirs' ? 'bg-secondary/5' : 'bg-surface-variant/30'
    return (
        <div className={`${bg} ${dimmed ? 'opacity-40' : ''} p-1.5`}>
            <div className="mb-0.5 font-sans text-ui-10 text-on-surface-variant" title={detail}>
                {title}
                {detail && <span className="ml-1 opacity-60">({detail})</span>}
            </div>
            <pre className="whitespace-pre-wrap break-all text-on-surface">{lines.length > 0 ? lines.join('\n') : '(vacío)'}</pre>
        </div>
    )
}
