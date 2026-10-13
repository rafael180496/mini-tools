import {useCallback, useEffect, useMemo, useState} from 'react'
import {
    CancelAgentChat,
    CloseAgentSession,
    DeleteAgentChat,
    GitListRepos,
    ListAgents,
    ListAgentWorkspaces,
    ListAllAgentChats,
    ListConnections,
    ListOpenAgentChats,
    MarkAgentSessionRead,
    SetAgentChatPinned,
} from '../../../../wailsjs/go/main/App'
import {agents as agentsModel, vault} from '../../../../wailsjs/go/models'
import Icon from '../../Icon'
import ConfirmDialog from '../../ConfirmDialog'
import PromptDialog from '../../git/PromptDialog'
import TreeRow from '../../sidebar/TreeRow'
import {useTreeMenu, type TreeMenuEntry} from '../../sidebar/TreeMenu'
import {agentIconName} from '../../agent/agentIcon'
import {CONTEXT_ICONS, type WorkContextKind} from '../../agent/workContext'
import {
    activeEntries,
    attentionCount,
    hideSession,
    isLive,
    reviewApprovalOf,
    sessionTokens,
    toMillis,
    useAgentSessions,
    useHiddenSessions,
    type AgentSessionInfo,
} from '../../../lib/agentSessions'
import {notifyAgentChatsChanged, notifyAiChatGone, onAgentChatsChanged, requestOpenAiChat} from '../../../lib/appBus'
import {MAX_CHAT_TITLE} from '../../../lib/chatTitle'
import {renameChat} from '../../../lib/chatRename'
import {formatDateTime, formatNumber, useT} from '../../../i18n'

// Las conversaciones de IA, colgando de la fila «Chat de IA» de Utilidades.
//
// Son los dos grupos que despliega esa fila, después de las pestañas de chat
// abiertas. Una IA con su propio módulo en la barra de módulos competía con las
// herramientas que la rodean: todo lo de la IA vive donde ya vivía el Chat.
//
//   Abiertas   «¿qué conversaciones tengo en marcha?». Es una lista PERSISTENTE
//              (estilo Hermes): una conversación entra cuando se crea —aunque no
//              se le haya escrito nada— y se queda hasta que la CIERRES o la
//              ELIMINES. Cerrar su pestaña no la saca; cerrar la app tampoco
//              (lo que corría figura «interrumpido» y se retoma con un clic).
//              Las fijadas van arriba. Une dos fuentes: las filas abiertas del
//              vault (el estado de siempre) y el registro de sesiones vivas (el
//              estado de ahora, que manda cuando existe).
//   Recientes  «¿cuál era esa conversación?». Las últimas, de cualquier módulo
//              y proveedor, que no estén abiertas, para abrirlas en una pestaña.
//
// **Detener no es Cerrar chat no es Eliminar.** «Detener» corta el turno en
// curso y deja el chat abierto (sigue listado, se le puede escribir de nuevo).
// «Cerrar chat» corta lo que corra y da la conversación por terminada: sale de
// «Abiertas» y queda en «Recientes». «Eliminar» la borra del todo, mensajes
// incluidos. Todo lo que se hace acá es sobre la conversación, no sobre la
// pestaña: sigue existiendo aunque ninguna pestaña la muestre.
//
// Está partido en un hook (los datos, que UtilitiesTree necesita ANTES de
// decidir si muestra la fila: una búsqueda puede coincidir sólo con una
// conversación) y un componente (los dos grupos).

const RECENT_LIMIT = 20
const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary'
const WORKSPACE_PREFIX = 'ws:'
const GROUPS_KEY = 'mini-tools:ai-groups-open'
// Cuánto se resalta la fila a la que lleva un aviso.
const HIGHLIGHT_MS = 2600

// Cómo está una conversación abierta, mezclando el estado en vivo (si hay
// sesión) con el que quedó guardado.
export type OpenState = 'working' | 'approval' | 'unread' | 'idle' | 'error' | 'interrupted' | 'cancelled' | 'draft'

// Una fila de «Abiertas».
export interface OpenEntry {
    // Id de la conversación (el de la sesión, si la hay).
    id: string
    chat: vault.AgentChat | null
    session: AgentSessionInfo | null
    state: OpenState
    pinned: boolean
    title: string
    agentId: string
    agentLabel: string
    model: string
    module: string
    contextId: string
    // Última actividad, en segundos Unix (lo que usa formatDateTime).
    at: number
}

