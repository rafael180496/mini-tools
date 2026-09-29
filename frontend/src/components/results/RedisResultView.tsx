import Icon from '../Icon'
import {useT, type Dict} from '../../i18n'
import ExportMenu from './ExportMenu'
import {redisResultToTable} from '../../lib/redisResultToTable'
import {parseFTSearchResult, type FTResultTable} from '../../lib/redisSearchResult'
import {tryPrettyPrintJSON} from '../../lib/prettyPrintJSON'
import {looksBinary} from '../../lib/binaryPreview'
import {formatElapsed} from '../../lib/formatElapsed'

// Así escribe redis-cli la respuesta nula: es un literal del protocolo, no
// texto a traducir.
const NIL = '(nil)'

export interface RedisCommandResult {
    commandText: string
    status: 'running' | 'done' | 'error' | 'cancelled'
    resultKind?: string
    result?: unknown
    durationMs: number
    error: string
}

interface RedisResultViewProps {
    results: RedisCommandResult[]
}

function commandNameOf(commandText: string): string {
    return commandText.trim().split(/\s+/)[0]?.toUpperCase() ?? ''
}

// A value that looks binary/non-printable (a marshaled object, a
// Sidekiq-style lock, etc. — see lib/binaryPreview.ts) renders as a
// confusing "tofu" box otherwise, since it already went through lossy
// UTF-8 replacement on the backend before ever reaching this component.
function renderScalarValue(v: unknown, t: Dict) {
    const s = String(v)
    if (looksBinary(s)) {
        return <span className="italic text-on-surface-variant">{t.results.redis.binary(s.length)}</span>
    }
    return <>{s}</>
}

function renderResultBody(r: RedisCommandResult, columns: string[], rows: unknown[][], cmdName: string, t: Dict) {
    if (r.status === 'error') return <span className="text-error">{r.error}</span>
    if (r.status === 'cancelled') return <span className="text-tertiary">{t.results.redis.cancelled}</span>
    if (r.status === 'running') return <span className="text-on-surface-variant">{t.results.redis.running}</span>

    if (r.resultKind === 'nil') return <span className="italic text-on-surface-variant">{NIL}</span>

    if (r.resultKind === 'array') {
        if (rows.length === 0) return <span className="text-on-surface-variant">{t.results.redis.emptyArray}</span>
        return (
            <table className="w-full text-left">
                <tbody>
                    {rows.map((row, i) => (
                        <tr key={i} className="align-top">
                            <td className="w-10 pr-2 text-on-surface-variant">{String(row[0])}</td>
                            <td className="break-all">{renderScalarValue(row[1], t)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        )
    }

    // RedisJSON commands return a JSON string — pretty-print it instead of
    // showing the raw single-line text, same treatment
    // RedisKeyDetailPanel.tsx already gives a 'ReJSON-RL' key's value.
    if (cmdName.startsWith('JSON.') && r.resultKind === 'string') {
        return <pre className="whitespace-pre-wrap break-all">{tryPrettyPrintJSON(String(r.result))}</pre>
    }

    return <span className="break-all">{renderScalarValue(r.result, t)}</span>
}

// Dynamic-column table for FT.SEARCH/FT.AGGREGATE — only ever called with a
// non-null table, i.e. r.status === 'done' and parseFTSearchResult
// recognized the shape (see the call site below); anything else falls back
// to the generic renderResultBody.
function renderFTTable(table: FTResultTable, t: Dict) {
    if (table.rows.length === 0) {
        return <span className="text-on-surface-variant">{t.results.redis.matchedNoRows(table.total)}</span>
    }
    return (
        <div>
            <p className="mb-1 text-on-surface-variant">{t.results.redis.matched(table.total)}</p>
            <table className="w-full text-left">
                <thead>
                    <tr className="text-on-surface-variant">
                        {table.columns.map((c) => (
                            <th key={c} className="pb-1 pr-2">
                                {c}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {table.rows.map((row, i) => (
                        <tr key={i} className="align-top">
                            {table.columns.map((c) => (
                                <td key={c} className="break-all pr-2">
                                    {renderScalarValue(row[c], t)}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

// Command-console transcript — one entry per Redis command run, instead of
// SQL's one-tab-per-statement ResultTabs/ResultGrid. Redis command results
// are typically small scalars/arrays rather than row sets worth paginating
// or resizing columns for, so a scrolling transcript (closer to redis-cli's
// own output) fits this shape better than forcing it through the tabular
// grid — the plan's suggestion to reuse ResultGrid directly was dropped
// once ResultGrid turned out to bake in SQL-specific "copiar como
// INSERT/UPDATE" actions that would be actively wrong for Redis data;
// ExportMenu (CSV/JSON/XLSX only, via the redisResultToTable flatten
// adapter) is still reused as-is per command — except for FT.SEARCH/
// FT.AGGREGATE, which pass their own dynamic columns/rows instead of the
// generic index/value pair, so exporting actually reflects what's on
// screen.
export default function RedisResultView({results}: RedisResultViewProps) {
    const t = useT()
    if (results.length === 0) {
        return <p className="p-3 text-xs text-on-surface-variant/60">{t.results.redis.empty}</p>
    }

    return (
        <div className="flex-1 overflow-y-auto p-2">
            {results.map((r, i) => {
                const cmdName = commandNameOf(r.commandText)
                const isFTCommand = cmdName === 'FT.SEARCH' || cmdName === 'FT.AGGREGATE'
                const ftTable = isFTCommand && r.status === 'done' ? parseFTSearchResult(r.result) : null

                const generic = redisResultToTable(r.resultKind, r.result)
                const exportColumns = ftTable ? ftTable.columns : generic.columns
                const done = r.status === 'done'
                const exportRows = ftTable ? ftTable.rows.map((row) => ftTable.columns.map((c) => row[c])) : generic.rows

                return (
                    <div key={i} className="mb-2 rounded-lg border border-outline-variant bg-surface p-2">
                        <div className="mb-1 flex items-center gap-2 text-xs">
                            <Icon
                                name={r.status === 'error' ? 'error' : r.status === 'cancelled' ? 'block' : 'chevron_right'}
                                size={14}
                                className={r.status === 'error' ? 'text-error' : 'text-on-surface-variant'}
                            />
                            <span className="flex-1 truncate font-mono text-on-surface" title={r.commandText}>
                                {r.commandText}
                            </span>
                            {done && <span className="shrink-0 text-on-surface-variant">{formatElapsed(r.durationMs)}</span>}
                            {done && exportColumns.length > 0 && <ExportMenu columns={exportColumns} rows={exportRows} />}
                        </div>
                        <div className="font-mono text-xs">
                            {ftTable ? renderFTTable(ftTable, t) : renderResultBody(r, generic.columns, generic.rows, cmdName, t)}
                        </div>
                    </div>
                )
            })}
        </div>
    )
}
