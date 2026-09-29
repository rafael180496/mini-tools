import {useState} from 'react'
import {CheckRedisLuaScript, RunRedisLuaScript} from '../../../wailsjs/go/main/App'
import {redisquery} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import {useT} from '../../i18n'

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
    const t = useT()
    const lt = t.redis.lua
    // The starting example carries a comment line, so it comes from the
    // dictionary like any other text.
    const [script, setScript] = useState(lt.example)
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
                <span className="font-semibold text-on-surface">{t.redis.browser.lua}</span>
                <span
                    className="text-on-surface-variant/70"
                    title={lt.atomicHint}
                >
                    {lt.atomic}
                </span>
                <button onClick={onClose} title={lt.closeHint} className="ml-auto rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface">
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
                    title={lt.scriptHint}
                    className="w-full resize-y rounded border border-outline-variant bg-surface-container-low p-2 font-mono text-xs text-on-surface outline-none focus:ring-1 focus:ring-primary"
                />

                <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                    <label className="block text-on-surface-variant">
                        {lt.keys}
                        <input
                            value={keys}
                            onChange={(e) => setKeys(e.target.value)}
                            placeholder={lt.keysPlaceholder}
                            title={lt.keysHint}
                            className="mt-0.5 w-full rounded border border-outline-variant bg-surface-container-low px-2 py-1 font-mono text-on-surface"
                        />
                    </label>
                    <label className="block text-on-surface-variant">
                        {lt.argv}
                        <input
                            value={args}
                            onChange={(e) => setArgs(e.target.value)}
                            placeholder={lt.argvPlaceholder}
                            title={lt.argvHint}
                            className="mt-0.5 w-full rounded border border-outline-variant bg-surface-container-low px-2 py-1 font-mono text-on-surface"
                        />
                    </label>
                </div>

                <div className="mt-2 flex items-center gap-2 text-xs">
                    <button
                        onClick={() => void check()}
                        disabled={busy}
                        title={lt.validateHint}
                        className="flex items-center gap-1 rounded border border-outline-variant px-2.5 py-1 text-on-surface hover:bg-surface-container-high disabled:opacity-40"
                    >
                        <Icon name="spellcheck" size={14} />
                        {lt.validate}
                    </button>
                    <button
                        onClick={() => void run()}
                        disabled={busy}
                        title={lt.runHint}
                        className="flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-on-primary disabled:opacity-40"
                    >
                        <Icon name="play_arrow" size={14} />
                        {lt.run}
                    </button>

                    {checked && !error && (
                        <span className="flex items-center gap-1 text-primary" title={lt.compilesHint}>
                            <Icon name="check_circle" size={13} />
                            {lt.compiles} · <span className="font-mono">{checked.slice(0, 12)}…</span>
                        </span>
                    )}
                </div>

                {error && <p className="mt-2 whitespace-pre-wrap rounded border border-error/40 bg-error/10 p-2 text-xs text-error">{error}</p>}

                {result && (
                    <div className="mt-3">
                        <div className="mb-1 flex items-center gap-2 text-ui-11 uppercase tracking-wide text-on-surface-variant">
                            {lt.result}
                            {!!result.durationMs && (
                                <span
                                    className="font-mono normal-case text-on-surface-variant/70"
                                    title={lt.durationHint}
                                >
                                    {lt.durationMs(result.durationMs)}
                                </span>
                            )}
                        </div>
                        <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded border border-outline-variant bg-surface-container-low p-2 font-mono text-xs text-on-surface">
                            {result.kind === 'nil' ? lt.nil : JSON.stringify(result.value, null, 2)}
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
