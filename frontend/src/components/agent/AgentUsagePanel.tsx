import {useEffect, useState} from 'react'
import {AgentPlans, AgentUsageAll} from '../../../wailsjs/go/main/App'
import {agentplan, agentusage} from '../../../wailsjs/go/models'
import Icon from '../Icon'

// Cuánto llevás gastado, desde el chat.
//
// Es el mismo panel que la solapa Agentes del módulo Git, con una diferencia
// que importa: **acá no hay repositorio**. El chat se abre sobre una conexión,
// una terminal o una nota, así que la columna "este repo" no significaría nada
// y no se muestra; lo que queda es el consumo de la máquina en la ventana de
// días.
//
// **Lo que NO dice, a propósito: cuánto te queda del plan.** Ese número lo sabe
// el servidor de cada proveedor, no un archivo local, y cada uno lo contesta
// con su propio comando (`/status`, `/usage`). Un "82% usado" sacado de una
// división inventada sería exactamente la clase de número que se lee mal y se
// cree igual. Se muestra lo que sí es verificable: lo consumido, en qué modelo,
// y qué parte de la entrada la resolvió el caché — que es el único de estos
// números sobre el que se puede actuar.

// compact acorta los totales: "1.2M" se compara de un vistazo, "1.234.567" no.
function compact(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
    return String(n)
}

interface Props {
    agentLabel: (id: string) => string
    onClose: () => void
    // Lo gastado en ESTA conversación, que el chat ya venía contando. Va arriba
    // porque es la pregunta inmediata: el resto es el contexto del mes.
    session?: {total: number; output: number; cost: number}
}

