import {useEffect, useMemo, useState} from 'react'
import {AgentAnalyzePlan} from '../../../wailsjs/go/main/App'
import {explain} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import MarkdownPreview from '../MarkdownPreview'
import {useAgentChat} from '../agent/AgentChatHost'

// Severity → visual weight. The rule the whole panel is built on: a plan
// node is flagged by a LEFT BORDER and a badge, never by filling its row
// with a solid colour. A wall of red rows saturates the eye, makes the text
// harder to read, and trains the user to ignore the colour — which is the
// opposite of what a warning is for. Only the tint of the border and the
// badge changes with severity; the row background stays the surface colour
// except for the single bottleneck, which earns a faint highlight.
const SEVERITY_STYLE: Record<string, {border: string; badge: string; icon: string}> = {
    critical: {
        border: 'border-l-error',
        badge: 'bg-error/15 text-error',
        icon: 'error',
    },
    warning: {
        border: 'border-l-tertiary',
        badge: 'bg-tertiary/15 text-tertiary',
        icon: 'warning',
    },
    info: {
        border: 'border-l-outline-variant',
        badge: 'bg-surface-variant text-on-surface-variant',
        icon: 'info',
    },
}

const INSIGHT_ICON: Record<string, string> = {
    'full-scan': 'search_off',
    misestimate: 'balance',
    bottleneck: 'speed',
    'buffer-miss': 'database',
    'not-analyzed': 'info',
}

