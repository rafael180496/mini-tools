import {useEffect, useState} from 'react'
import {ListConnections} from '../../../wailsjs/go/main/App'
import {vault, db} from '../../../wailsjs/go/models'
import logo from '../../assets/logo.png'

interface ConnectionTreeProps {
    selectedId: string | null
    onSelect: (conn: vault.ConnectionSummary) => void
    onNewConnection: () => void
    reloadToken: number
    metadata: db.SchemaMetadata | null
    onOpenTable: (table: string) => void
    onExportConnectionConfig: (connId: string) => void
    onExportTableDDL: (table: string, schema?: string) => void
}

// Conexiones → tablas (spec: "árbol conexiones → schemas → tablas/vistas").
// Schemas aren't rendered as their own level yet — table.schema (Postgres)
// is shown as a small prefix instead, since most connections here have a
// single relevant schema; revisit if that turns out to be too flat.
export default function ConnectionTree({
    selectedId,
    onSelect,
    onNewConnection,
    reloadToken,
    metadata,
    onOpenTable,
    onExportConnectionConfig,
    onExportTableDDL,
}: ConnectionTreeProps) {
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
                {filtered.length === 0 && <p className="p-3 text-xs text-neutral-600">Sin conexiones todavía.</p>}
                {filtered.map((c) => {
                    const isSelected = c.id === selectedId
                    return (
                        <div key={c.id}>
                            <div
                                className={`group flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-neutral-900 ${
                                    isSelected ? 'bg-neutral-900 text-emerald-400' : 'text-neutral-300'
                                }`}
                            >
                                <button onClick={() => onSelect(c)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                                    <span className="text-xs text-neutral-600">{isSelected ? '▾' : '▸'}</span>
                                    <span className="text-xs text-neutral-600">{c.dbType}</span>
                                    <span className="truncate">{c.name}</span>
                                </button>
                                <button
                                    onClick={() => onExportConnectionConfig(c.id)}
                                    title="Exportar configuración (sin password)"
                                    className="hidden shrink-0 text-xs text-neutral-600 hover:text-neutral-300 group-hover:block"
                                >
                                    cfg
                                </button>
                            </div>

                            {isSelected && metadata && (
                                <div className="pb-1 pl-6">
                                    {metadata.tables.length === 0 && (
                                        <p className="px-2 py-1 text-xs text-neutral-600">Sin tablas.</p>
                                    )}
                                    {metadata.tables.map((t) => (
                                        <div
                                            key={`${t.schema ?? ''}.${t.name}`}
                                            onDoubleClick={() => onOpenTable(t.name)}
                                            title="Doble click: SELECT * LIMIT 100"
                                            className="group/table flex items-center gap-2 rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
                                        >
                                            <span className="truncate">
                                                {t.schema ? `${t.schema}.${t.name}` : t.name}
                                            </span>
                                            <div className="flex-1" />
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation()
                                                    onExportTableDDL(t.name, t.schema)
                                                }}
                                                title="Exportar DDL de la tabla"
                                                className="hidden shrink-0 text-neutral-600 hover:text-neutral-300 group-hover/table:block"
                                            >
                                                DDL
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>
        </div>
    )
}
