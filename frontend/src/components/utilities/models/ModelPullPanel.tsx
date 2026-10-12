import {useState, type FormEvent} from 'react'
import type {main} from '../../../../wailsjs/go/models'
import {BrowserOpenURL} from '../../../../wailsjs/runtime'
import Icon from '../../Icon'
import {errorText, formatNumber, useT} from '../../../i18n'
import type {Dict} from '../../../i18n'
import {formatModelSize, hostOf, isValidModelName} from './modelFormat'
import type {Pull} from './useModelPulls'

// Descargar un modelo (ollama pull) y seguir las descargas en curso.
//
// Es el formulario de arriba más la lista de descargas. La lista muestra las de
// TODOS los servidores, no solo la del elegido: una descarga sigue corriendo si
// se cambia de servidor en el selector, y esconderla sería perderla de vista.

const CATALOG_URL = 'https://ollama.com/library'

// Ejemplos con nombres reales y chicos: sirven para ver cómo se escribe un
// nombre, no para recomendar.
const EXAMPLES = ['llama3.2:3b', 'qwen2.5-coder:7b', 'gemma3:1b', 'nomic-embed-text'] as const

interface FormProps {
    server: main.ModelServer
    onStart: (name: string) => Promise<void>
}

export function ModelPullForm({server, onStart}: FormProps) {
    const t = useT()
    const L = t.models.pull
    const [name, setName] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    const trimmed = name.trim()
    const valid = isValidModelName(trimmed)
    const buttonTitle = busy ? L.buttonStarting : !trimmed ? L.buttonNeedsName : !valid ? L.buttonInvalid : L.buttonTitle({server: server.name})

    async function submit(e?: FormEvent) {
        e?.preventDefault()
        if (!valid || busy) return
        setBusy(true)
        setError('')
        try {
            await onStart(trimmed)
            setName('')
        } catch (err) {
            setError(L.startFailed({error: errorText(err)}))
        } finally {
            setBusy(false)
        }
    }

    return (
        <form onSubmit={submit} className="flex flex-col gap-2 border-b border-outline-variant bg-surface-container-low px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
                <span className="flex shrink-0 items-center gap-1.5 text-xs font-semibold">
                    <Icon name="cloud_download" size={16} className="text-primary" />
                    {L.title}
                </span>
                <div className="flex min-w-48 flex-1 items-center gap-1.5 rounded-lg bg-surface-container-highest px-2.5 py-1.5 focus-within:ring-1 focus-within:ring-primary">
                    <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={L.placeholder}
                        aria-label={L.inputLabel}
                        title={L.inputTitle}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                        className="min-w-0 flex-1 bg-transparent font-mono text-xs text-on-surface outline-none placeholder:text-on-surface-variant/60"
                    />
                </div>
                <button
                    type="submit"
                    disabled={!valid || busy}
                    title={buttonTitle}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-on-primary enabled:hover:opacity-90 disabled:opacity-50"
                >
                    <Icon name={busy ? 'progress_activity' : 'download'} size={14} className={busy ? 'animate-spin' : ''} />
                    {L.button}
                </button>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-ui-10 uppercase tracking-wider text-on-surface-variant">{L.examplesLabel}</span>
                {EXAMPLES.map((ex) => (
                    <button
                        key={ex}
                        type="button"
                        onClick={() => setName(ex)}
                        title={L.exampleTitle({name: ex, hint: L.exampleHints[ex]})}
                        className="rounded-full border border-outline-variant px-2 py-0.5 font-mono text-ui-10 text-on-surface-variant hover:border-primary/60 hover:text-on-surface"
                    >
                        {ex}
                    </button>
                ))}
                <button
                    type="button"
                    onClick={() => BrowserOpenURL(CATALOG_URL)}
                    title={L.catalogTitle}
                    className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-ui-11 text-primary hover:underline"
                >
                    <Icon name="open_in_new" size={12} />
                    {L.catalog}
                </button>
            </div>

            <p className="flex items-start gap-1.5 text-ui-11 text-on-surface-variant">
                <Icon name={server.isLocal ? 'computer' : 'dns'} size={13} className="mt-px shrink-0" />
                {server.isLocal ? L.noteLocal : L.noteRemote({host: hostOf(server.baseUrl)})}
            </p>

            {error && (
                <p role="alert" className="flex items-start gap-1.5 text-xs text-error">
                    <Icon name="error" size={14} className="mt-px shrink-0" />
                    <span className="min-w-0 break-words">{error}</span>
                </p>
            )}
        </form>
    )
}

// El texto del estado, traducido. Ollama manda «pulling manifest», «pulling
// <digest>», «verifying sha256 digest», «writing manifest», «removing any
// unused layers» y «success»; un estado que no se reconoce se muestra tal cual.
function statusText(L: Dict['models']['pull'], p: Pull): string {
    if (p.cancelled) return L.statusCancelled
    if (p.done && !p.error) return L.statusSuccess
    const s = p.status.toLowerCase()
    if (s === 'success') return L.statusSuccess
    if (s.startsWith('pulling manifest')) return L.statusManifest
    if (s.startsWith('pulling')) return L.statusDownloading
    if (s.startsWith('verifying')) return L.statusVerifying
    if (s.startsWith('writing')) return L.statusWriting
    if (s.startsWith('removing')) return L.statusCleaning
    return p.status || L.statusStarting
}

