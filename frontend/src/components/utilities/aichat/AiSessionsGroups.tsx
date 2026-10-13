import {useCallback, useEffect, useMemo, useState} from 'react'
import {CancelAgentChat, CloseAgentSession, GitListRepos, ListAgents, ListAgentWorkspaces, ListAllAgentChats, ListConnections, MarkAgentSessionRead} from '../../../../wailsjs/go/main/App'
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
import {requestOpenAiChat} from '../../../lib/appBus'
import {MAX_CHAT_TITLE} from '../../../lib/chatTitle'
import {renameChat} from '../../../lib/chatRename'
import {formatDateTime, formatNumber, useT} from '../../../i18n'

// Las sesiones de IA, colgando de la fila «Chat de IA» de Utilidades.
//
// Antes eran un módulo propio de la barra lateral; ahora son los dos grupos que
// despliega esa fila, después de las pestañas de chat abiertas. Una IA con su
// propio módulo en la barra de módulos competía con las herramientas que la
// rodean: todo lo de la IA vive donde ya vivía el Chat.
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
//
// Está partido en un hook (los datos, que UtilitiesTree necesita ANTES de
// decidir si muestra la fila: una búsqueda puede coincidir sólo con una
// sesión) y un componente (los dos grupos).

const RECENT_LIMIT = 20
const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary'
const WORKSPACE_PREFIX = 'ws:'
const GROUPS_KEY = 'mini-tools:ai-groups-open'
// Cuánto se resalta la fila a la que lleva un aviso.
const HIGHLIGHT_MS = 2600

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

export interface AiSessionsData {
    // Hay una búsqueda activa (y entonces los grupos se muestran abiertos).
    query: string
    rawQuery: string
    active: AgentSessionInfo[]
    recent: vault.AgentChat[]
    // Cuántas trabajan y cuántas esperan una decisión: lo que dicen las
    // insignias de la fila y del módulo.
    attention: {running: number; approval: number}
    providerLabel: (agentId: string, fallback?: string) => string
    projectOf: (module: string, contextId: string) => string
}

export function useAiSessionsData(filter: string, visible: boolean): AiSessionsData {
    const sessions = useAgentSessions()
    const hidden = useHiddenSessions()
    const query = filter.trim().toLowerCase()

    const [agentList, setAgentList] = useState<agentsModel.Agent[]>([])
    const [chats, setChats] = useState<vault.AgentChat[]>([])
    const [names, setNames] = useState<Record<string, string>>({})

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
    // Sin proyecto no se rotula: «Sin proyecto» en cada fila es ruido que
    // empuja afuera lo que sí identifica (el proveedor y el modelo).
    const projectOf = useCallback((_module: string, contextId: string) => (contextId ? (names[contextId] ?? '') : ''), [names])

    const matches = useCallback(
        (title: string, agentId: string, project: string) => !query || `${title} ${providerLabel(agentId)} ${project}`.toLowerCase().includes(query),
        [query, providerLabel],
    )

    const active = useMemo(
        () => activeEntries(sessions, hidden).filter((s) => matches(s.title, s.agentId, projectOf(s.module, s.contextId))),
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

    const attention = useMemo(() => attentionCount(sessions, hidden), [sessions, hidden])

    return {query, rawQuery: filter.trim(), active, recent, attention, providerLabel, projectOf}
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
    // Pedido de mostrar una sesión (el aviso «Ver»): abre «Activas», lleva la
    // fila a la vista y la resalta un momento.
    reveal: AiRevealRequest | null
    onRevealed: () => void
}

export default function AiSessionsGroups({data, reveal, onRevealed}: GroupsProps) {
    const t = useT()
    const ts = t.aiSessions.sidebar
    const menu = useTreeMenu(288)
    const {query, rawQuery, active, recent, providerLabel, projectOf} = data

    const [open, setOpen] = useState(readGroups)
    const [stopping, setStopping] = useState<AgentSessionInfo | null>(null)
    const [closing, setClosing] = useState<AgentSessionInfo | null>(null)
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
    // «Activas» (la fila todavía no existe en el DOM), después —ya pintada—
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

    const openChat = (s: AgentSessionInfo) => requestOpenAiChat({chatId: s.chatId || s.sessionId})

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
            {label: ts.open, icon: 'open_in_new', title: ts.openTitle, onSelect: () => openChat(s)},
            {label: ts.rename, icon: 'edit', title: ts.renameTitle, onSelect: () => setRenaming({id: s.chatId || s.sessionId, title: s.title})},
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

    // Con una búsqueda activa los grupos sin coincidencias no se muestran (el
    // «Nada coincide» repetido dos veces sería ruido) y los demás van abiertos.
    const showActive = !query || active.length > 0
    const showRecent = !query || recent.length > 0
    const activeOpen = open.active || !!query
    const recentOpen = open.recent || !!query

    return (
        <>
            {showActive && (
                <>
                    <div data-ai-group="active">
                        <TreeRow
                            depth={1}
                            icon="bolt"
                            iconClass={active.length > 0 ? 'text-primary' : undefined}
                            label={ts.active}
                            labelClass="font-medium"
                            title={ts.activeHint}
                            expanded={activeOpen}
                            onToggle={() => toggle('active')}
                            onClick={() => toggle('active')}
                            trailing={<span className="font-mono text-ui-10 tabular-nums text-on-surface-variant/60">{active.length}</span>}
                        />
                    </div>
                    {activeOpen &&
                        (active.length === 0 ? (
                            <div className="ml-8 mr-2 pb-1.5 pt-0.5 text-ui-11 text-on-surface-variant">
                                <p>{ts.emptyActive}</p>
                                <p className="mt-0.5 opacity-70">{ts.emptyActiveHint}</p>
                            </div>
                        ) : (
                            <ul data-ai-active className="ml-6 mr-1 flex flex-col">
                                {active.map((s) => (
                                    <ActiveRow
                                        key={s.sessionId}
                                        s={s}
                                        highlight={highlight === s.sessionId}
                                        provider={providerLabel(s.agentId, s.agentLabel)}
                                        project={projectOf(s.module, s.contextId)}
                                        onOpen={() => openChat(s)}
                                        onStop={() => setStopping(s)}
                                        onLetFinish={() => hideSession(s)}
                                        onApprove={() => reviewApprovalOf(s.sessionId)}
                                        onMarkRead={() => markRead(s)}
                                        onClose={() => askClose(s)}
                                        onMenu={(e) => rowMenu(e, s)}
                                    />
                                ))}
                            </ul>
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
        </>
    )
}

const ACTION =
    'flex items-center gap-1 rounded-md px-1.5 py-0.5 text-ui-10 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary'

function ActiveRow({
    s,
    highlight,
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
    highlight: boolean
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
            className={`group/row relative border-l-2 ${tone} ${highlight ? 'shadow-[inset_0_0_0_2px_var(--color-primary)]' : ''}`}
        >
            <button
                type="button"
                onClick={onOpen}
                title={ts.rowTitle({title})}
                className={`flex w-full min-w-0 items-start gap-2 px-2 pb-1 pt-2 text-left hover:bg-surface-container-high ${FOCUS}`}
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
            <div className="flex flex-wrap items-center gap-0.5 pb-1.5 pl-7 pr-2">
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
