interface ResultGridProps {
    columns: string[]
    rows: unknown[][]
}

// Plain HTML table for now — virtualization with @tanstack/react-table +
// @tanstack/react-virtual lands in Fase 7. This is the minimal grid for the
// Fase 3 vertical slice.
export default function ResultGrid({columns, rows}: ResultGridProps) {
    if (columns.length === 0) {
        return (
            <div className="flex flex-1 items-center justify-center text-xs text-neutral-600">
                Sin resultados todavía.
            </div>
        )
    }

    return (
        <div className="flex-1 overflow-auto">
            <table className="w-full border-collapse text-left text-xs">
                <thead className="sticky top-0 bg-neutral-900">
                    <tr>
                        {columns.map((col) => (
                            <th key={col} className="border-b border-neutral-800 px-3 py-2 font-medium text-neutral-400">
                                {col}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, i) => (
                        <tr key={i} className="odd:bg-neutral-950 even:bg-neutral-900/40 hover:bg-neutral-800/60">
                            {row.map((cell, j) => (
                                <td key={j} className="whitespace-nowrap border-b border-neutral-900 px-3 py-1.5 text-neutral-200">
                                    {cell === null || cell === undefined ? (
                                        <span className="italic text-neutral-600">NULL</span>
                                    ) : (
                                        String(cell)
                                    )}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}
