import {useCallback, useEffect, useMemo, useState} from 'react'
import {
    GitAgentContext,
    GitAgentUsage,
    GitMCPConfig,
    GitRemoveMCPServer,
    GitUpsertMCPServer,
    AgentPlans,
    AgentQueryLimits,
    AgentUsageLimits,
    ListAgents,
} from '../../../wailsjs/go/main/App'
import {agentctx, agentlimits, agentplan, agents as agentsNs, agentusage, mcpconf} from '../../../wailsjs/go/models'
import AgentLimitBars from '../agent/AgentLimitBars'
import Icon from '../Icon'
import ConfirmDialog from '../ConfirmDialog'
import {formatNumber, useT} from '../../i18n'

// Solapa "Agentes" del panel de la pestaña Git: qué le ofrece ESTE
// repositorio a un CLI agéntico.
//
// El vacío que llena: la app ya sabía abrir Claude Code, Codex o Gemini sobre
// el repositorio, pero no mostraba nada de lo que el repositorio tiene
// preparado para ellos. Un repo con seis skills escritos y un CLAUDE.md de
// trescientas líneas se veía igual que uno vacío, y la única forma de saberlo
// era abrir una terminal y listar directorios a mano.
//
// La parte menos obvia y la más útil es la de instrucciones: se muestran
// también las que FALTAN. Cada CLI lee su propio archivo y no los de los otros
// —Claude Code lee CLAUDE.md, Codex lee AGENTS.md, Gemini lee GEMINI.md— así
// que un repo puede estar impecablemente documentado para uno y no decirle
// absolutamente nada a otro. Esa asimetría es invisible hasta que se la
// dibuja.

interface GitAgentPanelProps {
    repoId: string
    // Abre un archivo en el editor de la solapa Archivos. Es lo que convierte
    // este panel de un listado en algo accionable: ver que falta AGENTS.md y
    // poder escribirlo sin cambiar de herramienta.
    onOpenFile: (path: string) => void
    // Arma un prompt para una sesión de agente. Lo usa el botón de cada skill.
    onAskAgent: (prompt: string, about: string) => void
    // Agente por defecto del repositorio (migración 30). "" = preguntar.
    defaultAgent: string
    onSetDefaultAgent: (agentId: string) => void
}

