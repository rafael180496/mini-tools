import {useState} from 'react'
import {CheckRedisLuaScript, RunRedisLuaScript} from '../../../wailsjs/go/main/App'
import {redisquery} from '../../../wailsjs/go/models'
import Icon from '../Icon'

const EXAMPLE = `-- KEYS[1] es la clave; ARGV[1] el valor
if redis.call('EXISTS', KEYS[1]) == 1 then
  return redis.call('GET', KEYS[1])
end
redis.call('SET', KEYS[1], ARGV[1])
return ARGV[1]`

interface RedisLuaPanelProps {
    connId: string
    onClose: () => void
}

// Lua script runner with a validate-first step.
//
// A Redis script is ATOMIC: while it runs, the server serves nobody else.
// So a syntax error is not a polite failure and an accidental infinite loop
// is an outage. Validation (SCRIPT LOAD, which compiles without executing)
// is therefore its own button rather than something folded into running,
// and the panel says why.
export default function RedisLuaPanel({connId, onClose}: RedisLuaPanelProps) {
    const [script, setScript] = useState(EXAMPLE)
    const [keys, setKeys] = useState('')
    const [args, setArgs] = useState('')
    const [result, setResult] = useState<redisquery.LuaResult | null>(null)
    const [checked, setChecked] = useState<string>('')
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)

    async function check() {
        setBusy(true)
        setError('')
        setResult(null)
        try {
            const res = await CheckRedisLuaScript(connId, script)
            setChecked(res.sha ?? '')
        } catch (e) {
            setChecked('')
            setError(String(e))
        } finally {
            setBusy(false)
        }
    }

    async function run() {
        setBusy(true)
        setError('')
        try {
            const res = await RunRedisLuaScript(connId, script, splitList(keys), splitList(args))
            setResult(res)
            setChecked(res.sha ?? '')
        } catch (e) {
            setError(String(e))
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="flex h-full flex-col overflow-hidden">
            <div className="flex items-center gap-2 border-b border-outline-variant px-3 py-1.5 text-xs">
                <Icon name="code" size={15} className="shrink-0 text-primary" />
                <span className="font-semibold text-on-surface">Script Lua</span>
                <span
                    className="text-on-surface-variant/70"
                    title="Redis ejecuta los scripts de forma atómica: mientras uno corre, el servidor no atiende a nadie más. Por eso conviene validar antes, y por eso un bucle infinito acá es una caída."
                >
                    se ejecuta de forma atómica — bloquea al servidor mientras corre
                </span>
                <button onClick={onClose} title="Cierra el panel de scripts" className="ml-auto rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface">
                    <Icon name="close" size={16} />
                </button>
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-3">
                <textarea
                    value={script}
                    onChange={(e) => {
                        setScript(e.target.value)
                        setChecked('')
                    }}
                    spellCheck={false}
                    rows={12}
                    title="Cuerpo del script. Usá KEYS[] para las claves y ARGV[] para el resto de los parámetros."
                    className="w-full resize-y rounded border border-outline-variant bg-surface-container-low p-2 font-mono text-xs text-on-surface outline-none focus:ring-1 focus:ring-primary"
                />

                <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                    <label className="block text-on-surface-variant">
                        KEYS (separadas por comas)
                        <input
                            value={keys}
                            onChange={(e) => setKeys(e.target.value)}
                            placeholder="mi:clave"
                            title="Las claves que el script va a tocar. No es lo mismo que pasarlas por ARGV: Redis rutea y valida un script por las KEYS que declara, así que una clave pasada como ARGV funciona en un solo nodo y se rompe el día que el despliegue se reparta en shards."
                            className="mt-0.5 w-full rounded border border-outline-variant bg-surface-container-low px-2 py-1 font-mono text-on-surface"
                        />
                    </label>
                    <label className="block text-on-surface-variant">
                        ARGV (separados por comas)
                        <input
                            value={args}
                            onChange={(e) => setArgs(e.target.value)}
                            placeholder="valor"
                            title="Parámetros que no son claves"
                            className="mt-0.5 w-full rounded border border-outline-variant bg-surface-container-low px-2 py-1 font-mono text-on-surface"
                        />
                    </label>
                </div>

                <div className="mt-2 flex items-center gap-2 text-xs">
                    <button
                        onClick={() => void check()}
                        disabled={busy}
                        title="Compila el script sin ejecutarlo (SCRIPT LOAD). Encuentra errores de sintaxis antes de que el script bloquee al servidor, y deja la versión compilada en caché — así que validar no es trabajo perdido."
                        className="flex items-center gap-1 rounded border border-outline-variant px-2.5 py-1 text-on-surface hover:bg-surface-container-high disabled:opacity-40"
                    >
                        <Icon name="spellcheck" size={14} />
                        Validar
                    </button>
                    <button
                        onClick={() => void run()}
                        disabled={busy}
                        title="Valida y después ejecuta el script contra el servidor"
                        className="flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-on-primary disabled:opacity-40"
                    >
                        <Icon name="play_arrow" size={14} />
                        Ejecutar
                    </button>

                    {checked && !error && (
                        <span className="flex items-center gap-1 text-primary" title="El script compila. El SHA es el identificador con el que Redis lo tiene en caché.">
                            <Icon name="check_circle" size={13} />
                            compila · <span className="font-mono">{checked.slice(0, 12)}…</span>
                        </span>
                    )}
                </div>

                {error && <p className="mt-2 whitespace-pre-wrap rounded border border-error/40 bg-error/10 p-2 text-xs text-error">{error}</p>}

                {result && (
                    <div className="mt-3">
                        <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide text-on-surface-variant">
                            Resultado
                            {!!result.durationMs && (
                                <span
                                    className="font-mono normal-case text-on-surface-variant/70"
                                    title="Cuánto tardó el script. Como es atómico, es también cuánto esperó todo el resto de los clientes."
                                >
                                    {result.durationMs} ms
                                </span>
                            )}
                        </div>
                        <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded border border-outline-variant bg-surface-container-low p-2 font-mono text-xs text-on-surface">
                            {result.kind === 'nil' ? '(nil)' : JSON.stringify(result.value, null, 2)}
                        </pre>
                    </div>
                )}
            </div>
        </div>
    )
}

function splitList(raw: string): string[] {
    return raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '')
}
