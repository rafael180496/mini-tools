import {useCallback, useEffect, useState} from 'react'
import {GitClearCommandLog, GitCommandLog} from '../../../wailsjs/go/main/App'
import {git} from '../../../wailsjs/go/models'
import Icon from '../Icon'

interface GitCommandLogProps {
    // reloadToken changes after every mutating action, so the drawer shows
    // what just ran without polling.
    reloadToken: number
    onClose: () => void
}

// Collapsible drawer showing the git commands the module actually ran.
//
// Every operation here is a wrapper around a real invocation, so when one
// fails the useful question is always "what did it run?". Answering it in
// the app removes the step where somebody reproduces the failure in a
// terminal to find out — and makes the wrappers auditable instead of
// magic.
export default function GitCommandLogDrawer({reloadToken, onClose}: GitCommandLogProps) {
    const [entries, setEntries] = useState<git.CommandEntry[]>([])
    const [onlyFailed, setOnlyFailed] = useState(false)
    const [copied, setCopied] = useState('')

    const load = useCallback(() => {
        GitCommandLog()
            .then((e) => setEntries(e ?? []))
            .catch(() => {})
    }, [])

    useEffect(() => {
        load()
    }, [load, reloadToken])

    const visible = onlyFailed ? entries.filter((e) => e.failed) : entries
    const failedCount = entries.filter((e) => e.failed).length

    async function copy(command: string) {
        await navigator.clipboard.writeText(command)
        setCopied(command)
        window.setTimeout(() => setCopied(''), 1500)
    }

    return (
        <div className="flex h-56 shrink-0 flex-col border-t border-outline-variant bg-surface-container-lowest">
            <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-3 py-1 text-[11px]">
                <Icon name="terminal" size={14} className="shrink-0 text-on-surface-variant" />
                <span className="font-semibold text-on-surface">Comandos ejecutados</span>
                <span className="text-on-surface-variant">{entries.length}</span>
                {failedCount > 0 && (
                    <span className="rounded bg-error/15 px-1.5 text-error" title="Comandos que terminaron con error">
                        {failedCount} con error
                    </span>
                )}

                <label className="ml-auto flex items-center gap-1 text-on-surface-variant" title="Muestra solo los comandos que fallaron">
                    <input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} className="accent-primary" />
                    solo errores
                </label>
                <button onClick={load} title="Vuelve a leer el log" className="rounded p-0.5 text-on-surface-variant hover:text-on-surface">
                    <Icon name="refresh" size={14} />
                </button>
                <button
                    onClick={() => void GitClearCommandLog().then(load)}
                    title="Vacía el log. No afecta al repositorio."
                    className="rounded px-1.5 py-0.5 text-on-surface-variant hover:text-on-surface"
                >
                    Limpiar
                </button>
                <button onClick={onClose} title="Cierra el panel de comandos" className="rounded p-0.5 text-on-surface-variant hover:text-on-surface">
                    <Icon name="close" size={15} />
                </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto font-mono text-[11px]">
                {visible.length === 0 ? (
                    <p className="p-3 text-on-surface-variant">
                        {onlyFailed ? 'Ningún comando falló.' : 'Todavía no se ejecutó ningún comando en esta sesión.'}
                    </p>
                ) : (
                    visible.map((e, i) => (
                        <div key={i} className={`border-b border-outline-variant/30 px-2 py-1 ${e.failed ? 'bg-error/5' : ''}`}>
                            <div className="flex items-center gap-2">
                                <Icon
                                    name={e.failed ? 'error' : 'check'}
                                    size={12}
                                    className={`shrink-0 ${e.failed ? 'text-error' : 'text-secondary'}`}
                                />
                                <span className="min-w-0 flex-1 truncate text-on-surface" title={`${e.command}\n\nen ${e.dir}`}>
                                    {e.command}
                                </span>
                                <span className="shrink-0 text-[10px] text-on-surface-variant/60">{e.durationMs} ms</span>
                                <span className="shrink-0 text-[10px] text-on-surface-variant/60">
                                    {new Date(e.atMs).toLocaleTimeString('es')}
                                </span>
                                <button
                                    onClick={() => void copy(e.command)}
                                    title="Copia el comando para pegarlo en una terminal tal cual se ejecutó"
                                    className="shrink-0 rounded p-0.5 text-on-surface-variant hover:text-on-surface"
                                >
                                    <Icon name={copied === e.command ? 'check' : 'content_copy'} size={12} />
                                </button>
                            </div>
                            {e.output && (
                                <pre className="mt-0.5 whitespace-pre-wrap break-all pl-5 text-[10px] text-error/90">{e.output}</pre>
                            )}
                        </div>
                    ))
                )}
            </div>
        </div>
    )
}
