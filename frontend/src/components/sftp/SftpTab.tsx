import {useEffect, useRef, useState} from 'react'
import {
    CancelSftpTransfer,
    CloseSftpBrowse,
    OpenSftpBrowse,
    SftpHomeDir,
    StartSftpTransfer,
} from '../../../wailsjs/go/main/App'
import {EventsOn} from '../../../wailsjs/runtime'
import {main, vault} from '../../../wailsjs/go/models'
import {formatBytes} from '../../lib/formatBytes'
import Icon from '../Icon'
import SftpPane from './SftpPane'
import {LOCAL_SESSION, type PaneHost, type ProgressEvent, type TransferItem} from './types'

interface SftpTabProps {
    tabId: string
    // The host this tab was launched from — seeds the right pane. The left
    // pane defaults to the local machine.
    initialConnId: string
    // SSH connections only (filtered by Workspace) — the host picker offers
    // Local + these; DB/Redis connections have no SFTP surface.
    connections: vault.ConnectionSummary[]
}

type Side = 'left' | 'right'

interface PaneState {
    host: PaneHost
    dir: string
    reload: number
}

interface QueueItem {
    id: string
    label: string
    status: 'running' | 'done' | 'error' | 'cancelled'
    percent: number
    filesDone: number
    totalFiles: number
    bytesDone: number
    bytesTotal: number
    error?: string
}

const NONE_HOST: PaneHost = {kind: 'none', connId: null, connName: '', sessionId: ''}
const LOCAL_HOST: PaneHost = {kind: 'local', connId: null, connName: 'Local', sessionId: LOCAL_SESSION}

let seq = 0
function newId(): string {
    seq += 1
    return `xfer-${seq}-${Date.now()}`
}

function endpoint(host: PaneHost) {
    return {local: host.kind === 'local', connId: host.connId ?? ''}
}

function other(side: Side): Side {
    return side === 'left' ? 'right' : 'left'
}

