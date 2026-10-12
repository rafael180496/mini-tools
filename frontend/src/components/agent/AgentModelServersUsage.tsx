import {useEffect, useState} from 'react'
import {ModelServerUsage} from '../../../wailsjs/go/main/App'
import {main} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import {formatDateTime, formatNumber, useT} from '../../i18n'

// Consumo de los servidores de modelos (Ollama, compatibles con OpenAI), dentro
// del panel de consumo.
//
// Los CLIs dejan sus tokens en el disco; un servidor de modelos no deja nada,
// pero la app guarda el uso de cada turno en el historial de chats y de ahí sale
// esto (ver App.ModelServerUsage). **No hay costo**: un servidor propio no
// cobra por token y uno compatible con OpenAI no informa precio, así que la nota
// del pie lo dice en vez de mostrar un monto inventado.

// compact acorta los totales: "1.2M" se compara de un vistazo, "1.234.567" no.
function compact(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
    return String(n)
}

// DailyBars es la serie diaria: una barra por día de la ventana, con la altura
// proporcional al día más alto. Barras y no línea porque un día sin uso vale 0
// de verdad —no hay nada que interpolar— y una línea inventaría pendientes
// entre días sueltos. Cada barra explica su día en el tooltip; el SVG/flex es
// decorativo para el lector de pantalla, que ya tiene los totales en texto.
function DailyBars({days, title}: {days: main.ModelUsageDay[]; title: string}) {
    const t = useT()
    const max = days.reduce((m, d) => Math.max(m, d.total), 0)
    return (
        <div className="mt-1.5" title={title}>
            <div className="flex h-7 items-end gap-px" aria-hidden="true">
                {days.map((d) => {
                    const h = d.total > 0 && max > 0 ? Math.max(8, Math.round((d.total / max) * 100)) : 0
                    return (
                        <span
                            key={d.day}
                            title={t.agent.usage.servers.dayBar({day: d.day, tokens: formatNumber(d.total), turns: d.turns})}
                            className="relative flex h-full min-w-0 flex-1 items-end"
                        >
                            {/* La base: un día en cero se ve como una raya y no como un hueco. */}
                            <span className="absolute inset-x-0 bottom-0 h-px bg-outline-variant" />
                            {h > 0 && <span className="relative w-full rounded-t-[1px] bg-primary" style={{height: `${h}%`}} />}
                        </span>
                    )
                })}
            </div>
        </div>
    )
}

