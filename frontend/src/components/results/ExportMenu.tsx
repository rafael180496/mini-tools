import {useState} from 'react'
import {ExportResult} from '../../../wailsjs/go/main/App'
import {generateInsertStatements} from '../../lib/sqlGenerate'

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
    const [status, setStatus] = useState('')

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

    const disabled = columns.length === 0 || rows.length === 0

    return (
        <div className="relative flex items-center gap-2">
            <button
                onClick={() => setOpen((v) => !v)}
                disabled={disabled}
                title="Exporta las filas del resultado actual a un archivo, o cópialas como sentencias SQL"
                className="rounded bg-neutral-200 dark:bg-neutral-800 px-3 py-1 text-xs font-medium hover:bg-neutral-300 dark:hover:bg-neutral-700 disabled:opacity-50"
            >
                Exportar
            </button>
            {status && <span className="text-xs text-neutral-500">{status}</span>}
            {open && (
                <div className="absolute left-0 top-full z-10 mt-1 w-48 rounded border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900 p-1 shadow-lg">
                    <button
                        onClick={() => void exportAs('csv')}
                        title="Guarda el resultado como archivo .csv (valores separados por coma)"
                        className="block w-full rounded px-2 py-1 text-left text-xs text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-800"
                    >
                        CSV
                    </button>
                    <button
                        onClick={() => void exportAs('json')}
                        title="Guarda el resultado como archivo .json (un array de objetos, una fila por objeto)"
                        className="block w-full rounded px-2 py-1 text-left text-xs text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-800"
                    >
                        JSON
                    </button>
                    <button
                        onClick={() => void exportAs('xlsx')}
                        title="Guarda el resultado como archivo Excel (.xlsx)"
                        className="block w-full rounded px-2 py-1 text-left text-xs text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-800"
                    >
                        Excel (.xlsx)
                    </button>
                    <button
                        onClick={() => void copyAsInsert()}
                        title="Copia el resultado al portapapeles como sentencias INSERT listas para pegar en otro editor SQL"
                        className="block w-full rounded px-2 py-1 text-left text-xs text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-800"
                    >
                        Copiar como INSERT
                    </button>
                </div>
            )}
        </div>
    )
}
