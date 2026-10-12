import {useEffect, useMemo, useRef, useState} from 'react'
import {SearchAgentChats} from '../../../../wailsjs/go/main/App'
import {agents as agentsModel, vault} from '../../../../wailsjs/go/models'
import Icon from '../../Icon'
import {agentIconName} from '../../agent/agentIcon'
import {CONTEXT_ICONS, type WorkContextKind} from '../../agent/workContext'
import {isModelServerAgent} from '../../../lib/modelServers'
import {formatDateTime, useT} from '../../../i18n'
import {DATE_GROUP_ORDER, dateGroupOf, type DateGroupId} from './dateGroups'

// Lista de TODAS las conversaciones, a la izquierda del Chat de IA.
//
// Es otra pantalla que el AgentHistoryPanel del chat lateral, a propósito: aquel
// vive en un panel angosto y agrupa por módulo porque ahí se llega «desde» un
// módulo; acá se llega a buscar. Agrupa por fecha (así se recuerda una
// conversación: «la de ayer»), filtra por proveedor y busca en el TEXTO de los
// mensajes, no solo en el título — el título sale del primer mensaje y casi
// nunca es cómo se la va a buscar.

const SEARCH_DEBOUNCE_MS = 250
const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary'

interface Props {
    chats: vault.AgentChat[]
    agents: agentsModel.Agent[]
    // Cómo se llama cada proveedor de modelos que ya no está disponible (apagado o
    // eliminado). Sus conversaciones se pueden abrir para seguir con otro.
    lostLabels: Record<string, string>
    // Nombre visible del recurso de cada conversación, resuelto AHORA.
    resourceNames: Record<string, string>
    // Conversación que se está mirando, para resaltar su fila.
    activeChatId: string | null
    // Conversaciones que están contestando ahora mismo.
    busyChatIds: Set<string>
    onOpen: (chat: vault.AgentChat) => void
    onRename: (chat: vault.AgentChat) => void
    onDelete: (chat: vault.AgentChat) => void
}

