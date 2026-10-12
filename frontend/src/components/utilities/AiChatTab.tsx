import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {
    AgentActive,
    AgentModelCatalog,
    CancelAgentChat,
    CreateAgentChat,
    DeleteAgentChat,
    GitListRepos,
    ListAgents,
    ListAllAgentChats,
    ListConnections,
    RenameAgentChat,
    ResumeAgentChat,
    SetAgentChatContext,
    TouchAgentChat,
} from '../../../wailsjs/go/main/App'
import {agentmodels, agents as agentsModel, vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import Select from '../Select'
import ConfirmDialog from '../ConfirmDialog'
import PromptDialog from '../git/PromptDialog'
import AgentChat from '../agent/AgentChat'
import {agentIconName} from '../agent/agentIcon'
import {HealthBadge, ProviderIconWithHealth} from '../agent/HealthIndicators'
import {isModelServerAgent} from '../../lib/modelServers'
import {useModelServerHealth, useModelServersHealth} from '../../lib/modelServerHealth'
import {CONTEXT_ICONS, describeContext, repoIdOf, type WorkContext, type WorkContextKind} from '../agent/workContext'
import {useT} from '../../i18n'
import AiChatHistory from './aichat/AiChatHistory'

// Chat de IA: una pestaña de Utilidades con el chat a pantalla completa.
//
//   izquierda   historial de TODAS las conversaciones (de cualquier módulo y
//               proveedor), con buscador, filtro por proveedor y fechas
//   centro      el mismo `AgentChat` de los demás módulos (módulo «utilities»)
//   cabecera    proveedor + modelo + repositorio de trabajo
//
// **No es un chat nuevo.** La conversación es el componente de siempre, así que
// cualquier mejora del chat (Detener, copiar, uso por turno, bloques de código)
// vale acá y en el panel lateral. Lo que esta pestaña aporta es el espacio para
// elegir y retomar conversaciones, que en un panel angosto no entra.
//
// **Qué hace de anfitrión.** Igual que AgentChatHost, mantiene MONTADAS todas las
// conversaciones abiertas y esconde con CSS las que no se miran: cambiar de una
// a otra no puede cortar un turno en curso. La entrada del historial se crea con
// el primer mensaje (una ventana que nunca recibió texto no es historial).

const MODEL_DEFAULT = ''

interface Session {
    id: string
    agentId: string
    agentLabel: string
    // Entrada del historial en el vault; vacía hasta el primer mensaje.
    chatId: string
    context: WorkContext
    resumeConversationId?: string
    resumeChatId?: string
    initialSettings?: {model: string; effort: string; mode: string; brain?: boolean}
    // El modelo vive acá y no dentro de AgentChat: la cabecera lo elige.
    model: string
}

const newSessionId = () => `agent-chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

interface Props {
    // La pestaña está a la vista. Oculta sigue montada (para no perder las
    // conversaciones ni un turno en curso), pero no atiende atajos.
    visible: boolean
}

export default function AiChatTab({visible}: Props) {
    const t = useT()
    const ta = t.utilities.aiChat
    const rootRef = useRef<HTMLDivElement>(null)

    const [agentList, setAgentList] = useState<agentsModel.Agent[]>([])
    const [agentsLoaded, setAgentsLoaded] = useState(false)
    const [defaultAgentId, setDefaultAgentId] = useState('')
    const [repos, setRepos] = useState<vault.GitRepo[]>([])
    const [history, setHistory] = useState<vault.AgentChat[]>([])
    const [resourceNames, setResourceNames] = useState<Record<string, string>>({})
    const [sessions, setSessions] = useState<Session[]>([])
    const [currentId, setCurrentId] = useState('')
    const [historyOpen, setHistoryOpen] = useState(true)
    const [renaming, setRenaming] = useState<vault.AgentChat | null>(null)
    const [deleting, setDeleting] = useState<vault.AgentChat | null>(null)
    const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
    const [catalog, setCatalog] = useState<agentmodels.Catalog | null>(null)

    const sessionsRef = useRef(sessions)
    sessionsRef.current = sessions

    const available = useMemo(() => agentList.filter((a) => a.available), [agentList])
    const current = useMemo(() => sessions.find((s) => s.id === currentId) ?? null, [sessions, currentId])

    // Salud de los servidores de modelos. El proveedor elegido se sondea cada
    // 60 s mientras la pestaña está a la vista; los demás solo se leen una vez
    // (para el punto de cada opción del menú). Un CLI no se sondea.
    const providerHealth = useModelServerHealth(current?.agentId ?? '', visible)
    const optionsHealth = useModelServersHealth(
        useMemo(() => available.map((a) => a.id), [available]),
        visible,
    )

    // --- Carga ------------------------------------------------------------

    const loadHistory = useCallback(() => {
        ListAllAgentChats()
            .then((h) => setHistory(h ?? []))
            .catch(() => setHistory([]))
    }, [])

    // Los nombres se resuelven contra lo que existe HOY: una conexión renombrada
    // tiene que verse con su nombre nuevo, y una borrada simplemente sin recurso.
    const loadNames = useCallback(() => {
        Promise.all([ListConnections().catch(() => []), GitListRepos().catch(() => [])])
            .then(([conns, rs]) => {
                const map: Record<string, string> = {}
                for (const c of conns ?? []) map[c.id] = c.name
                for (const r of rs ?? []) map[r.id] = r.name
                setResourceNames(map)
                setRepos(rs ?? [])
            })
            .catch(() => {})
    }, [])

    useEffect(() => {
        ListAgents()
            .then((l) => setAgentList(l ?? []))
            .catch(() => setAgentList([]))
            .finally(() => setAgentsLoaded(true))
        AgentActive()
            .then((a) => setDefaultAgentId(a?.id ?? ''))
            .catch(() => {})
        loadHistory()
        loadNames()
    }, [loadHistory, loadNames])

    // Al volver a la pestaña se relee el historial: otro módulo (el chat lateral)
    // pudo haber agregado o borrado conversaciones mientras estaba oculta.
    useEffect(() => {
        if (visible) {
            loadHistory()
            loadNames()
        }
    }, [visible, loadHistory, loadNames])

    // Catálogo de modelos del proveedor vigente.
    const currentAgentId = current?.agentId ?? ''
    useEffect(() => {
        if (!currentAgentId) {
            setCatalog(null)
            return
        }
        let cancelled = false
        AgentModelCatalog(currentAgentId)
            .then((c) => !cancelled && setCatalog(c))
            .catch(() => !cancelled && setCatalog(null))
        return () => {
            cancelled = true
        }
    }, [currentAgentId])

    // --- Sesiones ----------------------------------------------------------

    const repoName = useCallback((id: string) => repos.find((r) => r.id === id)?.name ?? resourceNames[id] ?? '', [repos, resourceNames])

    const utilitiesContext = useCallback(
        (repoId: string): WorkContext => ({kind: 'utilities', id: repoId, label: repoId ? repoName(repoId) : ''}),
        [repoName],
    )

    const focusComposer = useCallback(() => {
        window.setTimeout(() => {
            rootRef.current?.querySelector<HTMLTextAreaElement>('[data-aichat-current] textarea')?.focus()
        }, 30)
    }, [])

    // La primera conversación: vacía, con el proveedor activo de la app (o el
    // primero disponible).
    useEffect(() => {
        if (!agentsLoaded || sessions.length > 0 || available.length === 0) return
        const agent = available.find((a) => a.id === defaultAgentId) ?? available[0]
        const s: Session = {
            id: newSessionId(),
            agentId: agent.id,
            agentLabel: agent.label,
            chatId: '',
            context: utilitiesContext(''),
            model: MODEL_DEFAULT,
        }
        setSessions([s])
        setCurrentId(s.id)
    }, [agentsLoaded, sessions.length, available, defaultAgentId, utilitiesContext])

    // El borrador es la conversación sin entrada en el historial. Hay a lo sumo
    // una: «Nuevo chat» con un borrador a la vista no abre otro, vuelve a él.
    const newChat = useCallback(() => {
        const draft = sessionsRef.current.find((s) => !s.chatId)
        if (draft) {
            setCurrentId(draft.id)
            focusComposer()
            return
        }
        const base = sessionsRef.current.find((s) => s.id === currentId)
        const agent = available.find((a) => a.id === base?.agentId) ?? available.find((a) => a.id === defaultAgentId) ?? available[0]
        if (!agent) return
        const baseRepo = base?.context.kind === 'utilities' ? base.context.id : ''
        const s: Session = {
            id: newSessionId(),
            agentId: agent.id,
            agentLabel: agent.label,
            chatId: '',
            context: utilitiesContext(baseRepo),
            model: MODEL_DEFAULT,
        }
        setSessions((prev) => [...prev, s])
        setCurrentId(s.id)
        focusComposer()
    }, [available, currentId, defaultAgentId, focusComposer, utilitiesContext])

    // Cmd/Ctrl+N: chat nuevo, solo con esta pestaña a la vista.
    useEffect(() => {
        if (!visible) return
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
                e.preventDefault()
                newChat()
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [visible, newChat])

    const openChat = useCallback(
        (c: vault.AgentChat) => {
            const existing = sessionsRef.current.find((s) => s.id === c.id)
            if (existing) {
                setCurrentId(existing.id)
                focusComposer()
                return
            }
            const agent = agentList.find((a) => a.id === c.agentId)
            if (!agent) return
            const kind = (c.module || 'none') as WorkContextKind
            // Se retoma EN SU contexto: una conversación pertenece al recurso
            // donde nació, aunque se la mire desde acá.
            const context: WorkContext =
                kind === 'utilities'
                    ? utilitiesContext(c.contextId)
                    : {kind, id: kind === 'none' ? '' : c.contextId, label: resourceNames[c.contextId] ?? ''}
            const s: Session = {
                id: c.id,
                agentId: agent.id,
                agentLabel: agent.label,
                chatId: c.id,
                context,
                resumeConversationId: c.conversationId || undefined,
                resumeChatId: c.id,
                initialSettings: {model: c.model, effort: c.effort, mode: c.mode, brain: c.brain},
                model: c.model || MODEL_DEFAULT,
            }
            if (c.conversationId) void ResumeAgentChat(c.id, c.conversationId).catch(() => {})
            setSessions((prev) => [...prev, s])
            setCurrentId(s.id)
            focusComposer()
        },
        [agentList, focusComposer, resourceNames, utilitiesContext],
    )

    // Cambiar de proveedor en una conversación ya empezada abre otra: la
    // continuidad la guarda cada proveedor en su propio almacenamiento, no hay
    // forma honesta de seguir con otro lo que venía uno. En un borrador (sin
    // mensajes) se cambia en el lugar.
    const changeProvider = useCallback(
        (agentId: string) => {
            const agent = available.find((a) => a.id === agentId)
            if (!agent || !current) return
            if (!current.chatId) {
                setSessions((prev) =>
                    prev.map((s) => (s.id === current.id ? {...s, agentId: agent.id, agentLabel: agent.label, model: MODEL_DEFAULT} : s)),
                )
            } else {
                const draft = sessionsRef.current.find((s) => !s.chatId)
                if (draft) {
                    setSessions((prev) =>
                        prev.map((s) => (s.id === draft.id ? {...s, agentId: agent.id, agentLabel: agent.label, model: MODEL_DEFAULT} : s)),
                    )
                    setCurrentId(draft.id)
                } else {
                    const s: Session = {
                        id: newSessionId(),
                        agentId: agent.id,
                        agentLabel: agent.label,
                        chatId: '',
                        context: utilitiesContext(current.context.kind === 'utilities' ? current.context.id : ''),
                        model: MODEL_DEFAULT,
                    }
                    setSessions((prev) => [...prev, s])
                    setCurrentId(s.id)
                }
            }
            focusComposer()
        },
        [available, current, focusComposer, utilitiesContext],
    )

    const changeModel = useCallback((sessionId: string, model: string) => {
        setSessions((prev) => (prev.some((s) => s.id === sessionId && s.model !== model) ? prev.map((s) => (s.id === sessionId ? {...s, model} : s)) : prev))
    }, [])

    const changeRepo = useCallback(
        (repoId: string) => {
            if (!current) return
            const context = utilitiesContext(repoId)
            setSessions((prev) => prev.map((s) => (s.id === current.id ? {...s, context} : s)))
            // La conversación ya guardada se reasigna: si no, al retomarla desde
            // el historial volvería con el repositorio con el que nació.
            if (current.chatId) void SetAgentChatContext(current.id, 'utilities', repoId).then(loadHistory).catch(() => {})
        },
        [current, loadHistory, utilitiesContext],
    )

    // El nombre del repositorio puede resolverse después de crear la sesión
    // (los repos llegan por una llamada aparte): se rellena la etiqueta.
    useEffect(() => {
        setSessions((prev) => {
            let changed = false
            const next = prev.map((s) => {
                if (s.context.kind !== 'utilities' || !s.context.id) return s
                const label = repoName(s.context.id)
                if (label === s.context.label) return s
                changed = true
                return {...s, context: {...s.context, label}}
            })
            return changed ? next : prev
        })
    }, [repoName])

    // --- Historial ---------------------------------------------------------

    // El primer mensaje crea la entrada del historial, con su texto como título.
    // El alta va indexada POR SESIÓN y guarda su promesa: el id de conversación
    // del proveedor llega apenas contesta y guardarlo es un UPDATE sobre la fila
    // que ese INSERT está creando; sin encadenarlos, un UPDATE que gana la carrera
    // no afecta ninguna fila y la conversación queda sin con qué retomarse.
    const creationsRef = useRef<Map<string, Promise<unknown>>>(new Map())
    const onFirstSend = useCallback(
        (sessionId: string, text: string) => {
            const s = sessionsRef.current.find((x) => x.id === sessionId)
            if (!s || s.chatId || creationsRef.current.has(s.id)) return
            const title = text.trim().split('\n')[0].slice(0, 80)
            creationsRef.current.set(
                s.id,
                CreateAgentChat(s.id, repoIdOf(s.context), s.agentId, title, s.context.kind, s.context.id)
                    .catch(() => {})
                    .then(loadHistory),
            )
            setSessions((prev) => prev.map((x) => (x.id === s.id ? {...x, chatId: s.id} : x)))
        },
        [loadHistory],
    )

    const onConversation = useCallback(
        (sessionId: string, conversationId: string) => {
            const s = sessionsRef.current.find((x) => x.id === sessionId)
            if (!s || (!s.chatId && !creationsRef.current.has(s.id))) return
            void (creationsRef.current.get(s.id) ?? Promise.resolve())
                .then(() => TouchAgentChat(s.id, conversationId))
                .then(loadHistory)
                .catch(() => {})
        },
        [loadHistory],
    )

    const onBusyChange = useCallback(
        (sessionId: string, busy: boolean) => {
            let finished = false
            setBusyIds((prev) => {
                if (prev.has(sessionId) === busy) return prev
                const next = new Set(prev)
                if (busy) next.add(sessionId)
                else {
                    next.delete(sessionId)
                    finished = true
                }
                return next
            })
            // Al terminar un turno la conversación sube en el historial.
            window.setTimeout(() => finished && loadHistory(), 400)
        },
        [loadHistory],
    )

    const removeChat = useCallback(
        (c: vault.AgentChat) => {
            void CancelAgentChat(c.id).catch(() => {})
            void DeleteAgentChat(c.id)
                .then(() => {
                    const rest = sessionsRef.current.filter((s) => s.id !== c.id)
                    setSessions(rest)
                    if (c.id === currentId) {
                        const draft = rest.find((s) => !s.chatId)
                        setCurrentId(draft?.id ?? rest[rest.length - 1]?.id ?? '')
                    }
                    loadHistory()
                })
                .catch(() => {})
        },
        [currentId, loadHistory],
    )

    // --- Dibujo ------------------------------------------------------------

    const modelOptions = (catalog?.models ?? [{id: MODEL_DEFAULT, label: t.agent.chat.modelDefault, description: '', efforts: []}]).map((m) => ({
        value: m.id,
        label: m.label,
        description: m.description || undefined,
    }))

    const repoOptions = [
        {value: '', label: ta.header.noRepo, separatorAfter: repos.length > 0},
        ...repos.map((r) => ({value: r.id, label: r.name, hint: r.path})),
    ]

    const moduleOwned = current && current.context.kind !== 'utilities'
    const workingOf = (s: Session) => {
        if (s.context.kind !== 'utilities' || !s.context.id) return null
        const repo = repos.find((r) => r.id === s.context.id)
        return repo ? {label: ta.repoBlock.label, text: ta.repoBlock.text({name: repo.name, path: repo.path})} : null
    }

    const shortcut = navigator.platform.includes('Mac') ? '⌘N' : 'Ctrl+N'
    const activeChatId = current?.chatId || null

    return (
        <div ref={rootRef} className="flex h-full w-full min-w-0 overflow-hidden bg-surface-container-lowest" role="region" aria-label={t.utilities.tools.aiChat.name}>
            {historyOpen && (
                <aside className="flex w-72 shrink-0 flex-col border-r border-outline-variant">
                    <AiChatHistory
                        chats={history}
                        agents={agentList}
                        resourceNames={resourceNames}
                        activeChatId={activeChatId}
                        busyChatIds={busyIds}
                        onOpen={openChat}
                        onRename={setRenaming}
                        onDelete={setDeleting}
                    />
                </aside>
            )}

            <section className="flex min-w-0 flex-1 flex-col">
                <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-outline-variant bg-surface-container px-3 py-2">
                    <button
                        onClick={() => setHistoryOpen((v) => !v)}
                        title={historyOpen ? ta.hideHistoryTitle : ta.showHistoryTitle}
                        aria-label={historyOpen ? ta.hideHistory : ta.showHistory}
                        aria-pressed={historyOpen}
                        className={`shrink-0 rounded-md p-1.5 hover:bg-surface-variant focus-visible:outline-2 focus-visible:outline-primary ${
                            historyOpen ? 'bg-surface-variant text-on-surface' : 'text-on-surface-variant hover:text-on-surface'
                        }`}
                    >
                        <Icon name="view_sidebar" size={16} filled={historyOpen} />
                    </button>

                    {current && available.length > 0 && (
                        <>
                            <Select
                                value={current.agentId}
                                onChange={changeProvider}
                                title={ta.header.providerTitle}
                                ariaLabel={ta.header.providerLabel}
                                size="sm"
                                placeholder={ta.header.providerPlaceholder}
                                className="max-w-56 min-w-0 rounded-lg"
                                menuMinWidth={220}
                                options={available.map((a) => ({
                                    value: a.id,
                                    label: a.label,
                                    hint: a.vendor || undefined,
                                    icon: isModelServerAgent(a.id) ? (
                                        <ProviderIconWithHealth icon={agentIconName(a.id)} health={optionsHealth[a.id] ?? null} server={a.label} />
                                    ) : (
                                        <Icon name={agentIconName(a.id)} size={14} />
                                    ),
                                }))}
                            />
                            {providerHealth && <HealthBadge health={providerHealth.health} server={current.agentLabel} />}
                            <Select
                                value={current.model}
                                onChange={(m) => changeModel(current.id, m)}
                                title={catalog?.models.find((m) => m.id === current.model)?.description || ta.header.modelTitle}
                                ariaLabel={ta.header.modelLabel}
                                size="sm"
                                leadingIcon="memory"
                                menuMinWidth={260}
                                className="max-w-56 min-w-0 rounded-lg"
                                options={modelOptions}
                            />
                            {moduleOwned ? (
                                <span
                                    title={ta.header.repoModuleTitle({where: t.agent.historyPanel.groups[current.context.kind]?.toLowerCase() ?? ''})}
                                    className="flex min-w-0 max-w-64 items-center gap-1.5 rounded-lg border border-outline-variant bg-surface-container-low px-2 py-1 text-xs text-on-surface-variant"
                                >
                                    <Icon name={CONTEXT_ICONS[current.context.kind]} size={13} className="shrink-0" />
                                    <span className="truncate">{describeContext(current.context) || t.agent.historyPanel.groups[current.context.kind]}</span>
                                </span>
                            ) : (
                                <Select
                                    value={current.context.id}
                                    onChange={changeRepo}
                                    title={ta.header.repoTitle}
                                    ariaLabel={ta.header.repoLabel}
                                    size="sm"
                                    leadingIcon="account_tree"
                                    menuMinWidth={280}
                                    className="max-w-56 min-w-0 rounded-lg"
                                    options={repoOptions}
                                />
                            )}
                        </>
                    )}

                    <button
                        onClick={newChat}
                        disabled={available.length === 0}
                        title={ta.newChatTitle({shortcut})}
                        className="ml-auto flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-40"
                    >
                        <Icon name="add" size={15} />
                        {ta.newChat}
                        <kbd className="rounded bg-on-primary/20 px-1 font-sans text-ui-10">{shortcut}</kbd>
                    </button>
                </header>

                <div className="min-h-0 flex-1">
                    {agentsLoaded && available.length === 0 && (
                        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-xs text-on-surface-variant">
                            <Icon name="smart_toy" size={32} className="opacity-40" />
                            <p className="text-sm text-on-surface">{t.agent.host.emptyNoAgent}</p>
                            <p className="max-w-md">{t.agent.host.emptyNoAgentHint}</p>
                        </div>
                    )}

                    {sessions.map((s) => {
                        const isCurrent = s.id === currentId
                        return (
                            <div
                                key={s.id}
                                data-aichat-current={isCurrent ? '' : undefined}
                                className={`h-full min-h-0 ${isCurrent && visible ? '' : 'hidden'}`}
                            >
                                {/* Una columna de lectura y no el ancho entero de la
                                    pestaña: líneas de 1.500 px no se leen. */}
                                <div className="mx-auto h-full w-full max-w-3xl border-x border-outline-variant bg-surface">
                                    <AgentChat
                                        sessionId={s.id}
                                        context={s.context}
                                        active={isCurrent && visible}
                                        agentId={s.agentId}
                                        agentLabel={s.agentLabel}
                                        resumeConversationId={s.resumeConversationId}
                                        resumeChatId={s.resumeChatId}
                                        initialSettings={s.initialSettings}
                                        model={s.model}
                                        onModelChange={(m) => changeModel(s.id, m)}
                                        working={isCurrent ? workingOf(s) : null}
                                        onSend={(text) => onFirstSend(s.id, text)}
                                        onConversation={(cid) => onConversation(s.id, cid)}
                                        onBusyChange={(b) => onBusyChange(s.id, b)}
                                    />
                                </div>
                            </div>
                        )
                    })}
                </div>
            </section>

            {renaming && (
                <PromptDialog
                    title={ta.rename.title}
                    label={ta.rename.label}
                    initial={renaming.title}
                    confirmLabel={t.common.save}
                    description={ta.rename.description}
                    onSubmit={(value) => {
                        const id = renaming.id
                        setRenaming(null)
                        void RenameAgentChat(id, value.trim())
                            .then(loadHistory)
                            .catch(() => {})
                    }}
                    onClose={() => setRenaming(null)}
                />
            )}

            {deleting && (
                <ConfirmDialog
                    title={ta.remove.title}
                    description={ta.remove.description({title: deleting.title || ta.untitled})}
                    confirmLabel={ta.remove.confirm}
                    danger
                    onConfirm={() => removeChat(deleting)}
                    onClose={() => setDeleting(null)}
                />
            )}
        </div>
    )
}