function ServerCard({s}: {s: main.ModelServerUsage}) {
    const t = useT()
    const L = t.agent.usage.servers
    const used = s.totals.turns > 0
    const maxDay = s.byDay.reduce((m, d) => Math.max(m, d.total), 0)
    const first = s.byDay[0]?.day ?? ''
    const last = s.byDay[s.byDay.length - 1]?.day ?? ''
    return (
        <div className="mb-1.5 rounded border border-outline-variant px-2 py-1.5">
            <div className="flex items-center gap-1.5">
                <Icon name={s.deleted ? 'delete_sweep' : s.isLocal ? 'computer' : 'cloud'} size={12} className="shrink-0 text-on-surface-variant" />
                <span className="min-w-0 truncate font-medium text-on-surface" title={s.deleted ? L.deletedTitle : s.name}>
                    {s.name}
                </span>
                {/* Un servidor eliminado ya trae "Servidor eliminado (id)" por nombre:
                    el rótulo de local/remoto no aplica y repetirlo sería ruido. */}
                {!s.deleted && (
                    <span
                        title={s.isLocal ? L.localTitle : L.remoteTitle}
                        className={`shrink-0 rounded-full px-1.5 text-ui-10 ${
                            s.isLocal ? 'bg-secondary/15 text-secondary' : 'bg-tertiary/15 text-tertiary'
                        }`}
                    >
                        {s.isLocal ? L.local : L.remote}
                    </span>
                )}
                {used && (
                    <span
                        className="ml-auto shrink-0 text-on-surface-variant"
                        title={L.tokensTitle({total: formatNumber(s.totals.total), input: formatNumber(s.totals.input), output: formatNumber(s.totals.output)})}
                    >
                        {L.tokens({n: compact(s.totals.total)})}
                    </span>
                )}
            </div>

            {!used ? (
                <p className="mt-0.5 text-on-surface-variant">{L.unused}</p>
            ) : (
                <>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-on-surface-variant">
                        <span title={L.tokensTitle({total: formatNumber(s.totals.total), input: formatNumber(s.totals.input), output: formatNumber(s.totals.output)})}>
                            {L.inOut({input: compact(s.totals.input), output: compact(s.totals.output)})}
                        </span>
                        <span title={L.turnsTitle}>{L.turns({n: s.totals.turns})}</span>
                        <span title={L.conversationsTitle}>{L.conversations({n: s.totals.conversations})}</span>
                        {s.tokensPerSec > 0 ? (
                            <span className="text-on-surface" title={L.speedTitle}>
                                {L.speed({n: formatNumber(s.tokensPerSec, {maximumFractionDigits: 1})})}
                            </span>
                        ) : (
                            <span title={L.speedUnknownTitle}>{L.speedUnknown}</span>
                        )}
                        {s.lastUsedAt > 0 && <span>{L.lastUsed({date: formatDateTime(s.lastUsedAt)})}</span>}
                    </div>

                    <DailyBars days={s.byDay} title={L.dailyTitle({first, last, max: formatNumber(maxDay)})} />

                    {s.byModel.map((m) => (
                        <div
                            key={m.model || '·'}
                            className="mt-0.5 flex items-center gap-1.5"
                            title={L.modelTokensTitle({total: formatNumber(m.totals.total), turns: m.totals.turns})}
                        >
                            <span
                                className={`w-28 shrink-0 truncate ${m.model ? 'text-on-surface-variant' : 'italic text-on-surface-variant/70'}`}
                                title={m.model || L.unknownModelTitle}
                            >
                                {m.model || L.unknownModel}
                            </span>
                            <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-variant">
                                <span className="block h-full rounded-full bg-primary" style={{width: `${m.percent}%`}} />
                            </span>
                            <span className="w-9 shrink-0 text-right text-on-surface-variant">{m.percent}%</span>
                            {m.tokensPerSec > 0 && (
                                <span className="w-16 shrink-0 text-right text-on-surface-variant" title={L.speedTitle}>
                                    {L.speed({n: formatNumber(m.tokensPerSec, {maximumFractionDigits: 1})})}
                                </span>
                            )}
                        </div>
                    ))}
                </>
            )}
        </div>
    )
}

export default function AgentModelServersUsage() {
    const t = useT()
    const L = t.agent.usage.servers
    const [report, setReport] = useState<main.ModelServerUsageReport | null>(null)
    const [error, setError] = useState('')

    useEffect(() => {
        ModelServerUsage(0)
            .then(setReport)
            .catch((e) => setError(String(e)))
    }, [])

    // Sin servidores ni historial de ninguno, la sección entera sobra: quien no
    // usa modelos propios no tiene por qué ver un bloque vacío.
    if (!error && report && report.servers.length === 0) return null
    if (!error && !report) return <p className="px-1 text-on-surface-variant">{L.reading}</p>

    return (
        <section className="mb-1.5">
            <h3 className="mb-1 flex items-center gap-1.5 px-1 font-medium text-on-surface-variant">
                <Icon name="dns" size={12} className="shrink-0" />
                {L.title}
            </h3>
            {error && <p className="rounded bg-error-container/40 px-2 py-1 text-error">{error}</p>}
            {report?.servers.map((s) => <ServerCard key={s.agentId} s={s} />)}
            {report && (
                <p className="px-1 text-ui-10 leading-4 text-on-surface-variant/70">
                    {L.costNote} {L.tokensNote}
                </p>
            )}
        </section>
    )
}