function fmtMs(ms: number): string {
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`
    if (ms >= 1) return `${ms.toFixed(1)} ms`
    return `${ms.toFixed(3)} ms`
}

function fmtRows(n: number): string {
    return n.toLocaleString('es')
}

// The planner's error, written in the direction it went. Formatting the raw
// ratio breaks down exactly when the miss is worst: estimating 7355 rows and
// getting 6 gives a ratio of 0.0008, which rounds to "×0.0" and tells the
// reader nothing. Under 1 the useful number is the inverse — the planner
// expected 1226 times MORE than it got.
function misestimateLabel(ratio: number): string {
    const factor = ratio >= 1 ? ratio : 1 / ratio
    const shown = factor >= 100 ? factor.toFixed(0) : factor.toFixed(1)
    return ratio >= 1 ? `×${shown} más` : `×${shown} menos`
}

interface PlanNodeViewProps {
    node: explain.PlanNode
    depth: number
    analyzed: boolean
}

// One plan node. Collapsible, so a deep plan can be folded down to the
// branch being investigated instead of scrolling past everything.
function PlanNodeView({node, depth, analyzed}: PlanNodeViewProps) {
    const [collapsed, setCollapsed] = useState(false)
    const children = node.children ?? []
    const style = node.severity ? SEVERITY_STYLE[node.severity] : undefined

    // A ratio far from 1 is the planner being wrong about this node. Shown
    // inline because it is the single most useful number in an analyzed
    // plan and hunting for it in a wall of text is how it gets missed.
    const misestimated = analyzed && !!node.rowsRatio && (node.rowsRatio >= 10 || node.rowsRatio <= 0.1)

    return (
        <div>
            <div
                className={`group flex flex-wrap items-center gap-x-2 gap-y-0.5 border-l-2 py-1 pr-2 font-mono text-xs ${
                    style?.border ?? 'border-l-transparent'
                } ${node.isBottleneck ? 'bg-tertiary/8' : ''}`}
                style={{paddingLeft: `${depth * 14 + 6}px`}}
            >
                <button
                    type="button"
                    onClick={() => setCollapsed((v) => !v)}
                    disabled={children.length === 0}
                    title={
                        children.length === 0
                            ? 'Este nodo no tiene hijos'
                            : collapsed
                              ? `Expande los ${children.length} nodos hijos`
                              : 'Colapsa este subárbol para leer el resto del plan'
                    }
                    className="shrink-0 rounded text-on-surface-variant hover:text-on-surface disabled:invisible"
                >
                    <Icon name={collapsed ? 'chevron_right' : 'expand_more'} size={14} />
                </button>

                <span className="font-sans font-medium text-on-surface">{node.operation}</span>
                {node.objectName && <span className="text-primary">{node.objectName}</span>}
                {node.indexName && (
                    <span className="text-on-surface-variant" title="Índice utilizado por este nodo">
                        via {node.indexName}
                    </span>
                )}

                {/* Estimated vs actual side by side — the comparison is the
                    point of running Analyze, so it should not need arithmetic. */}
                {!!node.rows && (
                    <span className="text-on-surface-variant/80" title="Filas estimadas por el planner">
                        est {fmtRows(node.rows)}
                    </span>
                )}
                {analyzed && (
                    <span className="text-on-surface-variant/80" title="Filas devueltas realmente">
                        real {fmtRows(node.actualRows ?? 0)}
                    </span>
                )}
                {misestimated && (
                    <span
                        className="rounded bg-tertiary/15 px-1 font-sans text-[10px] font-medium text-tertiary"
                        title={
                            node.rowsRatio! >= 1
                                ? `El planner esperaba muchas menos filas de las que este nodo devolvió (${misestimateLabel(node.rowsRatio!)}). Con estadísticas desactualizadas elige mal la estrategia de join.`
                                : `El planner esperaba muchas más filas de las que este nodo devolvió (${misestimateLabel(node.rowsRatio!)}). Con estadísticas desactualizadas elige mal la estrategia de join.`
                        }
                    >
                        {misestimateLabel(node.rowsRatio!)}
                    </span>
                )}

                {!!node.cost && (
                    <span className="text-on-surface-variant/60" title="Costo total estimado del subárbol">
                        cost {node.cost.toFixed(2)}
                    </span>
                )}
                {analyzed && !!node.selfTimeMs && (
                    <span
                        className="text-on-surface-variant/80"
                        title="Tiempo propio de este nodo, ya descontado el de sus hijos — es lo que realmente identifica al culpable"
                    >
                        {fmtMs(node.selfTimeMs)} propios
                    </span>
                )}
                {!!node.loops && node.loops > 1 && (
                    <span className="text-on-surface-variant/60" title="Cantidad de veces que se ejecutó este nodo">
                        ×{node.loops} vueltas
                    </span>
                )}

                {node.isFullScan && style && (
                    <span className={`flex items-center gap-1 rounded px-1.5 font-sans text-[10px] font-medium ${style.badge}`}>
                        <Icon name={style.icon} size={11} filled />
                        Full scan
                    </span>
                )}
                {node.isBottleneck && (
                    <span
                        className="flex items-center gap-1 rounded bg-tertiary/15 px-1.5 font-sans text-[10px] font-medium text-tertiary"
                        title="Nodo con más peso propio del plan — por acá empezar a optimizar"
                    >
                        <Icon name="speed" size={11} filled />
                        {node.impactPct ? `${node.impactPct.toFixed(0)}%` : 'cuello de botella'}
                    </span>
                )}

                {node.filter && (
                    <span className="w-full truncate pl-5 text-on-surface-variant/60" title={node.filter}>
                        filtro: {node.filter}
                    </span>
                )}
                {!node.filter && node.detail && node.detail !== node.operation && (
                    <span className="w-full truncate pl-5 text-on-surface-variant/60" title={node.detail}>
                        {node.detail}
                    </span>
                )}
            </div>

            {!collapsed && children.map((child, i) => <PlanNodeView key={i} node={child} depth={depth + 1} analyzed={analyzed} />)}
        </div>
    )
}

// One headline metric in the summary bar.
function Metric({label, value, hint, accent}: {label: string; value: string; hint: string; accent?: boolean}) {
    return (
        <div className="flex flex-col leading-tight" title={hint}>
            <span className="text-[10px] uppercase tracking-wide text-on-surface-variant/70">{label}</span>
            <span className={`font-mono text-xs ${accent ? 'font-semibold text-tertiary' : 'text-on-surface'}`}>{value}</span>
        </div>
    )
}

function InsightRow({insight}: {insight: explain.Insight}) {
    const [copied, setCopied] = useState(false)
    const style = SEVERITY_STYLE[insight.severity] ?? SEVERITY_STYLE.info

    async function copy() {
        if (!insight.sql) return
        await navigator.clipboard.writeText(insight.sql)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
    }

    return (
        <div className={`flex gap-2 border-l-2 py-1.5 pl-2 pr-2 ${style.border}`}>
            <Icon name={INSIGHT_ICON[insight.kind] ?? 'info'} size={14} className="mt-0.5 shrink-0 text-on-surface-variant" />
            <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-on-surface">{insight.title}</p>
                <p className="text-xs text-on-surface-variant">{insight.detail}</p>
                {insight.sql && (
                    <div className="mt-1 flex items-start gap-2">
                        <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded bg-surface-container-highest px-2 py-1 font-mono text-[11px] text-on-surface">
                            {insight.sql}
                        </code>
                        <button
                            type="button"
                            onClick={() => void copy()}
                            title="Copia la sentencia al portapapeles. No se ejecuta: crear un índice ocupa disco y hace más lentas las escrituras, así que la decisión (y el orden de las columnas) queda en tus manos."
                            className="mt-0.5 flex shrink-0 items-center gap-1 rounded border border-outline-variant px-1.5 py-0.5 text-[11px] text-on-surface-variant hover:border-primary/60 hover:text-on-surface"
                        >
                            <Icon name={copied ? 'check' : 'content_copy'} size={12} />
                            {copied ? 'Copiado' : 'Copiar'}
                        </button>
                    </div>
                )}
            </div>
        </div>
    )
}

interface ExplainPlanPanelProps {
    plan: explain.Plan | null
    loading: boolean
    error: string
    // Conexión de la que salió el plan, para poder pedirle al agente que lo
    // analice. Opcional: sin ella el panel funciona igual, solo que sin ese
    // botón — todo el diagnóstico de esta pantalla es determinista y no
    // depende de que haya un agente instalado.
    connId?: string | null
    connName?: string
}

type View = 'tree' | 'insights' | 'raw'

// Rendered as the body of the "Explain" bottom tab, alongside Resultados /
// Consola / Historial — not as a panel docked under them. It therefore owns
// no close button and no fixed height: the tab bar closes it (with its own
// X, like a result tab) and the shared panel sizes it.
export default function ExplainPlanPanel({plan, loading, error, connId, connName}: ExplainPlanPanelProps) {
    const [view, setView] = useState<View>('tree')
    const chat = useAgentChat()
    // Análisis del agente: se pide a mano y se muestra debajo del diagnóstico
    // determinista, no en su lugar. El 80% del valor de esta pantalla —dónde
    // está el cuello de botella, qué índice falta— ya lo calcula la app sin
    // ninguna IA; regalarlo detrás de "instalá un CLI" sería un mal negocio.
    const [aiAnswer, setAiAnswer] = useState('')
    const [aiBusy, setAiBusy] = useState(false)
    const [aiError, setAiError] = useState('')

    // Un plan nuevo invalida el análisis anterior: dejarlo visible bajo otro
    // plan sería explicar una consulta con las conclusiones de otra.
    useEffect(() => {
        setAiAnswer('')
        setAiError('')
    }, [plan])

    const analyzeWithAgent = () => {
        if (!connId || aiBusy) return
        setAiBusy(true)
        setAiError('')
        AgentAnalyzePlan(connId)
            .then(setAiAnswer)
            .catch((e) => setAiError(String(e)))
            .finally(() => setAiBusy(false))
    }
    const analyzed = !!plan?.analyzed
    const insights = useMemo(() => plan?.insights ?? [], [plan])
    const criticalCount = insights.filter((i) => i.severity === 'critical').length

    const tabs: {id: View; label: string; hint: string; badge?: number}[] = [
        {id: 'tree', label: 'Árbol', hint: 'Plan como árbol de nodos, colapsable'},
        {
            id: 'insights',
            label: 'Diagnóstico',
            hint: 'Qué está mal y qué hacer al respecto, con la sentencia lista para copiar',
            badge: insights.length,
        },
        {id: 'raw', label: 'Texto', hint: 'Salida cruda del motor, tal cual la devolvió'},
    ]

    return (
        <div className="flex min-h-0 flex-1 flex-col bg-surface">
            <div className="flex items-center justify-between gap-3 border-b border-outline-variant px-3 py-1">
                <span className="flex shrink-0 items-center gap-1.5 text-xs font-semibold text-on-surface-variant">
                    <Icon name="query_stats" size={15} />
                    {analyzed ? 'EXPLAIN ANALYZE' : 'EXPLAIN'}
                </span>

                {/* Summary bar: the numbers worth seeing before reading a
                    single node. Planning vs execution time separated because
                    a query that plans for 40ms and runs in 2ms has a very
                    different problem than the reverse. */}
                {plan && !loading && !error && (
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-0.5">
                        {!!plan.planningTimeMs && (
                            <Metric
                                label="Planificación"
                                value={fmtMs(plan.planningTimeMs)}
                                hint="Lo que tardó el motor en decidir el plan, antes de ejecutar nada"
                            />
                        )}
                        {!!plan.executionTimeMs && (
                            <Metric
                                label="Ejecución"
                                value={fmtMs(plan.executionTimeMs)}
                                hint="Tiempo real de ejecución de la consulta"
                                accent
                            />
                        )}
                        {!!plan.totalCost && (
                            <Metric
                                label="Costo total"
                                value={plan.totalCost.toFixed(2)}
                                hint="Costo estimado por el planner. Es una unidad interna del motor: sirve para comparar planes entre sí, no para leerla como tiempo."
                            />
                        )}
                        {!!plan.estimatedRows && (
                            <Metric
                                label={analyzed ? 'Filas est/real' : 'Filas estimadas'}
                                value={analyzed && plan.actualRows ? `${fmtRows(plan.estimatedRows)} / ${fmtRows(plan.actualRows)}` : fmtRows(plan.estimatedRows)}
                                hint="Filas que el planner esperaba devolver, y las que realmente devolvió"
                            />
                        )}
                        {plan.buffers && (
                            <Metric
                                label="Caché"
                                value={`${plan.buffers.hitRatePct.toFixed(0)}%`}
                                hint={`${fmtRows(plan.buffers.hit)} bloques desde memoria, ${fmtRows(plan.buffers.read)} leídos de disco. Un porcentaje bajo en una consulta que se repite significa que el conjunto de trabajo no entra en shared_buffers.`}
                            />
                        )}
                        {!!plan.nodeCount && (
                            <Metric label="Nodos" value={String(plan.nodeCount)} hint="Cantidad de operaciones en el plan" />
                        )}
                        {plan.rolledBack && (
                            <span
                                className="flex items-center gap-1 rounded bg-tertiary/15 px-1.5 py-0.5 text-[10px] font-medium text-tertiary"
                                title="La consulta modifica datos, así que se ejecutó dentro de una transacción que se revirtió al terminar. Los tiempos son reales; los cambios no se aplicaron."
                            >
                                <Icon name="undo" size={11} />
                                Revertido
                            </span>
                        )}
                        {!analyzed && plan.engine === 'postgres' && (
                            <span
                                className="text-[10px] text-on-surface-variant/70"
                                title="Este plan son previsiones del planner. Explain Analyze ejecuta la consulta y muestra filas y tiempos reales."
                            >
                                solo estimaciones
                            </span>
                        )}
                    </div>
                )}

                <div className="flex shrink-0 items-center gap-1">
                    {plan && !loading && !error && (
                        <div className="flex rounded-md border border-outline-variant p-0.5">
                            {tabs.map((t) => (
                                <button
                                    key={t.id}
                                    type="button"
                                    onClick={() => setView(t.id)}
                                    title={t.hint}
                                    className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] ${
                                        view === t.id ? 'bg-primary/15 text-primary' : 'text-on-surface-variant hover:text-on-surface'
                                    }`}
                                >
                                    {t.label}
                                    {!!t.badge && (
                                        <span
                                            className={`rounded-full px-1 text-[9px] font-semibold ${
                                                criticalCount > 0 ? 'bg-error/20 text-error' : 'bg-surface-variant text-on-surface-variant'
                                            }`}
                                        >
                                            {t.badge}
                                        </span>
                                    )}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            <div className="flex-1 overflow-auto">
                {loading && <p className="p-2 text-xs text-on-surface-variant">Generando plan…</p>}
                {error && <p className="p-2 text-xs text-error">{error}</p>}

                {!loading && !error && plan?.root && view === 'tree' && (
                    <div className="py-1">
                        <PlanNodeView node={plan.root} depth={0} analyzed={analyzed} />
                    </div>
                )}

                {!loading && !error && view === 'insights' && (
                    <div className="flex flex-col divide-y divide-outline-variant/40 p-1">
                        {insights.length === 0 ? (
                            <p className="p-2 text-xs text-on-surface-variant">
                                Sin observaciones: el plan no muestra recorridos completos costosos ni desvíos del planner.
                            </p>
                        ) : (
                            insights.map((insight, i) => <InsightRow key={i} insight={insight} />)
                        )}

                        {/* Segunda opinión, explícitamente pedida. Lo de arriba
                            es determinista y ya dice DÓNDE está el problema; lo
                            que el agente agrega es por qué pasa y qué conviene
                            hacer, que es lo que la app no puede saber. */}
                        {plan && connId && (
                            <div className="flex flex-col gap-2 p-2">
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={analyzeWithAgent}
                                        disabled={aiBusy}
                                        title="Le manda al agente la consulta, el plan y el esquema de las tablas involucradas, junto con lo que ya detectó la app, y pide una explicación y qué cambiar. No ejecuta nada ni crea ningún índice."
                                        className="flex items-center gap-1.5 rounded-md border border-outline-variant px-2.5 py-1 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50"
                                    >
                                        <Icon name="smart_toy" size={14} />
                                        {aiBusy ? 'Analizando…' : 'Analizar con el agente'}
                                    </button>
                                    {aiAnswer && (
                                        <button
                                            onClick={() =>
                                                chat.open({
                                                    prompt: '@explain:last ¿cómo sigo con esto?',
                                                    context: connId
                                                        ? {kind: 'db', id: connId, label: connName ?? ''}
                                                        : undefined,
                                                })
                                            }
                                            title="Abre el chat con el plan ya referenciado, para repreguntar sobre esta misma respuesta"
                                            className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                                        >
                                            <Icon name="forum" size={14} />
                                            Seguir en el chat
                                        </button>
                                    )}
                                </div>

                                {aiError && (
                                    <p className="rounded bg-error-container/40 px-2 py-1 text-[11px] text-error">{aiError}</p>
                                )}

                                {aiAnswer && (
                                    <div className="rounded-lg border border-outline-variant bg-surface-container p-2 text-xs text-on-surface">
                                        <MarkdownPreview source={aiAnswer} />
                                        <p className="mt-2 border-t border-outline-variant pt-1 text-[10px] text-on-surface-variant">
                                            Es una sugerencia. Un índice cuesta disco, enlentece las escrituras y su orden de
                                            columnas depende de las otras consultas que corren contra esa tabla — crearlo lo
                                            decidís vos.
                                        </p>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}

                {!loading && !error && view === 'raw' && (
                    <pre className="whitespace-pre-wrap p-2 font-mono text-[11px] text-on-surface-variant">{plan?.rawText}</pre>
                )}

                {!loading && !error && !plan?.root && view === 'tree' && <p className="p-2 text-xs text-on-surface-variant">Sin plan.</p>}
            </div>
        </div>
    )
}
