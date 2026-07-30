import {useEffect, useMemo, useRef, useState} from 'react'
import Icon from '../Icon'
import {formatValue, looksBinary, type RedisFormat} from '../../lib/redisFormat'

// A row of a complex Redis value, normalised so one table can render a
// hash, a list, a set, a sorted set and a stream.
//
// `id` is what identifies the row for editing: the field name for a hash,
// the index for a list, the member for a set/zset. `sortValue` is kept apart
// from the displayed text because a ZSET score sorts numerically and its
// rendering does not — sorting "10" before "9" is the classic bug this
// avoids.
export interface RedisRow {
    id: string
    cells: {key: string; text: string; sortValue: string | number}[]
}

export interface RedisColumn {
    key: string
    label: string
    hint: string
    // numeric columns right-align and sort numerically.
    numeric?: boolean
    // formatted columns run through the value formatter (JSON/hex/…).
    formatted?: boolean
}

interface RedisValueTableProps {
    columns: RedisColumn[]
    rows: RedisRow[]
    format: RedisFormat
    // Rendered at the right end of each row.
    rowActions?: (row: RedisRow) => React.ReactNode
    // Highlighted substring from the quick filter, if any.
    highlight?: string
    emptyLabel?: string

    // --- staged editing ---
    // editableColumn is the key of the one column a cell edit changes: the
    // value of a hash field, the score of a zset member. A set has none —
    // its member IS its identity, so "editing" it is a remove plus an add,
    // and pretending otherwise would silently create a second member.
    editableColumn?: string
    // pendingEdits maps rowId to the staged new value; pendingDeletes lists
    // the rows staged for removal. Both are rendered, neither is written:
    // the panel applies them when the user saves.
    pendingEdits?: Record<string, string>
    pendingDeletes?: string[]
    onEdit?: (rowId: string, value: string) => void
    onRevertEdit?: (rowId: string) => void
    onToggleDelete?: (rowId: string) => void
    // onExpand opens the side drawer for a value too long to edit in a cell.
    onExpand?: (rowId: string, value: string) => void
}

type SortDir = 'asc' | 'desc'

