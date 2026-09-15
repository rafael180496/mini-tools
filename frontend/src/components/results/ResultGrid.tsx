import {useEffect, useState, useRef, type MouseEvent} from 'react'
import {ColumnDef, flexRender, getCoreRowModel, useReactTable} from '@tanstack/react-table'
import {useVirtualizer} from '@tanstack/react-virtual'
import Icon from '../Icon'
import {generateCSV, generateInsertStatements, generateUpdateStatements, type SqlTarget} from '../../lib/sqlGenerate'
import CellEditor from './CellEditor'
import {useRowEditing} from './useRowEditing'
import {MIN_COL_WIDTH, measureColumnWidth, measureColumnWidths} from './columnWidths'

interface ResultGridProps {
    columns: string[]
    rows: unknown[][]
    sortColumn?: string | null
    sortDirection?: 'asc' | 'desc' | null
    onSort?: (column: string) => void
    // Contra qué tabla y con qué motor se generan el INSERT y el UPDATE.
    // Sale de useSqlTarget: la tabla viene calificada con su esquema, y el
    // tipo de cada columna lo declara el driver del result set (más el
    // catálogo cuando lo conoce), así que las fechas salen convertidas
    // (TO_DATE en Oracle) y no como texto.
    sqlTarget?: SqlTarget
    // Conexión y consulta que produjeron estas filas. Con las dos, la grilla
    // puede ofrecer EDITAR: el backend decide si el resultado sale de una sola
    // tabla con clave primaria y genera el UPDATE. Sin ellas la grilla es de
    // solo lectura, que es lo correcto para un resultado de Mongo o de una
    // vista previa.
    connId?: string
    sqlText?: string
    // Aviso de lo que se ejecutó al guardar una edición de la grilla, para que
    // quede en la consola. Lo consume Workspace, que es quien tiene la consola
    // de la pestaña; la grilla solo lo reenvía.
    onEditsApplied?: (result: {statements: string[]; values: string[]; rows: number; durationMs: number; error: string}) => void
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
    sqlTarget,
    connId,
    sqlText,
    onEditsApplied,
}: ResultGridProps) {
    const parentRef = useRef<HTMLDivElement>(null)
    // Set (not a single index) so ctrl/cmd-click and shift-click can build a
    // multi-row selection — anchorRef tracks the last non-shift click so a
    // shift-click knows which end of the range to extend from.
    const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set())
    const anchorRef = useRef<number | null>(null)
    // Un click simple sobre una fila que YA está seleccionada no reduce la
    // selección hasta que se suelta el mouse — ver rowMouseDown/rowClick.
    const pendingCollapse = useRef<number | null>(null)
    const [copyStatus, setCopyStatus] = useState('')

    // Edición de celdas, al estilo DataGrip. Ver useRowEditing: lo que se
    // escribe queda PENDIENTE hasta que se manda, y lo que se puede editar lo
    // decide el backend.
    const editing = useRowEditing(connId, sqlText, columns, rows, onEditsApplied)
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

    // La grilla NO se remonta al cambiar de pestaña de resultado ni al
    // ejecutar de nuevo: es el mismo componente con otras filas. Sin esto, la
    // selección de un resultado quedaba viva sobre el siguiente — marcando
    // filas que nadie eligió y, si el nuevo tenía menos, apuntando a índices
    // que ya no existen (copiar como INSERT reventaba sobre un `undefined`).
    //
    // Se compara la PRIMERA fila por referencia: paginar con «Cargar más»
    // agrega al mismo array de origen, así que ahí la primera fila sigue
    // siendo el mismo objeto y la selección se conserva, que es lo que
    // corresponde. Un resultado distinto trae filas distintas.
    const firstRowRef = useRef<unknown>(undefined)

    // Ancho que le toca a cada columna por su contenido (ver columnWidths.ts).
    // Es el ancho POR DEFECTO, no el definitivo: lo que el usuario arrastra
    // vive en el estado de la tabla y pisa a este.
    const [autoSizes, setAutoSizes] = useState<Record<string, number>>({})

    const colDefs: ColumnDef<unknown[]>[] = columns.map((col, i) => ({
        id: col,
        header: col,
        accessorFn: (row) => row[i],
        size: autoSizes[col] ?? 160,
        minSize: MIN_COL_WIDTH,
    }))

    const table = useReactTable({
        data: rows,
        columns: colDefs,
        getCoreRowModel: getCoreRowModel(),
        columnResizeMode: 'onChange',
    })

    // Las columnas arrastradas a mano se conservan mientras el resultado tenga
    // LAS MISMAS columnas —reejecutar la consulta no debería devolver todo a su
    // sitio—, y se sueltan cuando cambia el juego de columnas, porque ahí los
    // anchos guardados son de otra consulta.
    const colsKey = columns.join('\u0000')
    const colsKeyRef = useRef(colsKey)
    const tableRef = useRef(table)
    tableRef.current = table

    useEffect(() => {
        const first = rows[0]
        const sameResult = first === firstRowRef.current && rows.length > 0
        if (sameResult && colsKeyRef.current === colsKey) return
        firstRowRef.current = first
        if (colsKeyRef.current !== colsKey) {
            colsKeyRef.current = colsKey
            tableRef.current.resetColumnSizing()
        }
        setSelectedIndices(new Set())
        anchorRef.current = null
        setAutoSizes(measureColumnWidths(columns, rows))
        // `columns` se deriva de colsKey: agregarlo dispararía el efecto en cada
        // render, porque el padre arma el array nuevo cada vez.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rows, colsKey])

    // Doble clic en el agarre: la columna se ajusta a su contenido. Se vuelve a
    // medir sobre las filas de AHORA —no sobre las que había al abrir— para que
    // después de «Cargar más» el ajuste tenga en cuenta lo que se sumó.
    function fitColumn(id: string) {
        const index = columns.indexOf(id)
        if (index < 0) return
        table.setColumnSizing((prev) => ({...prev, [id]: measureColumnWidth(id, index, rows)}))
    }

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

    const isResizing = table.getState().columnSizingInfo.isResizingColumn !== false
    const virtualItems = virtualizer.getVirtualItems()
    const totalHeight = virtualizer.getTotalSize()
    const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0
    const paddingBottom = virtualItems.length > 0 ? totalHeight - virtualItems[virtualItems.length - 1].end : 0
    // El filtro por longitud es el cinturón además de los tirantes: el efecto
    // que limpia la selección al cambiar de resultado corre DESPUÉS del render,
    // así que en ese render intermedio los índices viejos todavía están acá y
    // `rows[i]` sería `undefined` — que es un `row.map is not a function` al
    // copiar como INSERT.
    const sortedSelectedIndices = Array.from(selectedIndices)
        .filter((i) => i < rows.length)
        .sort((a, b) => a - b)
    const selectedRows = sortedSelectedIndices.map((i) => rows[i])

    async function copy(text: string, label: string) {
        await navigator.clipboard.writeText(text)
        setCopyStatus(label)
        setTimeout(() => setCopyStatus(''), 2000)
    }

    // Selección de filas, con el mismo modelo que el panel SFTP (ver
    // `rowMouseDown` en components/sftp/SftpPane.tsx):
    //
    //   - click simple      → deja seleccionada solo esa fila
    //   - Ctrl/Cmd+click    → suma o quita esa fila sin perder el resto
    //   - Shift+click       → marca el rango desde el ancla
    //   - Ctrl/Cmd+Shift    → suma el rango a lo que ya había
    //   - Ctrl/Cmd+A / Esc  → marcar todo / limpiar (ver el onKeyDown del scroller)
    //
    // **Todo se decide en `mousedown`, no en `click`**, y ese es justamente el
    // motivo por el que "el Control no funcionaba": en macOS Ctrl+click no
    // dispara `click` — WebKit lo convierte en `contextmenu`—, así que la rama
    // de Ctrl no llegaba a correr nunca. Es el mismo bug que ya se había
    // arreglado en el panel SFTP, y esta grilla se había quedado atrás.
    //
    // Y con modificadores hay que llamar a `preventDefault`: el navegador, ante
    // un Shift+click, extiende su propia selección de TEXTO. Eso es lo que
    // pintaba las letras de azul y tapaba el resaltado de la fila — "solo se
    // sombrean las letras". Sin modificadores no se toca, para que arrastrar
    // sobre una celda siga seleccionando su texto y se pueda copiar un valor
    // suelto a mano.

    // Marca el rango entre el ancla e `index`. Devuelve false si no hay ancla
    // utilizable, para que quien llama caiga al click normal.
    function selectRangeTo(index: number, additive: boolean): boolean {
        const anchor = anchorRef.current
        if (anchor === null || anchor < 0 || anchor >= rows.length) return false
        const [lo, hi] = anchor <= index ? [anchor, index] : [index, anchor]
        const range: number[] = []
        for (let i = lo; i <= hi; i++) range.push(i)
        setSelectedIndices((prev) => (additive ? new Set([...prev, ...range]) : new Set(range)))
        return true
    }

    function toggleRow(index: number) {
        setSelectedIndices((prev) => {
            const next = new Set(prev)
            if (next.has(index)) next.delete(index)
            else next.add(index)
            return next
        })
    }

    function rowMouseDown(index: number, e: MouseEvent) {
        // El botón derecho no toca la selección.
        if (e.button !== 0) return
        pendingCollapse.current = null
        // El teclado de la grilla (Ctrl/Cmd+A, Esc) necesita el foco, y con el
        // `preventDefault` de abajo el navegador ya no se lo va a dar solo.
        parentRef.current?.focus()

        const additive = e.metaKey || e.ctrlKey
        const ranged = e.shiftKey
        if (ranged || additive) {
            e.preventDefault()
            // Una selección de texto anterior queda pintada encima aunque este
            // click ya no la extienda; se limpia para que lo único resaltado
            // sean las filas.
            window.getSelection()?.removeAllRanges()
        }

        if (ranged && selectRangeTo(index, additive)) return

        anchorRef.current = index
        if (additive) {
            toggleRow(index)
            return
        }
        // Sobre una fila que ya está seleccionada no se colapsa nada todavía:
        // se decide al soltar, así el gesto de arrastrar para marcar texto
        // dentro de una celda ya seleccionada no borra la selección de filas.
        if (selectedIndices.has(index)) {
            pendingCollapse.current = index
            return
        }
        setSelectedIndices(new Set([index]))
    }

    function rowClick(index: number) {
        if (pendingCollapse.current !== index) return
        pendingCollapse.current = null
        // Un click simple sobre la única fila seleccionada la deselecciona: es
        // la vuelta a "nada seleccionado" sin tener que usar un modificador.
        setSelectedIndices((prev) => (prev.size === 1 && prev.has(index) ? new Set() : new Set([index])))
    }

    return (
        <div className="relative flex flex-1 flex-col overflow-hidden">
            <div
                ref={parentRef}
                // Foco propio, fuera del orden de tabulación (se lo da el click
                // en una fila), para poder atender los dos atajos que cualquiera
                // prueba antes de buscar un botón.
                tabIndex={-1}
                onKeyDown={(e) => {
                    // Dentro del editor de una celda, Ctrl/Cmd+A es "seleccionar
                    // todo el texto" y Esc es "cancelar la edición": ahí la
                    // grilla no se mete.
                    const tag = (e.target as HTMLElement).tagName
                    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
                    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
                        e.preventDefault()
                        setSelectedIndices(new Set(rows.map((_, i) => i)))
                        anchorRef.current = rows.length > 0 ? 0 : null
                        return
                    }
                    if (e.key === 'Escape' && selectedIndices.size > 0) {
                        e.preventDefault()
                        setSelectedIndices(new Set())
                    }
                }}
                className="flex-1 overflow-auto bg-surface font-mono outline-none"
            >
                <table
                    // select-none mientras se arrastra un borde: sin eso el
                    // navegador va pintando de azul el texto de las celdas por
                    // las que pasa el cursor mientras se cambia el ancho.
                    className={`border-collapse text-left text-xs ${isResizing ? 'select-none' : ''}`}
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
                                        {/* El borde de la columna ES el agarre. Antes era una
                                            franja transparente de 4 px: la separación no se veía,
                                            así que no había nada que invitara a arrastrarla — y
                                            embocarla era cuestión de suerte. Ahora se dibuja
                                            siempre una línea, la zona sensible son 9 px a caballo
                                            del borde (de ahí el -right-1 y el z-20, para ganarle
                                            a la columna de al lado), y la línea se engrosa y se
                                            pinta al pasar el mouse o mientras se arrastra. */}
                                        <div
                                            onMouseDown={header.getResizeHandler()}
                                            onTouchStart={header.getResizeHandler()}
                                            onDoubleClick={() => fitColumn(header.column.id)}
                                            title="Arrastrá para cambiar el ancho de la columna — doble clic lo ajusta al contenido"
                                            className="group absolute -right-1 top-0 z-20 flex h-full w-[9px] cursor-col-resize touch-none select-none items-stretch justify-center"
                                        >
                                            <span
                                                className={
                                                    header.column.getIsResizing()
                                                        ? 'w-0.5 bg-primary'
                                                        : 'w-px bg-outline-variant group-hover:w-0.5 group-hover:bg-primary'
                                                }
                                            />
                                        </div>
                                    </th>
                                ))}
                                {/* Columna de relleno, sin ancho propio: con
                                    table-layout fijo se queda con el espacio que
                                    sobra a la derecha. Sin ella, ese sobrante se
                                    repartía entre las columnas reales — y
                                    arrastrar un borde reescalaba todas las demás
                                    en vez de mover solo esa. */}
                                <th aria-hidden className="border-b border-outline-variant" />
                            </tr>
                        ))}
                    </thead>
                    <tbody>
                        {paddingTop > 0 && (
                            <tr>
                                <td style={{height: paddingTop}} colSpan={columns.length + 1} />
                            </tr>
                        )}
                        {virtualItems.map((vi) => {
                            const row = tableRows[vi.index]
                            const isSelected = selectedIndices.has(vi.index)
                            return (
                                <tr
                                    key={row.id}
                                    onMouseDown={(e) => rowMouseDown(vi.index, e)}
                                    onClick={() => rowClick(vi.index)}
                                    title="Click para seleccionar la fila — Ctrl/Cmd+click suma filas sueltas, Shift+click marca un rango (con Ctrl/Cmd lo suma), Ctrl/Cmd+A marca todo y Esc limpia — habilita copiarlas como texto, CSV, INSERT o UPDATE"
                                    className={`cursor-pointer ${
                                        isSelected
                                            ? 'bg-primary-container/70 hover:bg-primary-container/90'
                                            : 'odd:bg-surface even:bg-surface-container-lowest hover:bg-surface-variant/40'
                                    }`}
                                >
                                    {row.getVisibleCells().map((cell, ci) => {
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
                                                className={`truncate whitespace-nowrap border-b border-r border-outline-variant/30 px-3 py-1.5 text-on-surface ${
                                                    change
                                                        ? change.saved
                                                            ? 'bg-tertiary/15'
                                                            : 'bg-primary/20 font-medium'
                                                        : ''
                                                } ${editable ? 'cursor-text' : ''} ${
                                                    // Barra de acento en la primera celda de una
                                                    // fila marcada: el tinte de fondo se pierde
                                                    // bajo el mouse y sobre una grilla larga cuesta
                                                    // seguir dónde empieza y termina lo elegido.
                                                    // Va como sombra interior y no como borde para
                                                    // no correr el ancho de la columna.
                                                    isSelected && ci === 0
                                                        ? 'shadow-[inset_3px_0_0_0_var(--color-primary)]'
                                                        : ''
                                                }`}
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
                                    <td aria-hidden className="border-b border-outline-variant/30" />
                                </tr>
                            )
                        })}
                        {paddingBottom > 0 && (
                            <tr>
                                <td style={{height: paddingBottom}} colSpan={columns.length + 1} />
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            {/* Barra de cambios pendientes. Aparece solo cuando hay algo sin
                guardar: es el recordatorio de que lo que se ve en la grilla
                todavía no está en la base. */}
            {editing.pendingCount > 0 && (
                <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-outline-variant bg-primary/10 px-2 py-1 text-ui-11">
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
                <div className="flex shrink-0 items-center gap-1.5 border-t border-outline-variant bg-surface-container-low px-2 py-1 text-ui-10 text-on-surface-variant">
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
                            <pre className="whitespace-pre-wrap font-mono text-ui-11 leading-5 text-on-surface">
                                {previewSql.join('\n')}
                            </pre>
                            <p className="mt-2 text-ui-10 leading-4 text-on-surface-variant">
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
                            void copy(generateInsertStatements(sqlTarget ?? {table: 'tabla'}, columns, selectedRows), 'INSERT copiado')
                        }
                        title="Copia la(s) fila(s) seleccionadas como sentencias INSERT listas para pegar en el editor"
                        className="flex items-center gap-1.5 rounded px-2 py-1.5 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="add_box" size={15} />
                        Copiar como INSERT
                    </button>
                    <button
                        onClick={() =>
                            void copy(generateUpdateStatements(sqlTarget ?? {table: 'tabla'}, columns, selectedRows), 'UPDATE copiado')
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
