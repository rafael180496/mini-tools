import {agentlimits} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import {formatDateTime, t as tr, useT} from '../../i18n'

// Cuánto llevás usado DEL LÍMITE de un proveedor, con su barra por ventana.
//
// **Por qué este porcentaje sí es de un tope y el de al lado no.** El panel de
// consumo cuenta tokens de los transcripts y sus porcentajes son proporciones
// de lo gastado: nadie puede dividir por un límite que no conoce. Lo que se
// dibuja acá es otra cosa — el porcentaje que **calculó el servidor del
// proveedor** y que el propio CLI dejó cacheado en el disco (ver
// backend/agentlimits). La app no inventa ninguna división: lee el número y
// dice de cuándo es.
//
// Esa fecha no es decoración: el dato se refresca cuando el CLI habla con su
// servidor, así que un agente que no se usa hace dos días muestra el
// porcentaje de hace dos días. Un "17% usado" sin la edad al lado se lee como
// si fuera de este minuto, y esa es exactamente la lectura equivocada.

interface Props {
    limits?: agentlimits.AgentLimits
    // Preguntarle el límite al CLI del agente, para los que no lo dejan escrito
    // en el disco (hoy Antigravity). Ausente = este panel no ofrece consultar.
    onQuery?: () => void
    querying?: boolean
    queryError?: string
}

// barColor: el color lo decide el proveedor cuando manda severidad, y el
// porcentaje cuando no. Los umbrales son los de siempre —tranquilo, atención,
// se acabó— y usan los roles del sistema de diseño, no colores sueltos.
function barColor(w: agentlimits.Window): string {
    if (w.severity === 'critical' || w.percent >= 90) return 'bg-error'
    if (w.severity === 'warning' || w.percent >= 70) return 'bg-tertiary'
    return 'bg-primary'
}

// resetLabel dice cuándo vuelve a cero, en hora local y en palabras. La fecha
// cruda en UTC que publica el proveedor no se puede leer de un vistazo, que es
// justo lo único que se le pide a este renglón.
function resetLabel(iso: string): string {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    const mins = Math.round((d.getTime() - Date.now()) / 60000)
    const l = tr().agent.limits
    if (mins <= 0) return l.resetsAnyMoment
    if (mins < 60) return l.resetsInMin({n: mins})
    const hours = Math.round(mins / 60)
    if (hours < 24) return l.resetsInHours({n: hours})
    return l.resetsInDays({n: Math.round(hours / 24)})
}

// measuredLabel es la edad del dato. Se dice en palabras y no en fecha porque
// la pregunta real es "¿esto es de recién o de la semana pasada?".
function measuredLabel(iso: string): string {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    const mins = Math.round((Date.now() - d.getTime()) / 60000)
    const l = tr().agent.limits
    if (mins < 2) return l.justMeasured
    if (mins < 60) return l.measuredMin({n: mins})
    const hours = Math.round(mins / 60)
    if (hours < 24) return l.measuredHours({n: hours})
    return l.measuredDays({n: Math.round(hours / 24)})
}

export default function AgentLimitBars({limits, onQuery, querying, queryError}: Props) {
    const t = useT()
    if (!limits) return null

    // El botón de consultar solo aparece donde hace algo: si el agente no
    // publica el dato en disco pero su CLI lo contesta. Cuesta un subproceso y
    // unos segundos, así que lo dispara el usuario y no la apertura del panel.
    const askButton = limits.queryable && onQuery && (
        <button
            onClick={onQuery}
            disabled={querying}
            title={
                querying
                    ? t.agent.limits.queryingTitle
                    : limits.known
                      ? t.agent.limits.refreshTitle
                      : t.agent.limits.queryTitle
            }
            className="flex shrink-0 items-center gap-1 rounded border border-outline-variant px-1.5 py-0.5 text-ui-10 text-on-surface-variant hover:text-on-surface disabled:opacity-40"
        >
            {querying ? (
                <span aria-hidden className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-t-transparent border-primary" />
            ) : (
                <Icon name="query_stats" size={11} />
            )}
            {querying ? t.agent.limits.querying : limits.known ? t.agent.limits.refresh : t.agent.limits.query}
        </button>
    )

    // Sin dato no se dibuja una barra en cero: "no sé" y "no consumiste nada"
    // son cosas distintas, y de las dos la peor de confundir es la segunda.
    if (!limits.known || limits.windows.length === 0) {
        return (
            <div className="mt-1">
                <p className="flex items-start gap-1 text-ui-10 leading-4 text-on-surface-variant/70" title={limits.source}>
                    <Icon name="help" size={11} className="mt-px shrink-0" />
                    <span>{limits.note || t.agent.limits.unknown}</span>
                </p>
                {queryError && <p className="mt-0.5 text-ui-10 leading-4 text-error">{queryError}</p>}
                {askButton && <div className="mt-1">{askButton}</div>}
            </div>
        )
    }

    return (
        <div className="mt-1">
            {limits.windows.map((w) => (
                <div
                    key={`${w.kind}-${w.label}`}
                    className="mt-0.5 flex items-center gap-1.5"
                    title={t.agent.limits.windowTitle({
                        label: w.label,
                        percent: w.percent,
                        reset: w.resetsAt ? `${resetLabel(w.resetsAt)} (${formatDateTime(new Date(w.resetsAt))})` : '',
                        active: !!w.active,
                        detail: w.detail ?? '',
                    })}
                >
                    <span className={`w-44 shrink-0 truncate text-ui-11 ${w.active ? 'text-on-surface' : 'text-on-surface-variant'}`}>
                        {w.active && <span aria-hidden className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-secondary align-middle" />}
                        {w.label}
                    </span>
                    <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-variant">
                        <span className={`block h-full rounded-full ${barColor(w)}`} style={{width: `${Math.min(100, Math.max(0, w.percent))}%`}} />
                    </span>
                    {/* Redondear a cero un consumo real diría que no se usó
                        nada. Debajo del 1% se muestra "<1%" y el valor exacto
                        queda en el tooltip de la fila. */}
                    <span className="w-10 shrink-0 text-right text-ui-11 text-on-surface">
                        {w.percent > 0 && w.percent < 1 ? '<1%' : `${Math.round(w.percent)}%`}
                    </span>
                </div>
            ))}

            <div className="mt-0.5 flex items-center gap-2">
            <p className="min-w-0 truncate text-ui-10 text-on-surface-variant/70" title={t.agent.limits.sourceTitle({source: limits.source})}>
                {measuredLabel(limits.measuredAt)}
                {limits.plan && t.agent.limits.plan({plan: limits.plan})}
                {limits.windows.some((w) => w.resetsAt) && ` · ${resetLabel(limits.windows.find((w) => w.active && w.resetsAt)?.resetsAt ?? limits.windows.find((w) => w.resetsAt)!.resetsAt)}`}
            </p>
            {askButton}
            </div>
            {/* Qué abarcan estas ventanas, cuando el proveedor reparte su cuota
                entre grupos. En Antigravity uno de esos grupos se llama "Claude
                y GPT": sin esta línea, esa fila se lee como consumo de otra
                cuenta —la de Claude Code o la de Codex— en vez de como el plan
                de Antigravity repartido entre los modelos que sirve. */}
            {limits.note && <p className="mt-0.5 text-ui-10 leading-4 text-on-surface-variant/70">{limits.note}</p>}
            {queryError && <p className="mt-0.5 text-ui-10 leading-4 text-error">{queryError}</p>}
        </div>
    )
}