// Table view for the complex Redis types, replacing the flat text dump.
//
// Sorting is client-side over the loaded page, and deliberately so: Redis
// itself has no ordering for a hash or a set, and asking the server to sort
// would mean fetching the whole structure — which the paginated reader
// exists specifically to avoid. The header says as much, so nobody reads a
// sorted page as a sorted key.
export default function RedisValueTable({
    columns,
    rows,
    format,
    rowActions,
    highlight,
    emptyLabel,
    editableColumn,
    pendingEdits,
    pendingDeletes,
    onEdit,
    onRevertEdit,
    onToggleDelete,
    onExpand,
}: RedisValueTableProps) {
    const [sortKey, setSortKey] = useState<string | null>(null)
    const [sortDir, setSortDir] = useState<SortDir>('asc')

    // Spreadsheet navigation: one focused cell, one optionally being edited.
    // Indices point into the SORTED rows so the arrow keys move the way the
    // table looks, not the way the data arrived.
    const [focus, setFocus] = useState<{row: number; col: number} | null>(null)
    const [editing, setEditing] = useState<{row: number; col: number} | null>(null)
    const [draft, setDraft] = useState('')
    const inputRef = useRef<HTMLInputElement>(null)

    const editableIdx = editableColumn ? columns.findIndex((c) => c.key === editableColumn) : -1
    const deletes = useMemo(() => new Set(pendingDeletes ?? []), [pendingDeletes])

    const sorted = useMemo(() => {
        if (!sortKey) return rows
        const idx = columns.findIndex((c) => c.key === sortKey)
        if (idx < 0) return rows
        const factor = sortDir === 'asc' ? 1 : -1
        return [...rows].sort((a, b) => {
            const av = a.cells[idx]?.sortValue ?? ''
            const bv = b.cells[idx]?.sortValue ?? ''
            if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * factor
            return String(av).localeCompare(String(bv), 'es', {numeric: true}) * factor
        })
    }, [rows, columns, sortKey, sortDir])

    useEffect(() => {
        if (editing) inputRef.current?.focus()
    }, [editing])

    function beginEdit(rowIdx: number, colIdx: number) {
        if (colIdx !== editableIdx || !onEdit) return
        const row = sorted[rowIdx]
        if (!row || deletes.has(row.id)) return
        setDraft(pendingEdits?.[row.id] ?? row.cells[colIdx].text)
        setEditing({row: rowIdx, col: colIdx})
    }

    function commitEdit(then?: () => void) {
        if (!editing || !onEdit) return
        const row = sorted[editing.row]
        if (row) {
            // Typing a value back to what it already was clears the pending
            // mark instead of staging a write that changes nothing.
            if (draft === row.cells[editing.col].text) onRevertEdit?.(row.id)
            else onEdit(row.id, draft)
        }
        setEditing(null)
        then?.()
    }

    // Keyboard model, matching what a spreadsheet trains people to expect:
    // arrows move, Enter edits and then confirms moving down, Tab confirms
    // moving right, Escape abandons the cell without staging anything.
    function onCellKeyDown(e: React.KeyboardEvent, rowIdx: number, colIdx: number) {
        if (editing && editing.row === rowIdx && editing.col === colIdx) {
            if (e.key === 'Escape') {
                e.preventDefault()
                setEditing(null)
            } else if (e.key === 'Enter') {
                e.preventDefault()
                commitEdit(() => setFocus({row: Math.min(sorted.length - 1, rowIdx + 1), col: colIdx}))
            } else if (e.key === 'Tab') {
                e.preventDefault()
                commitEdit(() => setFocus({row: rowIdx, col: Math.min(columns.length - 1, colIdx + 1)}))
            }
            return
        }

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault()
                setFocus({row: Math.min(sorted.length - 1, rowIdx + 1), col: colIdx})
                break
            case 'ArrowUp':
                e.preventDefault()
                setFocus({row: Math.max(0, rowIdx - 1), col: colIdx})
                break
            case 'ArrowRight':
                e.preventDefault()
                setFocus({row: rowIdx, col: Math.min(columns.length - 1, colIdx + 1)})
                break
            case 'ArrowLeft':
                e.preventDefault()
                setFocus({row: rowIdx, col: Math.max(0, colIdx - 1)})
                break
            case 'Enter':
            case 'F2':
                e.preventDefault()
                beginEdit(rowIdx, colIdx)
                break
            case 'Delete':
                if (onToggleDelete) {
                    e.preventDefault()
                    onToggleDelete(sorted[rowIdx].id)
                }
                break
        }
    }

    function toggleSort(key: string) {
        if (sortKey === key) {
            setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
            return
        }
        setSortKey(key)
        setSortDir('asc')
    }

    if (rows.length === 0) {
        return <p className="p-2 text-xs text-on-surface-variant">{emptyLabel ?? 'Sin elementos.'}</p>
    }

    return (
        <div className="overflow-auto">
            <table className="w-full border-collapse text-xs">
                <thead className="sticky top-0 z-10 bg-surface-container">
                    <tr>
                        {columns.map((c) => (
                            <th
                                key={c.key}
                                onClick={() => toggleSort(c.key)}
                                title={`${c.hint} · Click para ordenar. El orden es sobre la página cargada: Redis no ordena hashes ni sets, y ordenar la clave entera exigiría traerla completa.`}
                                className={`cursor-pointer select-none border-b border-outline-variant px-2 py-1 font-medium text-on-surface-variant hover:text-on-surface ${
                                    c.numeric ? 'text-right' : 'text-left'
                                }`}
                            >
                                <span className="inline-flex items-center gap-1">
                                    {c.label}
                                    {sortKey === c.key && <Icon name={sortDir === 'asc' ? 'arrow_upward' : 'arrow_downward'} size={12} />}
                                </span>
                            </th>
                        ))}
                        {rowActions && <th className="w-20 border-b border-outline-variant" />}
                    </tr>
                </thead>
                <tbody>
                    {sorted.map((row, rowIdx) => {
                        const staged = pendingEdits?.[row.id]
                        const removing = deletes.has(row.id)
                        return (
                            <tr
                                key={row.id}
                                className={`group border-b border-outline-variant/40 ${
                                    removing ? 'bg-error/8 opacity-60' : staged !== undefined ? 'bg-tertiary/8' : 'hover:bg-surface-variant/40'
                                }`}
                            >
                                {row.cells.map((cell, i) => {
                                    const col = columns[i]
                                    const isEditable = i === editableIdx && !!onEdit && !removing
                                    const isEditing = editing?.row === rowIdx && editing?.col === i
                                    const isFocused = focus?.row === rowIdx && focus?.col === i
                                    // A staged edit shows the NEW value: the point of
                                    // staging is seeing what you are about to write.
                                    const raw = i === editableIdx && staged !== undefined ? staged : cell.text
                                    const shown = col?.formatted ? formatValue(raw, format) : raw
                                    const binary = col?.formatted && looksBinary(raw)

                                    if (isEditing) {
                                        return (
                                            <td key={cell.key} className="px-1 py-0.5 align-top">
                                                <input
                                                    ref={inputRef}
                                                    value={draft}
                                                    onChange={(e) => setDraft(e.target.value)}
                                                    onKeyDown={(e) => onCellKeyDown(e, rowIdx, i)}
                                                    onBlur={() => commitEdit()}
                                                    type={col?.numeric ? 'number' : 'text'}
                                                    className="w-full rounded border border-primary bg-surface-container-lowest px-1 py-0.5 font-mono text-xs text-on-surface outline-none"
                                                />
                                            </td>
                                        )
                                    }

                                    return (
                                        <td
                                            key={cell.key}
                                            tabIndex={0}
                                            onFocus={() => setFocus({row: rowIdx, col: i})}
                                            onDoubleClick={() => beginEdit(rowIdx, i)}
                                            onKeyDown={(e) => onCellKeyDown(e, rowIdx, i)}
                                            title={
                                                binary
                                                    ? 'Valor binario: se muestra reemplazado. Cambiá el formato a Hex para ver los bytes.'
                                                    : isEditable
                                                      ? `${shown}\n\nDoble click (o Enter) para editar. Flechas para moverte, Supr para marcar la fila como baja.`
                                                      : shown
                                            }
                                            className={`max-w-md truncate px-2 py-1 align-top font-mono outline-none ${
                                                col?.numeric ? 'text-right' : 'text-left'
                                            } ${binary ? 'italic text-on-surface-variant/70' : 'text-on-surface'} ${
                                                isFocused ? 'ring-1 ring-inset ring-primary' : ''
                                            } ${removing ? 'line-through' : ''} ${
                                                i === editableIdx && staged !== undefined ? 'border-l-2 border-l-tertiary font-medium' : ''
                                            } ${isEditable ? 'cursor-text' : ''}`}
                                        >
                                            {highlight ? highlightText(shown, highlight) : shown}
                                        </td>
                                    )
                                })}
                                {rowActions && (
                                    <td className="whitespace-nowrap px-2 py-1 text-right align-top">
                                        <span className="flex items-center justify-end gap-0.5">
                                            {onExpand && (
                                                <button
                                                    onClick={() => onExpand(row.id, staged ?? row.cells[Math.max(0, editableIdx)]?.text ?? '')}
                                                    title="Abre el valor en un panel lateral con editor — para JSON o textos que no entran en una celda"
                                                    className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-primary"
                                                >
                                                    <Icon name="open_in_full" size={13} />
                                                </button>
                                            )}
                                            {staged !== undefined && onRevertEdit && (
                                                <button
                                                    onClick={() => onRevertEdit(row.id)}
                                                    title="Descarta el cambio pendiente de esta fila y vuelve al valor de Redis"
                                                    className="rounded p-0.5 text-tertiary hover:bg-surface-variant"
                                                >
                                                    <Icon name="undo" size={13} />
                                                </button>
                                            )}
                                            {rowActions(row)}
                                        </span>
                                    </td>
                                )}
                            </tr>
                        )
                    })}
                </tbody>
            </table>
        </div>
    )
}

