import {useState, useRef, type MouseEvent} from 'react'
import {ColumnDef, flexRender, getCoreRowModel, useReactTable} from '@tanstack/react-table'
import {useVirtualizer} from '@tanstack/react-virtual'
import Icon from '../Icon'
import {generateCSV, generateInsertStatements, generateUpdateStatements} from '../../lib/sqlGenerate'

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
    // Set (not a single index) so ctrl/cmd-click and shift-click can build a
    // multi-row selection — anchorRef tracks the last non-shift click so a
    // shift-click knows which end of the range to extend from.
    const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set())
    const anchorRef = useRef<number | null>(null)
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
    const sortedSelectedIndices = Array.from(selectedIndices).sort((a, b) => a - b)
    const selectedRows = sortedSelectedIndices.map((i) => rows[i])

    async function copy(text: string, label: string) {
        await navigator.clipboard.writeText(text)
        setCopyStatus(label)
        setTimeout(() => setCopyStatus(''), 2000)
    }

    function clickRow(index: number, e: MouseEvent) {
        if (e.shiftKey && anchorRef.current !== null) {
            const [lo, hi] = [Math.min(anchorRef.current, index), Math.max(anchorRef.current, index)]
            const range = new Set<number>()
            for (let i = lo; i <= hi; i++) range.add(i)
            setSelectedIndices(range)
            return
        }
        if (e.ctrlKey || e.metaKey) {
            setSelectedIndices((prev) => {
                const next = new Set(prev)
                if (next.has(index)) next.delete(index)
                else next.add(index)
                return next
            })
            anchorRef.current = index
            return
        }
        setSelectedIndices((prev) => (prev.size === 1 && prev.has(index) ? new Set() : new Set([index])))
        anchorRef.current = index
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
                            const isSelected = selectedIndices.has(vi.index)
                            return (
                                <tr
                                    key={row.id}
                                    onClick={(e) => clickRow(vi.index, e)}
                                    title="Click para seleccionar la fila — Ctrl/Cmd+click para sumar filas sueltas, Shift+click para un rango — habilita copiarlas como texto, CSV, INSERT o UPDATE"
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

            {selectedRows.length > 0 && (
                <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-lg border border-outline-variant bg-surface-container-high p-1 shadow-lg">
                    {copyStatus && <span className="px-2 text-xs text-secondary">{copyStatus}</span>}
                    {selectedRows.length > 1 && (
                        <span className="px-1 text-xs text-on-surface-variant/70">{selectedRows.length} filas</span>
                    )}
                    <button
                        onClick={() =>
                            void copy(
                                selectedRows.map((r) => r.map((v) => (v === null || v === undefined ? '' : String(v))).join('\t')).join('\n'),
                                selectedRows.length > 1 ? 'Filas copiadas' : 'Fila copiada'
                            )
                        }
                        title="Copia los valores de la(s) fila(s) separados por tab (una por línea), listos para pegar en una planilla"
                        className="flex items-center gap-1.5 rounded px-2 py-1.5 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="content_copy" size={15} />
                        Copiar fila{selectedRows.length > 1 ? 's' : ''}
                    </button>
                    <button
                        onClick={() => void copy(generateCSV(columns, selectedRows), 'CSV copiado')}
                        title="Copia la(s) fila(s) seleccionadas como CSV (con encabezado), listo para pegar en Excel/Sheets sin pasar por el diálogo de exportar"
                        className="flex items-center gap-1.5 rounded px-2 py-1.5 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="grid_on" size={15} />
                        Copiar como CSV
                    </button>
                    <button
                        onClick={() =>
                            void copy(generateInsertStatements(tableNameHint ?? 'tabla', columns, selectedRows), 'INSERT copiado')
                        }
                        title="Copia la(s) fila(s) seleccionadas como sentencias INSERT listas para pegar en el editor"
                        className="flex items-center gap-1.5 rounded px-2 py-1.5 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="add_box" size={15} />
                        Copiar como INSERT
                    </button>
                    <button
                        onClick={() =>
                            void copy(generateUpdateStatements(tableNameHint ?? 'tabla', columns, selectedRows), 'UPDATE copiado')
                        }
                        title="Copia la(s) fila(s) seleccionadas como sentencias UPDATE (con WHERE por todas las columnas — revisalas antes de ejecutar) listas para editar y pegar en el editor"
                        className="flex items-center gap-1.5 rounded px-2 py-1.5 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="edit_note" size={15} />
                        Copiar como UPDATE
                    </button>
                    <button
                        onClick={() => setSelectedIndices(new Set())}
                        title="Deselecciona todas las filas"
                        className="rounded p-1.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="close" size={15} />
                    </button>
                </div>
            )}
        </div>
    )
}
