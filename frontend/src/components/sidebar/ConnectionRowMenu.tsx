import {useRef, useState, type MouseEvent as ReactMouseEvent} from 'react'
import {createPortal} from 'react-dom'
import {vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'

// One entry of the menu. `danger` puts it below a separator in error colours —
// there is exactly one of those, and keeping it apart from the rest is the
// whole point of moving these out of the icon row.
export interface RowMenuItem {
    icon: string
    label: string
    title?: string
    danger?: boolean
    onSelect: () => void
}

interface ConnectionRowMenuProps {
    items: RowMenuItem[]
    flatFolders: {folder: vault.Folder; depth: number}[]
    onMoveToFolder: (folderId: string) => void
}

// Overflow menu for a database connection row's secondary actions.
//
// Same reasoning and same shape as SshRowMenu: a row carrying eight unlabelled
// icons is not a menu, and "eliminar" sitting a few pixels from the action you
// wanted is a real hazard. `items` is a list because this row's available
// actions depend on the engine (schema picker only for Postgres/Oracle/SQL
// Server, DDL export only when a schema is selected), so the caller decides
// what exists rather than this component knowing every engine's rules.
//
// Portal + fixed position because the row lives in an overflow-y-auto
// container, where an absolutely positioned dropdown gets clipped.
export default function ConnectionRowMenu({items, flatFolders, onMoveToFolder}: ConnectionRowMenuProps) {
    const [open, setOpen] = useState(false)
    // The folder list is a second view of the same panel, not a sideways
    // flyout — the sidebar is too narrow for one to fit on screen.
    const [view, setView] = useState<'main' | 'folders'>('main')
    const [pos, setPos] = useState({top: 0, left: 0})
    const btnRef = useRef<HTMLButtonElement>(null)

    function toggle(e: ReactMouseEvent) {
        e.stopPropagation()
        const rect = btnRef.current?.getBoundingClientRect()
        if (rect) setPos({top: rect.bottom + 4, left: rect.left})
        setView('main')
        setOpen((v) => !v)
    }

    function close() {
        setOpen(false)
        setView('main')
    }

    const itemClass =
        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'

    const normal = items.filter((i) => !i.danger)
    const dangerous = items.filter((i) => i.danger)

    return (
        <>
            <button
                ref={btnRef}
                onClick={toggle}
                title="Más acciones"
                className={`shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 ${open ? 'block' : 'hidden group-hover:block'}`}
            >
                <Icon name="more_vert" size={15} />
            </button>
            {open &&
                createPortal(
                    <>
                        <div className="fixed inset-0 z-40" onClick={close} />
                        <div
                            style={{position: 'fixed', top: pos.top, left: pos.left}}
                            onClick={(e) => e.stopPropagation()}
                            className="z-50 max-h-80 w-60 cursor-default overflow-y-auto rounded-lg border border-outline-variant bg-surface-container-high p-1 text-on-surface shadow-lg"
                        >
                            {view === 'main' ? (
                                <>
                                    {normal.map((item) => (
                                        <button
                                            key={item.label}
                                            onClick={() => {
                                                item.onSelect()
                                                close()
                                            }}
                                            title={item.title}
                                            className={itemClass}
                                        >
                                            <Icon name={item.icon} size={14} className="shrink-0 opacity-60" />
                                            <span className="truncate">{item.label}</span>
                                        </button>
                                    ))}
                                    <button onClick={() => setView('folders')} className={itemClass}>
                                        <Icon name="drive_file_move" size={14} className="shrink-0 opacity-60" />
                                        Mover a carpeta
                                        <Icon name="chevron_right" size={14} className="ml-auto shrink-0 opacity-60" />
                                    </button>
                                    {dangerous.length > 0 && <div className="my-1 border-t border-outline-variant" />}
                                    {dangerous.map((item) => (
                                        <button
                                            key={item.label}
                                            onClick={() => {
                                                item.onSelect()
                                                close()
                                            }}
                                            title={item.title}
                                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-error hover:bg-error-container/40"
                                        >
                                            <Icon name={item.icon} size={14} className="shrink-0" />
                                            <span className="truncate">{item.label}</span>
                                        </button>
                                    ))}
                                </>
                            ) : (
                                <>
                                    <button onClick={() => setView('main')} className={`${itemClass} font-medium`}>
                                        <Icon name="chevron_left" size={14} className="shrink-0 opacity-60" />
                                        Mover a carpeta
                                    </button>
                                    <div className="my-1 border-t border-outline-variant" />
                                    <button
                                        onClick={() => {
                                            onMoveToFolder('')
                                            close()
                                        }}
                                        className={itemClass}
                                    >
                                        <Icon name="close" size={14} className="shrink-0 opacity-60" />
                                        Sin carpeta
                                    </button>
                                    {flatFolders.map(({folder, depth}) => (
                                        <button
                                            key={folder.id}
                                            onClick={() => {
                                                onMoveToFolder(folder.id)
                                                close()
                                            }}
                                            style={{paddingLeft: `${8 + depth * 12}px`}}
                                            className={`${itemClass} px-0 pr-2`}
                                        >
                                            <Icon name="folder" size={14} className="shrink-0 opacity-60" />
                                            <span className="truncate">{folder.name}</span>
                                        </button>
                                    ))}
                                    {flatFolders.length === 0 && (
                                        <p className="px-2 py-1.5 text-xs text-on-surface-variant">No hay carpetas creadas.</p>
                                    )}
                                </>
                            )}
                        </div>
                    </>,
                    document.body,
                )}
        </>
    )
}
