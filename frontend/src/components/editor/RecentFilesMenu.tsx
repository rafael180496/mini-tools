import {useEffect, useState} from 'react'
import {ClearRecentFiles, ListRecentFiles} from '../../../wailsjs/go/main/App'
import {vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'

interface RecentFilesMenuProps {
    onOpen: (path: string) => void
}

// Spec: "click en recent reabre tab directo" + "limpiar historial: botón
// manual". A simple dropdown, opened on demand rather than always fetching.
export default function RecentFilesMenu({onOpen}: RecentFilesMenuProps) {
    const [open, setOpen] = useState(false)
    const [files, setFiles] = useState<vault.RecentFile[]>([])

    useEffect(() => {
        if (open) {
            ListRecentFiles().then(setFiles)
        }
    }, [open])

    return (
        <div className="relative">
            <button
                onClick={() => setOpen((v) => !v)}
                title="Muestra los últimos archivos .sql que abriste, para reabrirlos rápido"
                className="flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium text-on-surface-variant hover:bg-surface-variant"
            >
                <Icon name="history" size={16} />
                Recientes
            </button>
            {open && (
                <div className="absolute right-0 z-10 mt-1 w-72 rounded-lg border border-outline-variant bg-surface-container-high p-1 shadow-lg">
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
            )}
        </div>
    )
}
