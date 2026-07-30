import {useRef, useState, type MouseEvent as ReactMouseEvent} from 'react'
import {createPortal} from 'react-dom'
import {vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'

interface SshRowMenuProps {
    flatFolders: {folder: vault.Folder; depth: number}[]
    onOpenTerminal: () => void
    onEdit: () => void
    onMoveToFolder: (folderId: string) => void
    onExport: () => void
    onDelete: () => void
}

// Overflow menu for the secondary actions on an SSH connection row.
//
// The row used to carry seven icon buttons side by side on hover — edit, move,
// export, terminal, SFTP, combined, disconnect, delete — in a sidebar barely
// wide enough for the connection's name. Seven unlabelled icons is not a menu,
// it is a wall: nothing is findable, and the destructive one sits a few pixels
// from the one you actually wanted. What stays on the row are the actions with
// a distinct verb (open files, open combined, disconnect); everything else
// lives here, with words next to it.
//
// Same portal + fixed-position technique as MoveToFolderMenu: the row is inside
// an overflow-y-auto container, where an absolutely positioned dropdown gets
// clipped.
export default function SshRowMenu({flatFolders, onOpenTerminal, onEdit, onMoveToFolder, onExport, onDelete}: SshRowMenuProps) {
    const [open, setOpen] = useState(false)
    // The folder list is a second view of the SAME panel rather than a nested
    // flyout: a submenu that opens sideways off a sidebar this narrow ends up
    // half off-screen.
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
                            className="z-50 max-h-80 w-56 cursor-default overflow-y-auto rounded-lg border border-outline-variant bg-surface-container-high p-1 text-on-surface shadow-lg"
                        >
                            {view === 'main' ? (
                                <>
                                    <button
                                        onClick={() => {
                                            onOpenTerminal()
                                            close()
                                        }}
                                        className={itemClass}
                                    >
                                        <Icon name="terminal" size={14} className="opacity-60" />
                                        Abrir terminal
                                    </button>
                                    <button
                                        onClick={() => {
                                            onEdit()
                                            close()
                                        }}
                                        className={itemClass}
                                    >
                                        <Icon name="edit" size={14} className="opacity-60" />
                                        Editar conexión
                                    </button>
                                    <button onClick={() => setView('folders')} className={itemClass}>
                                        <Icon name="drive_file_move" size={14} className="opacity-60" />
                                        Mover a carpeta
                                        <Icon name="chevron_right" size={14} className="ml-auto opacity-60" />
                                    </button>
                                    <button
                                        onClick={() => {
                                            onExport()
                                            close()
                                        }}
                                        title="Guarda host, puerto y usuario en un archivo — nunca la contraseña ni la llave privada"
                                        className={itemClass}
                                    >
                                        <Icon name="output" size={14} className="opacity-60" />
                                        Exportar configuración
                                    </button>
                                    <div className="my-1 border-t border-outline-variant" />
                                    <button
                                        onClick={() => {
                                            onDelete()
                                            close()
                                        }}
                                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-error hover:bg-error-container/40"
                                    >
                                        <Icon name="delete" size={14} />
                                        Eliminar conexión
                                    </button>
                                </>
                            ) : (
                                <>
                                    <button onClick={() => setView('main')} className={`${itemClass} font-medium`}>
                                        <Icon name="chevron_left" size={14} className="opacity-60" />
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
                                        <Icon name="close" size={14} className="opacity-60" />
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
                                        <p className="px-2 py-1.5 text-xs text-on-surface-variant">
                                            No hay carpetas creadas en el módulo SSH.
                                        </p>
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
