import {useMemo, useState} from 'react'
import {agents as agentsModel, vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'
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
const GROUPS: {kind: WorkContextKind; label: string}[] = [
    {kind: 'db', label: 'Bases de datos'},
    {kind: 'git', label: 'Repositorios'},
    {kind: 'ssh', label: 'Servidores'},
    {kind: 'note', label: 'Notas'},
    {kind: 'none', label: 'Sin módulo'},
]

// relativeAge es cómo se ubica una conversación: "hoy", "2d", "3m". Una fecha
// completa obliga a hacer la cuenta.
function relativeAge(unix: number): string {
    const days = Math.floor((Date.now() / 1000 - unix) / 86400)
    if (days <= 0) return 'hoy'
    if (days === 1) return 'ayer'
    if (days < 30) return `${days}d`
    if (days < 365) return `${Math.floor(days / 30)}m`
    return `${Math.floor(days / 365)}a`
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

        return GROUPS.map((g) => ({
            key: g.kind,
            icon: CONTEXT_ICONS[g.kind],
            label: g.label,
            items: visible.filter((c) => (c.module || 'none') === g.kind),
        })).filter((g) => g.items.length > 0)
    }, [chats, query, resourceNames, groupBy, agents, onlyKind])

    const total = grouped.reduce((n, g) => n + g.items.length, 0)

    return (
        <div className="flex max-h-[70%] shrink-0 flex-col border-b border-outline-variant bg-surface-container-low">
            <div className="flex shrink-0 items-center gap-1.5 px-2 py-1">
                <Icon name="history" size={13} className="shrink-0 text-on-surface-variant" />
                <div className="flex min-w-0 flex-1 items-center gap-1 rounded border border-outline-variant bg-surface px-1.5">
                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder={`Buscar entre ${chats.length} conversaciones…`}
                        title="Busca por el título de la conversación o por el nombre de la conexión, repositorio o nota desde donde se abrió"
                        className="min-w-0 flex-1 bg-transparent py-0.5 text-[11px] text-on-surface outline-none placeholder:text-on-surface-variant/60"
                    />
                    {query && (
                        <button
                            onClick={() => setQuery('')}
                            title="Limpia la búsqueda"
                            className="shrink-0 text-on-surface-variant hover:text-on-surface"
                        >
                            <Icon name="close" size={11} />
                        </button>
                    )}
                </div>
                {onlyKind && (
                    <button
                        onClick={() => setOnlyKind(null)}
                        title={`Estás viendo solo las conversaciones de ${GROUPS.find((g) => g.kind === onlyKind)?.label.toLowerCase() ?? 'este módulo'}. Hacé clic para ver todas.`}
                        className="flex shrink-0 items-center gap-1 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary"
                    >
                        <Icon name={CONTEXT_ICONS[onlyKind]} size={11} />
                        Solo este módulo
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
                            ? 'Agrupado por módulo (de dónde salió cada conversación). Hacé clic para agrupar por agente.'
                            : 'Agrupado por agente. Hacé clic para agrupar por módulo.'
                    }
                    className="flex shrink-0 items-center gap-1 rounded border border-outline-variant px-1.5 py-0.5 text-[10px] text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name={groupBy === 'module' ? 'category' : 'smart_toy'} size={11} />
                    {groupBy === 'module' ? 'Módulo' : 'Agente'}
                </button>
                <button
                    onClick={onClose}
                    title="Cierra el historial y vuelve a la conversación abierta"
                    className="shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="close" size={13} />
                </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto pb-1">
                {total === 0 && (
                    <p className="px-3 py-2 text-[11px] text-on-surface-variant">
                        {chats.length === 0
                            ? 'Todavía no hay conversaciones. Una entra al historial con su primer mensaje.'
                            : `Ninguna coincide con «${query}».`}
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
                                title={`${g.items.length} ${g.items.length === 1 ? 'conversación' : 'conversaciones'} · ${g.label}`}
                                className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wider text-on-surface-variant hover:bg-surface-variant"
                            >
                                <Icon name={isCollapsed ? 'chevron_right' : 'expand_more'} size={12} className="shrink-0" />
                                <Icon name={g.icon} size={12} className="shrink-0" />
                                {g.label}
                                <span className="ml-auto rounded-full bg-surface-variant px-1.5 text-[10px] normal-case tracking-normal">
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
                                            className="group flex items-center gap-1.5 py-1 pl-7 pr-2 text-[11px] hover:bg-surface-container-high"
                                        >
                                            <button
                                                onClick={() => onOpen(c)}
                                                disabled={!agent}
                                                title={
                                                    agent
                                                        ? `Retoma esta conversación con ${agent.label}. Los mensajes los tiene el CLI: se vuelven a dibujar al abrirla.`
                                                        : `Esta conversación es de ${c.agentId}, que no está instalado en esta máquina.`
                                                }
                                                className="min-w-0 flex-1 truncate text-left text-on-surface disabled:opacity-50"
                                            >
                                                {c.title || 'Sin título'}
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
                                                title={new Date(c.updatedAt * 1000).toLocaleString('es')}
                                            >
                                                {relativeAge(c.updatedAt)}
                                            </span>

                                            <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                                                <button
                                                    onClick={() => onRename(c)}
                                                    title="Cambiar el nombre de esta conversación. El título sale de lo primero que escribiste, que casi nunca es cómo la vas a buscar después."
                                                    className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                                                >
                                                    <Icon name="edit" size={12} />
                                                </button>
                                                <button
                                                    onClick={() => onDelete(c)}
                                                    title="Quita la conversación del historial de mini-tools. NO borra la conversación del CLI: esa vive en su propio almacenamiento y se puede seguir retomando desde ahí."
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