// El estado de una conversación: la sesión viva manda; sin ella, el guardado.
export function openStateOf(chat: vault.AgentChat | null, session: AgentSessionInfo | null): OpenState {
    if (session) {
        if (session.status === 'running') return 'working'
        if (session.status === 'awaiting_approval') return 'approval'
        if (session.status === 'error') return 'error'
        if (session.status === 'cancelled') return 'cancelled'
        return session.unread ? 'unread' : 'idle'
    }
    switch (chat?.lastStatus) {
        case 'idle':
            return 'idle'
        case 'interrupted':
            return 'interrupted'
        case 'error':
            return 'error'
        case 'cancelled':
            return 'cancelled'
        default:
            return 'draft'
    }
}

// Reloj de un turno en curso. Cada fila viva tiene el suyo: un solo intervalo
// por fila, que existe sólo mientras la fila está.
function Elapsed({since}: {since: number}) {
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        const id = window.setInterval(() => setNow(Date.now()), 1000)
        return () => window.clearInterval(id)
    }, [])
    const sec = Math.max(0, Math.floor((now - since) / 1000))
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = sec % 60
    const pad = (n: number) => String(n).padStart(2, '0')
    return <span className="tabular-nums">{h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`}</span>
}

function StateIcon({state}: {state: OpenState}) {
    switch (state) {
        case 'working':
            return <Icon name="progress_activity" size={16} className="animate-spin text-primary motion-reduce:animate-none" />
        case 'approval':
            return <Icon name="gpp_maybe" size={16} filled className="text-tertiary" />
        case 'unread':
            return <Icon name="check_circle" size={16} filled className="text-secondary" />
        case 'error':
            return <Icon name="error" size={16} filled className="text-error" />
        case 'interrupted':
            return <Icon name="pause_circle" size={16} filled className="text-tertiary" />
        case 'cancelled':
            return <Icon name="stop_circle" size={16} className="text-on-surface-variant" />
        case 'draft':
            return <Icon name="edit_note" size={16} className="text-on-surface-variant" />
        default:
            return <Icon name="forum" size={16} className="text-on-surface-variant" />
    }
}

export interface AiSessionsData {
    // Hay una búsqueda activa (y entonces los grupos se muestran abiertos).
    query: string
    rawQuery: string
    // Las abiertas, ya ordenadas: primero las fijadas.
    pinned: OpenEntry[]
    open: OpenEntry[]
    recent: vault.AgentChat[]
    // Cuántas trabajan y cuántas esperan una decisión: lo que dicen las
    // insignias de la fila y del módulo.
    attention: {running: number; approval: number}
    providerLabel: (agentId: string, fallback?: string) => string
    projectOf: (module: string, contextId: string) => string
}

// Qué urge más a la hora de ordenar: lo que espera una decisión, lo que trabaja,
// lo que falló, lo no leído y, al final, lo quieto.
const rankOf = (state: OpenState) => (state === 'approval' ? 0 : state === 'working' ? 1 : state === 'error' ? 2 : state === 'unread' ? 3 : 4)

export function useAiSessionsData(filter: string, visible: boolean): AiSessionsData {
    const sessions = useAgentSessions()
    const hidden = useHiddenSessions()
    const query = filter.trim().toLowerCase()

    const [agentList, setAgentList] = useState<agentsModel.Agent[]>([])
    const [chats, setChats] = useState<vault.AgentChat[]>([])
    const [openChats, setOpenChats] = useState<vault.AgentChat[]>([])
    const [names, setNames] = useState<Record<string, string>>({})

    const loadChats = useCallback(() => {
        ListAllAgentChats()
            .then((h) => setChats(h ?? []))
            .catch(() => setChats([]))
        ListOpenAgentChats()
            .then((h) => setOpenChats(h ?? []))
            .catch(() => setOpenChats([]))
    }, [])
    const loadNames = useCallback(() => {
        Promise.all([ListConnections().catch(() => []), GitListRepos().catch(() => []), ListAgentWorkspaces().catch(() => [])])
            .then(([conns, rs, ws]) => {
                const map: Record<string, string> = {}
                for (const c of conns ?? []) map[c.id] = c.name
                for (const r of rs ?? []) map[r.id] = r.name
                for (const w of ws ?? []) map[WORKSPACE_PREFIX + w.id] = w.name
                setNames(map)
            })
            .catch(() => {})
    }, [])

    useEffect(() => {
        ListAgents()
            .then((l) => setAgentList(l ?? []))
            .catch(() => setAgentList([]))
        loadNames()
    }, [loadNames])

    // La lista se relee cuando la de sesiones cambia de forma (empezó o terminó
    // una: sube), al mostrarse el módulo y cuando algo cambia una conversación
    // por fuera (crear un chat, fijarlo, cerrarlo, renombrarlo).
    const shape = sessions.map((s) => `${s.sessionId}:${s.status}`).join('|')
    useEffect(() => {
        loadChats()
    }, [loadChats, shape])
    useEffect(() => onAgentChatsChanged(loadChats), [loadChats])
    useEffect(() => {
        if (visible) {
            loadChats()
            loadNames()
        }
    }, [visible, loadChats, loadNames])

    const providerLabel = useCallback((agentId: string, fallback = '') => agentList.find((a) => a.id === agentId)?.label ?? (fallback || agentId.replace(/^llm:/, '')), [agentList])
    // Sin proyecto no se rotula: «Sin proyecto» en cada fila es ruido que
    // empuja afuera lo que sí identifica (el proveedor y el modelo).
    const projectOf = useCallback((_module: string, contextId: string) => (contextId ? (names[contextId] ?? '') : ''), [names])

    const matches = useCallback(
        (title: string, agentId: string, project: string) => !query || `${title} ${providerLabel(agentId)} ${project}`.toLowerCase().includes(query),
        [query, providerLabel],
    )

    // Las abiertas: las filas abiertas del vault, con su sesión viva encima, más
    // las sesiones que piden atención sin ser un chat abierto (la conversación de
    // un panel de otro módulo que trabaja en segundo plano).
    const { pinned, open } = useMemo(() => {
        const byId = new Map(chats.map((c) => [c.id, c]))
        const live = new Map(sessions.map((s) => [s.chatId || s.sessionId, s]))
        const entries: OpenEntry[] = openChats.map((c) => {
            const session = live.get(c.id) ?? null
            return {
                id: c.id,
                chat: c,
                session,
                state: openStateOf(c, session),
                pinned: c.pinned,
                title: session?.title || c.title,
                agentId: c.agentId,
                agentLabel: session?.agentLabel ?? '',
                model: session?.model || c.model,
                module: c.module,
                contextId: c.contextId,
                at: Math.max(c.updatedAt, Math.floor(toMillis(session?.lastEventAt) / 1000)),
            }
        })
        const have = new Set(entries.map((e) => e.id))
        for (const s of activeEntries(sessions, hidden)) {
            const id = s.chatId || s.sessionId
            if (have.has(id)) continue
            const chat = byId.get(id) ?? null
            entries.push({
                id,
                chat,
                session: s,
                state: openStateOf(chat, s),
                pinned: false,
                title: s.title || chat?.title || '',
                agentId: s.agentId,
                agentLabel: s.agentLabel,
                model: s.model,
                module: s.module,
                contextId: s.contextId,
                at: Math.floor(toMillis(s.lastEventAt) / 1000),
            })
        }
        const shown = entries
            .filter((e) => matches(e.title, e.agentId, projectOf(e.module, e.contextId)))
            .sort((a, b) => rankOf(a.state) - rankOf(b.state) || b.at - a.at)
        return {pinned: shown.filter((e) => e.pinned), open: shown.filter((e) => !e.pinned)}
    }, [openChats, chats, sessions, hidden, matches, projectOf])

    // Una conversación que ya está en «Abiertas» no se repite en «Recientes».
    const recent = useMemo(() => {
        const inOpen = new Set([...pinned, ...open].map((e) => e.id))
        return chats
            .slice()
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .filter((c) => !c.open && !inOpen.has(c.id) && matches(c.title, c.agentId, projectOf(c.module, c.contextId)))
            .slice(0, RECENT_LIMIT)
    }, [chats, pinned, open, matches, projectOf])

    const attention = useMemo(() => attentionCount(sessions, hidden), [sessions, hidden])

    return {query, rawQuery: filter.trim(), pinned, open, recent, attention, providerLabel, projectOf}
}

// Qué grupos están abiertos se recuerda entre sesiones: es una comodidad por
// espectador, no un dato (si el almacenamiento falla, arrancan como siempre).
function readGroups(): {active: boolean; recent: boolean} {
    try {
        const v = JSON.parse(window.localStorage.getItem(GROUPS_KEY) ?? 'null')
        if (v && typeof v.active === 'boolean' && typeof v.recent === 'boolean') return v
    } catch {
        /* sin almacenamiento: valores por defecto */
    }
    return {active: true, recent: false}
}

export interface AiRevealRequest {
    token: number
    sessionId?: string
}

interface GroupsProps {
    data: AiSessionsData
    // Pedido de mostrar una sesión (el aviso «Ver»): abre «Abiertas», lleva la
    // fila a la vista y la resalta un momento.
    reveal: AiRevealRequest | null
    onRevealed: () => void
}

export default function AiSessionsGroups({data, reveal, onRevealed}: GroupsProps) {
    const t = useT()
    const ts = t.aiSessions.sidebar
    const menu = useTreeMenu(288)
    const {query, rawQuery, pinned, open: others, recent, providerLabel, projectOf} = data
    const entries = useMemo(() => [...pinned, ...others], [pinned, others])

    const [open, setOpen] = useState(readGroups)
    const [stopping, setStopping] = useState<OpenEntry | null>(null)
    const [closing, setClosing] = useState<OpenEntry | null>(null)
    const [deleting, setDeleting] = useState<{id: string; title: string} | null>(null)
    const [highlight, setHighlight] = useState<string | null>(null)
    // Conversación (por id de chat) cuyo nombre se está cambiando.
    const [renaming, setRenaming] = useState<{id: string; title: string} | null>(null)

    const toggle = (g: 'active' | 'recent') =>
        setOpen((cur) => {
            const next = {...cur, [g]: !cur[g]}
            try {
                window.localStorage.setItem(GROUPS_KEY, JSON.stringify(next))
            } catch {
                /* sólo se pierde la comodidad */
            }
            return next
        })

    // Llevar a la vista la sesión pedida. Va en dos tiempos: primero abrir
    // «Abiertas» (la fila todavía no existe en el DOM), después —ya pintada—
    // desplazar y resaltar.
    const revealToken = reveal?.token
    useEffect(() => {
        if (!reveal) return
        setOpen((cur) => (cur.active ? cur : {...cur, active: true}))
        const id = reveal.sessionId
        const frame = window.requestAnimationFrame(() => {
            const el = id ? document.querySelector<HTMLElement>(`[data-ai-session="${CSS.escape(id)}"]`) : document.querySelector<HTMLElement>('[data-ai-group="active"]')
            el?.scrollIntoView({block: 'nearest', behavior: 'smooth'})
            if (id && el) setHighlight(id)
            onRevealed()
        })
        return () => window.cancelAnimationFrame(frame)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [revealToken])
    useEffect(() => {
        if (!highlight) return
        const timer = window.setTimeout(() => setHighlight(null), HIGHLIGHT_MS)
        return () => window.clearTimeout(timer)
    }, [highlight])

    const openChat = (e: OpenEntry) => requestOpenAiChat({chatId: e.id})

    const stop = (e: OpenEntry) => {
        setStopping(null)
        void CancelAgentChat(e.session?.sessionId ?? e.id).catch(() => {})
    }

    const togglePin = (e: OpenEntry) => {
        void SetAgentChatPinned(e.id, !e.pinned)
            .catch(() => {})
            .then(() => notifyAgentChatsChanged())
    }

    // Una conversación leída sigue en la lista: lo único que la saca es cerrarla
    // o eliminarla. Marcar leído solo apaga el aviso de «sin leer».
    const markRead = (e: OpenEntry) => {
        if (!e.session) return
        if (!e.session.detached) hideSession(e.session)
        void MarkAgentSessionRead(e.session.sessionId).catch(() => {})
    }

    const closeChat = (e: OpenEntry) => {
        setClosing(null)
        void CloseAgentSession(e.session?.sessionId ?? e.id)
            .catch(() => {})
            .then(() => {
                notifyAiChatGone(e.id)
                notifyAgentChatsChanged()
            })
    }
    // Cerrar un chat que trabaja corta su turno: se pide confirmación. Uno quieto
    // se cierra en el acto (no pierde nada y se reabre desde «Recientes»).
    const askClose = (e: OpenEntry) => (e.state === 'working' || e.state === 'approval' ? setClosing(e) : closeChat(e))

    const deleteChat = (id: string) => {
        setDeleting(null)
        void DeleteAgentChat(id)
            .catch(() => {})
            .then(() => {
                notifyAiChatGone(id)
                notifyAgentChatsChanged()
            })
    }

    const rowMenu = (ev: React.MouseEvent, e: OpenEntry) => {
        const live = e.state === 'working' || e.state === 'approval'
        const items: TreeMenuEntry[] = [
            {label: ts.open, icon: 'open_in_new', title: e.state === 'interrupted' ? ts.openInterruptedTitle : ts.openTitle, onSelect: () => openChat(e)},
            {label: e.pinned ? ts.unpin : ts.pin, icon: 'push_pin', title: e.pinned ? ts.unpinTitle : ts.pinTitle, onSelect: () => togglePin(e)},
            {label: ts.rename, icon: 'edit', title: ts.renameTitle, onSelect: () => setRenaming({id: e.id, title: e.title})},
            ...(e.state === 'approval' && e.session
                ? [{label: ts.approve, icon: 'gpp_maybe', title: ts.approveTitle, onSelect: () => reviewApprovalOf(e.session!.sessionId)}]
                : []),
            ...(live ? [{label: ts.stop, icon: 'stop_circle', title: ts.stopTitle, onSelect: () => setStopping(e)}] : []),
            ...(e.state === 'unread' ? [{label: ts.markRead, icon: 'done_all', title: ts.markReadTitle, onSelect: () => markRead(e)}] : []),
            'separator',
            {label: ts.closeChat, icon: 'cancel_presentation', title: ts.closeChatTitle, danger: true, onSelect: () => askClose(e)},
            {label: ts.delete, icon: 'delete', title: ts.deleteTitle, danger: true, onSelect: () => setDeleting({id: e.id, title: e.title})},
        ]
        menu.openAt(ev, items)
    }

    // Con una búsqueda activa los grupos sin coincidencias no se muestran (el
    // «Nada coincide» repetido dos veces sería ruido) y los demás van abiertos.
    const showActive = !query || entries.length > 0
    const showRecent = !query || recent.length > 0
    const activeOpen = open.active || !!query
    const recentOpen = open.recent || !!query

    const renderRow = (e: OpenEntry) => (
        <OpenRow
            key={e.id}
            e={e}
            highlight={highlight === e.id || (!!e.session && highlight === e.session.sessionId)}
            provider={providerLabel(e.agentId, e.agentLabel)}
            project={projectOf(e.module, e.contextId)}
            onOpen={() => openChat(e)}
            onStop={() => setStopping(e)}
            onApprove={() => e.session && reviewApprovalOf(e.session.sessionId)}
            onMarkRead={() => markRead(e)}
            onPin={() => togglePin(e)}
            onClose={() => askClose(e)}
            onMenu={(ev) => rowMenu(ev, e)}
        />
    )

    return (
        <>
            {showActive && (
                <>
                    <div data-ai-group="active">
                        <TreeRow
                            depth={1}
                            icon="bolt"
                            iconClass={entries.length > 0 ? 'text-primary' : undefined}
                            label={ts.active}
                            labelClass="font-medium"
                            title={ts.activeHint}
                            expanded={activeOpen}
                            onToggle={() => toggle('active')}
                            onClick={() => toggle('active')}
                            trailing={<span className="font-mono text-ui-10 tabular-nums text-on-surface-variant/60">{entries.length}</span>}
                        />
                    </div>
                    {activeOpen &&
                        (entries.length === 0 ? (
                            <div className="ml-8 mr-2 pb-1.5 pt-0.5 text-ui-11 text-on-surface-variant">
                                <p>{ts.emptyActive}</p>
                                <p className="mt-0.5 opacity-70">{ts.emptyActiveHint}</p>
                            </div>
                        ) : (
                            <div data-ai-active className="ml-6 mr-1 flex flex-col">
                                {pinned.length > 0 && (
                                    <>
                                        <p data-ai-subgroup="pinned" title={ts.pinnedHint} className="flex items-center gap-1 px-2 pb-0.5 pt-1 text-ui-10 font-medium uppercase tracking-wide text-on-surface-variant">
                                            <Icon name="push_pin" size={11} filled />
                                            {ts.pinned}
                                            <span className="ml-auto font-mono tabular-nums opacity-60">{pinned.length}</span>
                                        </p>
                                        <ul data-ai-pinned className="flex flex-col">
                                            {pinned.map(renderRow)}
                                        </ul>
                                    </>
                                )}
                                {others.length > 0 && (
                                    <>
                                        {pinned.length > 0 && (
                                            <p data-ai-subgroup="others" className="px-2 pb-0.5 pt-2 text-ui-10 font-medium uppercase tracking-wide text-on-surface-variant">
                                                {ts.others}
                                                <span className="float-right font-mono tabular-nums opacity-60">{others.length}</span>
                                            </p>
                                        )}
                                        <ul data-ai-others className="flex flex-col">
                                            {others.map(renderRow)}
                                        </ul>
                                    </>
                                )}
                            </div>
                        ))}
                </>
            )}

            {showRecent && (
                <>
                    <div data-ai-group="recent">
                        <TreeRow
                            depth={1}
                            icon="history"
                            label={ts.recent}
                            labelClass="font-medium"
                            title={ts.recentHint}
                            expanded={recentOpen}
                            onToggle={() => toggle('recent')}
                            onClick={() => toggle('recent')}
                            trailing={<span className="font-mono text-ui-10 tabular-nums text-on-surface-variant/60">{recent.length}</span>}
                        />
                    </div>
                    {recentOpen &&
                        (recent.length === 0 ? (
                            <p className="ml-8 mr-2 pb-1.5 text-ui-11 text-on-surface-variant">{ts.emptyRecent}</p>
                        ) : (
                            <div data-ai-recent>
                                {recent.map((c) => {
                                    const kind = (c.module || 'none') as WorkContextKind
                                    const project = projectOf(c.module, c.contextId)
                                    return (
                                        <TreeRow
                                            key={c.id}
                                            depth={2}
                                            icon={agentIconName(c.agentId)}
                                            label={c.title || ts.untitled}
                                            title={ts.recentOpenTitle({title: c.title || ts.untitled})}
                                            onClick={() => requestOpenAiChat({chatId: c.id})}
                                            onContextMenu={(e) =>
                                                menu.openAt(e, [
                                                    {label: ts.open, icon: 'open_in_new', title: ts.openTitle, onSelect: () => requestOpenAiChat({chatId: c.id})},
                                                    {label: ts.rename, icon: 'edit', title: ts.renameTitle, onSelect: () => setRenaming({id: c.id, title: c.title})},
                                                    'separator',
                                                    {label: ts.delete, icon: 'delete', title: ts.deleteTitle, danger: true, onSelect: () => setDeleting({id: c.id, title: c.title})},
                                                ])
                                            }
                                            trailing={
                                                <span className="flex shrink-0 items-center gap-1 text-ui-10 text-on-surface-variant/70">
                                                    {kind !== 'utilities' && kind !== 'none' && <Icon name={CONTEXT_ICONS[kind]} size={11} />}
                                                    {project && kind === 'utilities' && <span className="max-w-16 truncate">{project}</span>}
                                                    <span className="tabular-nums">{formatDateTime(c.updatedAt, {day: 'numeric', month: 'short'})}</span>
                                                </span>
                                            }
                                        />
                                    )
                                })}
                            </div>
                        ))}
                </>
            )}
            {query && !showActive && !showRecent && <p className="ml-8 mr-2 pb-1.5 text-ui-11 text-on-surface-variant">{ts.noMatches({query: rawQuery})}</p>}

            {menu.element}
            {renaming && (
                <PromptDialog
                    title={t.utilities.aiChat.rename.title}
                    label={t.utilities.aiChat.rename.label}
                    initial={renaming.title}
                    confirmLabel={t.common.save}
                    description={t.utilities.aiChat.rename.description}
                    maxLength={MAX_CHAT_TITLE}
                    onSubmit={(value) => {
                        const id = renaming.id
                        setRenaming(null)
                        void renameChat(id, value)
                    }}
                    onClose={() => setRenaming(null)}
                />
            )}
            {closing && (
                <ConfirmDialog
                    title={ts.closeConfirm.title}
                    description={ts.closeConfirm.description({title: closing.title || ts.untitled})}
                    confirmLabel={ts.closeConfirm.confirm}
                    danger
                    onConfirm={() => closeChat(closing)}
                    onClose={() => setClosing(null)}
                />
            )}
            {stopping && (
                <ConfirmDialog
                    title={ts.stopConfirm.title}
                    description={ts.stopConfirm.description({title: stopping.title || ts.untitled})}
                    confirmLabel={ts.stopConfirm.confirm}
                    danger
                    onConfirm={() => stop(stopping)}
                    onClose={() => setStopping(null)}
                />
            )}
            {deleting && (
                <ConfirmDialog
                    title={ts.deleteConfirm.title}
                    description={ts.deleteConfirm.description({title: deleting.title || ts.untitled})}
                    confirmLabel={ts.deleteConfirm.confirm}
                    danger
                    onConfirm={() => deleteChat(deleting.id)}
                    onClose={() => setDeleting(null)}
                />
            )}
        </>
    )
}

const ACTION =
    'flex items-center gap-1 rounded-md px-1.5 py-0.5 text-ui-10 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary'

const TONE: Record<OpenState, {row: string; tint: string}> = {
    approval: {row: 'border-tertiary bg-tertiary/10', tint: 'text-tertiary'},
    error: {row: 'border-error bg-error-container/20', tint: 'text-error'},
    working: {row: 'border-primary bg-primary/5', tint: 'text-primary'},
    unread: {row: 'border-secondary bg-secondary/10', tint: 'text-secondary'},
    interrupted: {row: 'border-tertiary/60 bg-tertiary/5', tint: 'text-tertiary'},
    idle: {row: 'border-outline-variant bg-surface-container/40', tint: 'text-on-surface-variant'},
    cancelled: {row: 'border-outline-variant bg-surface-container/40', tint: 'text-on-surface-variant'},
    draft: {row: 'border-outline-variant border-dashed bg-surface-container/30', tint: 'text-on-surface-variant'},
}

function OpenRow({
    e,
    highlight,
    provider,
    project,
    onOpen,
    onStop,
    onApprove,
    onMarkRead,
    onPin,
    onClose,
    onMenu,
}: {
    e: OpenEntry
    highlight: boolean
    provider: string
    project: string
    onOpen: () => void
    onStop: () => void
    onApprove: () => void
    onMarkRead: () => void
    onPin: () => void
    onClose: () => void
    onMenu: (ev: React.MouseEvent) => void
}) {
    const t = useT()
    const ts = t.aiSessions.sidebar
    const s = e.session
    const live = e.state === 'working' || e.state === 'approval'
    const since = s ? toMillis(s.turnStartedAt) || toMillis(s.startedAt) : 0
    const tokens = s ? sessionTokens(s) : 0
    const tone = TONE[e.state]
    const statusLabel = e.state === 'idle' ? ts.idleRead : e.state === 'unread' ? ts.status.idle : e.state === 'working' ? ts.status.running : e.state === 'approval' ? ts.status.awaiting_approval : ts.status[e.state]
    const title = e.title || (e.state === 'draft' ? ts.draftTitle : ts.untitled)
    const lastText = s ? (s.status === 'error' ? s.error || s.lastText : s.lastText) : ''
    return (
        <li
            data-ai-session={e.id}
            data-state={e.state}
            data-status={s?.status}
            data-pinned={e.pinned ? '' : undefined}
            data-detached={s?.detached ? '' : undefined}
            onContextMenu={onMenu}
            className={`group/row relative border-l-2 ${tone.row} ${highlight ? 'shadow-[inset_0_0_0_2px_var(--color-primary)]' : ''}`}
        >
            <button
                type="button"
                onClick={onOpen}
                title={e.state === 'interrupted' ? ts.rowInterruptedTitle({title}) : ts.rowTitle({title})}
                className={`flex w-full min-w-0 items-start gap-2 px-2 pb-1 pt-2 text-left hover:bg-surface-container-high ${FOCUS}`}
            >
                <span className="mt-0.5 shrink-0" title={statusLabel}>
                    <StateIcon state={e.state} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-baseline gap-2">
                        {e.pinned && <Icon name="push_pin" size={11} filled className="shrink-0 -rotate-45 self-center text-primary" />}
                        <span className="min-w-0 flex-1 truncate pr-4 text-xs font-medium text-on-surface">{title}</span>
                        {live && since > 0 && (
                            <span title={ts.elapsedTitle} className="shrink-0 font-mono text-ui-10 text-on-surface-variant">
                                <Elapsed since={since} />
                            </span>
                        )}
                    </span>
                    <span className={`truncate text-ui-10 font-medium ${tone.tint}`}>
                        {statusLabel}
                        {!live && e.at > 0 && e.state !== 'draft' && (
                            <span className="font-normal text-on-surface-variant">
                                {' · '}
                                {formatDateTime(e.at, {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'})}
                            </span>
                        )}
                        {s?.detached && (
                            <span title={ts.backgroundTitle} className="font-normal text-on-surface-variant">
                                {' · '}
                                {ts.backgroundTag}
                            </span>
                        )}
                    </span>
                    <span className="flex min-w-0 items-center gap-1 text-ui-10 text-on-surface-variant">
                        <Icon name={agentIconName(e.agentId)} size={11} className="shrink-0 opacity-70" />
                        <span className="min-w-0 truncate">
                            {provider}
                            {e.model ? ` · ${e.model}` : ''}
                            {project ? ` · ${project}` : ''}
                        </span>
                    </span>
                    {lastText && (
                        <span className={`line-clamp-2 break-words text-ui-10 ${s?.status === 'error' ? 'text-error/90' : 'text-on-surface-variant/80'}`}>{lastText}</span>
                    )}
                    {tokens > 0 && (
                        <span title={ts.tokensTitle} className="font-mono text-ui-10 tabular-nums text-on-surface-variant/70">
                            {ts.tokens({n: formatNumber(tokens)})}
                        </span>
                    )}
                </span>
            </button>
            <div className="flex flex-wrap items-center gap-0.5 pb-1.5 pl-7 pr-2">
                {e.state === 'approval' && (
                    <button type="button" onClick={onApprove} title={ts.approveTitle} className={`${ACTION} font-medium text-tertiary hover:text-tertiary`}>
                        <Icon name="gpp_maybe" size={12} />
                        {ts.approve}
                    </button>
                )}
                <button type="button" onClick={onOpen} title={e.state === 'interrupted' ? ts.openInterruptedTitle : ts.openTitle} className={ACTION}>
                    <Icon name="open_in_new" size={12} />
                    {ts.open}
                </button>
                <button type="button" data-ai-row-pin onClick={onPin} title={e.pinned ? ts.unpinTitle : ts.pinTitle} aria-pressed={e.pinned} className={ACTION}>
                    <Icon name="push_pin" size={12} filled={e.pinned} />
                    {e.pinned ? ts.unpin : ts.pin}
                </button>
                {live && (
                    <button type="button" onClick={onStop} title={ts.stopTitle} className={`${ACTION} hover:text-error`}>
                        <Icon name="stop_circle" size={12} />
                        {ts.stop}
                    </button>
                )}
                {e.state === 'unread' && (
                    <button type="button" onClick={onMarkRead} title={ts.markReadTitle} className={ACTION}>
                        <Icon name="done_all" size={12} />
                        {ts.markRead}
                    </button>
                )}
                <button type="button" data-ai-row-menu onClick={onMenu} title={ts.moreTitle} aria-label={ts.more} aria-haspopup="menu" className={`${ACTION} ml-auto`}>
                    <Icon name="more_horiz" size={14} />
                </button>
            </div>
            {/* «Cerrar chat» a un clic: aparece al pasar el mouse (o al enfocar
                con el teclado) para no sumar un botón fijo a cada fila. */}
            <button
                type="button"
                data-ai-row-close
                onClick={onClose}
                title={ts.closeChatTitle}
                aria-label={ts.closeChat}
                className={`absolute right-1.5 top-1.5 rounded p-0.5 text-on-surface-variant opacity-0 hover:bg-surface-variant hover:text-error focus-visible:opacity-100 group-hover/row:opacity-100 ${FOCUS}`}
            >
                <Icon name="close" size={13} />
            </button>
        </li>
    )
}
