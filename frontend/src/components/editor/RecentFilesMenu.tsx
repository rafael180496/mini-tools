import {useEffect, useState} from 'react'
import {ClearRecentFiles, ListRecentFiles} from '../../../wailsjs/go/main/App'
import {vault} from '../../../wailsjs/go/models'

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
                className="rounded bg-neutral-200 dark:bg-neutral-800 px-3 py-1 text-xs font-medium hover:bg-neutral-300 dark:hover:bg-neutral-700"
            >
                Recientes
            </button>
            {open && (
                <div className="absolute right-0 z-10 mt-1 w-72 rounded border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900 p-1 shadow-lg">
                    {files.length === 0 && <p className="p-2 text-xs text-neutral-500">Sin archivos recientes.</p>}
                    {files.map((f) => (
                        <button
                            key={f.path}
                            onClick={() => {
                                onOpen(f.path)
                                setOpen(false)
                            }}
                            className="block w-full truncate rounded px-2 py-1 text-left text-xs text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-800"
                            title={f.path}
                        >
                            {f.path}
                        </button>
                    ))}
                    {files.length > 0 && (
                        <button
                            onClick={() => {
                                void ClearRecentFiles().then(() => setFiles([]))
                            }}
                            className="mt-1 block w-full rounded px-2 py-1 text-left text-xs text-neutral-400 dark:text-neutral-600 hover:bg-neutral-200 dark:hover:bg-neutral-800 hover:text-neutral-600 dark:hover:text-neutral-400"
                        >
                            Limpiar historial
                        </button>
                    )}
                </div>
            )}
        </div>
    )
}
