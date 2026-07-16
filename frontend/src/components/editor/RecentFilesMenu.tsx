import {useEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {ClearRecentFiles, ListRecentFiles} from '../../../wailsjs/go/main/App'
import {vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'

interface RecentFilesMenuProps {
    onOpen: (path: string) => void
}

const MENU_WIDTH = 288 // w-72

// Spec: "click en recent reabre tab directo" + "limpiar historial: botón
// manual". A simple dropdown, opened on demand rather than always fetching.
// Portal-based (document.body) + fixed positioning from
// getBoundingClientRect, same pattern as EditorTabs.tsx's per-tab connection
// chip menu and ConnectionTree.tsx's MoveToFolderMenu — this button lives in
// the tab strip, which has overflow-x-auto (so tabs can scroll instead of
// wrapping); a plain position:absolute dropdown there would get clipped
// vertically by that same overflow (the CSS rule where fixing one axis to
// something other than "visible" forces the other axis to behave as "auto"
// too — see those two components' own comments on this exact issue).
export default function RecentFilesMenu({onOpen}: RecentFilesMenuProps) {
    const [open, setOpen] = useState(false)
    const [pos, setPos] = useState({top: 0, left: 0})
    const btnRef = useRef<HTMLButtonElement>(null)
    const [files, setFiles] = useState<vault.RecentFile[]>([])

    useEffect(() => {
        if (open) {
            ListRecentFiles().then(setFiles)
        }
    }, [open])

    function toggleOpen() {
        if (!open) {
            const rect = btnRef.current?.getBoundingClientRect()
            if (rect) setPos({top: rect.bottom + 4, left: Math.max(8, rect.right - MENU_WIDTH)})
        }
        setOpen((v) => !v)
    }

    return (
        <>
            <button
                ref={btnRef}
                onClick={toggleOpen}
                title="Muestra los últimos archivos .sql que abriste, para reabrirlos rápido"
                className="flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium text-on-surface-variant hover:bg-surface-variant"
            >
                <Icon name="history" size={16} />
                Recientes
            </button>
            {open &&
                createPortal(
                    <>
                        <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
                        <div
                            style={{position: 'fixed', top: pos.top, left: pos.left, width: MENU_WIDTH}}
                            onClick={(e) => e.stopPropagation()}
                            className="z-50 rounded-lg border border-outline-variant bg-surface-container-high p-1 text-on-surface shadow-lg"
                        >
                            {files.length === 0 && <p className="p-2 text-xs text-on-surface-variant">Sin archivos recientes.</p>}
                            {files.map((f) => (
                                <button
                                    key={f.path}
                                    onClick={() => {
                                        onOpen(f.path)
                                        setOpen(false)
                                    }}
                                    className="flex w-full items-center gap-2 truncate rounded px-2 py-1 text-left font-mono text-xs text-on-surface hover:bg-surface-variant"
                                    title={f.path}
                                >
                                    <Icon name="description" size={14} className="shrink-0 opacity-60" />
                                    <span className="truncate">{f.path}</span>
                                </button>
                            ))}
                            {files.length > 0 && (
                                <button
                                    onClick={() => {
                                        void ClearRecentFiles().then(() => setFiles([]))
                                    }}
                                    title="Borra la lista de archivos recientes (no borra los archivos, solo el historial)"
                                    className="mt-1 flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                                >
                                    <Icon name="delete_sweep" size={14} />
                                    Limpiar historial
                                </button>
                            )}
                        </div>
                    </>,
                    document.body,
                )}
        </>
    )
}
