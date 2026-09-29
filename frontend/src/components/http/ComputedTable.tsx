import Icon from '../Icon'
import Select from '../Select'
import {newComputed, rich, type HttpComputed} from './httpShared'
import {useT} from '../../i18n'

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

// `algo` es el nombre técnico del algoritmo, igual en todos los idiomas.
const OPS: {id: string; algo: string; needsKey: boolean; hashed: boolean}[] = [
    // El rótulo de «text» es texto de la interfaz: se resuelve al dibujar.
    {id: 'text', algo: '', needsKey: false, hashed: false},
    {id: 'hmac-sha256', algo: 'HMAC-SHA256', needsKey: true, hashed: true},
    {id: 'hmac-sha1', algo: 'HMAC-SHA1', needsKey: true, hashed: true},
    {id: 'hmac-sha512', algo: 'HMAC-SHA512', needsKey: true, hashed: true},
    {id: 'sha256', algo: 'SHA-256', needsKey: false, hashed: true},
    {id: 'sha1', algo: 'SHA-1', needsKey: false, hashed: true},
    {id: 'sha512', algo: 'SHA-512', needsKey: false, hashed: true},
    {id: 'md5', algo: 'MD5', needsKey: false, hashed: true},
    {id: 'base64', algo: 'Base64', needsKey: false, hashed: false},
    {id: 'base64url', algo: 'Base64 URL-safe', needsKey: false, hashed: false},
]

const ENCODINGS = ['hex', 'base64', 'base64url']

function emptyRow(): HttpComputed {
    return newComputed()
}

export default function ComputedTable({rows, onChange, problems}: ComputedTableProps) {
    const t = useT()
    const display = [...rows, emptyRow()]

    function update(i: number, patch: Partial<HttpComputed>) {
        const next = display.map((r, k) => (k === i ? {...r, ...patch} : r))
        onChange(next.filter((r, k) => k < next.length - 1 || r.name.trim() !== '' || r.input.trim() !== ''))
    }

    return (
        <div className="px-2 pb-2">
            <p className="py-2 text-ui-10 leading-relaxed text-on-surface-variant/70">
                {rich(t.http.computed.intro)}
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
                                    title={row.enabled ? t.http.computed.enabledTitle : t.http.computed.disabledTitle}
                                    className="shrink-0 accent-primary"
                                />
                            )}
                            <input
                                value={row.name}
                                onChange={(e) => update(i, {name: e.target.value, enabled: true})}
                                placeholder={ghost ? t.http.computed.namePlaceholder : ''}
                                title={t.http.computed.nameTitle}
                                className="w-40 shrink-0 rounded bg-surface-container-highest px-1.5 py-1 font-mono text-ui-11 text-on-surface outline-none focus:ring-1 focus:ring-primary"
                            />
                            <Select
                                value={row.op}
                                options={OPS.map((o) => ({value: o.id, label: o.id === 'text' ? t.http.computed.opText : o.algo}))}
                                onChange={(v) => update(i, {op: v, enabled: true})}
                                size="sm"
                                ariaLabel={t.http.computed.opAria}
                                title={t.http.computed.opTitle}
                                className="w-48 shrink-0"
                            />
                            {op.hashed && (
                                <Select
                                    value={row.encoding || 'hex'}
                                    options={ENCODINGS.map((e) => ({value: e, label: e}))}
                                    onChange={(v) => update(i, {encoding: v})}
                                    size="sm"
                                    ariaLabel={t.http.computed.encodingAria}
                                    title={t.http.computed.encodingTitle}
                                    className="w-28 shrink-0"
                                />
                            )}
                            {!ghost && (
                                <button
                                    onClick={() => onChange(display.filter((_, k) => k !== i).filter((r) => r.name.trim() !== '' || r.input.trim() !== ''))}
                                    title={t.http.computed.removeTitle}
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
                                placeholder={t.http.computed.inputPlaceholder}
                                title={t.http.computed.inputTitle}
                                className="w-full rounded bg-surface-container-highest px-1.5 py-1 font-mono text-ui-11 text-on-surface outline-none focus:ring-1 focus:ring-primary"
                            />
                            {op.needsKey && (
                                <input
                                    value={row.key ?? ''}
                                    onChange={(e) => update(i, {key: e.target.value, enabled: true})}
                                    placeholder={t.http.computed.keyPlaceholder}
                                    title={t.http.computed.keyTitle}
                                    className="w-full rounded bg-surface-container-highest px-1.5 py-1 font-mono text-ui-11 text-on-surface outline-none focus:ring-1 focus:ring-primary"
                                />
                            )}
                        </div>

                        {failed && <p className="mt-1 text-ui-10 text-error">{failed}</p>}
                    </div>
                )
            })}
        </div>
    )
}
