import {useEffect, useState} from 'react'
import {ListConnections} from '../../../wailsjs/go/main/App'
import {vault} from '../../../wailsjs/go/models'
import logo from '../../assets/logo.png'

interface ConnectionTreeProps {
    selectedId: string | null
    onSelect: (conn: vault.ConnectionSummary) => void
    onNewConnection: () => void
    reloadToken: number
}

// Minimal flat list for the Fase 3 vertical slice — the full
// conexiones→schemas→tablas tree lands once GetSchemaMetadata exists
// (Fase 6).
export default function ConnectionTree({selectedId, onSelect, onNewConnection, reloadToken}: ConnectionTreeProps) {
    const [connections, setConnections] = useState<vault.ConnectionSummary[]>([])
    const [filter, setFilter] = useState('')

    useEffect(() => {
        ListConnections().then(setConnections)
    }, [reloadToken])

    const filtered = connections.filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()))

    return (
        <div className="flex h-full w-64 flex-col border-r border-neutral-800 bg-neutral-950 text-neutral-100">
            <div className="flex items-center gap-2 border-b border-neutral-800 p-2">
                <img src={logo} alt="mini-tools" className="h-5 w-5" />
                <span className="text-sm font-semibold">mini-tools</span>
            </div>
            <div className="flex items-center justify-between border-b border-neutral-800 p-2">
                <span className="text-xs font-semibold uppercase text-neutral-500">Conexiones</span>
                <button
                    onClick={onNewConnection}
                    className="rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700"
                >
                    + Nueva
                </button>
            </div>
            <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Buscar..."
                className="mx-2 mt-2 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs outline-none focus:border-neutral-600"
            />
            <div className="mt-2 flex-1 overflow-y-auto">
                {filtered.length === 0 && (
                    <p className="p-3 text-xs text-neutral-600">Sin conexiones todavía.</p>
                )}
                {filtered.map((c) => (
                    <button
                        key={c.id}
                        onClick={() => onSelect(c)}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-neutral-900 ${
                            c.id === selectedId ? 'bg-neutral-900 text-emerald-400' : 'text-neutral-300'
                        }`}
                    >
                        <span className="text-xs text-neutral-600">{c.dbType}</span>
                        <span className="truncate">{c.name}</span>
                    </button>
                ))}
            </div>
        </div>
    )
}