export default function GitAgentPanel({repoId, onOpenFile, onAskAgent, defaultAgent, onSetDefaultAgent}: GitAgentPanelProps) {
    const t = useT()
    const [ctx, setCtx] = useState<agentctx.Context | null>(null)
    const [mcp, setMcp] = useState<mcpconf.Config | null>(null)
    const [usage, setUsage] = useState<agentusage.Usage | null>(null)
    // Plan de cada agente: le da escala al consumo. Un total de tokens no
    // significa lo mismo en un plan gratuito que en uno de pago.
    const [plans, setPlans] = useState<agentplan.Plan[]>([])
    // Cuánto se lleva usado del LÍMITE de cada proveedor. Es otra pregunta y
    // otro origen que el consumo medido: acá el porcentaje lo calculó el
    // servidor del proveedor y su CLI lo dejó cacheado (ver backend/agentlimits).
    const [limits, setLimits] = useState<agentlimits.AgentLimits[]>([])
    // Consulta al CLI del agente que no publica su límite en disco (hoy
    // Antigravity): qué agente se está consultando y qué falló, por agente.
    const [querying, setQuerying] = useState('')
    const [queryErrors, setQueryErrors] = useState<Record<string, string>>({})
    const [installed, setInstalled] = useState<agentsNs.Agent[]>([])
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(true)

    const reload = useCallback(() => {
        setLoading(true)
        Promise.all([GitAgentContext(repoId), ListAgents(), GitMCPConfig(repoId), GitAgentUsage(repoId, 0), AgentPlans(), AgentUsageLimits()])
            .then(([c, list, m, u, p, l]) => {
                setCtx(c)
                setInstalled(list ?? [])
                setMcp(m)
                setUsage(u)
                setPlans(p ?? [])
                setLimits(l ?? [])
                setError('')
            })
            .catch((e) => setError(String(e)))
            .finally(() => setLoading(false))
    }, [repoId])

    useEffect(() => {
        reload()
    }, [reload])

    // Etiqueta legible de un agente por su id, cayendo al id crudo para
    // "copilot", que no está en el catálogo de CLIs que esta app lanza pero sí
    // lee un archivo de instrucciones.
    const agentLabel = (id: string) => installed.find((a) => a.id === id)?.label ?? id

    if (error) return <p className="p-3 text-xs text-error">{error}</p>
    if (loading && !ctx) return <p className="p-3 text-xs text-on-surface-variant">{t.git.agent.loading}</p>
    if (!ctx) return null

    const nothing = ctx.skills.length === 0 && ctx.agents.length === 0 && ctx.commands.length === 0
    const missing = ctx.instructions.filter((i) => !i.present)

    return (
        <div className="h-full overflow-y-auto p-2 text-xs">
            <div className="mb-2 flex items-center gap-2">
                <Icon name="smart_toy" size={14} className="shrink-0 text-primary" />
                <span className="font-semibold text-on-surface">{t.git.agent.heading}</span>
                <button
                    onClick={reload}
                    title={t.git.agent.reloadTitle}
                    className="ml-auto shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="refresh" size={14} />
                </button>
            </div>

            {/* Agente por defecto. Vacío = preguntar cada vez, que es el
                default correcto: elegir por el usuario un asistente que
                consume su cuota no es algo que nadie haya pedido. */}
            <label className="mb-2 flex items-center gap-2 px-1.5 text-ui-11 text-on-surface-variant">
                {t.git.agent.defaultAgent}
                <select
                    value={defaultAgent}
                    onChange={(e) => onSetDefaultAgent(e.target.value)}
                    title={t.git.agent.defaultAgentTitle}
                    className="rounded border border-outline-variant bg-surface px-1 py-0.5 text-ui-11 text-on-surface outline-none focus:border-primary"
                >
                    <option value="">{t.git.agent.askEachTime}</option>
                    {installed
                        .filter((a) => a.available)
                        .map((a) => (
                            <option key={a.id} value={a.id}>
                                {a.label}
                            </option>
                        ))}
                </select>
            </label>

            {/* Instrucciones: lo primero, porque es lo que más seguido falta */}
            <Section title={t.git.agent.instructions.title} count={ctx.instructions.filter((i) => i.present).length}>
                {ctx.instructions.map((i) => (
                    <button
                        key={i.file}
                        onClick={() => onOpenFile(i.path)}
                        title={
                            i.present
                                ? t.git.agent.instructions.openTitle({file: i.file, agents: i.agents.map(agentLabel).join(', ')})
                                : t.git.agent.instructions.missingTitle({file: i.file, agents: i.agents.map(agentLabel).join(', ')})
                        }
                        className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-surface-container-high"
                    >
                        <Icon
                            name={i.present ? 'description' : 'add_circle'}
                            size={13}
                            className={i.present ? 'shrink-0 text-primary' : 'shrink-0 text-on-surface-variant/60'}
                        />
                        <span className={i.present ? 'text-on-surface' : 'text-on-surface-variant/70'}>{i.file}</span>
                        <span className="ml-auto shrink-0 text-ui-10 text-on-surface-variant">
                            {i.agents.map(agentLabel).join(' · ')}
                            {i.present ? null : t.git.agent.instructions.missingTag}
                        </span>
                    </button>
                ))}
            </Section>

            {missing.length > 0 && (
                <p className="mb-2 px-1.5 text-ui-11 text-on-surface-variant">
                    {missing.length === ctx.instructions.length
                        ? t.git.agent.instructions.noneAtAll
                        : t.git.agent.instructions.someMissing({
                              files: missing.map((i) => i.file).join(', '),
                              fileCount: missing.length,
                              agents: missing
                                  .flatMap((i) => i.agents)
                                  .map(agentLabel)
                                  .join(', '),
                              agentCount: missing.flatMap((i) => i.agents).length,
                          })}
                </p>
            )}

            {ctx.skills.length > 0 && (
                <Section title={t.git.agent.skills} count={ctx.skills.length}>
                    {ctx.skills.map((s) => (
                        <EntryRow
                            key={`${s.scope}:${s.path}`}
                            entry={s}
                            onOpen={onOpenFile}
                            icon="lightbulb"
                            // Se le pide al agente que use el skill POR SU
                            // NOMBRE, que es como lo invocan los tres CLIs, en
                            // vez de pegarle el contenido del SKILL.md: el
                            // agente ya sabe cargarlo, y pegarlo gastaría
                            // contexto duplicando lo que va a leer igual.
                            onAsk={() => onAskAgent(t.git.agent.askSkillPrompt({name: s.name}), `skill ${s.name}`)}
                        />
                    ))}
                </Section>
            )}

            {ctx.agents.length > 0 && (
                <Section title={t.git.agent.subagents} count={ctx.agents.length}>
                    {ctx.agents.map((a) => (
                        <EntryRow key={`${a.scope}:${a.path}`} entry={a} onOpen={onOpenFile} icon="account_tree" />
                    ))}
                </Section>
            )}

            {ctx.commands.length > 0 && (
                <Section title={t.git.agent.commands} count={ctx.commands.length} defaultOpen={false}>
                    {ctx.commands.map((c) => (
                        <EntryRow key={`${c.scope}:${c.path}`} entry={c} onOpen={onOpenFile} icon="terminal" />
                    ))}
                </Section>
            )}

            {usage && (
                <UsageSection
                    usage={usage}
                    agentLabel={agentLabel}
                    plans={plans}
                    limits={limits}
                    onQueryLimits={(agent) => {
                        setQuerying(agent)
                        setQueryErrors((prev) => ({...prev, [agent]: ''}))
                        AgentQueryLimits(agent)
                            .then((l) => setLimits((prev) => prev.map((x) => (x.agent === agent ? l : x))))
                            .catch((e) => setQueryErrors((prev) => ({...prev, [agent]: String(e)})))
                            .finally(() => setQuerying(''))
                    }}
                    querying={querying}
                    queryErrors={queryErrors}
                />
            )}

            {mcp && <McpSection cfg={mcp} agentLabel={agentLabel} onChanged={reload} />}

            {nothing && (
                <p className="px-1.5 py-2 text-ui-11 text-on-surface-variant">
                    {t.git.agent.nothing}
                </p>
            )}
        </div>
    )
}