// highlightText wraps every occurrence of `needle` so a quick filter shows
// WHERE it matched, not just that it did.
export function highlightText(text: string, needle: string): React.ReactNode {
    const q = needle.trim()
    if (q === '') return text
    const lower = text.toLowerCase()
    const target = q.toLowerCase()

    const parts: React.ReactNode[] = []
    let from = 0
    let at = lower.indexOf(target)
    while (at >= 0) {
        if (at > from) parts.push(text.slice(from, at))
        parts.push(
            <mark key={`${at}`} className="rounded-sm bg-tertiary/30 text-on-surface">
                {text.slice(at, at + q.length)}
            </mark>,
        )
        from = at + q.length
        at = lower.indexOf(target, from)
    }
    if (from < text.length) parts.push(text.slice(from))
    return parts
}

// --- Row builders, one per Redis type --------------------------------------

export const HASH_COLUMNS: RedisColumn[] = [
    {key: 'field', label: 'Campo', hint: 'Nombre del campo del hash'},
    {key: 'value', label: 'Valor', hint: 'Contenido del campo', formatted: true},
]

export const LIST_COLUMNS: RedisColumn[] = [
    {key: 'index', label: '#', hint: 'Posición en la lista (LINDEX)', numeric: true},
    {key: 'value', label: 'Valor', hint: 'Contenido del elemento', formatted: true},
]

