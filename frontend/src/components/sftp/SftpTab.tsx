import {useEffect, useRef, useState} from 'react'
import {
    CancelSftpTransfer,
    CheckSftpConflicts,
    CloseSftpBrowse,
    OpenSftpBrowse,
    SftpHomeDir,
    StartSftpTransfer,
} from '../../../wailsjs/go/main/App'
import {EventsOn} from '../../../wailsjs/runtime'
import {main, sftpx, vault} from '../../../wailsjs/go/models'
import {formatBytes} from '../../lib/formatBytes'
import {setSessionHome} from '../../lib/sshSessionContext'
import {forget as forgetRate, formatEta, formatRate, observe} from '../../lib/transferRate'
import Icon from '../Icon'
import SftpConflictDialog, {type ConflictPolicy} from './SftpConflictDialog'
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
    // Opens a remote file in an editor tab. Optional so this component keeps
    // working exactly as before wherever it is rendered without one.
    onOpenRemoteFile?: (host: PaneHost, path: string) => void
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
    // Derived on this side from consecutive progress events — see
    // lib/transferRate.ts. etaSeconds is -1 while it cannot be estimated.
    bytesPerSec: number
    etaSeconds: number
}

// Where a transfer's files come from: a pane, or the OS file manager (a
// desktop drop, which is always the local machine and belongs to no pane).
type Source = {kind: 'pane'; side: Side} | {kind: 'desktop'}

