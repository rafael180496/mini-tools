import {useEffect, useRef, useState} from 'react'
import {DeleteSftpPath, ListSftpDir, MakeSftpDir, RenameSftpPath} from '../../../wailsjs/go/main/App'
import {sftpx, vault} from '../../../wailsjs/go/models'
import {formatBytes} from '../../lib/formatBytes'
import {registerDropZone} from '../../lib/desktopFileDrop'
import {
    currentCwd,
    isTerminalLive,
    publishCwd,
    subscribeCwd,
    subscribeTerminalLive,
    type SessionContext,
} from '../../lib/sshSessionContext'
import {WriteSSHTerminal} from '../../../wailsjs/go/main/App'
import ConfirmDialog from '../ConfirmDialog'
import Icon from '../Icon'
import SftpPermissionsDialog from './SftpPermissionsDialog'
import {dirname, joinPath, LOCAL_SESSION, type PaneHost, type TransferItem} from './types'

interface SftpPaneProps {
    host: PaneHost
    currentDir: string
    reloadToken: number
    connections: vault.ConnectionSummary[]
    // The other pane's host — shown in the transfer button label ("→ Local").
    otherLabel: string
    onPickHost: (host: PaneHost) => void
    onNavigate: (dir: string) => void
    // Reloads this pane's listing without changing directory.
    //
    // Separate from onNavigate because navigating to the directory you are
    // already in changes nothing the loader watches, so it silently does
    // NOTHING — which is exactly why deleting a file left it on screen until
    // you clicked away and back.
    onRefresh: () => void
    // Opens a remote file in an in-app editor tab. Optional: a pane rendered
    // somewhere without an editor to open into simply does not pass it, and
    // double-clicking a file stays a no-op there.
    onOpenFile?: (path: string) => void
    onError: (msg: string) => void
    // Begins a transfer of items from THIS pane to the other one (drag→drop
    // onto the other pane, or the explicit transfer button).
    onTransfer: (items: TransferItem[]) => void
    // Shared drag payload: set on dragstart here, read on drop in the other
    // pane. A ref (not state) so a drag never re-renders either pane.
    dragRef: React.MutableRefObject<TransferItem[] | null>
    // Files dragged in from Finder/Explorer and dropped on this pane. Optional
    // for the same reason as onOpenFile — a pane rendered without it simply
    // does not accept OS drops.
    onDropFromDesktop?: (paths: string[]) => void
}

function entryItems(entries: sftpx.FileEntry[]): TransferItem[] {
    return entries.map((e) => ({path: e.path, isDir: e.isDir}))
}

type SortCol = 'name' | 'modified' | 'size' | 'kind' | 'perms'

// Column widths in pixels, resizable by dragging the divider in the header.
//
// The two panes split a window between them, so the useful width per pane is
// half of what a file manager normally gets: whichever column matters right now
// (a long name, or the permissions) has to be able to take space from the
// others. Fixed proportions cannot do that.
type ColWidths = Record<SortCol, number>

const DEFAULT_WIDTHS: ColWidths = {name: 260, modified: 150, size: 80, kind: 70, perms: 100}

// MIN_COL_WIDTH stops a column from being dragged to nothing: a zero-width
// column is unrecoverable, since its own divider is what you would need to grab
// to bring it back.
const MIN_COL_WIDTH = 48

function ResizableHeader({
    label,
    col,
    active,
    dir,
    onSort,
    onResize,
    className,
    last,
}: {
    label: string
    col: SortCol
    active: SortCol
    dir: 'asc' | 'desc'
    onSort: (c: SortCol) => void
    onResize: (col: SortCol, deltaX: number, commit: boolean) => void
    className?: string
    // The last column has no divider — there is nothing to its right to take
    // width from, so a handle there would only ever do nothing.
    last?: boolean
}) {
    const isActive = active === col

    function startResize(ev: React.MouseEvent) {
        // Stop the mousedown from reaching the sort button: a resize that also
        // re-sorts the listing is a drag that ends somewhere unexpected.
        ev.preventDefault()
        ev.stopPropagation()
        const startX = ev.clientX

        function onMove(e: MouseEvent) {
            onResize(col, e.clientX - startX, false)
        }
        function onUp(e: MouseEvent) {
            onResize(col, e.clientX - startX, true)
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
            document.body.style.cursor = ''
        }
        // The cursor is forced on the body for the whole drag: without it the
        // pointer flickers back to the default the moment it leaves the 5px
        // handle, which it does immediately.
        document.body.style.cursor = 'col-resize'
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
    }

    return (
        <th className={`relative px-2 py-1.5 font-medium ${className ?? ''}`}>
            <button
                type="button"
                onClick={() => onSort(col)}
                className={`inline-flex max-w-full items-center gap-0.5 truncate hover:text-on-surface ${isActive ? 'text-on-surface' : ''}`}
                title={`Ordenar por ${label.toLowerCase()}`}
            >
                <span className="truncate">{label}</span>
                {isActive && <Icon name={dir === 'asc' ? 'arrow_upward' : 'arrow_downward'} size={13} className="shrink-0" />}
            </button>
            {!last && (
                <div
                    onMouseDown={startResize}
                    onClick={(e) => e.stopPropagation()}
                    title="Arrastrar para cambiar el ancho de la columna. Doble click restaura el ancho original."
                    onDoubleClick={(e) => {
                        e.stopPropagation()
                        onResize(col, NaN, true) // NaN = restaurar el ancho por defecto
                    }}
                    className="absolute top-0 -right-[3px] z-20 h-full w-[6px] cursor-col-resize hover:bg-primary/40"
                />
            )}
        </th>
    )
}

