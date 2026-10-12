import {useEffect, useState, type ReactNode} from 'react'
import {ModelServerShowModel} from '../../../../wailsjs/go/main/App'
import type {llm} from '../../../../wailsjs/go/models'
import Icon from '../../Icon'
import {errorText, formatNumber, useT} from '../../../i18n'
import {formatModelSize, fullDate} from './modelFormat'

// Detalle de un modelo instalado (POST /api/show): parámetros por defecto,
// plantilla, licencia y ventana de contexto, más los datos que ya trae la
// lista (tamaño, fecha, huella).
//
// Se lee al abrir y no junto con la lista: son un par de KB por modelo y se
// mira uno por vez.

interface Props {
    serverId: string
    model: llm.ManagedModel
    onClose: () => void
}

export default function ModelDetailsPanel({serverId, model, onClose}: Props) {
    const t = useT()
    const L = t.models.details
    const [details, setDetails] = useState<llm.ModelDetails | null>(null)
    const [error, setError] = useState('')
    const [copied, setCopied] = useState(false)

    useEffect(() => {
        let alive = true
        setDetails(null)
        setError('')
        ModelServerShowModel(serverId, model.name)
            .then((d) => alive && setDetails(d))
            .catch((e) => alive && setError(errorText(e)))
        return () => {
            alive = false
        }
    }, [serverId, model.name])

    // Esc cierra el panel.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onClose])

    const d = details
    const none = <span className="text-on-surface-variant/70">{t.models.unknown}</span>
    const fact = (label: string, value: ReactNode, title?: string) => (
        <div className="min-w-0" title={title}>
            <dt className="text-ui-10 uppercase tracking-wider text-on-surface-variant">{label}</dt>
            <dd className="mt-0.5 break-words text-xs text-on-surface">{value}</dd>
        </div>
    )
    const block = (label: string, title: string, text: string) => (
        <section className="min-w-0">
            <h3 className="text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant" title={title}>
                {label}
            </h3>
            {text ? (
                <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-container-lowest p-2 font-mono text-ui-11 text-on-surface [font-variant-ligatures:none]">{text}</pre>
            ) : (
                <p className="mt-1 text-xs text-on-surface-variant/70">{L.none}</p>
            )}
        </section>
    )

    const digest = model.digest.replace('sha256:', '')

    return (
        <aside aria-label={L.title} className="flex h-full min-h-0 w-full min-w-0 flex-col bg-surface-container-low text-on-surface">
            <header className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-3 py-2">
                <Icon name="info" size={16} className="shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                    <h2 className="truncate font-mono text-sm font-semibold" title={model.name}>
                        {model.name}
                    </h2>
                    <p className="text-ui-10 text-on-surface-variant">{L.title}</p>
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    title={L.closeTitle}
                    aria-label={L.close}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="close" size={16} />
                </button>
            </header>

            <div className="min-h-0 flex-1 space-y-4 overflow-auto p-3">
                {error ? (
                    <div role="alert" className="flex items-start gap-2 rounded-lg border border-error/40 bg-error-container/30 p-2 text-xs">
                        <Icon name="error" size={14} className="mt-px shrink-0 text-error" />
                        <span className="min-w-0">
                            <span className="block font-medium text-error">{L.failed}</span>
                            <span className="block break-words text-on-surface-variant">{error}</span>
                        </span>
                    </div>
                ) : !d ? (
                    <p className="text-xs text-on-surface-variant">{L.loading}</p>
                ) : (
                    <>
                        <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5">
                            {fact(L.facts.family, d.family || model.family || none)}
                            {fact(L.facts.params, d.parameterSize || model.parameterSize || none)}
                            {fact(L.facts.quant, d.quantizationLevel || model.quantizationLevel || none)}
                            {fact(L.facts.format, d.format || model.format || none)}
                            {fact(L.facts.size, model.size > 0 ? formatModelSize(model.size) : none)}
                            {fact(
                                L.facts.context,
                                d.contextLength > 0 ? L.contextValue({tokens: formatNumber(d.contextLength)}) : none,
                                L.contextTitle,
                            )}
                            {fact(L.facts.modified, model.modifiedAt ? fullDate(model.modifiedAt) || model.modifiedAt : none)}
                            {fact(
                                L.facts.digest,
                                digest ? (
                                    <span className="flex items-center gap-1">
                                        <span className="truncate font-mono text-ui-11" title={digest}>
                                            {digest.slice(0, 16)}
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                void navigator.clipboard?.writeText(digest).then(() => {
                                                    setCopied(true)
                                                    window.setTimeout(() => setCopied(false), 1500)
                                                })
                                            }}
                                            title={copied ? L.copied : L.copyTitle}
                                            aria-label={L.copy}
                                            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                                        >
                                            <Icon name={copied ? 'check' : 'content_copy'} size={12} />
                                        </button>
                                    </span>
                                ) : (
                                    none
                                ),
                            )}
                        </dl>

                        <section>
                            <h3 className="text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant" title={L.capabilitiesTitle}>
                                {L.capabilities}
                            </h3>
                            {d.capabilities && d.capabilities.length > 0 ? (
                                <div className="mt-1 flex flex-wrap gap-1">
                                    {d.capabilities.map((c) => (
                                        <span key={c} className="rounded-full bg-secondary/15 px-2 py-0.5 font-mono text-ui-10 text-secondary">
                                            {c}
                                        </span>
                                    ))}
                                </div>
                            ) : (
                                <p className="mt-1 text-xs text-on-surface-variant/70">{L.none}</p>
                            )}
                        </section>

                        {block(L.parameters, L.parametersTitle, d.parameters)}
                        {block(L.template, L.templateTitle, d.template)}
                        {block(L.license, L.licenseTitle, d.license)}
                    </>
                )}
            </div>
        </aside>
    )
}
