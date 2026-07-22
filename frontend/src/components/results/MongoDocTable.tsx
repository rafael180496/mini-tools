// A lightweight tabular view of flattened MongoDB documents — one column per
// top-level field, nested values arrive already JSON-stringified (from
// mongoResultToTable). Shared by the result transcript (MongoResultView) and
// the document browser (MongoDocumentPanel). Horizontal scroll is contained so
// the panel never overflows the page (same rule as ResultGrid).
export default function MongoDocTable({columns, rows}: {columns: string[]; rows: unknown[][]}) {
    return (
        <div className="overflow-x-auto">
            <table className="min-w-full border-collapse text-xs">
                <thead>
                    <tr className="border-b border-outline-variant text-left text-on-surface-variant">
                        {columns.map((c) => (
                            <th key={c} className="whitespace-nowrap px-2 py-1 font-medium">
                                {c}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, i) => (
                        <tr key={i} className="border-b border-outline-variant/40 odd:bg-surface-container-low/30">
                            {row.map((cell, j) => (
                                <td key={j} className="max-w-xs truncate px-2 py-1 text-on-surface" title={cell == null ? '' : String(cell)}>
                                    {cell == null ? <span className="text-on-surface-variant/50">null</span> : String(cell)}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}