// "Kind" column, Finder-style: a folder, or the file's extension (tar, log,
// sql…), or "archivo" when it has none.
function kindOf(e: sftpx.FileEntry): string {
    if (e.isDir) return 'carpeta'
    const dot = e.name.lastIndexOf('.')
    return dot > 0 && dot < e.name.length - 1 ? e.name.slice(dot + 1).toLowerCase() : 'archivo'
}

function formatDate(unixSeconds: number): string {
    if (!unixSeconds) return '—'
    return new Date(unixSeconds * 1000).toLocaleString(undefined, {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    })
}

// Folders always sort before files (standard file-manager behavior); within
// each group, by the chosen column and direction.
function sortEntriesBy(entries: sftpx.FileEntry[], col: SortCol, dir: 'asc' | 'desc'): sftpx.FileEntry[] {
    const sign = dir === 'asc' ? 1 : -1
    return [...entries].sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        let r = 0
        switch (col) {
            case 'name':
                r = a.name.localeCompare(b.name)
                break
            case 'modified':
                r = a.modTime - b.modTime
                break
            case 'size':
                r = a.size - b.size
                break
            case 'kind':
                r = kindOf(a).localeCompare(kindOf(b))
                break
            case 'perms':
                r = a.mode.localeCompare(b.mode)
                break
        }
        return r === 0 ? a.name.localeCompare(b.name) * sign : r * sign
    })
}

