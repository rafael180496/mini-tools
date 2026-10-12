import {useCallback, useEffect, useState} from 'react'
import {BrainStatus, GetBrainRoot, SetBrainRoot} from '../../wailsjs/go/main/App'
import {main} from '../../wailsjs/go/models'
import Icon from './Icon'
import {rich} from './agent/rich'
import {errorText, useT} from '../i18n'

// Sección «Cerebro» de Configuración → IA.
//
// El cerebro es la base de notas que el agente escribe por su cuenta cuando el
// usuario enciende «Guardar en mi cerebro» en una conversación. Esta pantalla
// hace tres cosas: dice qué falta para que se pueda encender (el servidor MCP y
// el permiso de escritura de notas viven arriba, en «Acceso de la IA»), deja
// elegir la carpeta raíz y explica la estructura que el agente va a armar.

const DEFAULT_ROOT = 'Cerebro'
const MAX_ROOT = 80

// Normaliza lo tecleado a una ruta de carpetas de notas: separador `/`, sin
// barras sobrantes. Devuelve null cuando no es una ruta válida (segmentos
// vacíos o `..`, demasiado larga). El backend vuelve a validar: esto solo evita
// ir a Go con algo que seguro se rechaza.
export function normalizeBrainRoot(raw: string): string | null {
    const path = raw.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (!path) return DEFAULT_ROOT
    if (path.length > MAX_ROOT) return null
    const segments = path.split('/')
    if (segments.some((s) => !s.trim() || s === '.' || s === '..')) return null
    return segments.map((s) => s.trim()).join('/')
}

function Requirement({ok, label, hint}: {ok: boolean; label: string; hint: string}) {
    return (
        <li className="flex items-start gap-2" title={hint}>
            <Icon name={ok ? 'check_circle' : 'radio_button_unchecked'} size={14} className={`mt-px shrink-0 ${ok ? 'text-secondary' : 'text-on-surface-variant'}`} />
            <span className="min-w-0 flex-1">
                <span className={ok ? 'text-on-surface' : 'text-on-surface-variant'}>{label}</span>
                {!ok && <span className="block text-ui-10 text-on-surface-variant/70">{hint}</span>}
            </span>
        </li>
    )
}

