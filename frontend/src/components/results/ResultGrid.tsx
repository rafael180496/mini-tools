import {useRef} from 'react'
import {ColumnDef, flexRender, getCoreRowModel, useReactTable} from '@tanstack/react-table'
import {useVirtualizer} from '@tanstack/react-virtual'

interface ResultGridProps {
    columns: string[]
    rows: unknown[][]
    sortColumn?: string | null
    sortDirection?: 'asc' | 'desc' | null
    onSort?: (column: string) => void
}

const ROW_HEIGHT = 28

// Virtualized (rows are windowed, not all rendered at once — thousands of
// rows scroll without lag) grid with resizable columns. Sorting doesn't
// happen client-side: clicking a header calls onSort, and the caller
// re-issues the query wrapped in ORDER BY — see spec's "ordenar = reemitir
// query con ORDER BY, no ordenar en cliente un dataset parcial".
export default function ResultGrid({columns, rows, sortColumn, sortDirection, onSort}: ResultGridProps) {
    const parentRef = useRef<HTMLDivElement>(null)

    const colDefs: ColumnDef<unknown[]>[] = columns.map((col, i) => ({
        id: col,
        header: col,
        accessorFn: (row) => row[i],
        size: 160,
        minSize: 60,
    }))

    const table = useReactTable({
        data: rows,
        columns: colDefs,
        getCoreRowModel: getCoreRowModel(),
        columnResizeMode: 'onChange',
    })

    const tableRows = table.getRowModel().rows

    const virtualizer = useVirtualizer({
        count: tableRows.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 12,
    })

    if (columns.length === 0) {
        return (
            <div className="flex flex-1 items-center justify-center text-xs text-neutral-600">
                Sin resultados todavía.
            </div>
        )
    }

    const virtualItems = virtualizer.getVirtualItems()
    const totalHeight = virtualizer.getTotalSize()
    const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0
    const paddingBottom = virtualItems.length > 0 ? totalHeight - virtualItems[virtualItems.length - 1].end : 0

    return (
        <div ref={parentRef} className="flex-1 overflow-auto">
            <table className="w-full border-collapse text-left text-xs" style={{tableLayout: 'fixed'}}>
                <thead className="sticky top-0 z-10 bg-neutral-900">
                    {table.getHeaderGroups().map((hg) => (
                        <tr key={hg.id}>
                            {hg.headers.map((header) => (
                                <th
                                    key={header.id}
                                    style={{width: header.getSize(), position: 'relative'}}
                                    className="border-b border-neutral-800 px-3 py-2 font-medium text-neutral-400"
                                >
                                    <button
                                        onClick={() => onSort?.(header.column.id)}
                                        className="flex w-full items-center gap-1 truncate text-left hover:text-neutral-200"
                                    >
                                        <span className="truncate">{flexRender(header.column.columnDef.header, header.getContext())}</span>
                                        {sortColumn === header.column.id && (
                                            <span className="shrink-0">{sortDirection === 'asc' ? '▲' : '▼'}</span>
                                        )}
                                    </button>
                                    <div
                                        onMouseDown={header.getResizeHandler()}
                                        onTouchStart={header.getResizeHandler()}
                                        className="absolute right-0 top-0 h-full w-1 cursor-col-resize select-none hover:bg-neutral-600"
                                    />
                                </th>
                            ))}
                        </tr>
                    ))}
                </thead>
                <tbody>
                    {paddingTop > 0 && (
                        <tr>
                            <td style={{height: paddingTop}} colSpan={columns.length} />
                        </tr>
                    )}
                    {virtualItems.map((vi) => {
                        const row = tableRows[vi.index]
                        return (
                            <tr key={row.id} className="odd:bg-neutral-950 even:bg-neutral-900/40 hover:bg-neutral-800/60">
                                {row.getVisibleCells().map((cell) => {
                                    const value = cell.getValue()
                                    return (
                                        <td
                                            key={cell.id}
                                            style={{width: cell.column.getSize()}}
                                            className="truncate whitespace-nowrap border-b border-neutral-900 px-3 py-1.5 text-neutral-200"
                                        >
                                            {value === null || value === undefined ? (
                                                <span className="italic text-neutral-600">NULL</span>
                                            ) : (
                                                String(value)
                                            )}
                                        </td>
                                    )
                                })}
                            </tr>
                        )
                    })}
                    {paddingBottom > 0 && (
                        <tr>
                            <td style={{height: paddingBottom}} colSpan={columns.length} />
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
    )
}