export default function SftpPane({
    host,
    currentDir,
    reloadToken,
    connections,
    otherLabel,
    onPickHost,
    onNavigate,
    onRefresh,
    onOpenFile,
    onError,
    onTransfer,
    dragRef,
    onDropFromDesktop,
}: SftpPaneProps) {
    const [entries, setEntries] = useState<sftpx.FileEntry[]>([])
    const [loading, setLoading] = useState(false)
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const [hostMenuOpen, setHostMenuOpen] = useState(false)
    const [dragOver, setDragOver] = useState(false)
    // Root element, registered as an OS drop zone below.
    const rootRef = useRef<HTMLDivElement | null>(null)
    const [newFolder, setNewFolder] = useState('')
    const [creatingFolder, setCreatingFolder] = useState(false)
    // Following the terminal is OFF by default, per pane. That default is
    // what keeps a standalone SFTP tab behaving exactly as before: with
    // nobody subscribed, the terminal's publishing is a no-op.
    const [followTerminal, setFollowTerminal] = useState(false)
    const [lastCtx, setLastCtx] = useState<SessionContext | null>(null)
    // Whether this host has an interactive shell open right now. The three
    // terminal-sync buttons below are meaningless without one: there is
    // nothing to follow, no path to pull, and nowhere to send a cd.
    const [shellLive, setShellLive] = useState(false)

    useEffect(() => {
        const connId = host.connId
        if (host.kind !== 'remote' || !connId) {
            setShellLive(false)
            return
        }
        setShellLive(isTerminalLive(connId))
        return subscribeTerminalLive(connId, setShellLive)
    }, [host.kind, host.connId])

    // Subscribe only while the toggle is on AND this pane is pointed at a
    // real host — a local pane has no terminal to follow.
    useEffect(() => {
        const connId = host.connId
        if (!followTerminal || !shellLive || host.kind !== 'remote' || !connId) return

        // Jump to wherever the shell already is, so turning the switch on
        // does something immediately instead of waiting for the next cd.
        const now = currentCwd(connId)
        if (now) {
            setLastCtx(now)
            onNavigate(now.cwd)
        }

        return subscribeCwd(connId, (ctx) => {
            setLastCtx(ctx)
            onNavigate(ctx.cwd)
        })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [followTerminal, shellLive, host.kind, host.connId])
    const [renaming, setRenaming] = useState<sftpx.FileEntry | null>(null)
    const [renameValue, setRenameValue] = useState('')
    const [confirmDelete, setConfirmDelete] = useState<TransferItem[] | null>(null)
    // Right-click context menu (position + which entry it targets) and the
    // permissions dialog it can open.
    const [menu, setMenu] = useState<{x: number; y: number; entry: sftpx.FileEntry} | null>(null)
    const [permsFor, setPermsFor] = useState<sftpx.FileEntry | null>(null)
    const [sortCol, setSortCol] = useState<SortCol>('name')
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
    // Name filter, applied locally over the directory already listed — it never
    // re-queries the server. A folder with hundreds of entries is unusable
    // otherwise, and the alternative (a remote glob) would need a round trip
    // per keystroke to answer something the pane already has in memory.
    const [filter, setFilter] = useState('')
    const [colWidths, setColWidths] = useState<ColWidths>(DEFAULT_WIDTHS)
    // Width at the moment a resize drag started, so the delta is applied to a
    // fixed base instead of compounding on every mousemove.
    // Updated on every committed resize, so the next drag starts from where the
    // previous one ended.
    const resizeBase = useRef<ColWidths>(DEFAULT_WIDTHS)
    // The row a Shift+click measures its range from. Refs, not state: it is read
    // inside the click handler and a re-render in between would be pointless.
    const anchorRef = useRef<string | null>(null)

    function resizeColumn(col: SortCol, deltaX: number, commit: boolean) {
        // NaN is the double-click "restore this column" signal.
        if (Number.isNaN(deltaX)) {
            setColWidths((w) => ({...w, [col]: DEFAULT_WIDTHS[col]}))
            resizeBase.current = {...resizeBase.current, [col]: DEFAULT_WIDTHS[col]}
            return
        }
        setColWidths((w) => {
            const next = {...w, [col]: Math.max(MIN_COL_WIDTH, resizeBase.current[col] + deltaX)}
            if (commit) resizeBase.current = next
            return next
        })
    }

    // Click a header to sort by it; click the active one again to flip the
    // direction (Finder behavior).
    function sortBy(col: SortCol) {
        if (col === sortCol) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
        else {
            setSortCol(col)
            setSortDir('asc')
        }
    }
    // Guards against a slow ListSftpDir resolving after the pane has already
    // navigated elsewhere and overwriting the newer listing (classic stale
    // async race — same generation-token idea as the WS anti-zombie guards).
    // Accept files dragged from Finder/Explorer. The handler is kept in a ref
    // so the zone is registered ONCE per mount: re-registering on every render
    // (which a prop dependency would cause) would tear down and reinstall the
    // native drop handler mid-drag.
    const dropHandlerRef = useRef(onDropFromDesktop)
    dropHandlerRef.current = onDropFromDesktop
    useEffect(() => {
        const el = rootRef.current
        if (!el) return
        return registerDropZone(el, (paths) => dropHandlerRef.current?.(paths))
    }, [])

    const loadGen = useRef(0)

    useEffect(() => {
        if (host.kind === 'none') {
            setEntries([])
            setSelected(new Set())
            return
        }
        const gen = ++loadGen.current
        setLoading(true)
        ListSftpDir(host.sessionId, currentDir)
            .then((res) => {
                if (gen !== loadGen.current) return
                setEntries(res ?? [])
                setSelected(new Set())
            })
            .catch((err) => {
                if (gen !== loadGen.current) return
                onError(String(err))
            })
            .finally(() => {
                if (gen === loadGen.current) setLoading(false)
            })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [host.sessionId, host.kind, currentDir, reloadToken])

    // Selection, the way a file manager does it.
    //
    // Before this, a plain click TOGGLED the row, so the selection grew with
    // every click and never shrank without clicking each row again. Now:
    //   - plain click     → select only that row
    //   - Ctrl/Cmd+click  → add or remove that row, keeping the rest
    //   - Shift+click     → select the range from the anchor to that row
    //   - the checkbox    → toggles without disturbing anything else, which is
    //                       what makes selecting several things possible without
    //                       having to hold a modifier at all
    function clickRow(path: string, ev: React.MouseEvent) {
        const additive = ev.metaKey || ev.ctrlKey
        const ranged = ev.shiftKey

        if (ranged && anchorRef.current) {
            const order = visible.map((v) => v.path)
            const from = order.indexOf(anchorRef.current)
            const to = order.indexOf(path)
            if (from >= 0 && to >= 0) {
                const [lo, hi] = from <= to ? [from, to] : [to, from]
                const range = order.slice(lo, hi + 1)
                // Shift EXTENDS an existing selection when combined with Ctrl,
                // and replaces it otherwise — same as Finder and Explorer.
                setSelected((prev) => (additive ? new Set([...prev, ...range]) : new Set(range)))
                return
            }
        }

        anchorRef.current = path
        if (additive) {
            toggleOne(path)
            return
        }
        // A plain click on the only selected row clears it, so there is a way
        // back to "nothing selected" without reaching for a modifier.
        setSelected((prev) => (prev.size === 1 && prev.has(path) ? new Set() : new Set([path])))
    }

    function toggleOne(path: string) {
        anchorRef.current = path
        setSelected((prev) => {
            const next = new Set(prev)
            if (next.has(path)) next.delete(path)
            else next.add(path)
            return next
        })
    }

    function selectedItems(): TransferItem[] {
        return entryItems(entries.filter((e) => selected.has(e.path)))
    }

    // The items an action on `e` should affect: the whole selection if the
    // target row is part of it, otherwise just that row. Shared by drag,
    // "Enviar" and "Eliminar" so they all behave consistently.
    function itemsForEntry(e: sftpx.FileEntry): TransferItem[] {
        const sel = selectedItems()
        return selected.has(e.path) && sel.length > 0 ? sel : [{path: e.path, isDir: e.isDir}]
    }

    function startDrag(e: sftpx.FileEntry) {
        dragRef.current = itemsForEntry(e)
    }

    function onDrop() {
        setDragOver(false)
        const items = dragRef.current
        dragRef.current = null
        if (items && items.length > 0) onTransfer(items)
    }

    function createFolder() {
        const name = newFolder.trim()
        if (!name) return
        MakeSftpDir(host.sessionId, joinPath(currentDir, name))
            .then(() => {
                setNewFolder('')
                setCreatingFolder(false)
                onRefresh()
            })
            .catch((err) => onError(String(err)))
    }

    function doRename() {
        if (!renaming) return
        const name = renameValue.trim()
        if (!name || name === renaming.name) {
            setRenaming(null)
            return
        }
        RenameSftpPath(host.sessionId, renaming.path, joinPath(dirname(renaming.path), name))
            .then(() => {
                setRenaming(null)
                onRefresh()
            })
            .catch((err) => onError(String(err)))
    }

    function doDelete(items: TransferItem[]) {
        Promise.all(items.map((it) => DeleteSftpPath(host.sessionId, it.path)))
            .then(() => onRefresh())
            .catch((err) => onError(String(err)))
    }

    // The rows actually on screen: filtered, then sorted. One source for the
    // rows, the Shift range and the counters — computing them separately is how
    // "select all" ends up selecting things the filter is hiding.
    const q = filter.trim().toLowerCase()
    const visible = sortEntriesBy(
        q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries,
        sortCol,
        sortDir,
    )
    const allVisibleSelected = visible.length > 0 && visible.every((e) => selected.has(e.path))
    // Floor width of the table. 28px is the checkbox column, which is not
    // resizable; the permissions column has no fixed width at all (it absorbs
    // whatever is left over, which is also why it has no resize handle), so it
    // only contributes its default here as a floor.
    //
    // The table renders with `width: 100%` and this as `minWidth`, under
    // `table-layout: fixed`: fixed makes the colgroup widths literal instead of
    // renegotiated against the content, 100% keeps the sticky header spanning a
    // wide pane instead of stopping short of the right edge, and minWidth is
    // what makes it scroll horizontally once the columns no longer fit.
    const totalWidth =
        28 + colWidths.name + colWidths.modified + colWidths.size + colWidths.kind + DEFAULT_WIDTHS.perms

    function toggleAllVisible() {
        setSelected((prev) => {
            if (allVisibleSelected) {
                const next = new Set(prev)
                visible.forEach((e) => next.delete(e.path))
                return next
            }
            return new Set([...prev, ...visible.map((e) => e.path)])
        })
    }

    const canAct = host.kind !== 'none'
    const parent = canAct ? dirname(currentDir) : ''
    const showParent = canAct && parent !== currentDir

    return (
        <div ref={rootRef} className="flex min-h-0 min-w-0 flex-1 flex-col border-outline-variant">
            {/* Host bar */}
            <div className="relative flex shrink-0 items-center gap-2 border-b border-outline-variant bg-surface-container-low px-2 py-1.5">
                <button
                    onClick={() => setHostMenuOpen((v) => !v)}
                    title="Elegir host de este panel"
                    className="flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-on-surface hover:bg-surface-variant"
                >
                    <Icon name={host.kind === 'local' ? 'computer' : host.kind === 'remote' ? 'dns' : 'add_link'} size={16} />
                    {host.kind === 'none' ? 'Elegir host' : host.connName}
                    <Icon name="arrow_drop_down" size={16} />
                </button>
                {canAct && (
                    <span className="min-w-0 flex-1 truncate text-[11px] text-on-surface-variant" title={currentDir}>
                        {currentDir}
                    </span>
                )}
                <div className="ml-auto flex items-center gap-0.5">
                    {host.kind === 'remote' && host.connId && (
                        <>
                            <button
                                onClick={() => setFollowTerminal((v) => !v)}
                                disabled={!shellLive}
                                title={
                                    !shellLive
                                        ? 'No hay una consola abierta contra este servidor. Abrí la sesión combinada (o una pestaña de terminal de este host) y el botón se activa.'
                                        : !followTerminal
                                        ? 'Seguir a la terminal: cuando hagas cd en la consola, este panel navega a la misma carpeta. Desactivado, el panel no reacciona a la consola.'
                                        : !lastCtx
                                          ? 'Siguiendo a la terminal — todavía no sabe dónde está parada la consola. Se moverá con el próximo cd que escribas. Si tu shell anuncia la ruta (OSC 7) será exacta; si no, se deduce del cd.'
                                          : lastCtx.source === 'guess'
                                            ? 'Siguiendo a la terminal. La ruta se dedujo del cd que escribiste: si usás alias o un script que cambia de carpeta, puede quedar desfasada — usá «Traer ruta de la terminal» para corregirla.'
                                            : 'Siguiendo a la terminal. La ruta la anuncia el propio shell, así que es exacta.'
                                }
                                className={`relative rounded p-1 disabled:opacity-40 disabled:hover:bg-transparent ${
                                    followTerminal && shellLive
                                        ? 'bg-primary/15 text-primary'
                                        : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
                                }`}
                            >
                                <Icon name="link" size={16} />
                                {/* Following but with nothing to follow yet is
                                    the state that reads as "the button did
                                    nothing". Marked explicitly instead. */}
                                {followTerminal && shellLive && !lastCtx && (
                                    <span
                                        aria-hidden
                                        className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-amber-500 dark:bg-amber-400"
                                    />
                                )}
                            </button>
                            <button
                                onClick={() => {
                                    const ctx = currentCwd(host.connId!)
                                    if (ctx) onNavigate(ctx.cwd)
                                }}
                                disabled={!shellLive}
                                title={
                                    shellLive
                                        ? 'Traer la ruta actual de la terminal una sola vez, sin activar el seguimiento. Es la salida cuando la detección automática no acierta (alias, shells no estándar, scripts que cambian de carpeta).'
                                        : 'No hay una consola abierta contra este servidor. Abrí la sesión combinada (o una pestaña de terminal de este host) y el botón se activa.'
                                }
                                className="rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-40 disabled:hover:bg-transparent"
                            >
                                <Icon name="download" size={16} />
                            </button>
                            <button
                                onClick={() => {
                                    // Send the cd to the shell AND record it,
                                    // so the two sides agree without waiting
                                    // for the echo to be parsed back.
                                    void WriteSSHTerminal(host.connId!, `cd ${shellQuotePath(currentDir)}\n`)
                                    publishCwd(host.connId!, currentDir, 'manual')
                                }}
                                disabled={!canAct || !shellLive}
                                title={
                                    shellLive
                                        ? 'Manda «cd» a la terminal para que la consola se pare en esta misma carpeta'
                                        : 'No hay una consola abierta contra este servidor. Abrí la sesión combinada (o una pestaña de terminal de este host) y el botón se activa.'
                                }
                                className="rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-40 disabled:hover:bg-transparent"
                            >
                                <Icon name="upload" size={16} />
                            </button>
                        </>
                    )}
                    <button
                        onClick={() => canAct && setCreatingFolder(true)}
                        disabled={!canAct}
                        title="Nueva carpeta"
                        className="rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-40"
                    >
                        <Icon name="create_new_folder" size={16} />
                    </button>
                    <button
                        onClick={() => canAct && onRefresh()}
                        disabled={!canAct}
                        title="Refrescar"
                        className="rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-40"
                    >
                        <Icon name="refresh" size={16} />
                    </button>
                </div>

                {hostMenuOpen && (
                    <>
                        <div className="fixed inset-0 z-40" onClick={() => setHostMenuOpen(false)} />
                        <div className="absolute left-2 top-full z-50 mt-1 w-56 rounded-lg border border-outline-variant bg-surface-container-high p-1 shadow-lg">
                            <button
                                onClick={() => {
                                    setHostMenuOpen(false)
                                    onPickHost({kind: 'local', connId: null, connName: 'Local', sessionId: LOCAL_SESSION})
                                }}
                                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-on-surface hover:bg-surface-variant"
                            >
                                <Icon name="computer" size={16} /> Local (esta máquina)
                            </button>
                            {connections.length > 0 && <div className="my-1 border-t border-outline-variant" />}
                            {connections.map((c) => (
                                <button
                                    key={c.id}
                                    onClick={() => {
                                        setHostMenuOpen(false)
                                        onPickHost({kind: 'remote', connId: c.id, connName: c.name, sessionId: `sftp:${c.id}`})
                                    }}
                                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-on-surface hover:bg-surface-variant"
                                >
                                    <Icon name="dns" size={16} /> {c.name}
                                </button>
                            ))}
                        </div>
                    </>
                )}
            </div>

            {/* Action row */}
            {canAct && (
                <div className="flex shrink-0 items-center gap-1 border-b border-outline-variant px-2 py-1">
                    <button
                        onClick={() => onTransfer(selectedItems())}
                        disabled={selected.size === 0}
                        title={`Transferir la selección a ${otherLabel}`}
                        className="flex items-center gap-1 rounded bg-secondary/15 px-2 py-1 text-[11px] font-medium text-secondary hover:bg-secondary/25 disabled:opacity-40"
                    >
                        <Icon name="send" size={14} /> Enviar a {otherLabel}
                    </button>
                    <button
                        onClick={() => setConfirmDelete(selectedItems())}
                        disabled={selected.size === 0}
                        title="Eliminar la selección"
                        className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-on-surface-variant hover:bg-error-container/40 hover:text-error disabled:opacity-40"
                    >
                        <Icon name="delete" size={14} /> Eliminar
                    </button>
                    <div className="relative ml-auto flex items-center">
                        <Icon name="search" size={13} className="pointer-events-none absolute left-1.5 text-on-surface-variant" />
                        <input
                            value={filter}
                            onChange={(ev) => setFilter(ev.target.value)}
                            onKeyDown={(ev) => {
                                if (ev.key === 'Escape') setFilter('')
                            }}
                            placeholder="Buscar en esta carpeta"
                            title="Filtra por nombre lo que ya está listado en esta carpeta. No baja a las subcarpetas ni vuelve a consultar el servidor. Esc limpia."
                            className="w-36 rounded border border-outline bg-surface py-0.5 pr-5 pl-6 text-[11px] text-on-surface placeholder:text-on-surface-variant/60 focus:w-48 focus:outline-none"
                        />
                        {filter && (
                            <button
                                onClick={() => setFilter('')}
                                title="Limpiar el filtro"
                                className="absolute right-1 text-on-surface-variant hover:text-on-surface"
                            >
                                <Icon name="close" size={12} />
                            </button>
                        )}
                    </div>
                    <span className="shrink-0 text-[11px] text-on-surface-variant">
                        {selected.size > 0
                            ? `${selected.size} seleccionado(s)`
                            : q
                              ? `${visible.length} de ${entries.length}`
                              : `${entries.length} elementos`}
                    </span>
                </div>
            )}

            {/* Listing / drop target */}
            <div
                onDragOver={(e) => {
                    if (dragRef.current && canAct) {
                        e.preventDefault()
                        setDragOver(true)
                    }
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                className={`min-h-0 flex-1 overflow-auto ${dragOver ? 'bg-primary/10 ring-2 ring-inset ring-primary' : ''}`}
            >
                {host.kind === 'none' ? (
                    <div className="flex h-full flex-col items-center justify-center gap-2 text-on-surface-variant">
                        <Icon name="folder_open" size={40} className="opacity-40" />
                        <p className="text-xs">Elegí un host para explorar sus archivos</p>
                    </div>
                ) : loading ? (
                    <div className="flex h-full items-center justify-center text-xs text-on-surface-variant">Cargando…</div>
                ) : (
                    <table className="text-xs" style={{width: '100%', minWidth: totalWidth, tableLayout: 'fixed'}}>
                        <colgroup>
                            <col style={{width: 28}} />
                            <col style={{width: colWidths.name}} />
                            <col style={{width: colWidths.modified}} />
                            <col style={{width: colWidths.size}} />
                            <col style={{width: colWidths.kind}} />
                            <col />
                        </colgroup>
                        <thead className="sticky top-0 z-10 bg-surface-container-low text-on-surface-variant">
                            <tr className="border-b border-outline-variant">
                                <th className="px-2 py-1.5">
                                    <input
                                        type="checkbox"
                                        checked={allVisibleSelected}
                                        onChange={toggleAllVisible}
                                        title={
                                            q
                                                ? 'Seleccionar o deseleccionar todo lo que muestra el filtro'
                                                : 'Seleccionar o deseleccionar todo'
                                        }
                                        className="h-3.5 w-3.5 cursor-pointer accent-primary align-middle"
                                    />
                                </th>
                                <ResizableHeader label="Nombre" col="name" active={sortCol} dir={sortDir} onSort={sortBy} onResize={resizeColumn} className="text-left" />
                                <ResizableHeader label="Fecha modificación" col="modified" active={sortCol} dir={sortDir} onSort={sortBy} onResize={resizeColumn} className="text-left" />
                                <ResizableHeader label="Tamaño" col="size" active={sortCol} dir={sortDir} onSort={sortBy} onResize={resizeColumn} className="text-right" />
                                <ResizableHeader label="Kind" col="kind" active={sortCol} dir={sortDir} onSort={sortBy} onResize={resizeColumn} className="text-left" />
                                <ResizableHeader label="Permisos" col="perms" active={sortCol} dir={sortDir} onSort={sortBy} onResize={resizeColumn} className="text-left" last />
                            </tr>
                        </thead>
                        <tbody>
                            {showParent && !q && (
                                <tr
                                    onDoubleClick={() => onNavigate(parent)}
                                    className="cursor-pointer select-none hover:bg-surface-variant"
                                >
                                    <td />
                                    <td className="flex items-center gap-1.5 px-2 py-1 text-on-surface-variant">
                                        <Icon name="drive_folder_upload" size={16} /> ..
                                    </td>
                                    <td colSpan={4} />
                                </tr>
                            )}
                            {visible.map((e) => (
                                <tr
                                    key={e.path}
                                    draggable
                                    onDragStart={() => startDrag(e)}
                                    onClick={(ev) => clickRow(e.path, ev)}
                                    onDoubleClick={() => (e.isDir ? onNavigate(e.path) : onOpenFile?.(e.path))}
                                    onContextMenu={(ev) => {
                                        ev.preventDefault()
                                        // Right-clicking outside the selection targets that row alone,
                                        // so the menu never acts on something you cannot see.
                                        if (!selected.has(e.path)) setSelected(new Set([e.path]))
                                        setMenu({x: ev.clientX, y: ev.clientY, entry: e})
                                    }}
                                    className={`group cursor-pointer select-none ${
                                        selected.has(e.path) ? 'bg-primary/15' : 'hover:bg-surface-variant'
                                    }`}
                                >
                                    <td className="px-2 py-1">
                                        <input
                                            type="checkbox"
                                            checked={selected.has(e.path)}
                                            onChange={() => toggleOne(e.path)}
                                            // The row handler would otherwise run too and replace the
                                            // selection the checkbox just added to.
                                            onClick={(ev) => ev.stopPropagation()}
                                            className="h-3.5 w-3.5 cursor-pointer accent-primary align-middle"
                                        />
                                    </td>
                                    <td className="px-2 py-1 text-on-surface">
                                        <div className="flex items-center gap-1.5">
                                            <Icon
                                                name={e.isDir ? 'folder' : 'draft'}
                                                size={16}
                                                className={`shrink-0 ${e.isDir ? 'text-primary' : 'text-on-surface-variant'}`}
                                            />
                                            <span className="truncate" title={e.name}>
                                                {e.name}
                                            </span>
                                        </div>
                                    </td>
                                    <td className="truncate px-2 py-1 text-on-surface-variant">{formatDate(e.modTime)}</td>
                                    <td className="truncate px-2 py-1 text-right text-on-surface-variant">
                                        {e.isDir ? '—' : formatBytes(e.size)}
                                    </td>
                                    <td className="truncate px-2 py-1 text-on-surface-variant">{kindOf(e)}</td>
                                    <td className="truncate px-2 py-1 font-mono text-on-surface-variant" title={e.mode}>
                                        {e.mode}
                                    </td>
                                </tr>
                            ))}
                            {visible.length === 0 && (
                                <tr>
                                    <td colSpan={6} className="px-3 py-6 text-center text-on-surface-variant">
                                        {q ? `Ningún archivo de esta carpeta coincide con "${filter}"` : 'La carpeta está vacía'}
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                )}
            </div>

            {/* Right-click context menu */}
            {menu && (
                <>
                    <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} onContextMenu={(e) => {
                        e.preventDefault()
                        setMenu(null)
                    }} />
                    <div
                        style={{position: 'fixed', top: menu.y, left: menu.x}}
                        className="z-50 w-52 rounded-lg border border-outline-variant bg-surface-container-high p-1 text-xs text-on-surface shadow-lg"
                    >
                        <button
                            onClick={() => {
                                onTransfer(itemsForEntry(menu.entry))
                                setMenu(null)
                            }}
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-surface-variant"
                        >
                            <Icon name="send" size={15} /> Enviar a {otherLabel}
                        </button>
                        <button
                            onClick={() => {
                                setRenaming(menu.entry)
                                setRenameValue(menu.entry.name)
                                setMenu(null)
                            }}
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-surface-variant"
                        >
                            <Icon name="edit" size={15} /> Renombrar
                        </button>
                        <button
                            onClick={() => {
                                setConfirmDelete(itemsForEntry(menu.entry))
                                setMenu(null)
                            }}
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-error hover:bg-error-container/40"
                        >
                            <Icon name="delete" size={15} /> Eliminar
                        </button>
                        <div className="my-1 border-t border-outline-variant" />
                        <button
                            onClick={() => {
                                onRefresh()
                                setMenu(null)
                            }}
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-surface-variant"
                        >
                            <Icon name="refresh" size={15} /> Refrescar
                        </button>
                        <button
                            onClick={() => {
                                setCreatingFolder(true)
                                setMenu(null)
                            }}
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-surface-variant"
                        >
                            <Icon name="create_new_folder" size={15} /> Nueva carpeta
                        </button>
                        <button
                            onClick={() => {
                                setPermsFor(menu.entry)
                                setMenu(null)
                            }}
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-surface-variant"
                        >
                            <Icon name="lock" size={15} /> Editar permisos
                        </button>
                    </div>
                </>
            )}

            {permsFor && (
                <SftpPermissionsDialog
                    sessionId={host.sessionId}
                    path={permsFor.path}
                    name={permsFor.name}
                    onClose={() => setPermsFor(null)}
                    onSaved={() => onRefresh()}
                    onError={onError}
                />
            )}

            {/* New folder inline dialog */}
            {creatingFolder && (
                <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60" onClick={() => setCreatingFolder(false)}>
                    <div
                        onClick={(e) => e.stopPropagation()}
                        className="flex w-80 flex-col gap-3 rounded-xl border border-outline-variant bg-surface-container-high p-5 text-on-surface shadow-lg"
                    >
                        <h3 className="text-sm font-semibold">Nueva carpeta</h3>
                        <input
                            autoFocus
                            value={newFolder}
                            onChange={(e) => setNewFolder(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && createFolder()}
                            placeholder="Nombre de la carpeta"
                            className="rounded border-none bg-surface-container-highest px-2 py-1.5 text-sm text-on-surface outline-none"
                        />
                        <div className="flex justify-end gap-2">
                            <button onClick={() => setCreatingFolder(false)} className="rounded-lg px-3 py-1.5 text-sm text-on-surface-variant hover:text-on-surface">
                                Cancelar
                            </button>
                            <button onClick={createFolder} className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-on-primary hover:opacity-90">
                                Crear
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Rename inline dialog */}
            {renaming && (
                <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60" onClick={() => setRenaming(null)}>
                    <div
                        onClick={(e) => e.stopPropagation()}
                        className="flex w-80 flex-col gap-3 rounded-xl border border-outline-variant bg-surface-container-high p-5 text-on-surface shadow-lg"
                    >
                        <h3 className="text-sm font-semibold">Renombrar</h3>
                        <input
                            autoFocus
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && doRename()}
                            className="rounded border-none bg-surface-container-highest px-2 py-1.5 text-sm text-on-surface outline-none"
                        />
                        <div className="flex justify-end gap-2">
                            <button onClick={() => setRenaming(null)} className="rounded-lg px-3 py-1.5 text-sm text-on-surface-variant hover:text-on-surface">
                                Cancelar
                            </button>
                            <button onClick={doRename} className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-on-primary hover:opacity-90">
                                Renombrar
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {confirmDelete && (
                <ConfirmDialog
                    title="Eliminar"
                    description={`Se eliminará(n) ${confirmDelete.length} elemento(s) de forma permanente. Las carpetas se borran con todo su contenido.`}
                    confirmLabel="Eliminar"
                    danger
                    onConfirm={() => doDelete(confirmDelete)}
                    onClose={() => setConfirmDelete(null)}
                />
            )}
        </div>
    )
}

// shellQuotePath wraps a path in single quotes for the remote shell,
// escaping any single quote inside it the POSIX way ('\'' closes, escapes,
// reopens). Paths with spaces are ordinary; sending one unquoted would make
// the shell read it as several arguments.
function shellQuotePath(path: string): string {
    return "'" + path.replace(/'/g, "'\\''") + "'"
}
