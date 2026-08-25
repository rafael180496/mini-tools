import {useEffect, useRef, useState} from 'react'
import Icon from '../Icon'

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
    nullable: boolean
    onCommit: (value: string | null) => void
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

export default function CellEditor({kind, initial, nullable, onCommit, onCancel}: Props) {
    const [value, setValue] = useState(() => toInputValue(kind, initial))
    const ref = useRef<HTMLInputElement | HTMLSelectElement>(null)

    useEffect(() => {
        ref.current?.focus()
        if (ref.current instanceof HTMLInputElement) ref.current.select()
    }, [])

    const keys = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault()
            onCommit(value)
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
            {kind === 'bool' ? (
                <select
                    ref={ref as React.RefObject<HTMLSelectElement>}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={keys}
                    className={common}
                >
                    <option value="true">true</option>
                    <option value="false">false</option>
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

            {nullable && (
                <button
                    onClick={() => onCommit(null)}
                    title="Deja la celda sin dato (NULL). Es distinto de dejarla vacía: la base guarda esa diferencia."
                    className="shrink-0 rounded px-1 text-ui-10 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    NULL
                </button>
            )}
            <button
                onClick={() => onCommit(value)}
                title="Guarda el cambio como PENDIENTE. Todavía no toca la base: se manda con el botón de arriba."
                className="shrink-0 rounded text-primary hover:bg-surface-variant"
            >
                <Icon name="check" size={13} />
            </button>
            <button
                onClick={onCancel}
                title="Descarta este cambio (Esc)"
                className="shrink-0 rounded text-on-surface-variant hover:bg-surface-variant"
            >
                <Icon name="close" size={13} />
            </button>
        </div>
    )
}
