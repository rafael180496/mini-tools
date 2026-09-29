import {useState} from 'react'
import Icon from '../Icon'
import {useT} from '../../i18n'
import ExportMenu from './ExportMenu'
import JsonView from './JsonView'
import MongoDocTable from './MongoDocTable'
import {mongoResultToTable} from '../../lib/mongoResultToTable'
import {formatElapsed} from '../../lib/formatElapsed'

// One accumulated UI row per mongosh command run — owner-defines-type pattern,
// imported by Workspace.tsx (same as RedisResultView's RedisCommandResult).
export interface MongoCommandResult {
    commandText: string
    status: 'running' | 'done' | 'error' | 'cancelled'
    documents?: string[]
    summary?: string
    durationMs?: number
    error?: string
}

interface MongoResultViewProps {
    results: MongoCommandResult[]
}

// Command-console transcript — one entry per Mongo command, each rendering its
// returned documents as colorized, collapsible JSON (JsonView) rather than
// SQL's tabular ResultGrid. Same reasoning as RedisResultView: documents are
// hierarchical JSON, not flat row sets, so a JSON view fits far better than
// forcing them through a grid (and ResultGrid bakes in SQL-specific "copiar
// como INSERT/UPDATE" actions that make no sense for a Mongo document).
// ExportMenu (CSV/JSON/XLSX) is still reused per command via the
// mongoResultToTable flatten adapter.
export default function MongoResultView({results}: MongoResultViewProps) {
    const t = useT()
    const [viewMode, setViewMode] = useState<'json' | 'table'>('json')
    const [search, setSearch] = useState('')

    if (results.length === 0) {
        return <p className="p-3 text-xs text-on-surface-variant/60">{t.results.mongo.empty}</p>
    }

    const needle = search.trim().toLowerCase()

    return (
        <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-2 py-1 text-xs">
                <div className="inline-flex overflow-hidden rounded-md border border-outline-variant">
                    <button
                        onClick={() => setViewMode('json')}
                        title={t.results.mongo.jsonTitle}
                        className={`px-2 py-0.5 ${viewMode === 'json' ? 'bg-secondary-container text-on-secondary-container' : 'text-on-surface-variant hover:bg-surface-container-high'}`}
                    >
                        JSON
                    </button>
                    <button
                        onClick={() => setViewMode('table')}
                        title={t.results.mongo.tableTitle}
                        className={`px-2 py-0.5 ${viewMode === 'table' ? 'bg-secondary-container text-on-secondary-container' : 'text-on-surface-variant hover:bg-surface-container-high'}`}
                    >
                        {t.results.mongo.table}
                    </button>
                </div>
                <div className="relative flex-1">
                    <Icon name="search" size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-on-surface-variant/60" />
                    <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder={t.results.mongo.filterPlaceholder}
                        title={t.results.mongo.filterTitle}
                        className="w-full rounded border border-outline-variant bg-surface-container-low py-1 pl-7 pr-2 text-on-surface"
                    />
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-2">
                {results.map((r, i) => {
                    const allDocs = r.documents ?? []
                    const docs = needle ? allDocs.filter((d) => d.toLowerCase().includes(needle)) : allDocs
                    const table = docs.length > 0 ? mongoResultToTable(docs) : {columns: [], rows: []}
                    const done = r.status === 'done'

                    return (
                        <div key={i} className="mb-2 rounded-lg border border-outline-variant bg-surface p-2">
                            <div className="mb-1 flex items-center gap-2 text-xs">
                                <Icon
                                    name={r.status === 'error' ? 'error' : r.status === 'cancelled' ? 'block' : r.status === 'running' ? 'pending' : 'chevron_right'}
                                    size={14}
                                    className={r.status === 'error' ? 'text-error' : 'text-on-surface-variant'}
                                />
                                <span className="flex-1 truncate font-mono text-on-surface" title={r.commandText}>
                                    {r.commandText}
                                </span>
                                {needle && done && (
                                    <span className="shrink-0 text-on-surface-variant/70">
                                        {docs.length}/{allDocs.length}
                                    </span>
                                )}
                                {r.summary && <span className="shrink-0 text-on-surface-variant">{r.summary}</span>}
                                {done && <span className="shrink-0 text-on-surface-variant">{formatElapsed(r.durationMs ?? NaN)}</span>}
                                {done && table.columns.length > 0 && <ExportMenu columns={table.columns} rows={table.rows} />}
                            </div>
                            <div className="font-mono text-xs">
                                {r.status === 'error' ? (
                                    <p className="whitespace-pre-wrap break-words text-error">{r.error}</p>
                                ) : r.status === 'cancelled' ? (
                                    <p className="text-on-surface-variant">{t.results.mongo.cancelled}</p>
                                ) : r.status === 'running' ? (
                                    <p className="text-on-surface-variant">{t.results.mongo.running}</p>
                                ) : allDocs.length === 0 ? (
                                    <p className="text-on-surface-variant">{t.results.mongo.noDocuments}</p>
                                ) : docs.length === 0 ? (
                                    <p className="text-on-surface-variant">{t.results.mongo.noMatch}</p>
                                ) : viewMode === 'table' ? (
                                    <MongoDocTable columns={table.columns} rows={table.rows} />
                                ) : (
                                    <div className="space-y-1">
                                        {docs.map((d, j) => (
                                            <div key={j} className="rounded border border-outline-variant/50 bg-surface-container-low/40 p-1.5">
                                                <JsonView data={d} />
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    )
                })}
            </div>
        </div>
    )
}

