import {useMemo, useState} from 'react'
import {agents as agentsModel, vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import {formatDateTime, t as tr, useT} from '../../i18n'
import {CONTEXT_ICONS, type WorkContextKind} from './workContext'

// Historial de conversaciones, agrupado por módulo.
//
// La versión anterior era una lista plana: nueve filas seguidas donde
// "Chat con Claude Code" aparecía cuatro veces y lo único que las distinguía
// era el nombre del agente a la derecha, que es el dato menos útil de los tres
// —casi siempre es el mismo—. Encontrar la conversación de una base de datos
// entre las de un repositorio era leerlas todas.
//
// Ahora se agrupan, con contador y plegables, **por dos criterios que se
// eligen**: por el módulo de donde salieron —que es como uno las recuerda, "la
// que tuve mirando tigochat"— o por agente, que es lo que sirve cuando lo que
// se busca es "aquella que le pregunté a Codex". Una sección vacía no se
// dibuja: un grupo con cero elementos es una pregunta sin respuesta.

interface Props {
    chats: vault.AgentChat[]
    agents: agentsModel.Agent[]
    // Nombre visible del recurso de cada conversación, resuelto AHORA por el
    // llamador (una conexión renombrada tiene que mostrarse con su nombre
    // nuevo, y una borrada como borrada). Por id de contexto.
    resourceNames: Record<string, string>
    // Módulo desde el que se abrió el historial. Arranca filtrado a ese: quien
    // viene de una conexión busca la conversación de esa conexión, no las nueve
    // de todo el programa. El encabezado ofrece ver el resto.
    initialFilterKind?: WorkContextKind
    onOpen: (chat: vault.AgentChat) => void
    onRename: (chat: vault.AgentChat) => void
    onDelete: (chat: vault.AgentChat) => void
    onClose: () => void
}

// Por qué criterio se agrupa. Dos, porque son dos preguntas distintas: "la de
// tal base" y "la que le pregunté a tal agente".
type GroupBy = 'module' | 'agent'

// Los grupos, en el orden en que se muestran. El orden no es alfabético: es el
// de uso — la mayoría de las conversaciones salen del repositorio o de una
// base, y las de "sin módulo" son las viejas, de antes de que el chat fuera
// único.
const GROUPS: WorkContextKind[] = ['db', 'git', 'ssh', 'note', 'http', 'none']

// relativeAge es cómo se ubica una conversación: "hoy", "2d", "3m". Una fecha
// completa obliga a hacer la cuenta.
function relativeAge(unix: number): string {
    const days = Math.floor((Date.now() / 1000 - unix) / 86400)
    const a = tr().agent.age
    if (days <= 0) return a.today
    if (days === 1) return a.yesterday
    if (days < 30) return a.days({n: days})
    if (days < 365) return a.months({n: Math.floor(days / 30)})
    return a.years({n: Math.floor(days / 365)})
}

export default function AgentHistoryPanel({
    chats,
    agents,
    resourceNames,
    initialFilterKind,
    onOpen,
    onRename,
    onDelete,
    onClose,
}: Props) {
    const t = useT()
    const groupLabels = t.agent.historyPanel.groups
    const [query, setQuery] = useState('')
    const [groupBy, setGroupBy] = useState<GroupBy>('module')
    // Filtro por módulo. Arranca en el módulo desde el que se abrió; null es
    // "todas". 'none' no filtra: las conversaciones sin módulo son las viejas y
    // filtrar por ellas no es algo que nadie quiera.
    const [onlyKind, setOnlyKind] = useState<WorkContextKind | null>(
        initialFilterKind && initialFilterKind !== 'none' ? initialFilterKind : null,
    )
    // Los grupos arrancan abiertos: plegarlos es para cuando molestan, no un
    // paso obligatorio antes de ver nada.
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

    const grouped = useMemo(() => {
        const q = query.trim().toLowerCase()
        const match = (c: vault.AgentChat) => {
            if (!q) return true
            const resource = resourceNames[c.contextId] ?? ''
            return (c.title + ' ' + resource).toLowerCase().includes(q)
        }
        const visible = chats.filter(match).filter((c) => !onlyKind || (c.module || 'none') === onlyKind)

        if (groupBy === 'agent') {
            // Los agentes salen de las conversaciones y no del catálogo: una
            // conversación de un CLI desinstalado tiene que seguir apareciendo
            // bajo su nombre, no desaparecer del historial.
            const ids: string[] = []
            for (const c of visible) if (!ids.includes(c.agentId)) ids.push(c.agentId)
            return ids
                .map((id) => ({
                    key: id,
                    icon: 'smart_toy',
                    label: agents.find((a) => a.id === id)?.label ?? id,
                    items: visible.filter((c) => c.agentId === id),
                }))
                .sort((a, b) => b.items.length - a.items.length)
        }

        return GROUPS.map((kind) => ({
            key: kind,
            icon: CONTEXT_ICONS[kind],
            label: groupLabels[kind],
            items: visible.filter((c) => (c.module || 'none') === kind),
        })).filter((g) => g.items.length > 0)
    }, [chats, query, resourceNames, groupBy, agents, onlyKind, groupLabels])

    const total = grouped.reduce((n, g) => n + g.items.length, 0)

    return (
        <div className="flex h-full min-h-0 flex-col bg-surface-container-low">
            <div className="flex shrink-0 items-center gap-1.5 px-2 py-1">
                <Icon name="history" size={13} className="shrink-0 text-on-surface-variant" />
                <div className="flex min-w-0 flex-1 items-center gap-1 rounded border border-outline-variant bg-surface px-1.5">
                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder={t.agent.historyPanel.searchPlaceholder({n: chats.length})}
                        title={t.agent.historyPanel.searchTitle}
                        className="min-w-0 flex-1 bg-transparent py-0.5 text-ui-11 text-on-surface outline-none placeholder:text-on-surface-variant/60"
                    />
                    {query && (
                        <button
                            onClick={() => setQuery('')}
                            title={t.agent.historyPanel.clearSearch}
                            className="shrink-0 text-on-surface-variant hover:text-on-surface"
                        >
                            <Icon name="close" size={11} />
                        </button>
                    )}
                </div>
                {onlyKind && (
                    <button
                        onClick={() => setOnlyKind(null)}
                        title={t.agent.historyPanel.onlyKindTitle({group: groupLabels[onlyKind]?.toLowerCase() ?? t.agent.historyPanel.thisModule})}
                        className="flex shrink-0 items-center gap-1 rounded bg-primary/15 px-1.5 py-0.5 text-ui-10 text-primary"
                    >
                        <Icon name={CONTEXT_ICONS[onlyKind]} size={11} />
                        {t.agent.historyPanel.onlyThisModule}
                        <Icon name="close" size={10} />
                    </button>
                )}

                {/* Dos criterios y no un desplegable de cinco: son las dos
                    preguntas que uno se hace, y un botón que alterna se lee de
                    un vistazo. */}
                <button
                    onClick={() => setGroupBy((g) => (g === 'module' ? 'agent' : 'module'))}
                    title={
                        groupBy === 'module'
                            ? t.agent.historyPanel.groupedByModuleTitle
                            : t.agent.historyPanel.groupedByAgentTitle
                    }
                    className="flex shrink-0 items-center gap-1 rounded border border-outline-variant px-1.5 py-0.5 text-ui-10 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name={groupBy === 'module' ? 'category' : 'smart_toy'} size={11} />
                    {groupBy === 'module' ? t.agent.historyPanel.module : t.agent.historyPanel.agent}
                </button>
                <button
                    onClick={onClose}
                    title={t.agent.historyPanel.backToChat}
                    className="shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="close" size={13} />
                </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto pb-1">
                {total === 0 && (
                    <p className="px-3 py-2 text-ui-11 text-on-surface-variant">
                        {chats.length === 0
                            ? t.agent.historyPanel.empty
                            : t.agent.historyPanel.noMatch({query})}
                    </p>
                )}

                {grouped.map((g) => {
                    const isCollapsed = collapsed.has(g.key)
                    return (
                        <div key={g.key}>
                            <button
                                onClick={() =>
                                    setCollapsed((prev) => {
                                        const next = new Set(prev)
                                        if (next.has(g.key)) next.delete(g.key)
                                        else next.add(g.key)
                                        return next
                                    })
                                }
                                title={t.agent.historyPanel.groupTitle({n: g.items.length, group: g.label})}
                                className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-ui-10 font-medium uppercase tracking-wider text-on-surface-variant hover:bg-surface-variant"
                            >
                                <Icon name={isCollapsed ? 'chevron_right' : 'expand_more'} size={12} className="shrink-0" />
                                <Icon name={g.icon} size={12} className="shrink-0" />
                                {g.label}
                                <span className="ml-auto rounded-full bg-surface-variant px-1.5 text-ui-10 normal-case tracking-normal">
                                    {g.items.length}
                                </span>
                            </button>

                            {!isCollapsed &&
                                g.items.map((c) => {
                                    const agent = agents.find((a) => a.id === c.agentId)
                                    const resource = resourceNames[c.contextId]
                                    return (
                                        // Fila con acciones al pasar por
                                        // encima. Renombrar y quitar no van
                                        // como botones fijos: ensuciarían las
                                        // nueve filas para dos acciones que se
                                        // hacen de vez en cuando, y la acción
                                        // principal —abrir— es obvia.
                                        <div
                                            key={c.id}
                                            className="group flex items-center gap-1.5 py-1 pl-7 pr-2 text-ui-11 hover:bg-surface-container-high"
                                        >
                                            <button
                                                onClick={() => onOpen(c)}
                                                disabled={!agent}
                                                title={
                                                    agent
                                                        ? t.agent.historyPanel.resumeTitle({agent: agent.label})
                                                        : t.agent.historyPanel.notInstalledTitle({agent: c.agentId})
                                                }
                                                className="min-w-0 flex-1 truncate text-left text-on-surface disabled:opacity-50"
                                            >
                                                {c.title || t.agent.historyPanel.untitled}
                                            </button>

                                            {/* El recurso importa más que el
                                                agente: distingue una fila de
                                                otra, que es lo que la lista
                                                plana no hacía. Al agrupar POR
                                                agente se muestra igual, porque
                                                ahí el agente ya está en el
                                                encabezado del grupo. */}
                                            {resource && (
                                                <span className="max-w-28 shrink-0 truncate text-on-surface-variant/70 group-hover:hidden">
                                                    {resource}
                                                </span>
                                            )}
                                            <span
                                                className="w-8 shrink-0 text-right text-on-surface-variant/60 group-hover:hidden"
                                                title={formatDateTime(c.updatedAt)}
                                            >
                                                {relativeAge(c.updatedAt)}
                                            </span>

                                            <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                                                <button
                                                    onClick={() => onRename(c)}
                                                    title={t.agent.historyPanel.renameTitle}
                                                    className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                                                >
                                                    <Icon name="edit" size={12} />
                                                </button>
                                                <button
                                                    onClick={() => onDelete(c)}
                                                    title={t.agent.historyPanel.deleteTitle}
                                                    className="rounded p-0.5 text-on-surface-variant hover:bg-error-container hover:text-on-error-container"
                                                >
                                                    <Icon name="delete" size={12} />
                                                </button>
                                            </span>
                                        </div>
                                    )
                                })}
                        </div>
                    )
                })}
            </div>
        </div>
    )
}