interface ListProps {
    pulls: Pull[]
    servers: main.ModelServer[]
    onCancel: (id: string) => Promise<void>
    onDismiss: (id: string) => Promise<void>
}

export function ModelPullList({pulls, servers, onCancel, onDismiss}: ListProps) {
    const t = useT()
    const L = t.models.pull
    // Las que se están cancelando: entre el clic y el evento final pasa un
    // instante en el que el botón no debería poder pulsarse dos veces.
    const [cancelling, setCancelling] = useState<Set<string>>(new Set())
    if (pulls.length === 0) return null

    const nameOf = (id: string) => servers.find((s) => s.id === id)?.name ?? id

    return (
        <ul aria-label={L.listTitle} className="flex flex-col gap-2 border-b border-outline-variant bg-surface px-4 py-2">
            {pulls.map((p) => {
                const failed = p.done && !!p.error
                const ok = p.done && !p.error && !p.cancelled
                const pct = Math.max(0, Math.min(100, p.percent))
                const known = p.total > 0
                const stopping = cancelling.has(p.pullId)
                return (
                    <li key={p.pullId} data-pull-state={failed ? 'failed' : ok ? 'done' : p.cancelled ? 'cancelled' : 'running'} className="flex flex-col gap-1">
                        <div className="flex min-w-0 items-center gap-2 text-xs">
                            <Icon
                                name={failed ? 'error' : ok ? 'check_circle' : p.cancelled ? 'cancel' : 'progress_activity'}
                                size={15}
                                filled={ok || failed}
                                className={`shrink-0 ${failed ? 'text-error' : ok ? 'text-secondary' : p.cancelled ? 'text-tertiary' : 'animate-spin text-primary'}`}
                            />
                            <span className="min-w-0 truncate font-mono font-medium" title={p.model}>
                                {p.model}
                            </span>
                            {servers.length > 1 && (
                                <span className="hidden shrink-0 text-ui-10 text-on-surface-variant sm:inline">{L.onServer({server: nameOf(p.serverId)})}</span>
                            )}
                            <span className="ml-auto shrink-0 text-ui-11 text-on-surface-variant">{statusText(L, p)}</span>
                            {!p.done ? (
                                <button
                                    type="button"
                                    disabled={stopping}
                                    onClick={() => {
                                        setCancelling((s) => new Set(s).add(p.pullId))
                                        void onCancel(p.pullId).catch(() => setCancelling((s) => new Set([...s].filter((x) => x !== p.pullId))))
                                    }}
                                    title={stopping ? L.cancelling : L.cancelTitle({name: p.model})}
                                    className="flex shrink-0 items-center gap-1 rounded-lg border border-outline-variant px-2 py-0.5 text-ui-11 text-on-surface-variant enabled:hover:border-error/60 enabled:hover:text-error disabled:opacity-60"
                                >
                                    <Icon name="stop_circle" size={13} />
                                    {stopping ? L.cancelling : L.cancel}
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => void onDismiss(p.pullId)}
                                    title={L.dismissTitle}
                                    className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-0.5 text-ui-11 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                                >
                                    <Icon name="close" size={13} />
                                    {L.dismiss}
                                </button>
                            )}
                        </div>

                        {!p.done && (
                            <div className="flex items-center gap-2">
                                <div
                                    role="progressbar"
                                    aria-label={L.progressLabel({name: p.model})}
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-valuenow={known ? Math.round(pct) : undefined}
                                    className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-container-highest"
                                >
                                    <div
                                        className={`h-full rounded-full bg-primary transition-[width] duration-150 ${known ? '' : 'w-1/3 animate-pulse'}`}
                                        style={known ? {width: `${pct}%`} : undefined}
                                    />
                                </div>
                                <span className="w-14 shrink-0 text-right font-mono text-ui-10 text-on-surface-variant">
                                    {known ? `${formatNumber(pct, {minimumFractionDigits: 1, maximumFractionDigits: 1})} %` : '—'}
                                </span>
                            </div>
                        )}
                        {!p.done && known && (
                            <p className="text-right font-mono text-ui-10 text-on-surface-variant">{L.bytes({done: formatModelSize(p.completed), total: formatModelSize(p.total)})}</p>
                        )}
                        {failed && (
                            <p role="alert" className="break-words text-ui-11 text-error" title={L.failedTitle({name: p.model})}>
                                {p.error}
                            </p>
                        )}
                        {p.cancelled && <p className="text-ui-11 text-on-surface-variant">{L.cancelledNote}</p>}
                        {ok && <p className="sr-only">{L.doneTitle({name: p.model})}</p>}
                    </li>
                )
            })}
        </ul>
    )
}