// compact abrevia un número de tokens. Un total real anda en los miles de
// millones y escrito entero no se lee: lo que interesa es el orden de
// magnitud y la proporción, no el dígito de las unidades.
function compact(n: number): string {
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
    return String(n)
}

// Consumo de tokens por agente, con las barras de límite arriba de cada uno.
//
// **Son dos porcentajes de origen distinto y no hay que leerlos igual.** Las
// barras de límite son el porcentaje del TOPE que calculó el servidor del
// proveedor y que su CLI dejó cacheado en el disco: la app lo lee tal cual y
// dice de cuándo es, porque es un dato fechado y no en vivo (ver
// backend/agentlimits). Todo lo demás —el reparto por modelo, el caché, la
// parte de ESTE repositorio— son proporciones de lo CONSUMIDO, medidas sobre
// los transcripts locales, y nunca fracciones de un tope: dividir por un límite
// que no está en ningún archivo daría la clase de número que se lee mal y se
// cree igual.
function UsageSection({
    usage,
    agentLabel,
    plans,
    limits,
    onQueryLimits,
    querying,
    queryErrors,
}: {
    usage: agentusage.Usage
    agentLabel: (id: string) => string
    plans: agentplan.Plan[]
    limits: agentlimits.AgentLimits[]
    onQueryLimits: (agent: string) => void
    querying: string
    queryErrors: Record<string, string>
}) {
    const t = useT()
    return (
        <Section title={t.git.agent.usage.title({days: usage.days})} count={usage.agents.filter((a) => a.available).length}>
            {usage.agents.map((a) => (
                <div key={a.agent} className="mb-1.5 rounded border border-outline-variant px-2 py-1.5">
                    <div className="flex items-center gap-1.5">
                        <Icon name="monitoring" size={13} className="shrink-0 text-on-surface-variant" />
                        <span className="font-medium text-on-surface">{agentLabel(a.agent)}</span>
                        {/* El plan al lado del consumo: sin él, un total de
                            tokens es un número sin escala. */}
                        {(() => {
                            const plan = plans.find((p) => p.agent === a.agent)
                            if (!plan) return null
                            return plan.known ? (
                                <span
                                    title={plan.detail || undefined}
                                    className="shrink-0 rounded-full bg-secondary/15 px-1.5 text-ui-10 text-secondary"
                                >
                                    {plan.label}
                                </span>
                            ) : (
                                <span
                                    title={plan.note}
                                    className="shrink-0 rounded-full bg-surface-variant px-1.5 text-ui-10 text-on-surface-variant"
                                >
                                    {plan.detail || t.git.agent.usage.unknownPlan}
                                </span>
                            )
                        })()}
                        {a.available && (
                            <span className="ml-auto shrink-0 text-ui-11 text-on-surface-variant" title={t.git.agent.usage.tokensDetail({total: formatNumber(a.all.total), messages: formatNumber(a.all.messages)})}>
                                {t.git.agent.usage.tokens({n: compact(a.all.total)})}
                            </span>
                        )}
                    </div>

                    {/* El límite va ARRIBA del consumo: "¿cuánto me queda?" es
                        la pregunta con la que se abre esto; "¿en qué se fue?"
                        es la de después. */}
                    <AgentLimitBars
                        limits={limits.find((l) => l.agent === a.agent)}
                        onQuery={() => onQueryLimits(a.agent)}
                        querying={querying === a.agent}
                        queryError={queryErrors[a.agent]}
                    />

                    {!a.available ? (
                        <>
                            <p className="mt-0.5 text-ui-11 text-on-surface-variant" title={a.source}>
                                {a.note}
                            </p>
                            {/* Un agente puede no dejar tokens en el disco y sí
                                rastro de uso. Mostrar la actividad evita las
                                dos salidas malas: decir "0 tokens" de algo que
                                se usó todo el día, o no decir nada teniendo el
                                dato. */}
                            {a.activity && (
                                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-ui-11 text-on-surface-variant">
                                    <span title={t.git.agent.usage.conversationsTitle}>
                                        {t.git.agent.usage.conversations} <span className="text-on-surface">{a.activity.conversations}</span>
                                    </span>
                                    <span title={t.git.agent.usage.stepsTitle}>
                                        {t.git.agent.usage.steps} <span className="text-on-surface">{a.activity.steps}</span>
                                    </span>
                                    <span title={t.git.agent.usage.repoConversationsTitle}>
                                        {t.git.agent.usage.thisRepo}{' '}
                                        <span className="text-on-surface">
                                            {t.git.agent.usage.repoActivity({conversations: a.activity.repoConversations, steps: a.activity.repoSteps})}
                                        </span>
                                    </span>
                                    {a.activity.lastUsed ? <span>{t.git.agent.usage.lastUsed({when: a.activity.lastUsed})}</span> : null}
                                </div>
                            )}
                        </>
                    ) : (
                        <>
                            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-ui-11 text-on-surface-variant">
                                <span title={t.git.agent.usage.repoTokensDetail({total: formatNumber(a.repo.total), messages: formatNumber(a.repo.messages)})}>
                                    {t.git.agent.usage.thisRepo} <span className="text-on-surface">{compact(a.repo.total)}</span>
                                    {a.all.total > 0 && ` (${Math.round((a.repo.total / a.all.total) * 100)}%)`}
                                </span>
                                <span title={t.git.agent.usage.cacheTitle}>
                                    {t.git.agent.usage.cache} <span className="text-on-surface">{a.cacheHitPercent}%</span>
                                </span>
                                <span title={t.git.agent.usage.outputTitle}>
                                    {t.git.agent.usage.output} <span className="text-on-surface">{compact(a.all.output)}</span>
                                </span>
                                <span>
                                    {a.firstDay} → {a.lastDay}
                                </span>
                            </div>

                            {a.byModel.map((m) => (
                                <div key={m.key} className="mt-0.5 flex items-center gap-1.5" title={t.git.agent.usage.tokensDetail({total: formatNumber(m.total), messages: formatNumber(m.messages)})}>
                                    <span className="w-32 shrink-0 truncate text-ui-11 text-on-surface-variant">{m.key}</span>
                                    <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-variant">
                                        <span className="block h-full rounded-full bg-primary" style={{width: `${m.percent}%`}} />
                                    </span>
                                    <span className="w-10 shrink-0 text-right text-ui-11 text-on-surface-variant">{m.percent}%</span>
                                </div>
                            ))}
                        </>
                    )}
                </div>
            ))}
            <p className="px-1.5 text-ui-10 leading-4 text-on-surface-variant/70">
                {t.git.agent.usage.footnote}
            </p>
        </Section>
    )
}

