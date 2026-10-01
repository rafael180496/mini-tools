import {useEffect, useState} from 'react'
import {useT} from '../../../i18n'

// El tope de líneas de lo que se exporta: de 100 a 10 000. Lo acota acá al
// escribir, y el backend lo vuelve a acotar al escribir el archivo.
export const EXPORT_MIN = 100
export const EXPORT_MAX = 10000

interface Props {
    value: number
    onChange: (n: number) => void
}

export default function ExportLimit({value, onChange}: Props) {
    const t = useT()
    const td = t.utilities.docker.detail
    const [text, setText] = useState(String(value))
    useEffect(() => setText(String(value)), [value])

    // Se aplica al salir del campo o con Enter, no tecla a tecla: mientras se
    // escribe «5000» el campo pasa por «5», que está fuera del rango.
    function commit() {
        const n = Math.round(Number(text))
        const next = Number.isFinite(n) && text.trim() !== '' ? Math.min(EXPORT_MAX, Math.max(EXPORT_MIN, n)) : value
        setText(String(next))
        if (next !== value) onChange(next)
    }

    return (
        <label title={td.exportLimitTitle} className="flex items-center gap-1.5 rounded-lg bg-surface-container-highest px-2 py-1 text-xs text-on-surface-variant">
            {td.exportLimit}
            <input
                type="number"
                min={EXPORT_MIN}
                max={EXPORT_MAX}
                step={100}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                className="w-16 bg-transparent text-right font-mono tabular-nums text-on-surface outline-none"
            />
        </label>
    )
}
