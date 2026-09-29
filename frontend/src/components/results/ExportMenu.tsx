import {useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {ExportResult} from '../../../wailsjs/go/main/App'
import {generateInsertStatements, type SqlTarget} from '../../lib/sqlGenerate'
import Icon from '../Icon'
import {useT} from '../../i18n'

interface ExportMenuProps {
    columns: string[]
    rows: unknown[][]
    // Contra qué tabla y con qué motor se escribe el INSERT — ver useSqlTarget:
    // sale del catálogo del backend, no del nombre de la conexión.
    sqlTarget?: SqlTarget
}

// Spec: "export de grid: CSV, JSON, copiar como INSERT" (+ Excel, per the
// performance/tooling section). Each format shows a native save dialog
// except "copiar como INSERT", which goes straight to the clipboard.
export default function ExportMenu({columns, rows, sqlTarget}: ExportMenuProps) {
    const t = useT()
    const [open, setOpen] = useState(false)
    const [menuPos, setMenuPos] = useState({top: 0, left: 0})
    const [status, setStatus] = useState('')
    const buttonRef = useRef<HTMLButtonElement>(null)

    async function exportAs(format: 'csv' | 'json' | 'xlsx') {
        setOpen(false)
        try {
            const dest = await ExportResult(columns, rows, format)
            setStatus(dest ? t.results.export.exportedTo({dest}) : '')
        } catch (err) {
            setStatus(t.results.export.error({error: String(err)}))
        }
    }

    async function copyAsInsert() {
        setOpen(false)
        const sql = generateInsertStatements(sqlTarget ?? {table: t.results.placeholderTable}, columns, rows)
        await navigator.clipboard.writeText(sql)
        setStatus(t.results.export.insertsCopied(rows.length))
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
                title={t.results.export.buttonTitle}
                className="flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium text-on-surface-variant hover:bg-surface-variant disabled:opacity-50"
            >
                <Icon name="download" size={16} />
                {t.results.export.button}
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
                                title={t.results.export.csvTitle}
                                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-on-surface hover:bg-surface-variant"
                            >
                                <Icon name="grid_on" size={15} />
                                CSV
                            </button>
                            <button
                                onClick={() => void exportAs('json')}
                                title={t.results.export.jsonTitle}
                                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-on-surface hover:bg-surface-variant"
                            >
                                <Icon name="data_object" size={15} />
                                JSON
                            </button>
                            <button
                                onClick={() => void exportAs('xlsx')}
                                title={t.results.export.xlsxTitle}
                                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-on-surface hover:bg-surface-variant"
                            >
                                <Icon name="table_view" size={15} />
                                {t.results.export.xlsx}
                            </button>
                            <button
                                onClick={() => void copyAsInsert()}
                                title={t.results.export.copyInsertTitle}
                                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-on-surface hover:bg-surface-variant"
                            >
                                <Icon name="content_copy" size={15} />
                                {t.results.export.copyInsert}
                            </button>
                        </div>
                    </>,
                    document.body,
                )}
        </div>
    )
}