export default function SftpTab({tabId, initialConnId, connections}: SftpTabProps) {
    const [panes, setPanes] = useState<{left: PaneState; right: PaneState}>({
        left: {host: LOCAL_HOST, dir: '', reload: 0},
        right: {host: NONE_HOST, dir: '', reload: 0},
    })
    const [error, setError] = useState<string | null>(null)
    const [queue, setQueue] = useState<QueueItem[]>([])

    // Live subscriptions + open remote browse sessions, tracked in refs so the
    // unmount cleanup tears them ALL down regardless of the latest render's
    // closure — this is what guarantees no orphaned event listeners, no live
    // SFTP sessions, and no running transfers survive closing the tab.
    const subs = useRef<Map<string, () => void>>(new Map())
    const openSessions = useRef<Set<string>>(new Set())

    function updatePane(side: Side, partial: Partial<PaneState>) {
        setPanes((prev) => ({...prev, [side]: {...prev[side], ...partial}}))
    }

    // Mount: seed the left pane with the local home and the right pane with
    // the launched host.
    useEffect(() => {
        SftpHomeDir(LOCAL_SESSION)
            .then((home) => updatePane('left', {dir: home}))
            .catch((err) => setError(String(err)))
        const conn = connections.find((c) => c.id === initialConnId)
        if (conn) void pickHost('right', {kind: 'remote', connId: conn.id, connName: conn.name, sessionId: `sftp:${conn.id}`})
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // Unmount: cancel every in-flight transfer, drop every event listener, and
    // close every open remote session. See the refs' comment above.
    useEffect(() => {
        return () => {
            subs.current.forEach((unsub, id) => {
                void CancelSftpTransfer(id)
                unsub()
            })
            subs.current.clear()
            openSessions.current.forEach((sid) => void CloseSftpBrowse(sid))
            openSessions.current.clear()
        }
    }, [])

    async function pickHost(side: Side, host: PaneHost) {
        setError(null)
        const prev = panes[side].host
        if (prev.kind === 'remote' && prev.sessionId !== host.sessionId) {
            openSessions.current.delete(prev.sessionId)
            void CloseSftpBrowse(prev.sessionId)
        }
        try {
            let dir: string
            if (host.kind === 'local') {
                dir = await SftpHomeDir(LOCAL_SESSION)
            } else {
                dir = await OpenSftpBrowse(host.sessionId, host.connId as string)
                openSessions.current.add(host.sessionId)
            }
            setPanes((p) => ({...p, [side]: {host, dir, reload: p[side].reload + 1}}))
        } catch (err) {
            setError(String(err))
        }
    }

    function refresh(side: Side) {
        setPanes((p) => ({...p, [side]: {...p[side], reload: p[side].reload + 1}}))
    }

    function updateQueue(id: string, patch: Partial<QueueItem>) {
        setQueue((q) => q.map((it) => (it.id === id ? {...it, ...patch} : it)))
    }

    function transfer(fromSide: Side, items: TransferItem[]) {
        const toSide = other(fromSide)
        const from = panes[fromSide]
        const to = panes[toSide]
        if (to.host.kind === 'none') {
            setError('Elegí un host de destino en el otro panel primero')
            return
        }
        if (items.length === 0) return

        const id = newId()
        const label = `${from.host.connName} → ${to.host.connName}`
        // Subscribe BEFORE StartSftpTransfer so the first emitted event can't
        // race the subscription — same contract as the SSH terminal.
        const unsub = EventsOn(id, (ev: ProgressEvent) => {
            if (ev.type === 'done' || ev.type === 'error' || ev.type === 'cancelled') {
                updateQueue(id, {
                    status: ev.type,
                    percent: ev.percent,
                    filesDone: ev.filesDone,
                    totalFiles: ev.totalFiles,
                    bytesDone: ev.bytesDone,
                    bytesTotal: ev.bytesTotal,
                    error: ev.error,
                })
                const un = subs.current.get(id)
                if (un) {
                    un()
                    subs.current.delete(id)
                }
                refresh(toSide) // surface transferred (or partial) files
            } else {
                updateQueue(id, {
                    percent: ev.percent,
                    filesDone: ev.filesDone,
                    totalFiles: ev.totalFiles,
                    bytesDone: ev.bytesDone,
                    bytesTotal: ev.bytesTotal,
                })
            }
        })
        subs.current.set(id, unsub)

        setQueue((q) => [
            {id, label, status: 'running', percent: 0, filesDone: 0, totalFiles: 0, bytesDone: 0, bytesTotal: 0},
            ...q,
        ])

        StartSftpTransfer(
            new main.SftpTransferInput({
                transferId: id,
                src: endpoint(from.host),
                dst: endpoint(to.host),
                dstDir: to.dir,
                items,
            }),
        ).catch((err) => {
            updateQueue(id, {status: 'error', error: String(err)})
            const un = subs.current.get(id)
            if (un) {
                un()
                subs.current.delete(id)
            }
        })
    }

    const dragRef = useRef<TransferItem[] | null>(null)
    const activeCount = queue.filter((q) => q.status === 'running').length

    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface">
            {error && (
                <div className="flex shrink-0 items-start gap-2 border-b border-error/40 bg-error-container/40 px-3 py-1.5 text-xs text-on-error-container">
                    <Icon name="error" size={16} className="mt-0.5 shrink-0" />
                    <span className="min-w-0 flex-1 whitespace-pre-wrap wrap-break-word">{error}</span>
                    <button onClick={() => setError(null)} title="Cerrar" className="mt-0.5 shrink-0 rounded p-0.5 hover:bg-error/20">
                        <Icon name="close" size={14} />
                    </button>
                </div>
            )}

            <div className="flex min-h-0 flex-1">
                <div className="flex min-h-0 min-w-0 flex-1 border-r border-outline-variant">
                    <SftpPane
                        host={panes.left.host}
                        currentDir={panes.left.dir}
                        reloadToken={panes.left.reload}
                        connections={connections}
                        otherLabel={panes.right.host.kind === 'none' ? 'destino' : panes.right.host.connName}
                        onPickHost={(h) => void pickHost('left', h)}
                        onNavigate={(dir) => updatePane('left', {dir})}
                        onError={setError}
                        onTransfer={(items) => transfer('left', items)}
                        dragRef={dragRef}
                    />
                </div>
                <div className="flex min-h-0 min-w-0 flex-1">
                    <SftpPane
                        host={panes.right.host}
                        currentDir={panes.right.dir}
                        reloadToken={panes.right.reload}
                        connections={connections}
                        otherLabel={panes.left.host.kind === 'none' ? 'destino' : panes.left.host.connName}
                        onPickHost={(h) => void pickHost('right', h)}
                        onNavigate={(dir) => updatePane('right', {dir})}
                        onError={setError}
                        onTransfer={(items) => transfer('right', items)}
                        dragRef={dragRef}
                    />
                </div>
            </div>

            {/* Transfer queue */}
            {queue.length > 0 && (
                <div className="max-h-48 shrink-0 overflow-auto border-t border-outline-variant bg-surface-container-low">
                    <div className="flex items-center gap-2 border-b border-outline-variant px-3 py-1.5 text-[11px] font-medium text-on-surface-variant">
                        <Icon name="swap_vert" size={14} />
                        Transferencias {activeCount > 0 && <span className="text-secondary">({activeCount} activas)</span>}
                        <button
                            onClick={() => setQueue((q) => q.filter((it) => it.status === 'running'))}
                            className="ml-auto rounded px-2 py-0.5 hover:bg-surface-variant hover:text-on-surface"
                            title="Quitar las transferencias finalizadas de la lista"
                        >
                            Limpiar finalizadas
                        </button>
                    </div>
                    {queue.map((it) => (
                        <div key={it.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                            <Icon
                                name={
                                    it.status === 'done'
                                        ? 'check_circle'
                                        : it.status === 'error'
                                          ? 'error'
                                          : it.status === 'cancelled'
                                            ? 'cancel'
                                            : 'sync'
                                }
                                size={16}
                                className={
                                    it.status === 'done'
                                        ? 'text-secondary'
                                        : it.status === 'error'
                                          ? 'text-error'
                                          : it.status === 'cancelled'
                                            ? 'text-on-surface-variant'
                                            : 'text-primary'
                                }
                            />
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <span className="min-w-0 truncate text-on-surface" title={it.label}>
                                        {it.label}
                                    </span>
                                    <span className="ml-auto shrink-0 text-[11px] text-on-surface-variant">
                                        {it.totalFiles > 0 && `${it.filesDone}/${it.totalFiles} · `}
                                        {formatBytes(it.bytesDone)}
                                        {it.bytesTotal > 0 && ` / ${formatBytes(it.bytesTotal)}`}
                                    </span>
                                </div>
                                <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-container-highest">
                                    <div
                                        className={`h-full rounded-full ${
                                            it.status === 'error'
                                                ? 'bg-error'
                                                : it.status === 'cancelled'
                                                  ? 'bg-outline'
                                                  : it.status === 'done'
                                                    ? 'bg-secondary'
                                                    : 'bg-primary'
                                        }`}
                                        style={{width: `${it.status === 'done' ? 100 : it.percent}%`}}
                                    />
                                </div>
                                {it.error && <p className="mt-0.5 whitespace-pre-wrap wrap-break-word text-[11px] text-error">{it.error}</p>}
                            </div>
                            {it.status === 'running' && (
                                <button
                                    onClick={() => void CancelSftpTransfer(it.id)}
                                    title="Cancelar esta transferencia"
                                    className="shrink-0 rounded p-1 text-on-surface-variant hover:bg-error-container/40 hover:text-error"
                                >
                                    <Icon name="stop_circle" size={16} />
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}