// A transfer waiting on the conflict dialog's answer: everything launch()
// needs, held until a policy is chosen.
interface PendingTransfer {
    src: Source
    toSide: Side
    items: TransferItem[]
    conflicts: sftpx.Conflict[]
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

export default function SftpTab({tabId, initialConnId, connections, onOpenRemoteFile}: SftpTabProps) {
    const [panes, setPanes] = useState<{left: PaneState; right: PaneState}>({
        left: {host: LOCAL_HOST, dir: '', reload: 0},
        right: {host: NONE_HOST, dir: '', reload: 0},
    })
    const [error, setError] = useState<string | null>(null)
    const [queue, setQueue] = useState<QueueItem[]>([])
    const [pending, setPending] = useState<PendingTransfer | null>(null)

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
                // The browse session is told the account's home directory when
                // it opens; share it so the terminal can resolve `cd`, `cd ~`
                // and `cd ~/algo`, which it otherwise cannot.
                setSessionHome(host.connId as string, dir)
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

    // Source of a transfer: a pane, or the OS file manager (a desktop drop,
    // which is always the local machine and belongs to no pane).
    function sourceHost(src: Source): PaneHost {
        return src.kind === 'desktop' ? LOCAL_HOST : panes[src.side].host
    }

    // Step 1: check whether anything would be overwritten, and ask before
    // touching the destination. Only then does the transfer start.
    async function beginTransfer(src: Source, toSide: Side, items: TransferItem[]) {
        setError(null)
        const to = panes[toSide]
        if (to.host.kind === 'none') {
            setError('Elegí un host de destino en el otro panel primero')
            return
        }
        if (items.length === 0) return

        const from = sourceHost(src)
        try {
            const conflicts = await CheckSftpConflicts(
                new main.SftpTransferInput({
                    transferId: '',
                    src: endpoint(from),
                    dst: endpoint(to.host),
                    dstDir: to.dir,
                    items,
                }),
            )
            if (conflicts && conflicts.length > 0) {
                setPending({src, toSide, items, conflicts})
                return
            }
        } catch (err) {
            // A failed pre-flight must not block the transfer: the check is a
            // courtesy, and the copy itself reports any real problem with a
            // far more specific message. Worst case the user gets the previous
            // behaviour (plain overwrite) instead of a dialog.
            console.warn('sftp: no se pudo comprobar conflictos', err)
        }
        launch(src, toSide, items, '')
    }

    // Step 2: subscribe, enqueue and start. onConflict is '' when nothing
    // collided, which the backend reads as overwrite.
    function launch(src: Source, toSide: Side, items: TransferItem[], onConflict: ConflictPolicy | '') {
        const from = sourceHost(src)
        const to = panes[toSide]
        const id = newId()
        const label = `${src.kind === 'desktop' ? 'Escritorio' : from.connName} → ${to.host.connName}`

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
                    bytesPerSec: 0,
                    etaSeconds: -1,
                })
                forgetRate(id)
                const un = subs.current.get(id)
                if (un) {
                    un()
                    subs.current.delete(id)
                }
                // The destination gained files, so it always reloads. The
                // source is a copy and normally unchanged — except when both
                // panes happen to be pointed at the same host and folder, where
                // the "other" pane IS the same folder and would otherwise sit
                // there stale.
                refresh(toSide)
                const fromSide = src.kind === 'pane' ? src.side : null
                if (
                    fromSide &&
                    panes[fromSide].host.sessionId === to.host.sessionId &&
                    panes[fromSide].dir === to.dir
                ) {
                    refresh(fromSide)
                }
            } else {
                const rate = observe(id, ev.bytesDone, ev.bytesTotal, performance.now())
                updateQueue(id, {
                    percent: ev.percent,
                    filesDone: ev.filesDone,
                    totalFiles: ev.totalFiles,
                    bytesDone: ev.bytesDone,
                    bytesTotal: ev.bytesTotal,
                    bytesPerSec: rate.bytesPerSec,
                    etaSeconds: rate.etaSeconds,
                })
            }
        })
        subs.current.set(id, unsub)

        setQueue((q) => [
            {
                id,
                label,
                status: 'running',
                percent: 0,
                filesDone: 0,
                totalFiles: 0,
                bytesDone: 0,
                bytesTotal: 0,
                bytesPerSec: 0,
                etaSeconds: -1,
            },
            ...q,
        ])

        StartSftpTransfer(
            new main.SftpTransferInput({
                transferId: id,
                src: endpoint(from),
                dst: endpoint(to.host),
                dstDir: to.dir,
                items,
                onConflict,
            }),
        ).catch((err) => {
            updateQueue(id, {status: 'error', error: String(err)})
            forgetRate(id)
            const un = subs.current.get(id)
            if (un) {
                un()
                subs.current.delete(id)
            }
        })
    }

    // Files dropped from Finder/Explorer land on a pane and are uploaded from
    // the local machine. isDir is left false: the backend stats every source
    // path anyway and corrects it, because an OS drop carries no type.
    function dropFromDesktop(side: Side, paths: string[]) {
        void beginTransfer(
            {kind: 'desktop'},
            side,
            paths.map((path) => ({path, isDir: false})),
        )
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
                        onRefresh={() => refresh('left')}
                        onOpenFile={(path) => onOpenRemoteFile?.(panes.left.host, path)}
                        onError={setError}
                        onTransfer={(items) => void beginTransfer({kind: 'pane', side: 'left'}, 'right', items)}
                        onDropFromDesktop={(paths) => dropFromDesktop('left', paths)}
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
                        onRefresh={() => refresh('right')}
                        onOpenFile={(path) => onOpenRemoteFile?.(panes.right.host, path)}
                        onError={setError}
                        onTransfer={(items) => void beginTransfer({kind: 'pane', side: 'right'}, 'left', items)}
                        onDropFromDesktop={(paths) => dropFromDesktop('right', paths)}
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
                                        {it.totalFiles > 0 && `${it.filesDone}/${it.totalFiles} archivos · `}
                                        {formatBytes(it.bytesDone)}
                                        {it.bytesTotal > 0 && ` / ${formatBytes(it.bytesTotal)}`}
                                        {it.status === 'running' && it.bytesPerSec > 0 && (
                                            <>
                                                {' · '}
                                                <span className="text-primary">{formatRate(it.bytesPerSec)}</span>
                                                {it.etaSeconds >= 0 && ` · faltan ${formatEta(it.etaSeconds)}`}
                                            </>
                                        )}
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

            {pending && (
                <SftpConflictDialog
                    conflicts={pending.conflicts}
                    destLabel={`${panes[pending.toSide].host.connName}: ${panes[pending.toSide].dir}`}
                    onChoose={(policy) => {
                        launch(pending.src, pending.toSide, pending.items, policy)
                        setPending(null)
                    }}
                    onCancel={() => setPending(null)}
                />
            )}
        </div>
    )
}
