import {useMemo, useState} from 'react'
import {agentchat, agents as agentsModel, vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'

// Historial de conversaciones del repositorio, como pantalla y no como menú.
//
// # Por qué dejó de ser un menú
//
// El historial vivía dentro del desplegable del `+`, y ahí solo entra una
// lista corta: no hay dónde buscar, los títulos se cortan a la mitad, y
// renombrar o borrar dependían de acordarse de que existía el clic derecho.
// Con veinte conversaciones —que es lo normal en un repositorio de trabajo—
// eso deja de ser navegable.
//
// # Qué junta
//
// Dos orígenes que para quien mira son lo mismo:
//
//   - Las conversaciones **de la app**: las que se abrieron desde acá. Tienen
//     nombre editable y se pueden quitar del historial.
//   - Las **del propio CLI**: las que ya existían fuera de la app —la
//     extensión de VS Code, la terminal— leídas de donde cada uno las guarda.
//     Se marcan como tales, y abrirlas las "adopta" (pasan a ser de la app,
//     sin copiar los mensajes).
//
// Se agrupan por proveedor con pestañas y no en una lista sola: es la primera
// pregunta que uno se hace —"¿esto se lo pregunté a Claude o a Codex?"— y
// mezclarlas obliga a leer de quién es cada fila.

export interface ChatHistoryEntry {
    // id es el de la sesión de la app, o el de la conversación del CLI cuando
    // todavía no se adoptó.
    id: string
    agentId: string
    title: string
    updatedAt: number
    // external distingue las que vienen del CLI: no tienen entrada propia en
    // la app todavía, así que no se pueden renombrar ni quitar del historial.
    external: boolean
    // conv es la conversación del CLI para las externas — lo que hace falta
    // para adoptarlas.
    conv?: agentchat.Conversation
}

interface Props {
    agents: agentsModel.Agent[]
    mine: vault.AgentChat[]
    cli: agentchat.Conversation[]
    activeId: string | null
    onOpen: (entry: ChatHistoryEntry) => void
    onRename: (id: string, current: string) => void
    onDelete: (id: string) => void
    onNew: (agentId: string) => void
}

// relativeAge es "hoy", "1d", "23d" — la forma en que uno ubica una
// conversación. Una fecha completa ocupa más y responde una pregunta que
// nadie se hace ("¿fue el 14 de agosto?" contra "¿fue hace mucho?").
function relativeAge(unix: number): string {
    if (!unix) return ''
    const days = Math.floor((Date.now() / 1000 - unix) / 86400)
    if (days <= 0) return 'hoy'
    if (days === 1) return 'ayer'
    if (days < 30) return `${days}d`
    const months = Math.floor(days / 30)
    return `${months}m`
}

export default function AgentChatHistory({agents, mine, cli, activeId, onOpen, onRename, onDelete, onNew}: Props) {
    const [query, setQuery] = useState('')
    // Qué proveedor se está mirando. `null` es "todos", que es lo útil cuando
    // uno busca por texto y no se acuerda a quién le preguntó.
    const [provider, setProvider] = useState<string | null>(null)

    const entries = useMemo<ChatHistoryEntry[]>(() => {
        const own: ChatHistoryEntry[] = mine.map((c) => ({
            id: c.id,
            agentId: c.agentId,
            title: c.title || 'Sin nombre',
            updatedAt: c.updatedAt,
            external: false,
        }))
        // Las del CLI que ya se adoptaron aparecen una sola vez, como propias.
        const adopted = new Set(mine.map((c) => c.conversationId).filter(Boolean))
        const external: ChatHistoryEntry[] = cli
            .filter((c) => !adopted.has(c.id))
            .map((c) => ({id: c.id, agentId: c.agent, title: c.title, updatedAt: c.updatedAt, external: true, conv: c}))

        return [...own, ...external].sort((a, b) => b.updatedAt - a.updatedAt)
    }, [mine, cli])

    const shown = useMemo(() => {
        const q = query.trim().toLowerCase()
        return entries.filter(
            (e) => (provider === null || e.agentId === provider) && (q === '' || e.title.toLowerCase().includes(q)),
        )
    }, [entries, provider, query])

    // Solo se ofrecen pestañas de agentes que tengan algo: una pestaña vacía
    // es una pregunta sin respuesta ("¿por qué no hay nada acá?").
    const tabs = agents.filter((a) => entries.some((e) => e.agentId === a.id))

    return (
        <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center gap-0.5 border-b border-outline-variant px-1 py-1">
                <button
                    onClick={() => setProvider(null)}
                    title="Todas las conversaciones de este repositorio, de cualquier agente"
                    className={`shrink-0 rounded px-2 py-0.5 text-[11px] ${
                        provider === null ? 'bg-primary/15 text-primary' : 'text-on-surface-variant hover:bg-surface-variant'
                    }`}
                >
                    Todas
                    <span className="ml-1 opacity-60">{entries.length}</span>
                </button>
                {tabs.map((a) => (
                    <button
                        key={a.id}
                        onClick={() => setProvider(a.id)}
                        title={`Solo las conversaciones con ${a.label}`}
                        className={`flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-[11px] ${
                            provider === a.id ? 'bg-primary/15 text-primary' : 'text-on-surface-variant hover:bg-surface-variant'
                        }`}
                    >
                        <Icon name="smart_toy" size={12} />
                        {a.label}
                        <span className="opacity-60">{entries.filter((e) => e.agentId === a.id).length}</span>
                    </button>
                ))}
            </div>

            <div className="flex shrink-0 items-center gap-1 border-b border-outline-variant px-2 py-1">
                <Icon name="search" size={13} className="shrink-0 text-on-surface-variant/60" />
                <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Escape') setQuery('')
                    }}
                    placeholder="Buscar en las conversaciones…"
                    className="min-w-0 flex-1 bg-transparent text-[11px] text-on-surface outline-none placeholder:text-on-surface-variant/50"
                />
                {/* Empezar una conversación vive acá también: si buscaste y no
                    estaba, lo siguiente que querés es crearla. */}
                {(provider !== null || tabs.length === 1) && (
                    <button
                        onClick={() => onNew(provider ?? tabs[0].id)}
                        title="Empezar una conversación nueva con este agente"
                        className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="add" size={13} />
                        Nueva
                    </button>
                )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
                {shown.length === 0 ? (
                    <p className="px-3 py-4 text-center text-[11px] text-on-surface-variant">
                        {query.trim()
                            ? `Ninguna conversación coincide con "${query.trim()}".`
                            : 'Todavía no hay conversaciones en este repositorio. Empezá una desde el + de arriba.'}
                    </p>
                ) : (
                    shown.map((e) => (
                        <div
                            key={`${e.agentId}:${e.id}`}
                            onClick={() => onOpen(e)}
                            className={`group flex cursor-pointer items-center gap-2 border-b border-outline-variant/40 px-2 py-1.5 text-[11px] ${
                                activeId === e.id ? 'bg-primary/10' : 'hover:bg-surface-variant/60'
                            }`}
                        >
                            {/* Por qué aparece algo que nunca abriste desde
                                acá: es la misma conversación que tenés en el
                                CLI o en la extensión. El title va en el
                                envoltorio porque Icon no lo acepta. */}
                            <span
                                className="shrink-0"
                                title={e.external ? 'Ya existía en el agente, fuera de esta app' : 'Conversación de esta app'}
                            >
                                <Icon
                                    name={e.external ? 'cloud_download' : 'chat'}
                                    size={13}
                                    className="text-on-surface-variant/70"
                                />
                            </span>
                            <span className={`min-w-0 flex-1 truncate ${activeId === e.id ? 'text-primary' : 'text-on-surface'}`}>
                                {e.title}
                            </span>

                            {/* Las acciones aparecen al pasar por encima: en
                                reposo la fila es solo el título, que es lo que
                                se lee para elegir. */}
                            {!e.external && (
                                <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
                                    <button
                                        onClick={(ev) => {
                                            ev.stopPropagation()
                                            onRename(e.id, e.title)
                                        }}
                                        title="Cambiarle el nombre a esta conversación"
                                        className="rounded p-0.5 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
                                    >
                                        <Icon name="edit" size={13} />
                                    </button>
                                    <button
                                        onClick={(ev) => {
                                            ev.stopPropagation()
                                            onDelete(e.id)
                                        }}
                                        title="Quitarla del historial. La conversación sigue existiendo en el agente; se pierde el atajo para retomarla."
                                        className="rounded p-0.5 text-on-surface-variant hover:bg-error-container/40 hover:text-error"
                                    >
                                        <Icon name="delete" size={13} />
                                    </button>
                                </span>
                            )}

                            <span className="shrink-0 tabular-nums text-on-surface-variant/70 group-hover:hidden">
                                {relativeAge(e.updatedAt)}
                            </span>
                        </div>
                    ))
                )}
            </div>
        </div>
    )
}
