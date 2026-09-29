import {useMemo, useState} from 'react'
import Icon from '../Icon'
import {parseGitOutput, type StatFile, type StatFileKind} from '../../lib/gitOutputSummary'
import {useT} from '../../i18n'

// GitOutputNotice muestra la salida de una operación de git (pull, merge…).
//
// Antes era un <pre> sin tope de alto: un pull de 150 archivos empujaba toda
// la pestaña fuera de la pantalla y el grafo quedaba inalcanzable hasta cerrar
// el mensaje. Ahora, cuando la salida trae diffstat, se resume en una línea
// (rango, fast-forward, archivos y +/−) y la lista de archivos se despliega a
// pedido, con alto acotado, filtro y clic para abrir cada archivo. Una salida
// sin diffstat se muestra como texto, también con alto acotado.

const kindStyle: Record<StatFileKind, {letter: string; cls: string}> = {
    added: {letter: 'A', cls: 'text-secondary'},
    deleted: {letter: 'D', cls: 'text-error'},
    renamed: {letter: 'R', cls: 'text-tertiary'},
    modified: {letter: 'M', cls: 'text-primary'},
}

// Con más archivos que esto aparece el filtro: por debajo, se leen de un vistazo.
const FILTER_FROM = 12

export default function GitOutputNotice({
    text,
    onClose,
    onOpenFile,
    onRevealCommit,
}: {
    text: string
    onClose: () => void
    onOpenFile?: (path: string) => void
    onRevealCommit?: (hash: string) => void
}) {
    const to = useT().git.output
    const summary = useMemo(() => parseGitOutput(text), [text])
    const [expanded, setExpanded] = useState(false)
    const [showRaw, setShowRaw] = useState(false)
    const [filter, setFilter] = useState('')
    const [copied, setCopied] = useState(false)

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(text)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
        } catch {
            // Sin permiso de portapapeles no hay nada útil que avisar.
        }
    }

    const actions = (
        <>
            <button
                onClick={() => void copy()}
                title={to.copyTitle}
                className="shrink-0 rounded p-0.5 hover:bg-surface-variant/50"
            >
                <Icon name={copied ? 'check' : 'content_copy'} size={14} />
            </button>
            <button onClick={onClose} title={to.closeTitle} className="shrink-0 rounded p-0.5 hover:bg-surface-variant/50">
                <Icon name="close" size={14} />
            </button>
        </>
    )

    if (!summary) {
        return (
            <div className="flex shrink-0 items-start gap-2 border-b border-outline-variant bg-surface-container px-3 py-1.5 text-ui-11 text-on-surface-variant">
                <Icon name="info" size={14} className="mt-px shrink-0" />
                <pre className="max-h-[30vh] min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words font-mono">{text}</pre>
                {actions}
            </div>
        )
    }

    const {files, totals, range, fastForward, other} = summary
    const counts = files.reduce(
        (acc, f) => ({...acc, [f.kind]: acc[f.kind] + 1}),
        {added: 0, deleted: 0, renamed: 0, modified: 0} as Record<StatFileKind, number>,
    )
    const maxChanges = Math.max(1, ...files.map((f) => f.changes ?? 0))
    const q = filter.trim().toLowerCase()
    const visible = q ? files.filter((f) => f.path.toLowerCase().includes(q) || f.from?.toLowerCase().includes(q)) : files

    return (
        <div className="flex max-h-[45vh] shrink-0 flex-col border-b border-outline-variant bg-surface-container text-ui-11 text-on-surface-variant">
            <div className="flex min-w-0 items-center gap-2 px-3 py-1.5">
                <Icon name="download" size={14} className="shrink-0 text-secondary" />
                <button
                    onClick={() => setExpanded((v) => !v)}
                    data-pull-notice-toggle
                    title={expanded ? to.hideFiles : to.showFiles}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded text-left hover:text-on-surface"
                >
                    <span className="shrink-0 font-medium text-on-surface">
                        {to.filesUpdated(totals.files)}
                    </span>
                    <span className="shrink-0 font-mono">
                        <span className="text-secondary">+{totals.insertions}</span>{' '}
                        <span className="text-error">−{totals.deletions}</span>
                    </span>
                    <span className="hidden min-w-0 truncate md:inline">
                        {(['added', 'modified', 'renamed', 'deleted'] as StatFileKind[])
                            .filter((k) => counts[k] > 0)
                            .map((k) => to.kindCount[k](counts[k]))
                            .join(' · ')}
                    </span>
                    <Icon
                        name="expand_more"
                        size={16}
                        className={`ml-auto shrink-0 transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`}
                    />
                </button>
                {fastForward && (
                    <span className="shrink-0 rounded-full bg-secondary-container px-1.5 py-px text-on-secondary-container">{to.fastForward}</span>
                )}
                {range && (
                    <button
                        onClick={() => onRevealCommit?.(range.to)}
                        disabled={!onRevealCommit}
                        title={to.revealTitle({hash: range.to})}
                        className="shrink-0 rounded px-1 font-mono hover:bg-surface-variant/50 hover:text-on-surface"
                    >
                        {range.from.slice(0, 7)} → {range.to.slice(0, 7)}
                    </button>
                )}
                {actions}
            </div>

            {expanded && (
                <div className="flex min-h-0 flex-col border-t border-outline-variant">
                    {files.length > FILTER_FROM && (
                        <div className="flex items-center gap-2 px-3 py-1">
                            <Icon name="search" size={14} className="shrink-0" />
                            <input
                                autoFocus
                                value={filter}
                                onChange={(e) => setFilter(e.target.value)}
                                onKeyDown={(e) => e.key === 'Escape' && (filter ? setFilter('') : setExpanded(false))}
                                placeholder={to.filterPlaceholder(files.length)}
                                className="min-w-0 flex-1 bg-transparent py-0.5 text-on-surface outline-none placeholder:text-on-surface-variant/70"
                            />
                            {q && (
                                <span className="shrink-0">
                                    {to.filterCount({visible: visible.length, total: files.length})}
                                </span>
                            )}
                        </div>
                    )}
                    <ul className="min-h-0 flex-1 overflow-auto py-0.5">
                        {visible.map((f) => (
                            <FileRow key={f.path} file={f} maxChanges={maxChanges} onOpen={onOpenFile} />
                        ))}
                        {visible.length === 0 && <li className="px-3 py-1 italic">{to.noMatch({filter})}</li>}
                    </ul>
                    <div className="flex items-center gap-3 border-t border-outline-variant px-3 py-1">
                        <button onClick={() => setShowRaw((v) => !v)} className="rounded hover:text-on-surface">
                            {showRaw ? to.hideRaw : to.showRaw}
                        </button>
                        {other.length > 0 && !showRaw && <span className="min-w-0 truncate font-mono">{other[other.length - 1]}</span>}
                    </div>
                    {showRaw && (
                        <pre className="max-h-40 shrink-0 overflow-auto whitespace-pre-wrap break-words border-t border-outline-variant px-3 py-1 font-mono">
                            {text}
                        </pre>
                    )}
                </div>
            )}
        </div>
    )
}

