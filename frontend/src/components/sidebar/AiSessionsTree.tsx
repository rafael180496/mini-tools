import {useCallback, useEffect, useMemo, useState} from 'react'
import {CancelAgentChat, CloseAgentSession, GitListRepos, ListAgents, ListAgentWorkspaces, ListAllAgentChats, ListConnections, MarkAgentSessionRead} from '../../../wailsjs/go/main/App'
import {agents as agentsModel, vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import ConfirmDialog from '../ConfirmDialog'
import SidebarSection from './SidebarSection'
import TreeRow from './TreeRow'
import {useTreeMenu, type TreeMenuEntry} from './TreeMenu'
import {agentIconName} from '../agent/agentIcon'
import {CONTEXT_ICONS, type WorkContextKind} from '../agent/workContext'
import {
    activeEntries,
    hideSession,
    isLive,
    reviewApprovalOf,
    sessionTokens,
    toMillis,
    useAgentSessions,
    useHiddenSessions,
    type AgentSessionInfo,
} from '../../lib/agentSessions'
import {requestOpenAiChat} from '../../lib/appBus'
import {aiChatShortcuts} from '../../lib/aiChatTabs'
import {formatDateTime, formatNumber, useT} from '../../i18n'

// El cuerpo del módulo «IA» de la barra lateral.
//
// Dos listas con dos preguntas distintas:
//
//   Activas    «¿qué está haciendo la IA ahora, y qué me espera?». Las sesiones
//              que trabajan, las que piden permiso, las que fallaron y las que
//              terminaron sin que las vieras. Es la lista de trabajo de quien
//              lanza varias conversaciones y se va a otra cosa.
//   Recientes  «¿cuál era esa conversación?». Las últimas, de cualquier módulo y
//              proveedor, para abrirlas en una pestaña.
//
// Cada sesión activa tiene las salidas que importan: abrirla (retomar el turno
// donde va), detenerla, dejarla terminar sin verla, contestar su permiso o
// cerrarla de verdad. Todo lo que se hace acá es sobre la sesión, no sobre la
// pestaña: la sesión sigue en el backend aunque ninguna pestaña la muestre.
//
// **Detener no es Cerrar chat.** «Detener» corta el turno en curso y deja el
// chat abierto (sigue listado, se le puede escribir de nuevo). «Cerrar chat»
// corta lo que corra y da la conversación por terminada: sale de «Activas». La
// conversación guardada queda en «Recientes» en los dos casos. Un chat cuya
// pestaña se cerró queda acá, «en segundo plano», hasta que se lo cierre.

const RECENT_LIMIT = 20
const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary'
const WORKSPACE_PREFIX = 'ws:'

interface Props {
    // Búsqueda global de la barra: filtra por título, proveedor y proyecto.
    filter: string
    onMatchCount: (n: number | null) => void
    // El módulo está a la vista: es cuando se relee «Recientes».
    visible: boolean
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

function StatusIcon({status, read}: {status: AgentSessionInfo['status']; read?: boolean}) {
    if (status === 'cancelled') return <Icon name="stop_circle" size={16} className="text-on-surface-variant" />
    if (status === 'idle' && read) return <Icon name="forum" size={16} className="text-on-surface-variant" />
    if (status === 'running') {
        return <Icon name="progress_activity" size={16} className="animate-spin text-primary motion-reduce:animate-none" />
    }
    if (status === 'awaiting_approval') return <Icon name="gpp_maybe" size={16} filled className="text-tertiary" />
    if (status === 'error') return <Icon name="error" size={16} filled className="text-error" />
    return <Icon name="check_circle" size={16} filled className="text-secondary" />
}

export default function AiSessionsTree({filter, onMatchCount, visible}: Props) {
    const t = useT()
    const ts = t.aiSessions.sidebar
    const menu = useTreeMenu(288)
    const sessions = useAgentSessions()
    const hidden = useHiddenSessions()
    const query = filter.trim().toLowerCase()

    const [agentList, setAgentList] = useState<agentsModel.Agent[]>([])
    const [chats, setChats] = useState<vault.AgentChat[]>([])
    const [names, setNames] = useState<Record<string, string>>({})
    const [stopping, setStopping] = useState<AgentSessionInfo | null>(null)
    const [closing, setClosing] = useState<AgentSessionInfo | null>(null)

    const loadChats = useCallback(() => {
        ListAllAgentChats()
            .then((h) => setChats(h ?? []))
            .catch(() => setChats([]))
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

    // «Recientes» se relee cuando la lista de sesiones cambia de forma (empezó
    // o terminó una: sube en el historial) y al mostrarse el módulo.
    const shape = sessions.map((s) => `${s.sessionId}:${s.status}`).join('|')
    useEffect(() => {
        loadChats()
    }, [loadChats, shape])
    useEffect(() => {
        if (visible) {
            loadChats()
            loadNames()
        }
    }, [visible, loadChats, loadNames])

    const providerLabel = useCallback((agentId: string, fallback = '') => agentList.find((a) => a.id === agentId)?.label ?? (fallback || agentId.replace(/^llm:/, '')), [agentList])
    const projectOf = useCallback(
        (module: string, contextId: string) => {
            // Sin proyecto no se rotula: «Sin proyecto» en cada fila es ruido que
            // empuja afuera lo que sí identifica (el proveedor y el modelo).
            return contextId ? (names[contextId] ?? '') : ''
        },
        [names],
    )

    const matches = useCallback(
        (title: string, agentId: string, project: string) =>
            !query || `${title} ${providerLabel(agentId)} ${project}`.toLowerCase().includes(query),
        [query, providerLabel],
    )

    const active = useMemo(
        () =>
            activeEntries(sessions, hidden).filter((s) => matches(s.title, s.agentId, projectOf(s.module, s.contextId))),
        [sessions, hidden, matches, projectOf],
    )

    // Una conversación que ya está en «Activas» no se repite en «Recientes».
    const recent = useMemo(() => {
        const inActive = new Set(active.map((s) => s.chatId || s.sessionId))
        return chats
            .slice()
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .filter((c) => !inActive.has(c.id) && matches(c.title, c.agentId, projectOf(c.module, c.contextId)))
            .slice(0, RECENT_LIMIT)
    }, [chats, active, matches, projectOf])

    useEffect(() => {
        onMatchCount(query ? active.length + recent.length : null)
    }, [query, active.length, recent.length, onMatchCount])

    const open = (s: AgentSessionInfo) => requestOpenAiChat({chatId: s.chatId || s.sessionId})

    const stop = (s: AgentSessionInfo) => {
        setStopping(null)
        void CancelAgentChat(s.sessionId).catch(() => {})
    }

    // Un chat abierto en segundo plano sigue en la lista aunque se lo marque
    // leído: lo único que lo saca de «Activas» es cerrarlo.
    const markRead = (s: AgentSessionInfo) => {
        if (!s.detached) hideSession(s)
        void MarkAgentSessionRead(s.sessionId).catch(() => {})
    }

    const closeChat = (s: AgentSessionInfo) => {
        setClosing(null)
        void CloseAgentSession(s.sessionId).catch(() => {})
    }
    // Cerrar un chat que trabaja corta su turno: se pide confirmación. Uno quieto
    // se cierra en el acto (no pierde nada y se reabre desde «Recientes»).
    const askClose = (s: AgentSessionInfo) => (isLive(s) ? setClosing(s) : closeChat(s))

    const rowMenu = (e: React.MouseEvent, s: AgentSessionInfo) => {
        const live = isLive(s)
        const items: TreeMenuEntry[] = [
            {label: ts.open, icon: 'open_in_new', title: ts.openTitle, onSelect: () => open(s)},
            ...(s.status === 'awaiting_approval'
                ? [{label: ts.approve, icon: 'gpp_maybe', title: ts.approveTitle, onSelect: () => reviewApprovalOf(s.sessionId)}]
                : []),
            ...(live ? [{label: ts.stop, icon: 'stop_circle', title: ts.stopTitle, onSelect: () => setStopping(s)}] : []),
            ...(s.status === 'running' ? [{label: ts.letFinish, icon: 'visibility_off', title: ts.letFinishTitle, onSelect: () => hideSession(s)}] : []),
            ...(!live && s.unread ? [{label: ts.markRead, icon: 'done_all', title: ts.markReadTitle, onSelect: () => markRead(s)}] : []),
            'separator',
            {label: ts.closeChat, icon: 'cancel_presentation', title: ts.closeChatTitle, danger: true, onSelect: () => askClose(s)},
        ]
        menu.openAt(e, items)
    }

    return (
        <SidebarSection
            title={ts.title}
            count={query ? `${active.length + recent.length}` : null}
        >
            {/* Abrir otra conversación es una pestaña NUEVA, y el rótulo lo dice:
                con «Nueva conversación» a secas se leía como «borrar esta
                y empezar de cero». La ▾ ofrece además abrirla ya dividida. */}
            <div className="mx-2 mb-2 mt-1 flex items-stretch rounded-lg border border-outline-variant text-ui-11 text-on-surface">
                <button
                    type="button"
                    data-ai-new-chat
                    onClick={() => requestOpenAiChat({newWindow: true})}
                    title={ts.newChatTitle({shortcut: aiChatShortcuts().newTab})}
                    aria-label={ts.newChat}
                    className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-l-lg px-2 py-1.5 text-left hover:bg-surface-variant ${FOCUS}`}
                >
                    <Icon name="add" size={14} className="shrink-0 text-primary" />
                    <span className="min-w-0 flex-1 truncate">{ts.newChat}</span>
                </button>
                <button
                    type="button"
                    data-ai-new-menu
                    onClick={(e) => {
                        const k = aiChatShortcuts()
                        menu.openAt(e, [
                            {label: t.aiSessions.tabs.newInNewTab, icon: 'open_in_new', hint: k.newTab, title: ts.newChatTitle({shortcut: k.newTab}), onSelect: () => requestOpenAiChat({newWindow: true})},
                            {label: t.aiSessions.tabs.newSplitTab, icon: 'vertical_split', title: t.aiSessions.tabs.newSplitTabTitle, onSelect: () => requestOpenAiChat({newWindow: true, split: true})},
                        ])
                    }}
                    title={ts.newChatMoreTitle}
                    aria-label={ts.newChatMore}
                    aria-haspopup="menu"
                    className={`flex shrink-0 items-center rounded-r-lg border-l border-outline-variant px-0.5 hover:bg-surface-variant ${FOCUS}`}
                >
                    <Icon name="arrow_drop_down" size={16} />
                </button>
            </div>
            {menu.element}

            <h3 title={ts.activeHint} className="flex items-center gap-2 px-3 pb-1 pt-1 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant">
                {ts.active}
                <span className="font-normal normal-case tracking-normal opacity-60">{active.length}</span>
            </h3>

            {active.length === 0 ? (
                <div className="px-3 pb-2 text-ui-11 text-on-surface-variant">
                    <p>{query ? ts.noMatches({query: filter.trim()}) : ts.emptyActive}</p>
                    {!query && <p className="mt-0.5 opacity-70">{ts.emptyActiveHint}</p>}
                </div>
            ) : (
                <ul data-ai-active className="flex flex-col">
                    {active.map((s) => (
                        <ActiveRow
                            key={s.sessionId}
                            s={s}
                            provider={providerLabel(s.agentId, s.agentLabel)}
                            project={projectOf(s.module, s.contextId)}
                            onOpen={() => open(s)}
                            onStop={() => setStopping(s)}
                            onLetFinish={() => hideSession(s)}
                            onApprove={() => reviewApprovalOf(s.sessionId)}
                            onMarkRead={() => markRead(s)}
                            onClose={() => askClose(s)}
                            onMenu={(e) => rowMenu(e, s)}
                        />
                    ))}
                </ul>
            )}

            <h3 title={ts.recentHint} className="mt-2 flex items-center gap-2 px-3 pb-1 pt-1 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant">
                {ts.recent}
                <span className="font-normal normal-case tracking-normal opacity-60">{recent.length}</span>
            </h3>
            {recent.length === 0 ? (
                <p className="px-3 pb-2 text-ui-11 text-on-surface-variant">{query ? ts.noMatches({query: filter.trim()}) : ts.emptyRecent}</p>
            ) : (
                <div data-ai-recent>
                    {recent.map((c) => {
                        const kind = (c.module || 'none') as WorkContextKind
                        const project = projectOf(c.module, c.contextId)
                        return (
                            <TreeRow
                                key={c.id}
                                depth={0}
                                icon={agentIconName(c.agentId)}
                                label={c.title || ts.untitled}
                                title={ts.recentOpenTitle({title: c.title || ts.untitled})}
                                onClick={() => requestOpenAiChat({chatId: c.id})}
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
        </SidebarSection>
    )
}

const ACTION =
    'flex items-center gap-1 rounded-md px-1.5 py-0.5 text-ui-10 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary'

function ActiveRow({
    s,
    provider,
    project,
    onOpen,
    onStop,
    onLetFinish,
    onApprove,
    onMarkRead,
    onClose,
    onMenu,
}: {
    s: AgentSessionInfo
    provider: string
    project: string
    onOpen: () => void
    onStop: () => void
    onLetFinish: () => void
    onApprove: () => void
    onMarkRead: () => void
    onClose: () => void
    onMenu: (e: React.MouseEvent) => void
}) {
    const t = useT()
    const ts = t.aiSessions.sidebar
    const live = s.status === 'running' || s.status === 'awaiting_approval'
    const since = toMillis(s.turnStartedAt) || toMillis(s.startedAt)
    const tokens = sessionTokens(s)
    // Terminó y ya la viste: solo sigue abierta en segundo plano.
    const idleRead = s.status === 'idle' && !s.unread
    const quiet = idleRead || s.status === 'cancelled'
    const tone =
        s.status === 'awaiting_approval'
            ? 'border-tertiary bg-tertiary/10'
            : s.status === 'error'
              ? 'border-error bg-error-container/20'
              : quiet
                ? 'border-outline-variant bg-surface-container/40'
                : s.status === 'idle'
                  ? 'border-secondary bg-secondary/10'
                  : 'border-primary bg-primary/5'
    const statusColor =
        s.status === 'awaiting_approval' ? 'text-tertiary' : s.status === 'error' ? 'text-error' : quiet ? 'text-on-surface-variant' : s.status === 'idle' ? 'text-secondary' : 'text-primary'
    const statusLabel = idleRead ? ts.idleRead : ts.status[s.status]
    const title = s.title || ts.untitled
    return (
        <li
            data-ai-session={s.sessionId}
            data-status={s.status}
            data-detached={s.detached ? '' : undefined}
            onContextMenu={onMenu}
            className={`group/row relative border-l-2 ${tone}`}
        >
            <button
                type="button"
                onClick={onOpen}
                title={ts.rowTitle({title})}
                className={`flex w-full min-w-0 items-start gap-2 px-3 pb-1 pt-2 text-left hover:bg-surface-container-high ${FOCUS}`}
            >
                <span className="mt-0.5 shrink-0" title={statusLabel}>
                    <StatusIcon status={s.status} read={idleRead} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate pr-4 text-xs font-medium text-on-surface">{title}</span>
                        {live && since > 0 && (
                            <span title={ts.elapsedTitle} className="shrink-0 font-mono text-ui-10 text-on-surface-variant">
                                <Elapsed since={since} />
                            </span>
                        )}
                    </span>
                    <span className={`truncate text-ui-10 font-medium ${statusColor}`}>
                        {statusLabel}
                        {s.detached && (
                            <span title={ts.backgroundTitle} className="font-normal text-on-surface-variant">
                                {' · '}
                                {ts.backgroundTag}
                            </span>
                        )}
                    </span>
                    <span className="flex min-w-0 items-center gap-1 text-ui-10 text-on-surface-variant">
                        <Icon name={agentIconName(s.agentId)} size={11} className="shrink-0 opacity-70" />
                        <span className="min-w-0 truncate">
                            {provider}
                            {s.model ? ` · ${s.model}` : ''}
                            {project ? ` · ${project}` : ''}
                        </span>
                    </span>
                    {(s.status === 'error' ? s.error || s.lastText : s.lastText) && (
                        <span className={`line-clamp-2 break-words text-ui-10 ${s.status === 'error' ? 'text-error/90' : 'text-on-surface-variant/80'}`}>
                            {s.status === 'error' ? s.error || s.lastText : s.lastText}
                        </span>
                    )}
                    {tokens > 0 && (
                        <span title={ts.tokensTitle} className="font-mono text-ui-10 tabular-nums text-on-surface-variant/70">
                            {ts.tokens({n: formatNumber(tokens)})}
                        </span>
                    )}
                </span>
            </button>
            <div className="flex flex-wrap items-center gap-0.5 pb-1.5 pl-8 pr-2">
                {s.status === 'awaiting_approval' && (
                    <button type="button" onClick={onApprove} title={ts.approveTitle} className={`${ACTION} font-medium text-tertiary hover:text-tertiary`}>
                        <Icon name="gpp_maybe" size={12} />
                        {ts.approve}
                    </button>
                )}
                <button type="button" onClick={onOpen} title={ts.openTitle} className={ACTION}>
                    <Icon name="open_in_new" size={12} />
                    {ts.open}
                </button>
                {live && (
                    <button type="button" onClick={onStop} title={ts.stopTitle} className={`${ACTION} hover:text-error`}>
                        <Icon name="stop_circle" size={12} />
                        {ts.stop}
                    </button>
                )}
                {s.status === 'running' && (
                    <button type="button" onClick={onLetFinish} title={ts.letFinishTitle} className={ACTION}>
                        <Icon name="visibility_off" size={12} />
                        {ts.letFinish}
                    </button>
                )}
                {!live && s.unread && (
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
