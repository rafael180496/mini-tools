import {useEffect, useRef, useState} from 'react'
import Icon from '../Icon'
import {useT} from '../../i18n'

// El editor de UNA celda, elegido según el tipo de la columna.
//
// **Por qué el tipo importa acá y no es un capricho.** Escribir una fecha a
// mano en un campo de texto es la forma más fácil de guardar `2026-13-45`, y un
// booleano escrito como "si" no es `true` en ninguna base. Cada tipo trae el
// control que hace imposible el error obvio: un selector de fecha y hora para
// un timestamp, un desplegable para un booleano, un campo numérico para un
// número. Lo que no tiene un control mejor se edita como texto, que siempre
// funciona.
//
// **NULL es un botón aparte, no un texto que se escribe.** Es la única forma de
// distinguir "sin dato" de "texto vacío" sin inventar una convención — y
// confundir esos dos es cómo se pierde una diferencia que la base sí guarda.

interface Props {
    kind: string
    initial: string | null
    // La celda ya tenía una expresión pendiente: se reabre en modo fx.
    initialExpression?: boolean
    nullable: boolean
    onCommit: (value: string | null, expression?: boolean) => void
    onCancel: () => void
}

// toInputValue adapta el valor guardado al formato que pide cada control.
// `datetime-local` no acepta el espacio ni los microsegundos que devuelve la
// base, y si el formato no le gusta se queda vacío — que es exactamente cómo
// se pierde un dato sin darse cuenta.
function toInputValue(kind: string, raw: string | null): string {
    const v = raw ?? ''
    if (kind === 'datetime') return v.replace(' ', 'T').slice(0, 19)
    if (kind === 'date') return v.slice(0, 10)
    return v
}

export default function CellEditor({kind, initial, initialExpression = false, nullable, onCommit, onCancel}: Props) {
    const t = useT()
    // Modo expresión (el «Edit as SQL Expression» de DataGrip): el valor es
    // SQL que la base evalúa al guardar —SYSDATE, NOW(), SEQ.NEXTVAL—, así
    // que el control es siempre texto, sea cual sea el tipo de la columna.
    const [expr, setExpr] = useState(initialExpression)
    const [value, setValue] = useState(() => (initialExpression ? (initial ?? '') : toInputValue(kind, initial)))
    const ref = useRef<HTMLInputElement | HTMLSelectElement>(null)

    useEffect(() => {
        ref.current?.focus()
        if (ref.current instanceof HTMLInputElement) ref.current.select()
    }, [])

    const keys = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault()
            onCommit(value, expr)
        }
        if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
        }
    }

    const common =
        'w-full min-w-0 rounded border border-primary bg-surface px-1 py-0.5 font-mono text-xs text-on-surface outline-none'

    return (
        <div className="flex items-center gap-1">
            {expr ? (
                <input
                    ref={ref as React.RefObject<HTMLInputElement>}
                    type="text"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={keys}
                    placeholder={t.results.cellEditor.exprPlaceholder}
                    spellCheck={false}
                    className={`${common} italic text-primary`}
                />
            ) : kind === 'bool' ? (
                <select
                    ref={ref as React.RefObject<HTMLSelectElement>}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={keys}
                    className={common}
                >
                    <option value="true">{String(true)}</option>
                    <option value="false">{String(false)}</option>
                </select>
            ) : (
                <input
                    ref={ref as React.RefObject<HTMLInputElement>}
                    // `step=1` es lo que hace que el selector de fecha y hora
                    // muestre los segundos: sin eso los trunca en silencio.
                    type={kind === 'datetime' ? 'datetime-local' : kind === 'date' ? 'date' : 'text'}
                    step={kind === 'datetime' ? 1 : undefined}
                    inputMode={kind === 'number' ? 'decimal' : undefined}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={keys}
                    className={common}
                />
            )}

            <button
                onClick={() => {
                    // Al pasar a expresión se arranca vacío: el dato que había
                    // casi nunca es una expresión válida (una fecha sin
                    // comillas es una resta). Al volver, se recupera el dato.
                    setExpr((v) => !v)
                    setValue(expr ? toInputValue(kind, initialExpression ? null : initial) : '')
                    setTimeout(() => ref.current?.focus(), 0)
                }}
                title={t.results.cellEditor.exprTitle}
                className={`shrink-0 rounded px-1 font-mono text-ui-10 italic ${expr ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'}`}
            >
                {t.results.cellEditor.exprBadge}
            </button>
            {nullable && (
                <button
                    onClick={() => onCommit(null)}
                    title={t.results.cellEditor.nullTitle}
                    className="shrink-0 rounded px-1 text-ui-10 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    NULL
                </button>
            )}
            <button
                onClick={() => onCommit(value, expr)}
                title={t.results.cellEditor.commitTitle}
                className="shrink-0 rounded text-primary hover:bg-surface-variant"
            >
                <Icon name="check" size={13} />
            </button>
            <button
                onClick={onCancel}
                title={t.results.cellEditor.cancelTitle}
                className="shrink-0 rounded text-on-surface-variant hover:bg-surface-variant"
            >
                <Icon name="close" size={13} />
            </button>
        </div>
    )
}
