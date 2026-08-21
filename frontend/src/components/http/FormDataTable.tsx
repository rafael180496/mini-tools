import {HttpPickFile} from '../../../wailsjs/go/main/App'
import {httpclient} from '../../../wailsjs/go/models'
import Icon from '../Icon'

// Tabla de form-data: como la de clave/valor, pero cada fila elige si su
// valor es TEXTO o un ARCHIVO.
//
// Una fila de archivo guarda la RUTA, no el contenido: el archivo se lee
// recién al enviar, en streaming. Guardar el contenido metería megabytes
// cifrados en el vault por cada petición y dejaría una copia congelada de un
// archivo que el usuario sigue editando afuera.

interface FormDataTableProps {
    rows: httpclient.FormField[]
    onChange: (rows: httpclient.FormField[]) => void
}

function emptyField(): httpclient.FormField {
    return new httpclient.FormField({key: '', value: '', type: 'text', enabled: true, description: ''})
}

// Solo el nombre del archivo: la ruta completa no entra en la celda y lo que
// importa de un vistazo es cuál es.
function baseName(path: string): string {
    const parts = path.split(/[/\\]/)
    return parts[parts.length - 1] || path
}

export default function FormDataTable({rows, onChange}: FormDataTableProps) {
    const display = [...rows, emptyField()]

    function update(i: number, patch: Partial<httpclient.FormField>) {
        const next = display.map((r, k) => (k === i ? new httpclient.FormField({...r, ...patch}) : r))
        onChange(next.filter((r, k) => k < next.length - 1 || r.key.trim() !== '' || r.value.trim() !== ''))
    }

    async function pick(i: number) {
        try {
            const path = await HttpPickFile('Elegir el archivo a subir')
            if (path) update(i, {value: path, type: 'file', enabled: true})
        } catch {
            /* cancelar no es un error */
        }
    }

    return (
        <div className="min-w-0 overflow-x-auto">
            <table className="w-full min-w-[520px] table-fixed border-collapse text-[11px]">
                <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-on-surface-variant/60">
                        <th className="w-8 px-2 py-1 font-medium"></th>
                        <th className="w-[28%] px-2 py-1 font-medium">Key</th>
                        <th className="w-20 px-2 py-1 font-medium">Tipo</th>
                        <th className="px-2 py-1 font-medium">Value</th>
                        <th className="w-8 px-1 py-1"></th>
                    </tr>
                </thead>
                <tbody>
                    {display.map((row, i) => {
                        const ghost = i === display.length - 1
                        const isFile = row.type === 'file'
                        return (
                            <tr key={i} className="border-t border-outline-variant/50">
                                <td className="px-2 py-0.5">
                                    {!ghost && (
                                        <input
                                            type="checkbox"
                                            checked={row.enabled}
                                            onChange={(e) => update(i, {enabled: e.target.checked})}
                                            title={row.enabled ? 'Se envía' : 'Queda guardada pero fuera de la petición'}
                                            className="accent-primary"
                                        />
                                    )}
                                </td>
                                <td className="px-2 py-0.5">
                                    <input
                                        value={row.key}
                                        onChange={(e) => update(i, {key: e.target.value, enabled: true})}
                                        placeholder={ghost ? 'campo' : ''}
                                        className="w-full bg-transparent font-mono text-[11px] text-on-surface outline-none placeholder:text-on-surface-variant/40"
                                    />
                                </td>
                                <td className="px-2 py-0.5">
                                    {!ghost && (
                                        <select
                                            value={row.type}
                                            onChange={(e) => update(i, {type: e.target.value, value: ''})}
                                            title="Texto manda el valor tal cual; Archivo sube el contenido del archivo elegido."
                                            className="w-full rounded bg-transparent text-[11px] text-on-surface-variant outline-none focus:ring-1 focus:ring-primary"
                                        >
                                            <option value="text">Texto</option>
                                            <option value="file">Archivo</option>
                                        </select>
                                    )}
                                </td>
                                <td className="px-2 py-0.5">
                                    {isFile && !ghost ? (
                                        <button
                                            onClick={() => void pick(i)}
                                            title={row.value || 'Elegir un archivo del disco. Se guarda la ruta, no el contenido: el archivo se lee recién al enviar.'}
                                            className="flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left font-mono text-[11px] text-on-surface hover:bg-surface-variant"
                                        >
                                            <Icon name="attach_file" size={12} className="shrink-0 opacity-60" />
                                            <span className="truncate">{row.value ? baseName(row.value) : 'Elegir archivo…'}</span>
                                        </button>
                                    ) : (
                                        <input
                                            value={row.value}
                                            onChange={(e) => update(i, {value: e.target.value, enabled: true})}
                                            placeholder={ghost ? 'valor' : ''}
                                            className="w-full bg-transparent font-mono text-[11px] text-on-surface outline-none placeholder:text-on-surface-variant/40"
                                        />
                                    )}
                                </td>
                                <td className="px-1 py-0.5">
                                    {!ghost && (
                                        <button
                                            onClick={() => onChange(display.filter((_, k) => k !== i).filter((r) => r.key.trim() !== '' || r.value.trim() !== ''))}
                                            title="Borrar esta fila"
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