export default function AiChatHistory({chats, agents, lostLabels, resourceNames, activeChatId, busyChatIds, onOpen, onRename, onDelete}: Props) {
    const t = useT()
    const ta = t.utilities.aiChat
    const [query, setQuery] = useState('')
    const [results, setResults] = useState<vault.AgentChat[] | null>(null)
    const [searching, setSearching] = useState(false)
    const [searchError, setSearchError] = useState(false)
    const [provider, setProvider] = useState<string | null>(null)
    const searchRef = useRef<HTMLInputElement>(null)

    // Búsqueda con retardo: cada consulta recorre los mensajes guardados, y
    // hacerlo por tecla sería una ráfaga. El contador descarta respuestas viejas
    // (una búsqueda lenta no puede pisar a una más nueva).
    const seq = useRef(0)
    useEffect(() => {
        const q = query.trim()
        if (!q) {
            seq.current++
            setResults(null)
            setSearching(false)
            setSearchError(false)
            return
        }
        setSearching(true)
        const mine = ++seq.current
        const timer = window.setTimeout(() => {
            SearchAgentChats(q)
                .then((r) => {
                    if (mine !== seq.current) return
                    setResults(r ?? [])
                    setSearchError(false)
                })
                .catch(() => {
                    if (mine !== seq.current) return
                    setResults([])
                    setSearchError(true)
                })
                .finally(() => {
                    if (mine === seq.current) setSearching(false)
                })
        }, SEARCH_DEBOUNCE_MS)
        return () => window.clearTimeout(timer)
    }, [query])

    // Los proveedores salen de las conversaciones y no del catálogo: la de un
    // CLI que ya no está instalado tiene que seguir apareciendo bajo su nombre.
    const providers = useMemo(() => {
        const counts = new Map<string, number>()
        for (const c of chats) counts.set(c.agentId, (counts.get(c.agentId) ?? 0) + 1)
        return [...counts.entries()]
            .map(([id, n]) => ({id, n, label: agents.find((a) => a.id === id)?.label ?? lostLabels[id] ?? id}))
            .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
    }, [chats, agents, lostLabels])

    // Si el proveedor filtrado ya no tiene conversaciones (se borró la última),
    // el filtro se suelta en vez de dejar una lista vacía sin explicación.
    useEffect(() => {
        if (provider && !providers.some((p) => p.id === provider)) setProvider(null)
    }, [provider, providers])

    const base = results ?? chats
    const shown = useMemo(
        () => (provider ? base.filter((c) => c.agentId === provider) : base).slice().sort((a, b) => b.updatedAt - a.updatedAt),
        [base, provider],
    )

    const groups = useMemo(() => {
        const now = new Date()
        const by = new Map<DateGroupId, vault.AgentChat[]>()
        for (const c of shown) {
            const g = dateGroupOf(c.updatedAt, now)
            by.set(g, [...(by.get(g) ?? []), c])
        }
        return DATE_GROUP_ORDER.filter((g) => by.has(g)).map((g) => ({id: g, items: by.get(g)!}))
    }, [shown])

    const whereOf = (c: vault.AgentChat): string => {
        const kind = (c.module || 'none') as WorkContextKind
        const resource = resourceNames[c.contextId]
        if (kind === 'utilities') return resource ?? ''
        // El ícono del módulo ya va en la fila: acá solo el recurso, o el nombre
        // del módulo si ya no existe (una conexión borrada).
        return resource ?? t.agent.historyPanel.groups[kind] ?? ''
    }

    const clockOf = (c: vault.AgentChat): string =>
        dateGroupOf(c.updatedAt) === 'today'
            ? formatDateTime(c.updatedAt, {hour: '2-digit', minute: '2-digit'})
            : formatDateTime(c.updatedAt, {day: 'numeric', month: 'short'})

    return (
        <div className="flex h-full min-h-0 w-full flex-col bg-surface-container-low" aria-label={ta.historyTitle}>
            <div className="shrink-0 border-b border-outline-variant px-2 pb-2 pt-2">
                <div className="flex items-center gap-1.5 rounded-lg border border-outline-variant bg-surface px-2 focus-within:border-primary">
                    <Icon name="search" size={14} className="shrink-0 text-on-surface-variant" />
                    <input
                        ref={searchRef}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Escape' && query) {
                                e.stopPropagation()
                                setQuery('')
                            }
                        }}
                        placeholder={ta.searchPlaceholder}
                        title={ta.searchTitle}
                        aria-label={ta.searchLabel}
                        className="min-w-0 flex-1 bg-transparent py-1.5 text-xs text-on-surface outline-none placeholder:text-on-surface-variant/60"
                    />
                    {searching ? (
                        <span title={ta.searching} className="shrink-0 text-on-surface-variant">
                            <Icon name="progress_activity" size={13} className="animate-spin motion-reduce:animate-none" />
                        </span>
                    ) : (
                        query && (
                            <button
                                onClick={() => {
                                    setQuery('')
                                    searchRef.current?.focus()
                                }}
                                title={ta.clearSearch}
                                aria-label={ta.clearSearch}
                                className={`shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface ${FOCUS}`}
                            >
                                <Icon name="close" size={13} />
                            </button>
                        )
                    )}
                </div>

                {providers.length > 1 && (
                    <div role="group" aria-label={ta.providersLabel} className="mt-2 flex flex-wrap gap-1">
                        <Chip active={provider === null} onClick={() => setProvider(null)} title={ta.allProvidersTitle}>
                            {ta.allProviders}
                        </Chip>
                        {providers.map((p) => (
                            <Chip
                                key={p.id}
                                active={provider === p.id}
                                onClick={() => setProvider((cur) => (cur === p.id ? null : p.id))}
                                title={ta.providerChipTitle({agent: p.label, n: p.n})}
                                icon={agentIconName(p.id)}
                            >
                                {p.label}
                            </Chip>
                        ))}
                    </div>
                )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto pb-2">
                {shown.length === 0 && !searching && (
                    <p className="px-3 py-4 text-center text-ui-11 text-on-surface-variant">
                        {searchError
                            ? ta.searchFailed
                            : chats.length === 0
                              ? ta.empty
                              : query.trim()
                                ? ta.noMatch({query: query.trim()})
                                : ta.noMatchFilter}
                    </p>
                )}

                {groups.map((g) => (
                    <section key={g.id} aria-label={ta.groups[g.id]}>
                        <h3 className="sticky top-0 z-[1] flex items-center gap-2 bg-surface-container-low/95 px-3 pb-1 pt-2.5 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant backdrop-blur-sm">
                            {ta.groups[g.id]}
                            <span className="font-normal normal-case tracking-normal opacity-60">{g.items.length}</span>
                        </h3>
                        {g.items.map((c) => {
                            const agent = agents.find((a) => a.id === c.agentId)
                            // Un proveedor de modelos perdido no bloquea la fila: se abre
                            // para leerla y seguir con otro. Un CLI que no está, sí.
                            const lost = !agent && isModelServerAgent(c.agentId)
                            const where = whereOf(c)
                            const active = c.id === activeChatId
                            const kind = (c.module || 'none') as WorkContextKind
                            return (
                                <div
                                    key={c.id}
                                    className={`group relative flex items-stretch border-l-2 ${
                                        active
                                            ? 'border-primary bg-primary/10'
                                            : 'border-transparent hover:bg-surface-container-high'
                                    }`}
                                >
                                    <button
                                        onClick={() => onOpen(c)}
                                        data-chat-id={c.id}
                                        disabled={!agent && !lost}
                                        data-lost-provider={lost ? '' : undefined}
                                        aria-current={active ? 'true' : undefined}
                                        title={
                                            agent
                                                ? ta.openTitle({agent: agent.label, where})
                                                : lost
                                                  ? ta.lost.openTitle({agent: lostLabels[c.agentId] ?? c.agentId})
                                                  : ta.notInstalledTitle({agent: providers.find((p) => p.id === c.agentId)?.label ?? c.agentId})
                                        }
                                        className={`flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-1.5 text-left disabled:opacity-50 ${FOCUS}`}
                                    >
                                        <span className="flex items-center gap-1.5">
                                            {busyChatIds.has(c.id) && (
                                                <span
                                                    aria-hidden
                                                    className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary motion-reduce:animate-none"
                                                />
                                            )}
                                            <span className={`min-w-0 flex-1 truncate text-xs ${active ? 'font-medium text-on-surface' : 'text-on-surface'}`}>
                                                {c.title || ta.untitled}
                                            </span>
                                        </span>
                                        <span className="flex min-w-0 items-center gap-1 text-ui-10 text-on-surface-variant">
                                            <Icon name={lost ? 'link_off' : agentIconName(c.agentId)} size={11} className={`shrink-0 ${lost ? 'text-tertiary' : 'opacity-70'}`} />
                                            <span className={`min-w-0 truncate ${lost ? 'text-tertiary' : 'shrink-0'}`}>{agent?.label ?? lostLabels[c.agentId] ?? c.agentId}</span>
                                            {kind !== 'utilities' && kind !== 'none' && (
                                                <Icon name={CONTEXT_ICONS[kind]} size={11} className="shrink-0 opacity-70" />
                                            )}
                                            {where && <span className="min-w-0 truncate opacity-80">· {where}</span>}
                                            <span className="ml-auto shrink-0 tabular-nums opacity-70">{clockOf(c)}</span>
                                        </span>
                                    </button>
                                    {/* Renombrar y borrar: siempre en el árbol (opacidad
                                        0) para llegar con Tab, y visibles al pasar el
                                        mouse o al enfocar. Flotan sobre el borde
                                        derecho y no reservan ancho en cada fila. */}
                                    <span className="absolute right-1 top-1 flex items-center gap-0.5 rounded bg-surface-container-high opacity-0 shadow-sm transition-opacity focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none">
                                        <button
                                            onClick={() => onRename(c)}
                                            title={ta.renameTitle}
                                            aria-label={ta.renameTitle}
                                            className={`rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface ${FOCUS}`}
                                        >
                                            <Icon name="edit" size={12} />
                                        </button>
                                        <button
                                            onClick={() => onDelete(c)}
                                            title={ta.deleteTitle}
                                            aria-label={ta.deleteTitle}
                                            className={`rounded p-1 text-on-surface-variant hover:bg-error-container hover:text-on-error-container ${FOCUS}`}
                                        >
                                            <Icon name="delete" size={12} />
                                        </button>
                                    </span>
                                </div>
                            )
                        })}
                    </section>
                ))}
            </div>

            <div className="shrink-0 border-t border-outline-variant px-3 py-1.5 text-ui-10 text-on-surface-variant" aria-live="polite">
                {searching ? ta.searching : ta.count({n: shown.length})}
            </div>
        </div>
    )
}

function Chip({
    active,
    onClick,
    title,
    icon,
    children,
}: {
    active: boolean
    onClick: () => void
    title: string
    icon?: string
    children: React.ReactNode
}) {
    return (
        <button
            onClick={onClick}
            title={title}
            aria-pressed={active}
            className={`flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-ui-10 transition-colors ${FOCUS} ${
                active
                    ? 'border-primary/50 bg-primary/15 text-primary'
                    : 'border-outline-variant text-on-surface-variant hover:border-primary/40 hover:text-on-surface'
            }`}
        >
            {icon && <Icon name={icon} size={11} className="shrink-0" />}
            <span className="truncate">{children}</span>
        </button>
    )
}
