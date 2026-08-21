import Icon from '../Icon'
import {newComputed, type HttpComputed} from './httpShared'

// Variables calculadas: la firma declarativa que reemplaza a los scripts.
//
// Cada fila produce una variable a partir de una plantilla y un algoritmo, y
// las siguientes pueden usarla — así se arma una firma en dos pasos
// (primero el texto a firmar, después el HMAC) sin un lenguaje de por medio.
//
// Todo lo que sale de acá nace SECRETO: es una firma o un token, así que
// queda enmascarado en el historial y fuera del export sin que el usuario
// tenga que acordarse de marcarlo.

interface ComputedTableProps {
    rows: HttpComputed[]
    onChange: (rows: HttpComputed[]) => void
    // Errores de cálculo del último envío, para señalar la fila culpable.
    problems?: string[]
}

const OPS: {id: string; label: string; needsKey: boolean; hashed: boolean}[] = [
    {id: 'text', label: 'Texto (solo sustituir)', needsKey: false, hashed: false},
    {id: 'hmac-sha256', label: 'HMAC-SHA256', needsKey: true, hashed: true},
    {id: 'hmac-sha1', label: 'HMAC-SHA1', needsKey: true, hashed: true},
    {id: 'hmac-sha512', label: 'HMAC-SHA512', needsKey: true, hashed: true},
    {id: 'sha256', label: 'SHA-256', needsKey: false, hashed: true},
    {id: 'sha1', label: 'SHA-1', needsKey: false, hashed: true},
    {id: 'sha512', label: 'SHA-512', needsKey: false, hashed: true},
    {id: 'md5', label: 'MD5', needsKey: false, hashed: true},
    {id: 'base64', label: 'Base64', needsKey: false, hashed: false},
    {id: 'base64url', label: 'Base64 URL-safe', needsKey: false, hashed: false},
]

function emptyRow(): HttpComputed {
    return newComputed()
}

export default function ComputedTable({rows, onChange, problems}: ComputedTableProps) {
    const display = [...rows, emptyRow()]

    function update(i: number, patch: Partial<HttpComputed>) {
        const next = display.map((r, k) => (k === i ? {...r, ...patch} : r))
        onChange(next.filter((r, k) => k < next.length - 1 || r.name.trim() !== '' || r.input.trim() !== ''))
    }

    return (
        <div className="px-2 pb-2">
            <p className="py-2 text-[10px] leading-relaxed text-on-surface-variant/70">
                Cada fila calcula una variable antes de enviar, y las de abajo pueden usar las de arriba. Sirven para firmar: en la entrada podés usar{' '}
                <span className="font-mono">{'{{$timestamp}}'}</span>, <span className="font-mono">{'{{$randomUUID}}'}</span> y cualquier variable del entorno.
                El resultado se usa como <span className="font-mono">{'{{nombre}}'}</span> en la URL, los headers o el cuerpo.
            </p>

            {display.map((row, i) => {
                const ghost = i === display.length - 1
                const op = OPS.find((o) => o.id === row.op) ?? OPS[0]
                const failed = problems?.find((p) => p.startsWith(`${row.name}:`))
                return (
                    <div
                        key={i}
                        className={`mb-1 rounded border p-2 ${failed ? 'border-error/60 bg-error-container/20' : 'border-outline-variant/60'}`}
                    >
                        <div className="flex items-center gap-1.5">
                            {!ghost && (
                                <input
                                    type="checkbox"
                                    checked={row.enabled}
                                    onChange={(e) => update(i, {enabled: e.target.checked})}
                                    title={row.enabled ? 'Se calcula antes de cada envío' : 'Queda guardada pero no se calcula'}
                                    className="shrink-0 accent-primary"
                                />
                            )}
                            <input
                                value={row.name}
                                onChange={(e) => update(i, {name: e.target.value, enabled: true})}
                                placeholder={ghost ? 'nombre de la variable' : ''}
                                title="Cómo se llama el resultado. Se usa entre llaves dobles en el resto de la petición."
                                className="w-40 shrink-0 rounded bg-surface-container-highest px-1.5 py-1 font-mono text-[11px] text-on-surface outline-none focus:ring-1 focus:ring-primary"
                            />
                            <select
                                value={row.op}
                                onChange={(e) => update(i, {op: e.target.value, enabled: true})}
                                title="Qué se le hace a la entrada"
                                className="shrink-0 rounded bg-surface-container-highest px-1.5 py-1 text-[11px] text-on-surface outline-none focus:ring-1 focus:ring-primary"
                            >
                                {OPS.map((o) => (
                                    <option key={o.id} value={o.id}>
                                        {o.label}
                                    </option>
                                ))}
                            </select>
                            {op.hashed && (
                                <select
                                    value={row.encoding || 'hex'}
                                    onChange={(e) => update(i, {encoding: e.target.value})}
                                    title="Cómo se representan los bytes del resultado. La mayoría de las APIs esperan hexadecimal."
                                    className="shrink-0 rounded bg-surface-container-highest px-1.5 py-1 text-[11px] text-on-surface outline-none focus:ring-1 focus:ring-primary"
                                >
                                    <option value="hex">hex</option>
                                    <option value="base64">base64</option>
                                    <option value="base64url">base64url</option>
                                </select>
                            )}
                            {!ghost && (
                                <button
                                    onClick={() => onChange(display.filter((_, k) => k !== i).filter((r) => r.name.trim() !== '' || r.input.trim() !== ''))}
                                    title="Borrar esta variable calculada"
                                    className="ml-auto shrink-0 rounded p-0.5 text-on-surface-variant/40 hover:bg-surface-variant hover:text-error"
                                >
                                    <Icon name="close" size={12} />
                                </button>
                            )}
                        </div>

                        <div className="mt-1.5 flex flex-col gap-1">
                            <input
                                value={row.input}
                                onChange={(e) => update(i, {input: e.target.value, enabled: true})}
                                placeholder="{{$timestamp}}/dev/blocks"
                                title="Lo que se va a procesar. Admite variables entre llaves dobles, incluidas las de otras filas de esta misma tabla."
                                className="w-full rounded bg-surface-container-highest px-1.5 py-1 font-mono text-[11px] text-on-surface outline-none focus:ring-1 focus:ring-primary"
                            />
                            {op.needsKey && (
                                <input
                                    value={row.key ?? ''}
                                    onChange={(e) => update(i, {key: e.target.value, enabled: true})}
                                    placeholder="{{secreto}}"
                                    title="Clave del HMAC. Ponela como variable secreta del entorno en vez de escribirla acá: así queda cifrada y fuera del export."
                                    className="w-full rounded bg-surface-container-highest px-1.5 py-1 font-mono text-[11px] text-on-surface outline-none focus:ring-1 focus:ring-primary"
                                />
                            )}
                        </div>

                        {failed && <p className="mt-1 text-[10px] text-error">{failed}</p>}
                    </div>
                )
            })}
        </div>
    )
}