export default function AgentUsagePanel({agentLabel, onClose, session}: Props) {
    const [usage, setUsage] = useState<agentusage.Usage | null>(null)
    const [plans, setPlans] = useState<agentplan.Plan[]>([])
    const [error, setError] = useState('')

    useEffect(() => {
        Promise.all([AgentUsageAll(0), AgentPlans()])
            .then(([u, p]) => {
                setUsage(u)
                setPlans(p ?? [])
            })
            .catch((e) => setError(String(e)))
    }, [])

    return (
        <div className="flex max-h-80 shrink-0 flex-col border-b border-outline-variant bg-surface-container-low">
            <div className="flex shrink-0 items-center gap-1.5 border-b border-outline-variant px-2 py-1 text-[11px]">
                <Icon name="monitoring" size={13} className="shrink-0 text-primary" />
                <span className="font-medium text-on-surface">Consumo{usage ? ` · ${usage.days} días` : ''}</span>
                <button
                    onClick={onClose}
                    title="Cierra el consumo y vuelve a la conversación"
                    className="ml-auto shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="close" size={13} />
                </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-1.5 text-[11px]">
                {error && <p className="rounded bg-error-container/40 px-2 py-1 text-error">{error}</p>}

                {session && session.total > 0 && (
                    <div className="mb-1.5 rounded border border-primary/40 bg-primary/10 px-2 py-1.5">
                        <p className="flex items-center gap-1.5">
                            <Icon name="forum" size={12} className="shrink-0 text-primary" />
                            <span className="font-medium text-on-surface">Esta conversación</span>
                            <span className="ml-auto text-on-surface-variant">
                                {session.total.toLocaleString('es')} tokens
                            </span>
                        </p>
                        <p className="mt-0.5 text-on-surface-variant">
                            {session.output.toLocaleString('es')} de salida
                            {session.cost > 0 && ` · US$${session.cost.toFixed(4)}`}
                        </p>
                    </div>
                )}

                {!usage && !error && <p className="px-1 text-on-surface-variant">Leyendo lo que dejó cada CLI…</p>}

                {usage?.agents.map((a) => {
                    const plan = plans.find((p) => p.agent === a.agent)
                    return (
                        <div key={a.agent} className="mb-1.5 rounded border border-outline-variant px-2 py-1.5">
                            <div className="flex items-center gap-1.5">
                                <Icon name="smart_toy" size={12} className="shrink-0 text-on-surface-variant" />
                                <span className="font-medium text-on-surface">{agentLabel(a.agent)}</span>

                                {/* El plan al lado del consumo: sin él, un total
                                    de tokens es un número sin escala. */}
                                {plan &&
                                    (plan.known ? (
                                        <span
                                            title={plan.detail || undefined}
                                            className="shrink-0 rounded-full bg-secondary/15 px-1.5 text-[10px] text-secondary"
                                        >
                                            {plan.label}
                                        </span>
                                    ) : (
                                        <span
                                            title={plan.note}
                                            className="shrink-0 rounded-full bg-surface-variant px-1.5 text-[10px] text-on-surface-variant"
                                        >
                                            {plan.detail || 'plan desconocido'}
                                        </span>
                                    ))}

                                {a.available && (
                                    <span
                                        className="ml-auto shrink-0 text-on-surface-variant"
                                        title={`${a.all.total.toLocaleString('es')} tokens en ${a.all.messages.toLocaleString('es')} respuestas`}
                                    >
                                        {compact(a.all.total)} tokens
                                    </span>
                                )}
                            </div>

                            {!a.available ? (
                                <>
                                    <p className="mt-0.5 text-on-surface-variant" title={a.source}>
                                        {a.note}
                                    </p>
                                    {/* Un CLI puede no dejar tokens en el disco
                                        y sí rastro de uso. Mostrar la actividad
                                        evita las dos salidas malas: decir "0
                                        tokens" de algo que se usó todo el día, o
                                        no decir nada teniendo el dato. */}
                                    {a.activity && (
                                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-on-surface-variant">
                                            <span title="Conversaciones registradas por el CLI en esta máquina">
                                                Conversaciones:{' '}
                                                <span className="text-on-surface">{a.activity.conversations}</span>
                                            </span>
                                            <span title="Pasos (turnos de trabajo del agente) sumados de todas las conversaciones">
                                                Pasos: <span className="text-on-surface">{a.activity.steps}</span>
                                            </span>
                                            {a.activity.lastUsed && <span>último uso: {a.activity.lastUsed}</span>}
                                        </div>
                                    )}
                                </>
                            ) : (
                                <>
                                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-on-surface-variant">
                                        <span title="Qué parte de los tokens de ENTRADA salió del caché en vez de reprocesarse. Es el único número de acá sobre el que se puede actuar: cuanto más alto, más barata la sesión larga.">
                                            Caché: <span className="text-on-surface">{a.cacheHitPercent}%</span>
                                        </span>
                                        <span title="Los tokens que generó el modelo. Son los más caros de las cuatro clases.">
                                            Salida: <span className="text-on-surface">{compact(a.all.output)}</span>
                                        </span>
                                        <span>
                                            {a.firstDay} → {a.lastDay}
                                        </span>
                                    </div>

                                    {a.byModel.map((m) => (
                                        <div
                                            key={m.key}
                                            className="mt-0.5 flex items-center gap-1.5"
                                            title={`${m.total.toLocaleString('es')} tokens en ${m.messages.toLocaleString('es')} respuestas`}
                                        >
                                            <span className="w-28 shrink-0 truncate text-on-surface-variant">{m.key}</span>
                                            <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-variant">
                                                <span
                                                    className="block h-full rounded-full bg-primary"
                                                    style={{width: `${m.percent}%`}}
                                                />
                                            </span>
                                            <span className="w-9 shrink-0 text-right text-on-surface-variant">
                                                {m.percent}%
                                            </span>
                                        </div>
                                    ))}
                                </>
                            )}
                        </div>
                    )
                })}

                <p className="px-1 text-[10px] leading-4 text-on-surface-variant/70">
                    Son proporciones de lo consumido, <strong>no de un límite de plan</strong>: cuánto te queda de tu
                    suscripción lo sabe el servidor del proveedor, no un archivo local. Cada CLI lo contesta con su
                    propio comando (<span className="font-mono">/status</span>, <span className="font-mono">/usage</span>).
                </p>
            </div>
        </div>
    )
}
