import {useEffect, useRef, useState} from 'react'
import {DeleteSftpPath, ListSftpDir, MakeSftpDir, RenameSftpPath} from '../../../wailsjs/go/main/App'
import {sftpx, vault} from '../../../wailsjs/go/models'
import {formatBytes} from '../../lib/formatBytes'
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
    onError: (msg: string) => void
    // Begins a transfer of items from THIS pane to the other one (drag→drop
    // onto the other pane, or the explicit transfer button).
    onTransfer: (items: TransferItem[]) => void
    // Shared drag payload: set on dragstart here, read on drop in the other
    // pane. A ref (not state) so a drag never re-renders either pane.
    dragRef: React.MutableRefObject<TransferItem[] | null>
}

function entryItems(entries: sftpx.FileEntry[]): TransferItem[] {
    return entries.map((e) => ({path: e.path, isDir: e.isDir}))
}

type SortCol = 'name' | 'modified' | 'size' | 'kind' | 'perms'

function SortHeader({
    label,
    col,
    active,
    dir,
    onSort,
    className,
}: {
    label: string
    col: SortCol
    active: SortCol
    dir: 'asc' | 'desc'
    onSort: (c: SortCol) => void
    className?: string
}) {
    const isActive = active === col
    return (
        <th className={`px-2 py-1.5 font-medium ${className ?? ''}`}>
            <button
                type="button"
                onClick={() => onSort(col)}
                className={`inline-flex items-center gap-0.5 hover:text-on-surface ${isActive ? 'text-on-surface' : ''}`}
                title={`Ordenar por ${label.toLowerCase()}`}
            >
                {label}
                {isActive && <Icon name={dir === 'asc' ? 'arrow_upward' : 'arrow_downward'} size={13} />}
            </button>
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
    onError,
    onTransfer,
    dragRef,
}: SftpPaneProps) {
    const [entries, setEntries] = useState<sftpx.FileEntry[]>([])
    const [loading, setLoading] = useState(false)
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const [hostMenuOpen, setHostMenuOpen] = useState(false)
    const [dragOver, setDragOver] = useState(false)
    const [newFolder, setNewFolder] = useState('')
    const [creatingFolder, setCreatingFolder] = useState(false)
    const [renaming, setRenaming] = useState<sftpx.FileEntry | null>(null)
    const [renameValue, setRenameValue] = useState('')
    const [confirmDelete, setConfirmDelete] = useState<TransferItem[] | null>(null)
    // Right-click context menu (position + which entry it targets) and the
    // permissions dialog it can open.
    const [menu, setMenu] = useState<{x: number; y: number; entry: sftpx.FileEntry} | null>(null)
    const [permsFor, setPermsFor] = useState<sftpx.FileEntry | null>(null)
    const [sortCol, setSortCol] = useState<SortCol>('name')
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

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

    function toggle(path: string) {
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
                onNavigate(currentDir) // refresh
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
                onNavigate(currentDir)
            })
            .catch((err) => onError(String(err)))
    }

    function doDelete(items: TransferItem[]) {
        Promise.all(items.map((it) => DeleteSftpPath(host.sessionId, it.path)))
            .then(() => onNavigate(currentDir))
            .catch((err) => onError(String(err)))
    }

    const canAct = host.kind !== 'none'
    const parent = canAct ? dirname(currentDir) : ''
    const showParent = canAct && parent !== currentDir

    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col border-outline-variant">
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
                    <button
                        onClick={() => canAct && setCreatingFolder(true)}
                        disabled={!canAct}
                        title="Nueva carpeta"
                        className="rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-40"
                    >
                        <Icon name="create_new_folder" size={16} />
                    </button>
                    <button
                        onClick={() => canAct && onNavigate(currentDir)}
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
                    <span className="ml-auto text-[11px] text-on-surface-variant">
                        {selected.size > 0 ? `${selected.size} seleccionado(s)` : `${entries.length} elementos`}
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
                    <table className="w-full text-xs">
                        <thead className="sticky top-0 z-10 bg-surface-container-low text-on-surface-variant">
                            <tr className="border-b border-outline-variant">
                                <SortHeader label="Nombre" col="name" active={sortCol} dir={sortDir} onSort={sortBy} className="text-left" />
                                <SortHeader label="Fecha modificación" col="modified" active={sortCol} dir={sortDir} onSort={sortBy} className="text-left" />
                                <SortHeader label="Tamaño" col="size" active={sortCol} dir={sortDir} onSort={sortBy} className="text-right" />
                                <SortHeader label="Kind" col="kind" active={sortCol} dir={sortDir} onSort={sortBy} className="text-left" />
                                <SortHeader label="Permisos" col="perms" active={sortCol} dir={sortDir} onSort={sortBy} className="text-left" />
                            </tr>
                        </thead>
                        <tbody>
                            {showParent && (
                                <tr
                                    onDoubleClick={() => onNavigate(parent)}
                                    className="cursor-pointer select-none hover:bg-surface-variant"
                                >
                                    <td className="flex items-center gap-1.5 px-2 py-1 text-on-surface-variant">
                                        <Icon name="drive_folder_upload" size={16} /> ..
                                    </td>
                                    <td colSpan={4} />
                                </tr>
                            )}
                            {sortEntriesBy(entries, sortCol, sortDir).map((e) => (
                                <tr
                                    key={e.path}
                                    draggable
                                    onDragStart={() => startDrag(e)}
                                    onClick={() => toggle(e.path)}
                                    onDoubleClick={() => e.isDir && onNavigate(e.path)}
                                    onContextMenu={(ev) => {
                                        ev.preventDefault()
                                        setMenu({x: ev.clientX, y: ev.clientY, entry: e})
                                    }}
                                    className={`group cursor-pointer select-none ${
                                        selected.has(e.path) ? 'bg-primary/15' : 'hover:bg-surface-variant'
                                    }`}
                                >
                                    <td className="max-w-0 px-2 py-1 text-on-surface">
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
                                    <td className="whitespace-nowrap px-2 py-1 text-on-surface-variant">{formatDate(e.modTime)}</td>
                                    <td className="whitespace-nowrap px-2 py-1 text-right text-on-surface-variant">
                                        {e.isDir ? '—' : formatBytes(e.size)}
                                    </td>
                                    <td className="whitespace-nowrap px-2 py-1 text-on-surface-variant">{kindOf(e)}</td>
                                    <td className="whitespace-nowrap px-2 py-1 font-mono text-on-surface-variant" title={e.mode}>
                                        {e.mode}
                                    </td>
                                </tr>
                            ))}
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
                                onNavigate(currentDir)
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
                    onSaved={() => onNavigate(currentDir)}
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