export const SET_COLUMNS: RedisColumn[] = [{key: 'member', label: 'Miembro', hint: 'Elemento del conjunto', formatted: true}]

export const ZSET_COLUMNS: RedisColumn[] = [
    {key: 'score', label: 'Score', hint: 'Puntaje que define el orden del sorted set', numeric: true},
    {key: 'member', label: 'Miembro', hint: 'Elemento del sorted set', formatted: true},
]

export const STREAM_COLUMNS: RedisColumn[] = [
    {key: 'id', label: 'ID', hint: 'Identificador de la entrada (timestamp-secuencia)'},
    {key: 'fields', label: 'Campos', hint: 'Pares campo/valor de la entrada', formatted: true},
]

export function hashRows(pairs: {field: string; value: string}[]): RedisRow[] {
    return pairs.map((p) => ({
        id: p.field,
        cells: [
            {key: 'field', text: p.field, sortValue: p.field},
            {key: 'value', text: p.value, sortValue: p.value},
        ],
    }))
}

// listRows takes the page's starting offset so the displayed index is the
// real position in the list, not the position within the page.
export function listRows(items: string[], offset: number): RedisRow[] {
    return items.map((v, i) => ({
        id: String(offset + i),
        cells: [
            {key: 'index', text: String(offset + i), sortValue: offset + i},
            {key: 'value', text: v, sortValue: v},
        ],
    }))
}

export function setRows(members: string[]): RedisRow[] {
    return members.map((m) => ({id: m, cells: [{key: 'member', text: m, sortValue: m}]}))
}

export function zsetRows(items: {member: string; score: number}[]): RedisRow[] {
    return items.map((z) => ({
        id: z.member,
        cells: [
            // sortValue stays numeric so scores order 9 before 10.
            {key: 'score', text: String(z.score), sortValue: z.score},
            {key: 'member', text: z.member, sortValue: z.member},
        ],
    }))
}

export function streamRows(entries: {id: string; fields: Record<string, string>}[]): RedisRow[] {
    return entries.map((e) => ({
        id: e.id,
        cells: [
            {key: 'id', text: e.id, sortValue: e.id},
            {
                key: 'fields',
                text: JSON.stringify(e.fields ?? {}, null, 2),
                sortValue: Object.keys(e.fields ?? {}).join(','),
            },
        ],
    }))
}