export default function BrainSettingsPanel() {
    const t = useT()
    const b = t.agent.brainPanel
    const [status, setStatus] = useState<main.BrainStatus | null>(null)
    const [saved, setSaved] = useState('')
    const [value, setValue] = useState('')
    const [loaded, setLoaded] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [justSaved, setJustSaved] = useState(false)

    const refresh = useCallback(() => {
        BrainStatus()
            .then(setStatus)
            .catch(() => setStatus(null))
    }, [])

    useEffect(() => {
        let cancelled = false
        GetBrainRoot()
            .then((root) => {
                if (cancelled) return
                const r = root || DEFAULT_ROOT
                setSaved(r)
                setValue(r)
            })
            .catch((e) => !cancelled && setError(errorText(e)))
            .finally(() => !cancelled && setLoaded(true))
        return () => {
            cancelled = true
        }
    }, [])

    // El servidor MCP y el permiso de escritura se cambian en la tarjeta de
    // arriba; esta checklist se pone al día sola mientras Configuración está
    // abierta.
    useEffect(() => {
        refresh()
        const timer = setInterval(refresh, 3000)
        return () => clearInterval(timer)
    }, [refresh])

    const normalized = normalizeBrainRoot(value)
    const invalid = normalized === null
    const dirty = normalized !== null && normalized !== saved

    const save = () => {
        if (normalized === null || busy) return
        setBusy(true)
        setError('')
        setJustSaved(false)
        SetBrainRoot(normalized)
            .then(() => {
                setSaved(normalized)
                setValue(normalized)
                setJustSaved(true)
                refresh()
            })
            .catch((e) => setError(errorText(e)))
            .finally(() => setBusy(false))
    }

    const ready = !!status?.mcpEnabled && !!status?.notesWrite
    const root = saved || DEFAULT_ROOT

    return (
        <section className="flex flex-col gap-2" data-brain-settings>
            <h3 className="px-1 text-ui-11 font-semibold uppercase tracking-wider text-on-surface-variant">{b.heading}</h3>

            <div className="flex flex-col gap-3 rounded-lg border border-outline-variant bg-surface-container p-3">
                <div className="flex items-start gap-3">
                    <Icon name="psychology" size={18} className={`mt-0.5 shrink-0 ${ready ? 'text-primary' : 'text-on-surface-variant'}`} />
                    <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-on-surface">{b.title}</p>
                        <p className="mt-0.5 text-ui-11 leading-4 text-on-surface-variant">{rich(b.intro)}</p>
                    </div>
                </div>

                <ul className="flex flex-col gap-1.5 rounded border border-outline-variant bg-surface-container-low p-2 text-ui-11">
                    <Requirement ok={!!status?.mcpEnabled} label={b.reqMcp} hint={b.reqMcpHint} />
                    <Requirement ok={!!status?.notesWrite} label={b.reqNotes} hint={b.reqNotesHint} />
                    <li className="flex items-start gap-2 text-on-surface-variant">
                        <Icon name="toggle_on" size={14} className="mt-px shrink-0 text-primary" />
                        <span className="min-w-0 flex-1">{rich(b.reqChat)}</span>
                    </li>
                </ul>

                <form
                    className="flex flex-col gap-1"
                    onSubmit={(e) => {
                        e.preventDefault()
                        save()
                    }}
                >
                    <label className="flex flex-col gap-1" title={b.rootTitle}>
                        <span className="text-xs font-medium text-on-surface">{b.rootLabel}</span>
                        <span className="flex items-center gap-2">
                            <input
                                value={value}
                                onChange={(e) => {
                                    setValue(e.target.value)
                                    setJustSaved(false)
                                }}
                                disabled={!loaded}
                                placeholder={DEFAULT_ROOT}
                                spellCheck={false}
                                aria-invalid={invalid}
                                data-brain-root
                                className={`min-w-0 flex-1 rounded-lg border bg-surface px-2.5 py-1.5 font-mono text-xs text-on-surface outline-none focus:border-primary ${
                                    invalid ? 'border-error' : 'border-outline-variant'
                                }`}
                            />
                            <button
                                type="submit"
                                disabled={!dirty || busy}
                                title={b.saveTitle}
                                className="flex shrink-0 items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-40"
                            >
                                <Icon name={justSaved ? 'check' : 'save'} size={14} />
                                {justSaved ? b.saved : b.save}
                            </button>
                        </span>
                    </label>
                    <p className={`text-ui-10 leading-4 ${invalid ? 'text-error' : 'text-on-surface-variant/70'}`}>
                        {invalid ? b.rootInvalid : rich(b.rootHint({def: DEFAULT_ROOT}))}
                    </p>
                    {error && <p className="rounded bg-error-container/40 px-2 py-1 text-ui-11 text-error">{error}</p>}
                </form>

                <div className="flex flex-col gap-1.5 rounded border border-outline-variant bg-surface-container-low p-2">
                    <p className="text-ui-10 font-medium uppercase tracking-wider text-on-surface-variant">{b.structureHeading}</p>
                    <pre className="overflow-x-auto rounded bg-surface-container-highest px-2 py-1.5 font-mono text-ui-10 leading-4 text-on-surface">
                        {/* Los nombres de las carpetas y la nota de índice son datos
                            que escribe el backend: no cambian con el idioma. */}
                        {[
                            `${root}/`,
                            `  Proyectos/`,
                            `    mini-tools/`,
                            `      _Índice`,
                            `      ${b.exampleProjectNote}`,
                            `  Temas/`,
                            `    Oracle/`,
                            `      _Índice`,
                            `      ${b.exampleTopicNote}`,
                        ].join('\n')}
                    </pre>
                    <p className="text-ui-11 leading-4 text-on-surface-variant">{rich(b.structureBody)}</p>
                    <p className="text-ui-11 leading-4 text-on-surface-variant">{rich(b.indexBody)}</p>
                    <p className="text-ui-10 leading-4 text-on-surface-variant/70">{rich(b.rules)}</p>
                </div>
            </div>
        </section>
    )
}
