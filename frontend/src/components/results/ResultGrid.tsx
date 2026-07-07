import {useState, useRef} from 'react'
import {ColumnDef, flexRender, getCoreRowModel, useReactTable} from '@tanstack/react-table'
import {useVirtualizer} from '@tanstack/react-virtual'
import Icon from '../Icon'
import {generateInsertStatements, generateUpdateStatement} from '../../lib/sqlGenerate'

interface ResultGridProps {
    columns: string[]
    rows: unknown[][]
    sortColumn?: string | null
    sortDirection?: 'asc' | 'desc' | null
    onSort?: (column: string) => void
    // Best-effort name for the generated INSERT/UPDATE statements — same
    // limitation as ExportMenu's "copiar como INSERT": there's no reliable
    // way to know which table a SELECT's rows came from without parsing
    // the query, so this is just whatever the caller has handy (the active
    // connection's name), not necessarily the real table.
    tableNameHint?: string
}

const ROW_HEIGHT = 28

// Virtualized (rows are windowed, not all rendered at once — thousands of
// rows scroll without lag) grid with resizable columns. Sorting doesn't
// happen client-side: clicking a header calls onSort, and the caller
// re-issues the query wrapped in ORDER BY — see spec's "ordenar = reemitir
// query con ORDER BY, no ordenar en cliente un dataset parcial".
export default function ResultGrid({columns, rows, sortColumn, sortDirection, onSort, tableNameHint}: ResultGridProps) {
    const parentRef = useRef<HTMLDivElement>(null)
    const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
    const [copyStatus, setCopyStatus] = useState('')

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
            <div className="flex flex-1 items-center justify-center gap-2 bg-surface text-xs text-on-surface-variant/60">
                <Icon name="table_rows" size={16} />
                Sin resultados todavía.
            </div>
        )
    }

    const virtualItems = virtualizer.getVirtualItems()
    const totalHeight = virtualizer.getTotalSize()
    const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0
    const paddingBottom = virtualItems.length > 0 ? totalHeight - virtualItems[virtualItems.length - 1].end : 0
    const selectedRow = selectedIndex !== null ? rows[selectedIndex] : null

    async function copy(text: string, label: string) {
        await navigator.clipboard.writeText(text)
        setCopyStatus(label)
        setTimeout(() => setCopyStatus(''), 2000)
    }

    return (
        <div className="relative flex flex-1 flex-col overflow-hidden">
            <div ref={parentRef} className="flex-1 overflow-auto bg-surface font-mono">
                <table
                    className="border-collapse text-left text-xs"
                    style={{tableLayout: 'fixed', width: '100%', minWidth: table.getTotalSize()}}
                >
                    <thead className="sticky top-0 z-10 bg-surface-container-high shadow-sm">
                        {table.getHeaderGroups().map((hg) => (
                            <tr key={hg.id}>
                                {hg.headers.map((header) => (
                                    <th
                                        key={header.id}
                                        style={{width: header.getSize(), position: 'relative'}}
                                        className="border-b border-outline-variant px-3 py-2 font-sans font-medium text-on-surface-variant"
                                    >
                                        <button
                                            onClick={() => onSort?.(header.column.id)}
                                            title="Ordenar por esta columna — click de nuevo para invertir el orden"
                                            className="flex w-full items-center gap-1 truncate text-left hover:text-on-surface"
                                        >
                                            <span className="truncate">{flexRender(header.column.columnDef.header, header.getContext())}</span>
                                            {sortColumn === header.column.id && (
                                                <Icon
                                                    name={sortDirection === 'asc' ? 'arrow_upward' : 'arrow_downward'}
                                                    size={14}
                                                    className="shrink-0 text-primary"
                                                />
                                            )}
                                        </button>
                                        <div
                                            onMouseDown={header.getResizeHandler()}
                                            onTouchStart={header.getResizeHandler()}
                                            className="absolute right-0 top-0 h-full w-1 cursor-col-resize select-none hover:bg-primary/40"
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
                            const isSelected = vi.index === selectedIndex
                            return (
                                <tr
                                    key={row.id}
                                    onClick={() => setSelectedIndex(isSelected ? null : vi.index)}
                                    title="Click para seleccionar la fila — habilita copiarla como texto, INSERT o UPDATE"
                                    className={`cursor-pointer ${
                                        isSelected
                                            ? 'bg-primary-container/40'
                                            : 'odd:bg-surface even:bg-surface-container-lowest hover:bg-surface-variant/40'
                                    }`}
                                >
                                    {row.getVisibleCells().map((cell) => {
                                        const value = cell.getValue()
                                        return (
                                            <td
                                                key={cell.id}
                                                style={{width: cell.column.getSize()}}
                                                className="truncate whitespace-nowrap border-b border-outline-variant/30 px-3 py-1.5 text-on-surface"
                                            >
                                                {value === null || value === undefined ? (
                                                    <span className="italic text-on-surface-variant/60">NULL</span>
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

            {selectedRow && (
                <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-lg border border-outline-variant bg-surface-container-high p-1 shadow-lg">
                    {copyStatus && <span className="px-2 text-xs text-secondary">{copyStatus}</span>}
                    <button
                        onClick={() => void copy(selectedRow.map((v) => (v === null || v === undefined ? '' : String(v))).join('\t'), 'Fila copiada')}
                        title="Copia los valores de la fila separados por tab, listos para pegar en una planilla"
                        className="flex items-center gap-1.5 rounded px-2 py-1.5 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="content_copy" size={15} />
                        Copiar fila
                    </button>
                    <button
                        onClick={() =>
                            void copy(generateInsertStatements(tableNameHint ?? 'tabla', columns, [selectedRow]), 'INSERT copiado')
                        }
                        title="Copia esta fila como una sentencia INSERT lista para pegar en el editor"
                        className="flex items-center gap-1.5 rounded px-2 py-1.5 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="add_box" size={15} />
                        Copiar como INSERT
                    </button>
                    <button
                        onClick={() =>
                            void copy(generateUpdateStatement(tableNameHint ?? 'tabla', columns, selectedRow), 'UPDATE copiado')
                        }
                        title="Copia esta fila como una sentencia UPDATE (con WHERE por todas las columnas — revisala antes de ejecutar) lista para editar y pegar en el editor"
                        className="flex items-center gap-1.5 rounded px-2 py-1.5 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="edit_note" size={15} />
                        Copiar como UPDATE
                    </button>
                    <button
                        onClick={() => setSelectedIndex(null)}
                        title="Deselecciona la fila"
                        className="rounded p-1.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="close" size={15} />
                    </button>
                </div>
            )}
        </div>
    )
}
