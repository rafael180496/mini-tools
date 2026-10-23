import {useEffect, useMemo, useState, useRef, type MouseEvent, type ReactNode} from 'react'
import {ColumnDef, columnResizingFeature, columnSizingFeature, flexRender, tableFeatures, useTable} from '@tanstack/react-table'
import {useVirtualizer} from '@tanstack/react-virtual'
import Icon from '../Icon'
import {generateCSV, generateInsertStatements, generateUpdateStatements, type SqlTarget} from '../../lib/sqlGenerate'
import CellEditor from './CellEditor'
import {useRowEditing} from './useRowEditing'
import {MIN_COL_WIDTH, measureColumnWidth, measureColumnWidths} from './columnWidths'
import {formatNumber, useT} from '../../i18n'
import GridStatsPanel from './GridStatsPanel'
import RecordView from './RecordView'
import {columnStats, rowMatches} from './columnStats'
import {highlightMatch} from './highlightMatch'

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
    // Lo que va al principio de la barra de la grilla, antes del filtro. Hoy
    // es el menú Exportar: vivía en una fila propia encima, y esa fila es la
    // que ahora tiene el filtro, las estadísticas y la vista de registro.
    toolbarStart?: ReactNode
}

const ROW_HEIGHT = 28

// Se arma una vez, fuera del componente: useTable pide que los features no
// cambien de identidad entre renders.
const gridFeatures = tableFeatures({columnSizingFeature, columnResizingFeature})

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
    toolbarStart,
}: ResultGridProps) {
    const t = useT()
    const parentRef = useRef<HTMLDivElement>(null)
    const filterRef = useRef<HTMLInputElement>(null)

    // Filtro rápido, estadísticas y vista de registro — las herramientas de
    // la grilla de DataGrip que no vuelven a consultar la base. Las tres
    // trabajan sobre las filas YA CARGADAS, y lo dicen.
    const [filter, setFilter] = useState('')
    const needle = filter.trim().toLowerCase()
    const [view, setView] = useState<'grid' | 'record'>('grid')
    const [statsOpen, setStatsOpen] = useState(false)
    const [statsColumn, setStatsColumn] = useState('')
    const [recordPos, setRecordPos] = useState(0)

    // Índices (en `rows`) de las filas que pasan el filtro. La selección, la
    // edición y el ancla siguen hablando en índices de `rows`: el filtro solo
    // decide cuáles se dibujan, así que quitarlo no pierde nada de lo marcado
    // ni de lo editado.
    const visible = useMemo(() => {
        const out: number[] = []
        for (let i = 0; i < rows.length; i++) {
            if (!needle || rowMatches(rows[i], needle)) out.push(i)
        }
        return out
    }, [rows, needle])
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

    const colDefs: ColumnDef<typeof gridFeatures, unknown[]>[] = columns.map((col, i) => ({
        id: col,
        header: col,
        accessorFn: (row) => row[i],
        size: autoSizes[col] ?? 160,
        minSize: MIN_COL_WIDTH,
    }))

    const table = useTable({
        features: gridFeatures,
        data: rows,
        columns: colDefs,
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
        setRecordPos(0)
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
        count: visible.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 12,
    })

    // La columna de las estadísticas: la elegida si sigue existiendo; si no,
    // la primera numérica, que es casi siempre la que se quiere sumar.
    const statsCol = columns.includes(statsColumn)
        ? statsColumn
        : (columns.find((_, i) => rows.length > 0 && columnStats(rows.slice(0, 50), i).numeric) ?? columns[0] ?? '')

    if (columns.length === 0) {
        return (
            <div className="flex flex-1 items-center justify-center gap-2 bg-surface text-xs text-on-surface-variant/60">
                <Icon name="table_rows" size={16} />
                {t.results.grid.empty}
            </div>
        )
    }

    const isResizing = table.state.columnResizing.isResizingColumn !== false
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
        // El rango se mide en filas VISIBLES: con un filtro puesto, Shift+click
        // marca lo que se ve entre las dos, no las filas escondidas de en medio.
        const a = visible.indexOf(anchor)
        const b = visible.indexOf(index)
        if (a < 0 || b < 0) return false
        const [lo, hi] = a <= b ? [a, b] : [b, a]
        const range = visible.slice(lo, hi + 1)
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

    function openRecordView() {
        // Abre la fila seleccionada (la primera, si hay varias); sin selección,
        // la primera visible.
        const first = sortedSelectedIndices.find((i) => visible.includes(i))
        setRecordPos(first === undefined ? 0 : visible.indexOf(first))
        setView('record')
    }

    const statsRows = selectedRows.length > 0 ? selectedRows : visible.map((i) => rows[i])
    const recordRow = rows[visible[Math.min(recordPos, Math.max(0, visible.length - 1))]]
    const toggleBtn = (active: boolean) =>
        `flex items-center gap-1 rounded px-1.5 py-0.5 text-ui-11 ${
            active ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
        }`

    return (
        <div className="relative flex flex-1 flex-col overflow-hidden">
            <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant bg-surface-container px-2 py-1">
                {toolbarStart}
                <div
                    className="flex h-6 min-w-0 max-w-[22em] flex-1 items-center gap-1 rounded border border-outline-variant bg-surface-container-lowest px-1.5 focus-within:border-primary"
                    title={t.results.grid.filterTitle}
                >
                    <Icon name="filter_list" size={13} className="shrink-0 text-on-surface-variant" />
                    <input
                        ref={filterRef}
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                                e.preventDefault()
                                setFilter('')
                                parentRef.current?.focus()
                            }
                        }}
                        placeholder={t.results.grid.filterPlaceholder}
                        spellCheck={false}
                        className="min-w-0 flex-1 bg-transparent font-mono text-ui-11 text-on-surface outline-none placeholder:text-on-surface-variant/60"
                    />
                    {filter && (
                        <button onClick={() => setFilter('')} title={t.results.grid.clearFilter} className="shrink-0 rounded text-on-surface-variant hover:text-on-surface">
                            <Icon name="close" size={12} />
                        </button>
                    )}
                </div>
                {needle && (
                    <span className={`shrink-0 font-mono text-ui-11 ${visible.length === 0 ? 'text-error' : 'text-on-surface-variant'}`}>
                        {visible.length === 0
                            ? t.results.grid.filterNoMatches
                            : t.results.grid.filterCount({shown: formatNumber(visible.length), total: formatNumber(rows.length)})}
                    </span>
                )}
                <div className="ml-auto flex shrink-0 items-center gap-1">
                    <button onClick={() => setStatsOpen((v) => !v)} title={t.results.grid.statsTitle} className={toggleBtn(statsOpen)}>
                        <Icon name="functions" size={14} />
                        {t.results.grid.statsToggle}
                    </button>
                    <button
                        onClick={() => (view === 'record' ? setView('grid') : openRecordView())}
                        title={t.results.grid.recordTitle}
                        className={toggleBtn(view === 'record')}
                    >
                        <Icon name="view_list" size={14} />
                        {t.results.grid.recordToggle}
                    </button>
                </div>
            </div>

            {view === 'record' ? (
                <RecordView
                    columns={columns}
                    row={recordRow}
                    pos={Math.min(recordPos, Math.max(0, visible.length - 1))}
                    count={visible.length}
                    onPos={setRecordPos}
                    filter={needle}
                    onCopy={(value, col) => void copy(value, t.results.grid.recordValueCopied(col))}
                />
            ) : (
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
                            setSelectedIndices(new Set(visible))
                            anchorRef.current = visible.length > 0 ? visible[0] : null
                            return
                        }
                        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
                            e.preventDefault()
                            filterRef.current?.focus()
                            filterRef.current?.select()
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
                                                title={t.results.grid.sortTitle}
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
                                                title={t.results.grid.resizeTitle}
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
                                // Índice en `rows`, no en la lista filtrada: es el
                                // que entienden la selección y la edición.
                                const ri = visible[vi.index]
                                const row = tableRows[ri]
                                if (!row) return null
                                const isSelected = selectedIndices.has(ri)
                                return (
                                    <tr
                                        key={row.id}
                                        onMouseDown={(e) => rowMouseDown(ri, e)}
                                        onClick={() => rowClick(ri)}
                                        title={t.results.grid.rowTitle}
                                        className={`cursor-pointer ${
                                            isSelected
                                                ? 'bg-primary-container/70 hover:bg-primary-container/90'
                                                : 'odd:bg-surface even:bg-surface-container-lowest hover:bg-surface-variant/40'
                                        }`}
                                    >
                                        {row.getAllCells().map((cell, ci) => {
                                            const colName = cell.column.id
                                            const editable = editing.editableCols.get(colName.toLowerCase())
                                            const change = editing.valueOf(ri, colName)
                                            const value = change ? change.value : cell.getValue()
                                            const isEditing =
                                                editCell?.row === ri && editCell.col === colName
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
                                                        setEditCell({row: ri, col: colName})
                                                    }}
                                                    title={
                                                        editable
                                                            ? t.results.grid.editCellTitle({dataType: editable.dataType})
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
                                                            initialExpression={!!change?.expression}
                                                            nullable={editable.nullable}
                                                            onCommit={(v, expression) => {
                                                                editing.setValue(ri, colName, v, expression)
                                                                setEditCell(null)
                                                            }}
                                                            onCancel={() => setEditCell(null)}
                                                        />
                                                    ) : change?.expression ? (
                                                        <span
                                                            className="italic text-primary"
                                                            title={t.results.cellEditor.exprCellTitle({expr: String(value)})}
                                                        >
                                                            <span className="mr-1 font-mono not-italic opacity-70">{t.results.cellEditor.exprBadge}</span>
                                                            {String(value)}
                                                        </span>
                                                    ) : value === null || value === undefined ? (
                                                        <span className="italic text-on-surface-variant/60">NULL</span>
                                                    ) : needle ? (
                                                        highlightMatch(String(value), needle)
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
            )}

            {statsOpen && (
                <GridStatsPanel
                    columns={columns}
                    rows={statsRows}
                    scopeLabel={
                        selectedRows.length > 0
                            ? t.results.grid.statsScopeSelected(formatNumber(selectedRows.length))
                            : t.results.grid.statsScopeAll(formatNumber(visible.length))
                    }
                    column={statsCol}
                    onColumn={setStatsColumn}
                    onCopy={(v) => void copy(v, t.results.grid.statCopied)}
                />
            )}

            {/* Barra de cambios pendientes. Aparece solo cuando hay algo sin
                guardar: es el recordatorio de que lo que se ve en la grilla
                todavía no está en la base. */}
            {editing.pendingCount > 0 && (
                <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-outline-variant bg-primary/10 px-2 py-1 text-ui-11">
                    <Icon name="edit" size={13} className="shrink-0 text-primary" />
                    <span className="text-on-surface">
                        {t.results.grid.pendingCount(editing.pendingCount)}
                    </span>

                    <button
                        onClick={() => void editing.preview().then(setPreviewSql).catch((e) => editing.setError(String(e)))}
                        title={t.results.grid.previewSqlTitle}
                        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="visibility" size={13} />
                        {t.results.grid.previewSql}
                    </button>
                    <button
                        onClick={() => void editing.apply().catch(() => {})}
                        disabled={editing.busy}
                        title={t.results.grid.saveTitle}
                        className="flex items-center gap-1 rounded bg-primary/20 px-1.5 py-0.5 text-primary hover:bg-primary/30 disabled:opacity-50"
                    >
                        <Icon name="upload" size={13} />
                        {editing.busy ? t.results.grid.saving : t.results.grid.save}
                    </button>
                    <button
                        onClick={editing.discard}
                        title={t.results.grid.discardTitle}
                        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="undo" size={13} />
                        {t.results.grid.discard}
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
                    {t.results.grid.readOnly({reason: editing.reason})}
                </div>
            )}

            {previewSql && (
                <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-4">
                    <div className="flex max-h-full w-full max-w-2xl flex-col rounded-lg border border-outline-variant bg-surface-container shadow-xl">
                        <p className="flex items-center gap-1.5 border-b border-outline-variant px-3 py-2 text-xs font-medium text-on-surface">
                            <Icon name="code" size={14} className="text-primary" />
                            {t.results.grid.previewHeading}
                        </p>
                        <div className="min-h-0 flex-1 overflow-auto p-3">
                            <pre className="whitespace-pre-wrap font-mono text-ui-11 leading-5 text-on-surface">
                                {previewSql.join('\n')}
                            </pre>
                            <p className="mt-2 text-ui-10 leading-4 text-on-surface-variant">
                                {t.results.grid.previewNoteBefore}
                                <strong>{t.results.grid.previewNoteParams}</strong>
                                {t.results.grid.previewNoteAfter}
                            </p>
                        </div>
                        <div className="flex justify-end gap-2 border-t border-outline-variant px-3 py-2">
                            <button
                                onClick={() => setPreviewSql(null)}
                                className="rounded px-3 py-1 text-xs text-on-surface-variant hover:bg-surface-variant"
                            >
                                {t.common.close}
                            </button>
                            <button
                                onClick={() => {
                                    setPreviewSql(null)
                                    void editing.apply().catch(() => {})
                                }}
                                className="rounded bg-primary px-3 py-1 text-xs text-on-primary hover:opacity-90"
                            >
                                {t.results.grid.execute}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {selectedRows.length > 0 && view === 'grid' && (
                <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-lg border border-outline-variant bg-surface-container-high p-1 shadow-lg">
                    {copyStatus && <span className="px-2 text-xs text-secondary">{copyStatus}</span>}
                    {selectedRows.length > 1 && (
                        <span className="px-1 text-xs text-on-surface-variant/70">{t.results.grid.selectedRows(selectedRows.length)}</span>
                    )}
                    <button
                        onClick={() =>
                            void copy(
                                selectedRows.map((r) => r.map((v) => (v === null || v === undefined ? '' : String(v))).join('\t')).join('\n'),
                                t.results.grid.rowsCopied(selectedRows.length)
                            )
                        }
                        title={t.results.grid.copyRowsTitle}
                        className="flex items-center gap-1.5 rounded px-2 py-1.5 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="content_copy" size={15} />
                        {t.results.grid.copyRows(selectedRows.length)}
                    </button>
                    <button
                        onClick={() => void copy(generateCSV(columns, selectedRows), t.results.grid.csvCopied)}
                        title={t.results.grid.copyCsvTitle}
                        className="flex items-center gap-1.5 rounded px-2 py-1.5 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="grid_on" size={15} />
                        {t.results.grid.copyCsv}
                    </button>
                    <button
                        onClick={() =>
                            void copy(generateInsertStatements(sqlTarget ?? {table: t.results.placeholderTable}, columns, selectedRows), t.results.grid.insertCopied)
                        }
                        title={t.results.grid.copyInsertTitle}
                        className="flex items-center gap-1.5 rounded px-2 py-1.5 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="add_box" size={15} />
                        {t.results.grid.copyInsert}
                    </button>
                    <button
                        onClick={() =>
                            void copy(generateUpdateStatements(sqlTarget ?? {table: t.results.placeholderTable}, columns, selectedRows), t.results.grid.updateCopied)
                        }
                        title={t.results.grid.copyUpdateTitle}
                        className="flex items-center gap-1.5 rounded px-2 py-1.5 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="edit_note" size={15} />
                        {t.results.grid.copyUpdate}
                    </button>
                    <button
                        onClick={() => setSelectedIndices(new Set())}
                        title={t.results.grid.deselectTitle}
                        className="rounded p-1.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="close" size={15} />
                    </button>
                </div>
            )}
        </div>
    )
}