function FileRow({file, maxChanges, onOpen}: {file: StatFile; maxChanges: number; onOpen?: (path: string) => void}) {
    const to = useT().git.output
    const k = kindStyle[file.kind]
    const slash = file.path.lastIndexOf('/')
    const dir = slash >= 0 ? file.path.slice(0, slash + 1) : ''
    const base = file.path.slice(slash + 1)
    // Un archivo borrado ya no existe en el árbol: no hay nada que abrir.
    const canOpen = !!onOpen && file.kind !== 'deleted'
    const width = file.changes ? Math.max(4, Math.round((file.changes / maxChanges) * 48)) : 0
    const addW = file.changes ? Math.round((width * file.insertions) / file.changes) : 0

    return (
        <li>
            <button
                disabled={!canOpen}
                onClick={() => canOpen && onOpen(file.path)}
                title={canOpen ? to.openTitle({path: file.path}) : file.path}
                className="group flex w-full min-w-0 items-center gap-2 px-3 py-[3px] text-left enabled:hover:bg-surface-variant/50"
            >
                <span title={to.kind[file.kind]} className={`w-3 shrink-0 text-center font-mono font-semibold ${k.cls}`}>
                    {k.letter}
                </span>
                <span className="flex min-w-0 flex-1 items-baseline font-mono">
                    {file.from && (
                        // En un renombre dentro de la misma carpeta basta el nombre viejo.
                        <span className="mr-1 max-w-[40%] shrink-0 truncate line-through opacity-70">
                            {file.from.startsWith(dir) ? file.from.slice(dir.length) : file.from} →
                        </span>
                    )}
                    <span className="min-w-0 truncate [direction:rtl] text-left">
                        {/* rtl recorta por la izquierda: si no entra, se pierde el
                            principio de la carpeta, nunca el nombre del archivo. */}
                        <bdi>
                            <span className="opacity-70">{dir}</span>
                            <span className={`text-on-surface ${file.kind === 'deleted' ? 'line-through' : ''}`}>{base}</span>
                        </bdi>
                    </span>
                </span>
                {file.binary !== undefined ? (
                    <span className="shrink-0 font-mono opacity-80">{file.binary ? to.binDetail({detail: file.binary}) : to.binary}</span>
                ) : (
                    <>
                        <span className="w-10 shrink-0 text-right font-mono tabular-nums">{file.changes}</span>
                        <span className="flex h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-surface-variant">
                            <span className="h-full bg-secondary" style={{width: addW}} />
                            <span className="h-full bg-error" style={{width: width - addW}} />
                        </span>
                    </>
                )}
            </button>
        </li>
    )
}