// Servidores MCP: qué herramientas tiene de verdad el agente que estás por
// abrir acá.
//
// Los valores de las variables de entorno NO llegan a este componente — el
// backend manda solo los nombres (ver backend/mcpconf). Lo que se muestra
// entonces es "este servidor necesita GITHUB_TOKEN", que es la información
// útil, sin que el token salga nunca del backend.
function McpSection({
    cfg,
    agentLabel,
    onChanged,
}: {
    cfg: mcpconf.Config
    agentLabel: (id: string) => string
    onChanged: () => void
}) {
    const t = useT()
    const [removing, setRemoving] = useState<mcpconf.Server | null>(null)
    const [error, setError] = useState('')
    // Formulario para agregar un servidor. `null` = cerrado; el string es el
    // archivo destino, que se elige antes de escribir nada: dónde va es parte
    // de la decisión, no un detalle.
    const [addingTo, setAddingTo] = useState<string | null>(null)
    const [draft, setDraft] = useState({name: '', command: '', args: '', env: ''})
    // Qué archivos se pueden escribir lo decide el backend (mcpconf.Writable):
    // duplicar esa regla acá haría que la UI ofrezca botones que fallan.
    const writableFiles = useMemo(
        () => new Set(cfg.files.filter((f) => f.writable).map((f) => f.path)),
        [cfg.files],
    )

    // Un archivo presente que no se pudo parsear es MUY distinto de uno
    // ausente: sin decirlo, "no tengo servidores" y "mi config tiene un error
    // de sintaxis" se ven exactamente igual.
    const broken = cfg.files.filter((f) => f.present && f.error)

    if (cfg.servers.length === 0 && broken.length === 0) {
        return (
            <Section title={t.git.agent.mcp.title} count={0}>
                <p className="px-1.5 text-ui-11 text-on-surface-variant">
                    {t.git.agent.mcp.none({looked: cfg.files.length, present: cfg.files.filter((f) => f.present).length})}
                </p>
            </Section>
        )
    }

    return (
        <Section title={t.git.agent.mcp.title} count={cfg.servers.length}>
            {error && <p className="px-1.5 py-0.5 text-ui-11 text-error">{error}</p>}

            {/* Agregar. Solo aparece si hay al menos un archivo escribible: en
                una máquina donde no lo hay, un botón que siempre falla es peor
                que ninguno. */}
            {writableFiles.size > 0 && (
                <div className="mb-1 px-1.5">
                    {addingTo === null ? (
                        <button
                            onClick={() => setAddingTo([...writableFiles][0])}
                            title={t.git.agent.mcp.addTitle}
                            className="flex items-center gap-1 rounded border border-outline-variant px-1.5 py-0.5 text-ui-11 text-on-surface-variant hover:text-on-surface"
                        >
                            <Icon name="add" size={12} />
                            {t.git.agent.mcp.add}
                        </button>
                    ) : (
                        <div className="flex flex-col gap-1 rounded border border-outline-variant bg-surface-container p-1.5 text-ui-11">
                            <select
                                value={addingTo}
                                onChange={(e) => setAddingTo(e.target.value)}
                                title={t.git.agent.mcp.fileTitle}
                                className="rounded border border-outline-variant bg-surface px-1 py-0.5 text-on-surface outline-none focus:border-primary"
                            >
                                {[...writableFiles].map((f) => (
                                    <option key={f} value={f}>
                                        {f}
                                    </option>
                                ))}
                            </select>
                            <input
                                value={draft.name}
                                onChange={(e) => setDraft((d) => ({...d, name: e.target.value}))}
                                placeholder={t.git.agent.mcp.namePlaceholder}
                                className="rounded border border-outline-variant bg-surface px-1 py-0.5 font-mono text-on-surface outline-none focus:border-primary"
                            />
                            <input
                                value={draft.command}
                                onChange={(e) => setDraft((d) => ({...d, command: e.target.value}))}
                                placeholder={t.git.agent.mcp.commandPlaceholder}
                                className="rounded border border-outline-variant bg-surface px-1 py-0.5 font-mono text-on-surface outline-none focus:border-primary"
                            />
                            <input
                                value={draft.args}
                                onChange={(e) => setDraft((d) => ({...d, args: e.target.value}))}
                                placeholder={t.git.agent.mcp.argsPlaceholder}
                                className="rounded border border-outline-variant bg-surface px-1 py-0.5 font-mono text-on-surface outline-none focus:border-primary"
                            />
                            <input
                                value={draft.env}
                                onChange={(e) => setDraft((d) => ({...d, env: e.target.value}))}
                                placeholder={t.git.agent.mcp.envPlaceholder}
                                // Se dice dónde termina el valor porque es lo que
                                // suele ser un token: va al archivo del usuario en
                                // texto plano, que es como esos configs funcionan,
                                // y NO al vault de esta app.
                                title={t.git.agent.mcp.envTitle}
                                className="rounded border border-outline-variant bg-surface px-1 py-0.5 font-mono text-on-surface outline-none focus:border-primary"
                            />
                            <div className="flex items-center gap-1">
                                <button
                                    onClick={() => {
                                        const env: Record<string, string> = {}
                                        for (const pair of draft.env.split(',')) {
                                            const [k, ...rest] = pair.split('=')
                                            if (k.trim() && rest.length) env[k.trim()] = rest.join('=').trim()
                                        }
                                        void GitUpsertMCPServer(addingTo, {
                                            name: draft.name.trim(),
                                            transport: 'stdio',
                                            command: draft.command.trim(),
                                            args: draft.args.split(' ').filter(Boolean),
                                            url: '',
                                            env,
                                        } as mcpconf.ServerInput)
                                            .then(() => {
                                                setAddingTo(null)
                                                setDraft({name: '', command: '', args: '', env: ''})
                                                onChanged()
                                            })
                                            .catch((e) => setError(String(e)))
                                    }}
                                    disabled={!draft.name.trim() || !draft.command.trim()}
                                    className="rounded bg-primary px-2 py-0.5 text-on-primary disabled:opacity-40"
                                >
                                    {t.common.save}
                                </button>
                                <button
                                    onClick={() => setAddingTo(null)}
                                    className="rounded px-2 py-0.5 text-on-surface-variant hover:text-on-surface"
                                >
                                    {t.common.cancel}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            )}
            {broken.map((f) => (
                <p key={f.path} className="px-1.5 py-0.5 text-ui-11 text-error" title={f.path}>
                    {f.path}: {f.error}
                </p>
            ))}
            {cfg.servers.map((s) => (
                <div
                    key={`${s.agent}:${s.scope}:${s.name}`}
                    // group para que el botón de quitar aparezca al pasar por
                    // encima: borrar algo del config de otro programa no
                    // debería estar a un clic accidental de distancia.
                    style={undefined}
                    title={t.git.agent.mcp.serverTitle({
                        target: s.transport === 'stdio' ? `${s.command} ${s.args.join(' ')}`.trim() : s.url,
                        agent: agentLabel(s.agent),
                        project: s.scope === 'project',
                        source: s.source,
                    })}
                    className="flex items-start gap-2 rounded px-1.5 py-1"
                >
                    <Icon
                        name={s.transport === 'stdio' ? 'terminal' : 'cloud'}
                        size={13}
                        className="mt-0.5 shrink-0 text-on-surface-variant"
                    />
                    <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                            <span className="truncate font-medium text-on-surface">{s.name}</span>
                            <span className="shrink-0 text-ui-10 text-on-surface-variant">{agentLabel(s.agent)}</span>
                            {s.scope === 'user' ? (
                                <span className="shrink-0 rounded-full bg-surface-variant px-1.5 text-ui-10 text-on-surface-variant">
                                    {t.git.agent.personal}
                                </span>
                            ) : null}
                            {/* Un servidor remoto manda contexto del repositorio
                                fuera de la máquina; que se note sin abrir el
                                tooltip es justamente el punto. */}
                            {s.transport !== 'stdio' ? (
                                <span className="shrink-0 rounded-full bg-tertiary-container px-1.5 text-ui-10 text-on-tertiary-container">
                                    {t.git.agent.mcp.remote}
                                </span>
                            ) : null}
                        </span>
                        <span className="block truncate text-ui-11 text-on-surface-variant">
                            {s.transport === 'stdio' ? `${s.command} ${s.args.join(' ')}`.trim() : s.url}
                        </span>
                        {s.envKeys.length > 0 && (
                            <span
                                className="block truncate text-ui-10 text-on-surface-variant/70"
                                title={t.git.agent.mcp.envKeysTitle}
                            >
                                {t.git.agent.mcp.envKeys({keys: s.envKeys.join(', ')})}
                            </span>
                        )}
                    </span>
                    {/* Quitar solo donde el archivo se puede escribir de
                        verdad: el config.toml de Codex y el archivo de estado
                        de Claude Code quedan afuera, y el botón no aparece en
                        vez de aparecer y fallar. */}
                    {writableFiles.has(s.source) && (
                        <button
                            onClick={() => setRemoving(s)}
                            title={t.git.agent.mcp.removeTitle({name: s.name, source: s.source})}
                            className="shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-error-container/40 hover:text-error"
                        >
                            <Icon name="delete" size={13} />
                        </button>
                    )}
                </div>
            ))}

            {removing && (
                <ConfirmDialog
                    title={t.git.agent.mcp.removeConfirmTitle({name: removing.name})}
                    description={t.git.agent.mcp.removeConfirm({source: removing.source})}
                    confirmLabel={t.git.agent.mcp.removeLabel}
                    danger
                    onConfirm={() => {
                        const target = removing
                        void GitRemoveMCPServer(target.source, target.name)
                            .then(onChanged)
                            .catch((e) => setError(String(e)))
                    }}
                    onClose={() => setRemoving(null)}
                />
            )}
        </Section>
    )
}

// Section es plegable.
//
// Sin esto el panel era una tira única: en un repositorio con 22 comandos
// slash, el consumo de tokens y los servidores MCP quedaban debajo del pliegue
// y no se veían nunca. Se pliega lo que uno no está mirando.
function Section({
    title,
    count,
    children,
    defaultOpen = true,
}: {
    title: string
    count: number
    children: React.ReactNode
    // Los comandos vienen cerrados: son muchos, son de una línea cada uno, y
    // casi nunca es lo que se viene a buscar acá.
    defaultOpen?: boolean
}) {
    const t = useT()
    const [open, setOpen] = useState(defaultOpen)
    return (
        <div className="mb-2">
            <button
                onClick={() => setOpen((v) => !v)}
                title={open ? t.git.agent.collapseSection : t.git.agent.expandSection({count})}
                className="mb-0.5 flex w-full items-center gap-1 rounded px-1.5 text-left text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant hover:bg-surface-container-high"
            >
                <Icon name={open ? 'expand_more' : 'chevron_right'} size={12} className="shrink-0 opacity-70" />
                {title}
                <span className="font-normal opacity-70">{count}</span>
            </button>
            {open && children}
        </div>
    )
}

function EntryRow({
    entry,
    onOpen,
    icon,
    onAsk,
}: {
    entry: agentctx.Entry
    onOpen: (path: string) => void
    icon: string
    onAsk?: () => void
}) {
    const t = useT()
    // Las entradas del home son de esta máquina y no del repositorio: no se
    // pueden abrir en el editor, que trabaja contra el árbol del repo. Se
    // muestran igual porque explican por qué a un compañero "no le anda
    // igual" — pero no fingen ser accionables.
    const isRepo = entry.scope === 'repo'
    const body = (
        <>
            <Icon name={icon} size={13} className="mt-0.5 shrink-0 text-on-surface-variant" />
            <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                    <span className="truncate font-medium text-on-surface">{entry.name}</span>
                    {!isRepo && (
                        <span className="shrink-0 rounded-full bg-surface-variant px-1.5 text-ui-10 text-on-surface-variant">{t.git.agent.personal}</span>
                    )}
                </span>
                {entry.description && <span className="block truncate text-ui-11 text-on-surface-variant">{entry.description}</span>}
            </span>
        </>
    )

    // Un skill personal SÍ se puede usar aunque no se pueda abrir en el
    // editor: el agente lo carga igual. Por eso el botón de preguntar va
    // afuera de esa distinción.
    const ask = onAsk && (
        <button
            onClick={onAsk}
            title={t.git.agent.entry.askTitle({name: entry.name})}
            className="shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
        >
            <Icon name="smart_toy" size={13} />
        </button>
    )

    if (!isRepo) {
        return (
            <div
                title={t.git.agent.entry.personalTitle({path: entry.path})}
                className="flex w-full items-start gap-2 rounded px-1.5 py-1 text-left"
            >
                <span className="flex min-w-0 flex-1 items-start gap-2 opacity-70">{body}</span>
                {ask}
            </div>
        )
    }
    return (
        <div className="flex w-full items-start gap-2 rounded px-1.5 py-1 hover:bg-surface-container-high">
            <button
                onClick={() => onOpen(entry.path)}
                title={t.git.agent.entry.openTitle({path: entry.path})}
                className="flex min-w-0 flex-1 items-start gap-2 text-left"
            >
                {body}
            </button>
            {ask}
        </div>
    )
}
