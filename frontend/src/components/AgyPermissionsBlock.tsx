import {useCallback, useEffect, useState} from 'react'
import {AntigravityPermissionsStatus, RemoveAntigravityPermissions, RepairAntigravityPermissions} from '../../wailsjs/go/main/App'
import type {main} from '../../wailsjs/go/models'
import ConfirmDialog from './ConfirmDialog'
import Icon from './Icon'
import {rich} from './agent/rich'
import {useT} from '../i18n'

// Permisos de mini-tools en Antigravity (Acceso de la IA).
//
// En su modo no interactivo (el chat de la app) Antigravity bloquea toda
// herramienta MCP que no tenga una regla `mcp(<servidor>/<herramienta>)` en el
// `settings.json` global. mini-tools las agrega solo —al preparar un turno y al
// Conectar—; acá se ve cuántas hay, se **quitan** (y entonces no se reponen
// solas) o se **vuelven a sincronizar**. Las reglas son globales: el texto lo
// dice, porque la terminal interactiva de Antigravity tampoco preguntará.
// Backend: app_agyperm.go.
export default function AgyPermissionsBlock({refreshKey = 0}: {refreshKey?: number}) {
    const t = useT()
    const a = t.agent.aiAccess.agyPerms
    const [st, setSt] = useState<main.AntigravityPermissions | null>(null)
    const [busy, setBusy] = useState(false)
    const [confirmRemove, setConfirmRemove] = useState(false)
    const [msg, setMsg] = useState('')
    const [error, setError] = useState('')

    const load = useCallback(() => {
        AntigravityPermissionsStatus()
            .then(setSt)
            .catch((e) => setError(String(e)))
    }, [])
    // refreshKey: el panel lo sube después de Conectar, que puede haber
    // agregado reglas por su cuenta.
    useEffect(load, [load, refreshKey])

    // Sin el CLI instalado no hay nada que aprobar ni que quitar.
    if (!st || !st.installed) return null

    const missing = st.missing ?? []
    const synced = st.valid && missing.length === 0 && st.stale === 0
    let icon = 'check_circle'
    let tone = 'text-secondary'
    let label = st.approved === 1 ? a.statusOne : a.statusOk({n: st.approved})
    if (!st.valid && st.problem) {
        icon = 'warning'
        tone = 'text-error'
        label = a.statusInvalid
    } else if (st.approved === 0) {
        icon = 'shield'
        tone = 'text-on-surface-variant'
        label = a.statusNone
    } else if (st.approved < st.expected) {
        icon = 'warning'
        tone = 'text-tertiary'
        label = a.statusPartial({n: st.approved, total: st.expected})
    }

    const run = async (action: 'remove' | 'resync') => {
        setBusy(true)
        setError('')
        setMsg('')
        try {
            const next = action === 'remove' ? await RemoveAntigravityPermissions() : await RepairAntigravityPermissions()
            setSt(next)
            setMsg(action === 'remove' ? a.removed : a.resynced({n: next.approved}))
        } catch (e) {
            setError(String(e))
            load()
        } finally {
            setBusy(false)
        }
    }

    const canRemove = st.valid && (st.approved > 0 || st.stale > 0)

    return (
        <div className="rounded border border-outline-variant bg-surface-container-low p-2" data-agy-permissions>
            <p className="mb-1 flex items-center gap-1.5 text-ui-10 font-medium uppercase tracking-wider text-on-surface-variant">
                <Icon name="verified_user" size={12} className="shrink-0 text-primary" />
                {a.heading}
            </p>
            <p className="mb-1.5 text-ui-11 leading-4 text-on-surface-variant">{rich(a.intro)}</p>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className={`flex min-w-0 items-center gap-1 text-ui-11 ${tone}`} title={a.statusTitle({path: st.path})}>
                    <Icon name={icon} size={13} className="shrink-0" />
                    <span className="truncate">{label}</span>
                </span>
                <div className="ml-auto flex shrink-0 items-center gap-2 text-ui-11">
                    <button
                        onClick={() => setConfirmRemove(true)}
                        disabled={busy || !canRemove}
                        title={busy ? a.busyTitle : canRemove ? a.removeTitle : a.removeTitleNone}
                        className="flex items-center gap-1 rounded border border-outline-variant px-2 py-0.5 text-on-surface hover:bg-surface-variant disabled:opacity-40"
                    >
                        <Icon name="delete" size={12} />
                        {a.remove}
                    </button>
                    <button
                        onClick={() => void run('resync')}
                        disabled={busy || (synced && !st.removedByUser)}
                        title={busy ? a.busyTitle : synced && !st.removedByUser ? a.resyncTitleOk : a.resyncTitle}
                        className="flex items-center gap-1 rounded bg-secondary px-2 py-0.5 font-medium text-on-secondary hover:opacity-90 disabled:opacity-40"
                    >
                        {busy ? (
                            <span aria-hidden className="h-3 w-3 animate-spin rounded-full border-2 border-t-transparent border-on-secondary" />
                        ) : (
                            <Icon name="sync" size={12} />
                        )}
                        {a.resync}
                    </button>
                </div>
            </div>

            {st.removedByUser && (
                <p className="mt-1 flex items-start gap-1.5 text-ui-11 text-tertiary">
                    <Icon name="info" size={12} className="mt-px shrink-0" />
                    {a.statusRemoved}
                </p>
            )}
            {!st.removedByUser && !st.mcpEnabled && (
                <p className="mt-1 flex items-start gap-1.5 text-ui-11 text-on-surface-variant">
                    <Icon name="info" size={12} className="mt-px shrink-0" />
                    {a.statusMcpOff}
                </p>
            )}
            {missing.length > 0 && st.valid && st.approved > 0 && (
                <p className="mt-1 break-words font-mono text-ui-10 text-on-surface-variant/80">{a.missing({tools: missing.join(', ')})}</p>
            )}
            {st.stale > 0 && <p className="mt-1 text-ui-10 text-on-surface-variant/80">{a.stale({n: st.stale})}</p>}
            {!st.valid && st.problem && (
                <p className="mt-1 break-words rounded border border-error/30 bg-error-container/30 px-2 py-1 text-ui-11 text-error">
                    {a.invalid({problem: st.problem})}
                </p>
            )}
            {msg && (
                <p className="mt-1 flex items-center gap-1.5 rounded bg-secondary-container/40 px-2 py-1 text-ui-11 text-on-surface">
                    <Icon name="check_circle" size={13} className="shrink-0 text-secondary" />
                    {msg}
                </p>
            )}
            {error && <p className="mt-1 break-words text-ui-11 text-error">{error}</p>}

            <p className="mt-1.5 text-ui-10 leading-4 text-on-surface-variant/70">{rich(a.global)}</p>

            {confirmRemove && (
                <ConfirmDialog
                    title={a.removeConfirmTitle}
                    description={a.removeConfirmBody({path: st.path})}
                    confirmLabel={a.remove}
                    danger
                    onConfirm={() => void run('remove')}
                    onClose={() => setConfirmRemove(false)}
                />
            )}
        </div>
    )
}
