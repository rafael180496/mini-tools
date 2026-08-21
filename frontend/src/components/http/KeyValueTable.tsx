import {httpclient} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import {emptyRow} from './httpShared'

// La tabla de pares clave/valor de Params, Headers y variables de ruta.
//
// Un solo componente para las tres porque son la misma tabla con distintas
// columnas habilitadas, y tres copias divergirían en detalles que el usuario
// nota (el ancho de la columna, dónde queda el checkbox, si hay fila vacía
// al final).
//
// La fila vacía del final es cómo se agrega una nueva: escribir ahí la
// convierte en fila real y aparece otra vacía debajo. Es el patrón de
// Postman y evita un botón "+" que hay que ir a buscar.

interface KeyValueTableProps {
    rows: httpclient.KeyValue[]
    onChange: (rows: httpclient.KeyValue[]) => void
    keyLabel?: string
    valueLabel?: string
    // Las variables de ruta no se pueden agregar ni borrar a mano: salen de
    // la URL. Editar solo el valor es lo que las mantiene sincronizadas con
    // el texto de arriba.
    lockKeys?: boolean
    emptyHint?: string
}

export default function KeyValueTable({
    rows,
    onChange,
    keyLabel = 'Key',
    valueLabel = 'Value',
    lockKeys,
    emptyHint,
}: KeyValueTableProps) {
    // Con las claves bloqueadas no hay fila para agregar: la lista es
    // exactamente lo que declara la URL.
    const display = lockKeys ? rows : [...rows, emptyRow()]

    function update(index: number, patch: Partial<httpclient.KeyValue>) {
        const next = display.map((r, i) => (i === index ? new httpclient.KeyValue({...r, ...patch}) : r))
        // Se descarta la última si sigue vacía: es la fila fantasma, no un
        // dato que el usuario haya escrito.
        const cleaned = next.filter((r, i) => i < next.length - 1 || r.key.trim() !== '' || r.value.trim() !== '' || lockKeys)
        onChange(cleaned)
    }

    function remove(index: number) {
        onChange(display.filter((_, i) => i !== index).filter((r) => r.key.trim() !== '' || r.value.trim() !== ''))
    }

    if (lockKeys && rows.length === 0) {
        return <p className="px-3 py-4 text-[11px] leading-relaxed text-on-surface-variant/70">{emptyHint}</p>
    }

    return (
        <div className="min-w-0 overflow-x-auto">
            <table className="w-full min-w-[420px] table-fixed border-collapse text-[11px]">
                <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-on-surface-variant/60">
                        <th className="w-8 px-2 py-1 font-medium"></th>
                        <th className="w-[34%] px-2 py-1 font-medium">{keyLabel}</th>
                        <th className="px-2 py-1 font-medium">{valueLabel}</th>
                        <th className="w-8 px-1 py-1"></th>
                    </tr>
                </thead>
                <tbody>
                    {display.map((row, i) => {
                        const ghost = !lockKeys && i === display.length - 1
                        return (
                            <tr key={i} className="border-t border-outline-variant/50">
                                <td className="px-2 py-0.5">
                                    {!ghost && (
                                        <input
                                            type="checkbox"
                                            checked={row.enabled}
                                            onChange={(e) => update(i, {enabled: e.target.checked})}
                                            title={
                                                row.enabled
                                                    ? 'Se envía. Destildar la deja guardada pero fuera de la petición — útil para probar sin borrarla.'
                                                    : 'No se envía. Queda guardada para volver a activarla.'
                                            }
                                            className="accent-primary"
                                        />
                                    )}
                                </td>
                                <td className="px-2 py-0.5">
                                    <input
                                        value={row.key}
                                        readOnly={lockKeys}
                                        onChange={(e) => update(i, {key: e.target.value, enabled: true})}
                                        placeholder={ghost ? keyLabel : ''}
                                        title={lockKeys ? 'Sale de la URL de arriba: para cambiarlo, editá la URL' : undefined}
                                        className={`w-full bg-transparent font-mono text-[11px] text-on-surface outline-none placeholder:text-on-surface-variant/40 ${
                                            lockKeys ? 'cursor-default text-on-surface-variant' : ''
                                        }`}
                                    />
                                </td>
                                <td className="px-2 py-0.5">
                                    <input
                                        value={row.value}
                                        onChange={(e) => update(i, {value: e.target.value, enabled: true})}
                                        placeholder={ghost ? valueLabel : ''}
                                        className="w-full bg-transparent font-mono text-[11px] text-on-surface outline-none placeholder:text-on-surface-variant/40"
                                    />
                                </td>
                                <td className="px-1 py-0.5">
                                    {!ghost && !lockKeys && (
                                        <button
                                            onClick={() => remove(i)}
                                            title="Borrar esta fila definitivamente. Si solo querés dejarla fuera de la petición, destildá el casillero de la izquierda."
                                            className="rounded p-0.5 text-on-surface-variant/40 hover:bg-surface-variant hover:text-error"
                                        >
                                            <Icon name="close" size={12} />
                                        </button>
                                    )}
                                </td>
                            </tr>
                        )
                    })}
                </tbody>
            </table>
        </div>
    )
}
