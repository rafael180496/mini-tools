import {useEffect, useState, useRef, type MouseEvent} from 'react'
import {ColumnDef, flexRender, getCoreRowModel, useReactTable} from '@tanstack/react-table'
import {useVirtualizer} from '@tanstack/react-virtual'
import Icon from '../Icon'
import {generateCSV, generateInsertStatements, generateUpdateStatements} from '../../lib/sqlGenerate'
import CellEditor from './CellEditor'
import {useRowEditing} from './useRowEditing'

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
    // Conexión y consulta que produjeron estas filas. Con las dos, la grilla
    // puede ofrecer EDITAR: el backend decide si el resultado sale de una sola
    // tabla con clave primaria y genera el UPDATE. Sin ellas la grilla es de
    // solo lectura, que es lo correcto para un resultado de Mongo o de una
    // vista previa.
    connId?: string
    sqlText?: string
}

const ROW_HEIGHT = 28

// Virtualized (rows are windowed, not all rendered at once — thousands of
// rows scroll without lag) grid with resizable columns. Sorting doesn't
// happen client-side: clicking a header calls onSort, and the caller
// re-issues the query wrapped in ORDER BY — see spec's "ordenar = reemitir
// query con ORDER BY, no ordenar en cliente un dataset parcial".
export default function ResultGrid({
    columns,
    rows,
    sortColumn,
    sortDirection,
    onSort,
    tableNameHint,
    connId,
    sqlText,
}: ResultGridProps) {
    const parentRef = useRef<HTMLDivElement>(null)
    // Set (not a single index) so ctrl/cmd-click and shift-click can build a
    // multi-row selection — anchorRef tracks the last non-shift click so a
    // shift-click knows which end of the range to extend from.
    const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set())
    const anchorRef = useRef<number | null>(null)
    const [copyStatus, setCopyStatus] = useState('')

    // Edición de celdas, al estilo DataGrip. Ver useRowEditing: lo que se
    // escribe queda PENDIENTE hasta que se manda, y lo que se puede editar lo
    // decide el backend.
    const editing = useRowEditing(connId, sqlText, columns, rows)
    const [editCell, setEditCell] = useState<{row: number; col: string} | null>(null)
    const [previewSql, setPreviewSql] = useState<string[] | null>(null)

    // ⌘↵ / Ctrl+↵ manda los cambios, como en DataGrip. Solo cuando hay algo
    // pendiente: un atajo que escribe en la base no puede dispararse por
    // casualidad sobre una grilla sin cambios.
    const applyRef = useRef(editing.apply)
    applyRef.current = editing.apply
    useEffect(() => {
        if (editing.pendingCount === 0) return
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void applyRef.current().catch(() => {})
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [editing.pendingCount])

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
                                        const colName = cell.column.id
                                        const editable = editing.editableCols.get(colName.toLowerCase())
                                        const change = editing.valueOf(vi.index, colName)
                                        const value = change ? change.value : cell.getValue()
                                        const isEditing =
                                            editCell?.row === vi.index && editCell.col === colName
                                        return (
                                            <td
                                                key={cell.id}
                                                style={{width: cell.column.getSize()}}
                                                // Doble clic y no un clic: el clic simple ya
                                                // selecciona la fila para copiarla, y una
                                                // grilla donde tocar un dato lo pone en
                                                // edición se edita sola sin querer.
                                                onDoubleClick={(e) => {
                                                    if (!editable) return
                                                    e.stopPropagation()
                                                    setEditCell({row: vi.index, col: colName})
                                                }}
                                                title={
                                                    editable
                                                        ? `Doble clic para editar. ${editable.dataType} — el cambio queda pendiente hasta que lo mandes.`
                                                        : undefined
                                                }
                                                className={`truncate whitespace-nowrap border-b border-outline-variant/30 px-3 py-1.5 text-on-surface ${
                                                    change
                                                        ? change.saved
                                                            ? 'bg-tertiary/15'
                                                            : 'bg-primary/20 font-medium'
                                                        : ''
                                                } ${editable ? 'cursor-text' : ''}`}
                                            >
                                                {isEditing && editable ? (
                                                    <CellEditor
                                                        kind={editable.kind}
                                                        initial={value === null || value === undefined ? null : String(value)}
                                                        nullable={editable.nullable}
                                                        onCommit={(v) => {
                                                            editing.setValue(vi.index, colName, v)
                                                            setEditCell(null)
                                                        }}
                                                        onCancel={() => setEditCell(null)}
                                                    />
                                                ) : value === null || value === undefined ? (
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

            {/* Barra de cambios pendientes. Aparece solo cuando hay algo sin
                guardar: es el recordatorio de que lo que se ve en la grilla
                todavía no está en la base. */}
            {editing.pendingCount > 0 && (
                <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-outline-variant bg-primary/10 px-2 py-1 text-[11px]">
                    <Icon name="edit" size={13} className="shrink-0 text-primary" />
                    <span className="text-on-surface">
                        {editing.pendingCount} {editing.pendingCount === 1 ? 'cambio sin guardar' : 'cambios sin guardar'}
                    </span>

                    <button
                        onClick={() => void editing.preview().then(setPreviewSql).catch((e) => editing.setError(String(e)))}
                        title="Muestra exactamente el UPDATE que se va a ejecutar, con su WHERE, antes de tocar la base."
                        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="visibility" size={13} />
                        Ver el SQL
                    </button>
                    <button
                        onClick={() => void editing.apply().catch(() => {})}
                        disabled={editing.busy}
                        title="Ejecuta los UPDATE en UNA transacción. Cada uno tiene que afectar exactamente una fila: si alguno afecta otra cantidad, se revierte el lote entero. (Cmd/Ctrl + Enter)"
                        className="flex items-center gap-1 rounded bg-primary/20 px-1.5 py-0.5 text-primary hover:bg-primary/30 disabled:opacity-50"
                    >
                        <Icon name="upload" size={13} />
                        {editing.busy ? 'Guardando…' : 'Guardar en la base'}
                    </button>
                    <button
                        onClick={editing.discard}
                        title="Descarta los cambios pendientes. La base no se tocó, así que no hay nada que deshacer."
                        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="undo" size={13} />
                        Descartar
                    </button>

                    {editing.error && (
                        <span className="min-w-0 flex-1 truncate text-error" title={editing.error}>
                            {editing.error}
                        </span>
                    )}
                </div>
            )}

            {/* Por qué esta consulta NO se puede editar. Se dice el motivo y no
                se esconde la función en silencio: es lo que explica por qué en
                la consulta de al lado sí anda. */}
            {editing.reason && editing.pendingCount === 0 && (
                <div className="flex shrink-0 items-center gap-1.5 border-t border-outline-variant bg-surface-container-low px-2 py-1 text-[10px] text-on-surface-variant">
                    <Icon name="lock" size={11} className="shrink-0" />
                    Solo lectura: {editing.reason}
                </div>
            )}

            {previewSql && (
                <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-4">
                    <div className="flex max-h-full w-full max-w-2xl flex-col rounded-lg border border-outline-variant bg-surface-container shadow-xl">
                        <p className="flex items-center gap-1.5 border-b border-outline-variant px-3 py-2 text-xs font-medium text-on-surface">
                            <Icon name="code" size={14} className="text-primary" />
                            Esto es lo que se va a ejecutar
                        </p>
                        <div className="min-h-0 flex-1 overflow-auto p-3">
                            <pre className="whitespace-pre-wrap font-mono text-[11px] leading-5 text-on-surface">
                                {previewSql.join('\n')}
                            </pre>
                            <p className="mt-2 text-[10px] leading-4 text-on-surface-variant">
                                Los valores se muestran escritos adentro de la sentencia para poder leerla. Al ejecutar
                                viajan como <strong>parámetros</strong>, aparte del texto — que es lo que hace que un
                                valor con comillas no pueda cambiar el sentido del UPDATE.
                            </p>
                        </div>
                        <div className="flex justify-end gap-2 border-t border-outline-variant px-3 py-2">
                            <button
                                onClick={() => setPreviewSql(null)}
                                className="rounded px-3 py-1 text-xs text-on-surface-variant hover:bg-surface-variant"
                            >
                                Cerrar
                            </button>
                            <button
                                onClick={() => {
                                    setPreviewSql(null)
                                    void editing.apply().catch(() => {})
                                }}
                                className="rounded bg-primary px-3 py-1 text-xs text-on-primary hover:opacity-90"
                            >
                                Ejecutar
                            </button>
                        </div>
                    </div>
                </div>
            )}

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
