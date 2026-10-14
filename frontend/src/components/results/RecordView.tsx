import Icon from '../Icon'
import {formatNumber, useT} from '../../i18n'
import {highlightMatch} from './highlightMatch'

interface RecordViewProps {
    columns: string[]
    row: unknown[] | undefined
    // Posición dentro de las filas visibles (0-based) y cuántas hay.
    pos: number
    count: number
    onPos: (pos: number) => void
    filter: string
    onCopy: (value: string, column: string) => void
}

function display(v: unknown): string {
    if (typeof v === 'object' && v !== null) return JSON.stringify(v, null, 2)
    return String(v)
}

// La vista de registro (el «Transpose» de DataGrip): una fila a la vez, cada
// columna en su renglón y el valor COMPLETO, sin el recorte de la celda. Es
// la forma de leer una fila de una tabla de sesenta columnas sin desplazarse
// de costado, y de ver entero un texto largo o un JSON.
//
// Es de solo lectura a propósito: la edición vive en la grilla, donde están
// el borrador de cambios y el «Ver el SQL». Dos lugares para editar la misma
// fila son dos estados pendientes que hay que conciliar.
export default function RecordView({columns, row, pos, count, onPos, filter, onCopy}: RecordViewProps) {
    const t = useT()
    const tg = t.results.grid
    const go = (p: number) => onPos(Math.max(0, Math.min(count - 1, p)))
    const navBtn = 'rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-30 disabled:hover:bg-transparent'

    return (
        <div
            tabIndex={-1}
            onKeyDown={(e) => {
                const tag = (e.target as HTMLElement).tagName
                if (tag === 'INPUT' || tag === 'SELECT') return
                if (e.key === 'ArrowLeft') {
                    e.preventDefault()
                    go(pos - 1)
                } else if (e.key === 'ArrowRight') {
                    e.preventDefault()
                    go(pos + 1)
                }
            }}
            className="flex min-h-0 flex-1 flex-col bg-surface outline-none"
        >
            <div className="flex shrink-0 items-center gap-1 border-b border-outline-variant bg-surface-container-low px-2 py-0.5 text-ui-11 text-on-surface-variant">
                <button onClick={() => go(0)} disabled={pos <= 0} title={tg.recordFirst} className={navBtn}>
                    <Icon name="first_page" size={15} />
                </button>
                <button onClick={() => go(pos - 1)} disabled={pos <= 0} title={tg.recordPrev} className={navBtn}>
                    <Icon name="chevron_left" size={15} />
                </button>
                <span className="px-1 font-mono text-on-surface">
                    {tg.recordPos({i: formatNumber(count === 0 ? 0 : pos + 1), n: formatNumber(count)})}
                </span>
                <button onClick={() => go(pos + 1)} disabled={pos >= count - 1} title={tg.recordNext} className={navBtn}>
                    <Icon name="chevron_right" size={15} />
                </button>
                <button onClick={() => go(count - 1)} disabled={pos >= count - 1} title={tg.recordLast} className={navBtn}>
                    <Icon name="last_page" size={15} />
                </button>
                <span className="ml-auto flex items-center gap-1 opacity-70">
                    <Icon name="lock" size={11} />
                    {tg.recordReadOnly}
                </span>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
                {row && (
                    <table className="w-full border-collapse text-left text-xs">
                        <tbody>
                            {columns.map((col, i) => {
                                const v = row[i]
                                const isNull = v === null || v === undefined
                                const text = isNull ? '' : display(v)
                                return (
                                    <tr key={col} className="group odd:bg-surface even:bg-surface-container-lowest">
                                        <th
                                            scope="row"
                                            className="sticky left-0 w-[1%] max-w-[22em] truncate whitespace-nowrap border-b border-r border-outline-variant/30 bg-surface-container px-3 py-1.5 align-top font-sans font-medium text-on-surface-variant"
                                            title={col}
                                        >
                                            {col}
                                        </th>
                                        <td className="border-b border-outline-variant/30 px-3 py-1.5 align-top font-mono text-on-surface">
                                            <div className="flex items-start gap-2">
                                                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                                                    {isNull ? (
                                                        <span className="italic text-on-surface-variant/60">NULL</span>
                                                    ) : (
                                                        highlightMatch(text, filter)
                                                    )}
                                                </span>
                                                {!isNull && (
                                                    <button
                                                        onClick={() => onCopy(text, col)}
                                                        title={tg.recordCopyValue}
                                                        className="shrink-0 rounded p-0.5 text-on-surface-variant opacity-0 hover:bg-surface-variant hover:text-on-surface focus:opacity-100 group-hover:opacity-100"
                                                    >
                                                        <Icon name="content_copy" size={13} />
                                                    </button>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    )
}
