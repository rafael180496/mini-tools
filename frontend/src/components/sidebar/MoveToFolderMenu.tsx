import {useRef, useState, type MouseEvent as ReactMouseEvent} from 'react'
import {createPortal} from 'react-dom'
import {vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import type {FolderNode} from '../../lib/folderTree'

// Portal-based "Mover a carpeta ▸" menu on a connection row — same
// createPortal(..., document.body) + fixed-position-from-getBoundingClientRect
// pattern EditorTabs.tsx's per-tab connection chip already established, for
// the same reason: this row sits inside a scrollable container
// (overflow-y-auto), and a plain position:absolute dropdown would get
// clipped vertically (the CSS "fixing one overflow axis forces the other to
// behave as auto too" rule — see EditorTabs.tsx's own comment on this).
// Shared by ConnectionTree.tsx and SshConnectionTree.tsx — both organize
// their own connection type into the SAME folders (backend/vault/folders_repo.go
// has no dbType column), just in two separate module trees.
export default function MoveToFolderMenu({
    connId,
    flatFolders,
    onMove,
}: {
    connId: string
    flatFolders: {folder: vault.Folder; depth: number}[]
    onMove: (connId: string, folderId: string) => void
}) {
    const [open, setOpen] = useState(false)
    const [pos, setPos] = useState({top: 0, left: 0})
    const btnRef = useRef<HTMLButtonElement>(null)

    function openMenu(e: ReactMouseEvent) {
        e.stopPropagation()
        const rect = btnRef.current?.getBoundingClientRect()
        if (rect) setPos({top: rect.bottom + 4, left: rect.left})
        setOpen((v) => !v)
    }

    return (
        <>
            <button
                ref={btnRef}
                onClick={openMenu}
                title="Mover a carpeta"
                className="hidden shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 group-hover:block"
            >
                <Icon name="drive_file_move" size={15} />
            </button>
            {open &&
                createPortal(
                    <>
                        <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
                        <div
                            style={{position: 'fixed', top: pos.top, left: pos.left}}
                            onClick={(e) => e.stopPropagation()}
                            className="z-50 max-h-64 w-56 cursor-default overflow-y-auto rounded-lg border border-outline-variant bg-surface-container-high p-1 text-on-surface shadow-lg"
                        >
                            <button
                                onClick={() => {
                                    onMove(connId, '')
                                    setOpen(false)
                                }}
                                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                            >
                                <Icon name="close" size={14} className="opacity-60" />
                                Sin carpeta
                            </button>
                            {flatFolders.map(({folder, depth}) => (
                                <button
                                    key={folder.id}
                                    onClick={() => {
                                        onMove(connId, folder.id)
                                        setOpen(false)
                                    }}
                                    style={{paddingLeft: `${8 + depth * 12}px`}}
                                    className="flex w-full items-center gap-2 rounded py-1.5 pr-2 text-left text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                                >
                                    <Icon name="folder" size={14} className="shrink-0 opacity-60" />
                                    <span className="truncate">{folder.name}</span>
                                </button>
                            ))}
                            {flatFolders.length === 0 && (
                                <p className="px-2 py-1.5 text-xs text-on-surface-variant/60">Sin carpetas todavía.</p>
                            )}
                        </div>
                    </>,
                    document.body,
                )}
        </>
    )
}

export function flattenForMenu(nodes: FolderNode[], depth = 0): {folder: vault.Folder; depth: number}[] {
    return nodes.flatMap((n) => [{folder: n.folder, depth}, ...flattenForMenu(n.children, depth + 1)])
}
