import {useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {ExportResult} from '../../../wailsjs/go/main/App'
import {generateInsertStatements} from '../../lib/sqlGenerate'
import Icon from '../Icon'

interface ExportMenuProps {
    columns: string[]
    rows: unknown[][]
    tableNameHint?: string
}

// Spec: "export de grid: CSV, JSON, copiar como INSERT" (+ Excel, per the
// performance/tooling section). Each format shows a native save dialog
// except "copiar como INSERT", which goes straight to the clipboard.
export default function ExportMenu({columns, rows, tableNameHint}: ExportMenuProps) {
    const [open, setOpen] = useState(false)
    const [menuPos, setMenuPos] = useState({top: 0, left: 0})
    const [status, setStatus] = useState('')
    const buttonRef = useRef<HTMLButtonElement>(null)

    async function exportAs(format: 'csv' | 'json' | 'xlsx') {
        setOpen(false)
        try {
            const dest = await ExportResult(columns, rows, format)
            setStatus(dest ? `Exportado a ${dest}` : '')
        } catch (err) {
            setStatus(`Error: ${String(err)}`)
        }
    }

    async function copyAsInsert() {
        setOpen(false)
        const sql = generateInsertStatements(tableNameHint ?? 'tabla', columns, rows)
        await navigator.clipboard.writeText(sql)
        setStatus(`${rows.length} INSERT(s) copiados al portapapeles`)
    }

    // Positioned via viewport coords + a portal to document.body instead of
    // position:absolute inside this component's own wrapper — ExportMenu
    // also renders inside RedisResultView.tsx's scrollable
    // (overflow-y-auto) command transcript, one instance per command; an
    // absolute-inside-a-scroll-container menu gets clipped there the same
    // way EditorTabs' connection/language menu did (see its fix — fixing
    // one overflow axis forces the other to clip too). A portal escapes
    // that entirely, regardless of which scrollable/non-scrollable context
    // this component is used from.
    function toggleOpen() {
        if (!open) {
            const rect = buttonRef.current?.getBoundingClientRect()
            if (rect) setMenuPos({top: rect.bottom + 4, left: rect.left})
        }
        setOpen((v) => !v)
    }

    const disabled = columns.length === 0 || rows.length === 0

    return (
        <div className="flex items-center gap-2">
            <button
                ref={buttonRef}
                onClick={toggleOpen}
                disabled={disabled}
                title="Exporta las filas del resultado actual a un archivo, o cópialas como sentencias SQL"
                className="flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium text-on-surface-variant hover:bg-surface-variant disabled:opacity-50"
            >
                <Icon name="download" size={16} />
                Exportar
            </button>
            {status && <span className="text-xs text-on-surface-variant">{status}</span>}
            {open &&
                createPortal(
                    <>
                        <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
                        <div
                            style={{position: 'fixed', top: menuPos.top, left: menuPos.left}}
                            className="z-50 w-48 rounded-lg border border-outline-variant bg-surface-container-high p-1 shadow-lg"
                        >
                            <button
                                onClick={() => void exportAs('csv')}
                                title="Guarda el resultado como archivo .csv (valores separados por coma)"
                                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-on-surface hover:bg-surface-variant"
                            >
                                <Icon name="grid_on" size={15} />
                                CSV
                            </button>
                            <button
                                onClick={() => void exportAs('json')}
                                title="Guarda el resultado como archivo .json (un array de objetos, una fila por objeto)"
                                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-on-surface hover:bg-surface-variant"
                            >
                                <Icon name="data_object" size={15} />
                                JSON
                            </button>
                            <button
                                onClick={() => void exportAs('xlsx')}
                                title="Guarda el resultado como archivo Excel (.xlsx)"
                                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-on-surface hover:bg-surface-variant"
                            >
                                <Icon name="table_view" size={15} />
                                Excel (.xlsx)
                            </button>
                            <button
                                onClick={() => void copyAsInsert()}
                                title="Copia el resultado al portapapeles como sentencias INSERT listas para pegar en otro editor SQL"
                                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-on-surface hover:bg-surface-variant"
                            >
                                <Icon name="content_copy" size={15} />
                                Copiar como INSERT
                            </button>
                        </div>
                    </>,
                    document.body,
                )}
        </div>
    )
}
