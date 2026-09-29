import {useEffect, useState} from 'react'
import {GitStashDiff} from '../../../wailsjs/go/main/App'
import {git} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import {useT} from '../../i18n'

interface GitStashPanelProps {
    repoId: string
    stashes: git.Stash[]
    busy: boolean
    onApply: (ref: string, drop: boolean) => void
    onDrop: (ref: string) => void
    onPush: () => void
    onClose: () => void
}

// Stash manager with a preview.
//
// The preview is the reason this exists as a panel instead of a menu.
// `git stash pop` is not reversible in any obvious way once it conflicts,
// and the entry it came from is gone — so choosing between "stash@{0}" and
// "stash@{3}" from a one-line message is a guess. Seeing the patch first
// turns it into a decision.
export default function GitStashPanel({repoId, stashes, busy, onApply, onDrop, onPush, onClose}: GitStashPanelProps) {
    const t = useT()
    const ts = t.git.stash
    const [selected, setSelected] = useState<string | null>(null)
    const [patch, setPatch] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')
    const [confirmDrop, setConfirmDrop] = useState<string | null>(null)

    // Select the newest stash by default — it is the one people mean.
    useEffect(() => {
        if (!selected && stashes.length > 0) setSelected(stashes[0].ref)
        if (selected && !stashes.some((s) => s.ref === selected)) setSelected(stashes[0]?.ref ?? null)
    }, [stashes, selected])

    useEffect(() => {
        if (!selected) {
            setPatch('')
            return
        }
        let cancelled = false
        setLoading(true)
        setError('')
        GitStashDiff(repoId, selected)
            .then((p) => {
                if (!cancelled) setPatch(p ?? '')
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
    }, [repoId, selected])

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-3 py-1.5 text-xs">
                <Icon name="inventory_2" size={15} className="shrink-0 text-primary" />
                <span className="font-semibold text-on-surface">{ts.title}</span>
                <span className="text-on-surface-variant">{stashes.length}</span>
                <button
                    onClick={onPush}
                    disabled={busy}
                    title={ts.pushTitle}
                    className="ml-auto flex items-center gap-1 rounded border border-outline-variant px-2 py-0.5 text-on-surface hover:bg-surface-container-high disabled:opacity-40"
                >
                    <Icon name="add" size={13} />
                    {ts.push}
                </button>
                <button onClick={onClose} title={ts.closeTitle} className="shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface">
                    <Icon name="close" size={16} />
                </button>
            </div>

            {stashes.length === 0 ? (
                <p className="p-4 text-center text-xs text-on-surface-variant">
                    {ts.empty}
                </p>
            ) : (
                <div className="flex min-h-0 flex-1">
                    <div className="w-64 shrink-0 overflow-y-auto border-r border-outline-variant">
                        {stashes.map((s) => (
                            <button
                                key={s.ref}
                                onClick={() => setSelected(s.ref)}
                                title={ts.itemTitle({ref: s.ref, branch: s.branch, date: s.date})}
                                className={`flex w-full flex-col items-start gap-0.5 border-b border-outline-variant/40 px-2 py-1.5 text-left text-ui-11 ${
                                    selected === s.ref ? 'bg-primary-container/50 text-on-primary-container' : 'text-on-surface hover:bg-surface-variant/50'
                                }`}
                            >
                                <span className="flex w-full items-center gap-1">
                                    <span className="font-mono text-ui-10 opacity-70">{s.ref}</span>
                                    <span className="ml-auto truncate text-ui-10 opacity-60">{s.branch}</span>
                                </span>
                                <span className="w-full truncate">{s.message}</span>
                            </button>
                        ))}
                    </div>

                    <div className="flex min-w-0 flex-1 flex-col">
                        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-outline-variant px-2 py-1 text-ui-11">
                            <button
                                onClick={() => selected && onApply(selected, false)}
                                disabled={busy || !selected}
                                title={ts.applyTitle}
                                className="rounded border border-outline-variant px-2 py-0.5 text-on-surface hover:bg-surface-container-high disabled:opacity-40"
                            >
                                {ts.apply}
                            </button>
                            <button
                                onClick={() => selected && onApply(selected, true)}
                                disabled={busy || !selected}
                                title={ts.popTitle}
                                className="rounded bg-primary px-2 py-0.5 text-on-primary disabled:opacity-40"
                            >
                                {ts.pop}
                            </button>
                            <button
                                onClick={() => selected && setConfirmDrop(selected)}
                                disabled={busy || !selected}
                                title={ts.dropTitle}
                                className="ml-auto rounded px-2 py-0.5 text-error hover:bg-error-container disabled:opacity-40"
                            >
                                {ts.drop}
                            </button>
                        </div>

                        <div className="min-h-0 flex-1 overflow-auto p-2">
                            {loading && <p className="text-xs text-on-surface-variant">{ts.loading}</p>}
                            {error && <p className="text-xs text-error">{error}</p>}
                            {!loading && !error && patch === '' && (
                                <p className="text-xs text-on-surface-variant">{ts.noChanges}</p>
                            )}
                            {!loading && !error && patch !== '' && (
                                <pre className="whitespace-pre-wrap break-all font-mono text-ui-11 leading-relaxed">
                                    {patch.split('\n').map((line, i) => (
                                        <div
                                            key={i}
                                            className={
                                                line.startsWith('+') && !line.startsWith('+++')
                                                    ? 'text-secondary'
                                                    : line.startsWith('-') && !line.startsWith('---')
                                                      ? 'text-error'
                                                      : line.startsWith('@@')
                                                        ? 'text-primary'
                                                        : 'text-on-surface-variant'
                                            }
                                        >
                                            {line}
                                        </div>
                                    ))}
                                </pre>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {confirmDrop && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/50">
                    <div className="w-80 rounded-xl border border-outline-variant bg-surface-container-high p-5 text-on-surface shadow-lg">
                        <h3 className="flex items-center gap-2 text-sm font-semibold">
                            <Icon name="warning" size={16} className="text-error" />
                            {ts.confirmTitle}
                        </h3>
                        <p className="mt-2 text-xs text-on-surface-variant">
                            {ts.confirmBody({message: stashes.find((s) => s.ref === confirmDrop)?.message ?? ''})}
                        </p>
                        <div className="mt-4 flex justify-end gap-2 text-xs">
                            <button onClick={() => setConfirmDrop(null)} className="rounded px-3 py-1.5 text-on-surface-variant hover:text-on-surface">
                                {t.common.cancel}
                            </button>
                            <button
                                onClick={() => {
                                    onDrop(confirmDrop)
                                    setConfirmDrop(null)
                                }}
                                className="rounded bg-error px-3 py-1.5 text-on-error"
                            >
                                {ts.drop}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
