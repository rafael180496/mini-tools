import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {
    AddAgentWorkspace,
    AgentActive,
    AgentModelCatalog,
    CancelAgentChat,
    CloseAgentSession,
    CreateAgentChatDraft,
    DeleteAgentChat,
    GitListRepos,
    ListAgents,
    ListAgentWorkspaces,
    ListAllAgentChats,
    ListConnections,
    ListModelServers,
    ListOpenAgentChats,
    PickAgentWorkspaceFolder,
    ResumeAgentChat,
    SetAgentChatContext,
    SetAgentChatDraftAgent,
    SetAgentChatOpen,
    TouchAgentChat,
} from '../../../wailsjs/go/main/App'
import {agentmodels, agents as agentsModel, main, vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import Select, {type SelectOption} from '../Select'
import ResizeHandle from '../ResizeHandle'
import ModelServerDialog from '../ModelServerDialog'
import ConfirmDialog from '../ConfirmDialog'
import PromptDialog from '../git/PromptDialog'
import AgentChat from '../agent/AgentChat'
import AgentUsagePanel from '../agent/AgentUsagePanel'
import {agentIconName} from '../agent/agentIcon'
import {HealthBadge, ProviderIconWithHealth} from '../agent/HealthIndicators'
import {isModelServerAgent} from '../../lib/modelServers'
import {useModelServerHealth, useModelServersHealth} from '../../lib/modelServerHealth'
import {CONTEXT_ICONS, describeContext, type WorkContext, type WorkContextKind} from '../agent/workContext'
import {errorText, useT} from '../../i18n'
import {notifyAgentChatsChanged, onAgentChatsChanged, onAiChatGone, onModelServersChanged, onRenameAiChatTabRequest, requestOpenAiChat} from '../../lib/appBus'
import {chatTitleFromMessage, cleanChatTitle, MAX_CHAT_TITLE} from '../../lib/chatTitle'
import {renameChat} from '../../lib/chatRename'
import InlineRename from '../InlineRename'
import {aiChatShortcuts, claimChat, clearPane, paneOwningChat, setPaneChats} from '../../lib/aiChatTabs'
import {useTreeMenu} from '../sidebar/TreeMenu'
import {useElementWidth} from '../../hooks/useElementWidth'
import AiChatHistory from './aichat/AiChatHistory'
import ProjectContextBar from './aichat/ProjectContextBar'
import ManageFoldersDialog from './aichat/ManageFoldersDialog'
import {LostProviderBar, SwitchedBar} from './aichat/ProviderSwitchBars'
import {persistChatAgent} from '../../lib/chatAgentSwitch'
import {onModelsChangedFor} from '../../lib/modelsChanged'
import {
    CHAT_MIN,
    COMPACT_BELOW,
    HISTORY_WIDTH_DEFAULT,
    HISTORY_WIDTH_MAX,
    HISTORY_WIDTH_MIN,
    LABEL_NEW_TAB_FROM,
    LABEL_SPLIT_FROM,
    NARROW_BELOW,
    readHistoryOpen,
    readHistoryWidth,
    writeHistoryOpen,
    writeHistoryWidth,
} from './aichat/layoutPrefs'

// Chat de IA: una pestaña de Utilidades con el chat a pantalla completa.
//
//   izquierda   historial de TODAS las conversaciones (de cualquier módulo y
//               proveedor), con buscador, filtro por proveedor y fechas.
//               Su ancho se arrastra (como la barra lateral) y se recuerda
//   centro      el mismo `AgentChat` de los demás módulos (módulo «utilities»),
//               a TODO el ancho que le quede a la pestaña
//   cabecera    proveedor + modelo + proyecto de trabajo (un repositorio git o
//               cualquier carpeta que se le haya dado a la app)
//   franja      bajo la cabecera, lo que la app lee sola del proyecto: archivos de
//               instrucciones (AGENTS.md, CLAUDE.md…) y skills
//
// **Se adapta al ancho de la pestaña, no al de la ventana.** La pestaña puede
// quedar angosta con la ventana enorme (barra lateral abierta, panel del agente
// acoplado al costado), así que se mide el propio contenedor con un
// ResizeObserver. Por debajo de NARROW_BELOW el historial deja de ocupar una
// columna y pasa a un cajón que se abre sobre el chat; por debajo de
// COMPACT_BELOW la cabecera se compacta. Ambas cosas se DERIVAN del ancho
// medido: la preferencia del usuario (historial abierto o cerrado) no se pisa,
// de modo que al volver a ensanchar la pestaña el historial reaparece solo.
//
// **Persistente.** Una conversación existe en el vault desde que se la crea (con
// su proveedor, modelo y proyecto), no desde el primer mensaje: cerrar la
// pestaña, o la app, no la pierde, y sigue en Chat de IA → Abiertas hasta que se
// la cierre o se la elimine. Una conversación sin mensajes es un «borrador»
// (`fresh`); hay a lo sumo uno por panel, y un panel nuevo adopta uno suelto en
// vez de crear otro, para que abrir y cerrar pestañas no llene la lista de
// borradores vacíos.
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
// Valor de la opción de cierre del selector de proveedor. No es un agente: al
// elegirla se abre el diálogo de alta y el proveedor elegido no cambia.
const ADD_SERVER = '__add_model_server__'
// Valores de las dos acciones del final del selector de proyecto. Como ADD_SERVER,
// no son un proyecto: al elegirlas no cambia el proyecto de la conversación.
const OPEN_FOLDER = '__open_folder__'
const MANAGE_FOLDERS = '__manage_folders__'
// Id de contexto de una carpeta: `ws:<id>`. Un repositorio git va con su id a secas.
const WORKSPACE_PREFIX = 'ws:'

const baseName = (path: string) => path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path

interface Session {
    id: string
    agentId: string
    agentLabel: string
    // Entrada del historial en el vault. Existe desde que se crea la
    // conversación (es el mismo id que `id`), aunque todavía no tenga mensajes.
    chatId: string
    // Todavía sin mensajes: un borrador.
    fresh?: boolean
    context: WorkContext
    resumeConversationId?: string
    resumeChatId?: string
    initialSettings?: {model: string; effort: string; mode: string; brain?: boolean}
    // El modelo vive acá y no dentro de AgentChat: la cabecera lo elige.
    model: string
    // El proveedor de esta conversación ya no está disponible (apagado o
    // eliminado): se abre para leerla y seguir con otro proveedor de modelos.
    lost?: boolean
}

const newSessionId = () => `agent-chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

// Pedido de abrir una conversación en este panel. El `token` hace que pedir dos
// veces la misma vuelva a llevar a ella (igual que el seed del chat).
export interface AiChatOpenRequest {
    chatId: string
    token: number
    // Además de `chatId` (la que queda a la vista): las otras conversaciones del
    // panel, al reabrir una pestaña guardada.
    chatIds?: string[]
}

interface Props {
    // La pestaña está a la vista. Oculta sigue montada (para no perder las
    // conversaciones ni un turno en curso), pero no atiende atajos.
    visible: boolean
    // Id de este panel (el de su pestaña, o ese con `#b` si es el segundo de una
    // pestaña dividida). Es la clave con la que el panel declara qué
    // conversaciones tiene abiertas (lib/aiChatTabs).
    paneId: string
    // Conversación que hay que abrir apenas se pueda (lo pide la barra lateral
    // «IA», el historial de otra pestaña o el atajo de nueva ventana).
    openRequest?: AiChatOpenRequest | null
    // Cómo se llama lo que muestra el panel: el título de la conversación, o el
    // proyecto. La pestaña lo usa de rótulo. Sólo lo informa el primer panel.
    onTitleChange?: (title: string) => void
    // Pestaña dividida en dos paneles: el primero ofrece dividir/juntar, el
    // segundo se cierra a sí mismo.
    split?: boolean
    secondary?: boolean
    onToggleSplit?: () => void
    // Atiende los atajos de teclado (Cmd/Ctrl+N). En una pestaña dividida lo
    // hace sólo el panel donde está el foco, no los dos a la vez.
    shortcutsEnabled?: boolean
}

export default function AiChatTab({visible, paneId, openRequest, onTitleChange, split = false, secondary = false, onToggleSplit, shortcutsEnabled = true}: Props) {
    const t = useT()
    const ta = t.utilities.aiChat
    const rootRef = useRef<HTMLDivElement>(null)
    const headerRef = useRef<HTMLElement>(null)
    const newMenu = useTreeMenu(288)

    const [agentList, setAgentList] = useState<agentsModel.Agent[]>([])
    const [agentsLoaded, setAgentsLoaded] = useState(false)
    const [defaultAgentId, setDefaultAgentId] = useState('')
    // Proveedores de modelos guardados (aunque estén apagados), por id de agente: el
    // catálogo de agentes solo trae los activos, y para rotular una conversación de
    // uno apagado hace falta saber cómo se llama.
    const [providerInfo, setProviderInfo] = useState<Record<string, {name: string; enabled: boolean}>>({})
    // Último cambio de proveedor hecho en una conversación abierta.
    const [switchNote, setSwitchNote] = useState<{sessionId: string; from: string; to: string} | null>(null)
    const [repos, setRepos] = useState<vault.GitRepo[]>([])
    // Carpetas a las que el usuario le dio acceso a la app (no son repos git).
    const [workspaces, setWorkspaces] = useState<main.AgentWorkspace[]>([])
    const [manageFolders, setManageFolders] = useState(false)
    // Los repos y las carpetas ya se leyeron (evita marcar «quitada» una carpeta
    // que solo todavía no llegó).
    const [projectsLoaded, setProjectsLoaded] = useState(false)
    // Por qué no se pudo abrir una carpeta (la raíz del disco, el home…).
    const [projectError, setProjectError] = useState('')
    const [history, setHistory] = useState<vault.AgentChat[]>([])
    const [resourceNames, setResourceNames] = useState<Record<string, string>>({})
    const [sessions, setSessions] = useState<Session[]>([])
    const [currentId, setCurrentId] = useState('')
    // Preferencia del usuario (columna abierta o cerrada) y ancho arrastrado.
    const [historyOpen, setHistoryOpen] = useState(readHistoryOpen)
    const [historyWidth, setHistoryWidth] = useState(readHistoryWidth)
    // Cajón del historial, solo en una pestaña angosta.
    const [drawerOpen, setDrawerOpen] = useState(false)
    const [serverDialog, setServerDialog] = useState(false)
    // Qué ocupa el cuerpo: el chat o el panel de consumo. Las conversaciones se
    // ESCONDEN, no se desmontan: tienen adentro turnos en curso y lo que se
    // esté escribiendo (mismo criterio que AgentChatHost).
    const [body, setBody] = useState<'chat' | 'usage'>('chat')
    const [sessionUsage, setSessionUsage] = useState({total: 0, output: 0, cost: 0})
    // Servidor recién guardado, a elegir apenas aparezca en el catálogo.
    const [pendingProvider, setPendingProvider] = useState('')
    const rootWidth = useElementWidth(rootRef)
    // La cabecera se mide aparte: con el historial en columna le queda mucho menos
    // que a la pestaña. Los rótulos de «Nueva pestaña» y «Dividir» aparecen sólo
    // cuando caben sin partir el renglón; sin ellos quedan los íconos con su
    // tooltip, y el menú de «Nuevo chat ▾» siempre dice las tres opciones con texto.
    const headerWidth = useElementWidth(headerRef)
    // 0 = todavía sin medir: no se asume angosto.
    const narrow = rootWidth > 0 && rootWidth < NARROW_BELOW
    const compact = rootWidth > 0 && rootWidth < COMPACT_BELOW
    const labelNewTab = !compact && headerWidth >= LABEL_NEW_TAB_FROM
    const labelSplit = !compact && headerWidth >= LABEL_SPLIT_FROM
    const inlineHistory = historyOpen && !narrow
    // El historial nunca le deja al chat menos de CHAT_MIN.
    const historyMax = rootWidth > 0 ? Math.max(HISTORY_WIDTH_MIN, Math.min(HISTORY_WIDTH_MAX, rootWidth - CHAT_MIN)) : HISTORY_WIDTH_MAX
    const historyShown = Math.min(historyMax, Math.max(HISTORY_WIDTH_MIN, historyWidth))
    const [renaming, setRenaming] = useState<vault.AgentChat | null>(null)
    const [deleting, setDeleting] = useState<vault.AgentChat | null>(null)
    // «Cerrar chat» pendiente de confirmar (solo se pregunta si está trabajando).
    const [closingChat, setClosingChat] = useState<Session | null>(null)
    const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
    const [catalog, setCatalog] = useState<agentmodels.Catalog | null>(null)
    // Sube cuando cambian los modelos del servidor elegido: relee el catálogo.
    const [catalogTick, setCatalogTick] = useState(0)

    // Sube cuando termina un pedido de apertura (con o sin resultado): reabre la
    // decisión de crear el borrador inicial.
    const [openSettled, setOpenSettled] = useState(0)
    const sessionsRef = useRef(sessions)
    sessionsRef.current = sessions
    // El alta de cada conversación nueva, por sesión, con su promesa: lo que se
    // le haga enseguida (renombrarla, cambiar su proveedor, guardar el id de
    // conversación del CLI) es un UPDATE sobre la fila que ese INSERT está
    // creando, y sin encadenarlos el UPDATE que gana la carrera no afecta ninguna
    // fila.
    const creationsRef = useRef<Map<string, Promise<unknown>>>(new Map())
    const afterCreation = useCallback((id: string) => creationsRef.current.get(id) ?? Promise.resolve(), [])
    // La cabecera está editando el nombre de la conversación a la vista.
    const [editingTitle, setEditingTitle] = useState(false)

    const available = useMemo(() => agentList.filter((a) => a.available), [agentList])
    const current = useMemo(() => sessions.find((s) => s.id === currentId) ?? null, [sessions, currentId])

    // Qué conversaciones tiene abiertas este panel, y cuál está a la vista, para
    // que ninguna se abra también en otro, para que la barra de pestañas y la
    // lateral sepan cuál de ellas está trabajando y para reabrir la pestaña tal
    // cual estaba. Los borradores cuentan: ya son conversaciones de alguien.
    const openIdsKey = sessions.map((s) => s.id).join('|')
    useEffect(() => {
        setPaneChats(paneId, openIdsKey ? openIdsKey.split('|') : [], currentId)
    }, [paneId, openIdsKey, currentId])
    useEffect(() => () => clearPane(paneId), [paneId])

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
        Promise.all([ListConnections().catch(() => []), GitListRepos().catch(() => []), ListAgentWorkspaces().catch(() => [])])
            .then(([conns, rs, ws]) => {
                const map: Record<string, string> = {}
                for (const c of conns ?? []) map[c.id] = c.name
                for (const r of rs ?? []) map[r.id] = r.name
                for (const w of ws ?? []) map[WORKSPACE_PREFIX + w.id] = w.name
                setResourceNames(map)
                setRepos(rs ?? [])
                setWorkspaces(ws ?? [])
                setProjectsLoaded(true)
            })
            .catch(() => {})
    }, [])

    // El catálogo de agentes se relee cuando cambia la lista de servidores de
    // modelos (alta desde acá, desde Configuración o desde el panel lateral).
    const refreshAgents = useCallback(() => {
        ListModelServers()
            .then((l) => setProviderInfo(Object.fromEntries((l ?? []).map((x) => [`llm:${x.id}`, {name: x.name, enabled: x.enabled}]))))
            .catch(() => setProviderInfo({}))
        ListAgents()
            .then((l) => setAgentList(l ?? []))
            .catch(() => setAgentList([]))
            .finally(() => setAgentsLoaded(true))
    }, [])

    useEffect(() => onModelServersChanged(refreshAgents), [refreshAgents])

    useEffect(() => {
        refreshAgents()
        AgentActive()
            .then((a) => setDefaultAgentId(a?.id ?? ''))
            .catch(() => {})
        loadHistory()
        loadNames()
    }, [refreshAgents, loadHistory, loadNames])

    // Al volver a la pestaña se relee el historial: otro módulo (el chat lateral)
    // pudo haber agregado o borrado conversaciones mientras estaba oculta.
    useEffect(() => {
        if (visible) {
            loadHistory()
            loadNames()
        }
    }, [visible, loadHistory, loadNames])

    // Una carpeta se mueve o se desmonta con la app abierta: al volver a la
    // ventana se vuelve a comprobar cuáles existen.
    useEffect(() => {
        if (!visible) return
        window.addEventListener('focus', loadNames)
        return () => window.removeEventListener('focus', loadNames)
    }, [visible, loadNames])

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
    }, [currentAgentId, catalogTick])

    // Se bajó o se borró un modelo en «Modelos»: el selector relee la lista de
    // ESTE servidor sin esperar a que se cambie de proveedor.
    useEffect(() => onModelsChangedFor(currentAgentId, () => setCatalogTick((n) => n + 1)), [currentAgentId])

    // El cajón solo existe en una pestaña angosta; Esc lo cierra.
    useEffect(() => {
        if (!narrow) setDrawerOpen(false)
    }, [narrow])
    useEffect(() => {
        if (!drawerOpen || !visible) return
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setDrawerOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [drawerOpen, visible])

    // --- Sesiones ----------------------------------------------------------

    // Cómo se llama un proveedor de modelos que ya no está entre los disponibles:
    // por su nombre si sigue guardado pero apagado; sin nombre si se eliminó.
    const lostLabel = useCallback(
        (agentId: string) => {
            const info = providerInfo[agentId]
            return info ? (info.enabled ? info.name : ta.lost.disabledName({name: info.name})) : ta.lost.removedName
        },
        [providerInfo, ta],
    )
    // Rótulo de cada proveedor de modelos perdido que aparece en el historial.
    const lostLabels = useMemo(() => {
        const out: Record<string, string> = {}
        for (const c of history) if (isModelServerAgent(c.agentId) && !agentList.some((a) => a.id === c.agentId)) out[c.agentId] = lostLabel(c.agentId)
        return out
    }, [history, agentList, lostLabel])

    // Nombre del proyecto de trabajo: el de un repositorio o el de una carpeta.
    const projectName = useCallback(
        (id: string) =>
            repos.find((r) => r.id === id)?.name ??
            workspaces.find((w) => WORKSPACE_PREFIX + w.id === id)?.name ??
            resourceNames[id] ??
            '',
        [repos, workspaces, resourceNames],
    )

    // Rótulo de la pestaña: el nombre de la conversación a la vista o, si todavía
    // no lo tiene (un borrador), el proyecto elegido y, sin ninguno de los dos,
    // «Nuevo chat». Una pestaña no tiene nombre propio: renombrarla es renombrar
    // su conversación (renameSession).
    const onTitleChangeRef = useRef(onTitleChange)
    onTitleChangeRef.current = onTitleChange
    const convTitle = current ? history.find((c) => c.id === current.chatId)?.title || '' : ''
    const tabTitle = convTitle || current?.context.label || t.aiSessions.tabs.draftTitle
    useEffect(() => {
        onTitleChangeRef.current?.(tabTitle)
    }, [tabTitle])

    const utilitiesContext = useCallback(
        (projectId: string): WorkContext => ({kind: 'utilities', id: projectId, label: projectId ? projectName(projectId) : ''}),
        [projectName],
    )

    const focusComposer = useCallback(() => {
        window.setTimeout(() => {
            rootRef.current?.querySelector<HTMLTextAreaElement>('[data-aichat-current] textarea')?.focus()
        }, 30)
    }, [])

    // Una conversación nueva: se guarda YA (abierta, sin título, con el proveedor
    // y el proyecto elegidos) para que no se pierda si se cierra la pestaña o la
    // app antes del primer mensaje.
    const makeDraft = useCallback(
        (agent: agentsModel.Agent, projectId: string): Session => {
            const id = newSessionId()
            creationsRef.current.set(
                id,
                CreateAgentChatDraft(id, agent.id, MODEL_DEFAULT, 'utilities', projectId)
                    .catch(() => {})
                    .then(() => notifyAgentChatsChanged()),
            )
            return {id, agentId: agent.id, agentLabel: agent.label, chatId: id, fresh: true, context: utilitiesContext(projectId), model: MODEL_DEFAULT}
        },
        [utilitiesContext],
    )

    // La primera conversación del panel. Antes de crear otra se busca un borrador
    // suelto (abierto, sin mensajes, que ningún panel tenga): abrir y cerrar la
    // pestaña de chat no puede dejar un borrador vacío por cada vez. Sin ninguno,
    // se crea uno con el proveedor activo de la app (o el primero disponible).
    const initialRef = useRef(false)
    useEffect(() => {
        if (!agentsLoaded || sessions.length > 0 || available.length === 0 || initialRef.current) return
        // Si el panel nació para abrir una conversación, el borrador sobra: se
        // crea recién si esa apertura no llegó a nada.
        if (openRequest && (handledOpenRef.current !== openRequest.token || openingRef.current)) return
        initialRef.current = true
        void (async () => {
            try {
                const open = await ListOpenAgentChats().catch(() => [] as vault.AgentChat[])
                if (sessionsRef.current.length > 0) return
                const loose = open.find(
                    (c) => c.lastStatus === '' && !c.conversationId && c.module === 'utilities' && available.some((a) => a.id === c.agentId) && claimChat(c.id, paneId),
                )
                if (loose) {
                    openChat(loose, true)
                    return
                }
                const agent = available.find((a) => a.id === defaultAgentId) ?? available[0]
                const s = makeDraft(agent, '')
                setSessions([s])
                setCurrentId(s.id)
            } finally {
                initialRef.current = false
            }
        })()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [agentsLoaded, sessions.length, available, defaultAgentId, makeDraft, openSettled])

    // El borrador es la conversación sin mensajes. Hay a lo sumo una por panel:
    // «Nuevo chat» con un borrador a la vista no abre otro, vuelve a él.
    const newChat = useCallback(() => {
        const draft = sessionsRef.current.find((s) => s.fresh)
        if (draft) {
            setCurrentId(draft.id)
            focusComposer()
            return
        }
        const base = sessionsRef.current.find((s) => s.id === currentId)
        const agent = available.find((a) => a.id === base?.agentId) ?? available.find((a) => a.id === defaultAgentId) ?? available[0]
        if (!agent) return
        const s = makeDraft(agent, base?.context.kind === 'utilities' ? base.context.id : '')
        setSessions((prev) => [...prev, s])
        setCurrentId(s.id)
        focusComposer()
    }, [available, currentId, defaultAgentId, focusComposer, makeDraft])

    // Cmd/Ctrl+N: chat nuevo, solo con esta pestaña a la vista.
    useEffect(() => {
        if (!visible || !shortcutsEnabled) return
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
                e.preventDefault()
                newChat()
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [visible, shortcutsEnabled, newChat])

    // `force`: la conversación se pidió PARA este panel (llegó por un pedido de
    // apertura), así que no se la manda a buscar a otro.
    const openChat = useCallback(
        (c: vault.AgentChat, force = false) => {
            const existing = sessionsRef.current.find((s) => s.id === c.id)
            if (existing) {
                setCurrentId(existing.id)
                focusComposer()
                return
            }
            // Una conversación no se muestra en dos paneles a la vez: dos cajas
            // de texto para un turno que sólo admite un mensaje a la vez. Si ya
            // está en otra pestaña, se lleva al frente esa.
            if (!force && paneOwningChat(c.id, paneId)) {
                requestOpenAiChat({chatId: c.id})
                return
            }
            const agent = agentList.find((a) => a.id === c.agentId)
            // Un proveedor de modelos apagado o eliminado no impide abrirla: se la
            // lee y se sigue con otro. Un CLI que ya no está, sí (su hilo es suyo).
            const lost = !agent && isModelServerAgent(c.agentId)
            if (!agent && !lost) return
            const kind = (c.module || 'none') as WorkContextKind
            // Se retoma EN SU contexto: una conversación pertenece al recurso
            // donde nació, aunque se la mire desde acá.
            const context: WorkContext =
                kind === 'utilities'
                    ? utilitiesContext(c.contextId)
                    : {kind, id: kind === 'none' ? '' : c.contextId, label: resourceNames[c.contextId] ?? ''}
            const s: Session = {
                id: c.id,
                agentId: c.agentId,
                agentLabel: agent?.label ?? lostLabel(c.agentId),
                lost,
                chatId: c.id,
                context,
                resumeConversationId: c.conversationId || undefined,
                resumeChatId: c.id,
                initialSettings: {model: c.model, effort: c.effort, mode: c.mode, brain: c.brain},
                model: c.model || MODEL_DEFAULT,
                // Sin mensajes: una abierta que nunca corrió. Una del historial
                // (cerrada) nunca cuenta como borrador, aunque no tenga estado.
                fresh: c.open && c.lastStatus === '' && !c.conversationId,
            }
            if (c.conversationId) void ResumeAgentChat(c.id, c.conversationId).catch(() => {})
            // Abrirla desde el historial la suma a Abiertas, donde se queda hasta
            // que alguien la cierre.
            if (!c.open) void SetAgentChatOpen(c.id, true).then(() => notifyAgentChatsChanged()).catch(() => {})
            setSessions((prev) => [...prev, s])
            setCurrentId(s.id)
            focusComposer()
        },
        [agentList, focusComposer, lostLabel, paneId, resourceNames, utilitiesContext],
    )

    // Pedido de apertura desde afuera. Se resuelve contra el historial FRESCO y no
    // contra el estado: una conversación recién creada puede no estar todavía en
    // la lista que ya tenía el panel. Espera a los agentes, que `openChat`
    // necesita para saber qué proveedor es.
    const handledOpenRef = useRef(0)
    const openingRef = useRef(false)
    useEffect(() => {
        if (!openRequest || !agentsLoaded || openRequest.token === handledOpenRef.current) return
        handledOpenRef.current = openRequest.token
        openingRef.current = true
        ListAllAgentChats()
            .then((h) => {
                setHistory(h ?? [])
                // Al reabrir una pestaña guardada vienen todas las conversaciones
                // del panel: se abren primero las demás y al final la que estaba a
                // la vista, que queda como actual.
                for (const id of openRequest.chatIds ?? []) {
                    const other = (h ?? []).find((x) => x.id === id)
                    if (other && id !== openRequest.chatId) openChat(other, true)
                }
                const c = (h ?? []).find((x) => x.id === openRequest.chatId)
                if (c) openChat(c, true)
            })
            .catch(() => {})
            .finally(() => {
                openingRef.current = false
                setOpenSettled((n) => n + 1)
            })
    }, [openRequest, agentsLoaded, openChat])

    // Pasar una conversación de un proveedor de modelos a otro SIN abrir otra:
    // el hilo lo tiene la app (los mensajes guardados en el vault y la memoria de
    // la sesión), no el proveedor, así que el nuevo recibe lo hablado como
    // contexto. Se queda el mismo id de conversación, el mismo historial y el
    // mismo proyecto; el modelo vuelve al predeterminado del proveedor nuevo.
    const switchProvider = useCallback(
        (sessionId: string, agentId: string) => {
            const agent = available.find((a) => a.id === agentId)
            const s = sessionsRef.current.find((x) => x.id === sessionId)
            if (!agent || !s || s.agentId === agent.id) return
            setSwitchNote({sessionId, from: s.agentLabel, to: agent.label})
            setSessions((prev) => prev.map((x) => (x.id === sessionId ? {...x, agentId: agent.id, agentLabel: agent.label, model: MODEL_DEFAULT, lost: false} : x)))
            // Que la fila del historial deje de rotularla con el proveedor viejo.
            if (!s.fresh) void persistChatAgent(s.chatId, agent.id).then((saved) => saved && loadHistory())
            focusComposer()
        },
        [available, focusComposer, loadHistory],
    )

    // Cambiar de proveedor en una conversación ya empezada abre otra, salvo entre
    // proveedores de modelos (ver switchProvider): la continuidad de un CLI la
    // guarda el propio CLI en su almacenamiento, no hay forma honesta de seguir
    // con otro lo que venía uno. En un borrador (sin mensajes) se cambia en el
    // lugar.
    const changeProvider = useCallback(
        (agentId: string) => {
            const agent = available.find((a) => a.id === agentId)
            if (!agent || !current) return
            if (!current.fresh && isModelServerAgent(agent.id) && (isModelServerAgent(current.agentId) || current.lost)) {
                switchProvider(current.id, agent.id)
                return
            }
            // Cambia el proveedor del borrador, en pantalla y en el vault.
            const retarget = (id: string) => {
                setSessions((prev) => prev.map((s) => (s.id === id ? {...s, agentId: agent.id, agentLabel: agent.label, model: MODEL_DEFAULT} : s)))
                void afterCreation(id)
                    .then(() => SetAgentChatDraftAgent(id, agent.id))
                    .then(() => notifyAgentChatsChanged())
                    .catch(() => {})
            }
            if (current.fresh) {
                retarget(current.id)
            } else {
                const draft = sessionsRef.current.find((s) => s.fresh)
                if (draft) {
                    retarget(draft.id)
                    setCurrentId(draft.id)
                } else {
                    const s = makeDraft(agent, current.context.kind === 'utilities' ? current.context.id : '')
                    setSessions((prev) => [...prev, s])
                    setCurrentId(s.id)
                }
            }
            focusComposer()
        },
        [afterCreation, available, current, focusComposer, makeDraft, switchProvider],
    )

    // Tras guardar un servidor desde el selector, se lo elige apenas el catálogo
    // lo trae. Si el catálogo no lo trae disponible no se queda esperando.
    useEffect(() => {
        if (!pendingProvider || !current) return
        if (available.some((a) => a.id === pendingProvider)) {
            changeProvider(pendingProvider)
            setPendingProvider('')
        }
    }, [pendingProvider, available, current, changeProvider])

    const onServerSaved = useCallback(
        (saved: {id: string}) => {
            setServerDialog(false)
            setPendingProvider(`llm:${saved.id}`)
            window.setTimeout(() => setPendingProvider(''), 5000)
            refreshAgents()
        },
        [refreshAgents],
    )

    const changeModel = useCallback((sessionId: string, model: string) => {
        setSessions((prev) => (prev.some((s) => s.id === sessionId && s.model !== model) ? prev.map((s) => (s.id === sessionId ? {...s, model} : s)) : prev))
    }, [])

    const changeProject = useCallback(
        (projectId: string) => {
            if (!current) return
            const context = utilitiesContext(projectId)
            setSessions((prev) => prev.map((s) => (s.id === current.id ? {...s, context} : s)))
            // La conversación se reasigna: si no, al retomarla desde el historial
            // volvería con el proyecto con el que nació.
            void afterCreation(current.id)
                .then(() => SetAgentChatContext(current.id, 'utilities', projectId))
                .then(loadHistory)
                .catch(() => {})
        },
        [afterCreation, current, loadHistory, utilitiesContext],
    )

    // «Abrir carpeta…»: diálogo nativo → alta (el backend rechaza la raíz del
    // disco y el home, y dice por qué) → devuelve el contexto de la carpeta, o ''
    // si se canceló o falló.
    const openFolder = useCallback(async (): Promise<string> => {
        try {
            const path = await PickAgentWorkspaceFolder()
            if (!path) return ''
            const w = await AddAgentWorkspace(path, baseName(path))
            setProjectError('')
            setWorkspaces((prev) => (prev.some((x) => x.id === w.id) ? prev.map((x) => (x.id === w.id ? w : x)) : [...prev, w]))
            setResourceNames((prev) => ({...prev, [WORKSPACE_PREFIX + w.id]: w.name}))
            return WORKSPACE_PREFIX + w.id
        } catch (e) {
            setProjectError(errorText(e))
            return ''
        }
    }, [])

    const onProjectChange = useCallback(
        (value: string) => {
            if (value === MANAGE_FOLDERS) setManageFolders(true)
            else if (value === OPEN_FOLDER) void openFolder().then((id) => id && changeProject(id))
            else {
                setProjectError('')
                changeProject(value)
            }
        },
        [changeProject, openFolder],
    )

    // El nombre del proyecto puede resolverse después de crear la sesión (los
    // repos y las carpetas llegan por una llamada aparte): se rellena la etiqueta.
    useEffect(() => {
        setSessions((prev) => {
            let changed = false
            const next = prev.map((s) => {
                if (s.context.kind !== 'utilities' || !s.context.id) return s
                const label = projectName(s.context.id)
                if (label === s.context.label) return s
                changed = true
                return {...s, context: {...s.context, label}}
            })
            return changed ? next : prev
        })
    }, [projectName])

    // --- Historial ---------------------------------------------------------

    // El primer mensaje deja de ser borrador a la conversación y, si seguía sin
    // nombre, le da el suyo (sin referencias @ ni bloques de código). El
    // backend hace lo mismo al recibirlo (nameUntitledChat); acá se anticipa
    // para que la pestaña y las listas lo muestren sin esperar la relectura.
    // Un nombre que el usuario ya eligió no se toca.
    const onFirstSend = useCallback(
        (sessionId: string, text: string) => {
            const s = sessionsRef.current.find((x) => x.id === sessionId)
            if (!s || !s.fresh) return
            setSessions((prev) => prev.map((x) => (x.id === s.id ? {...x, fresh: false} : x)))
            const title = chatTitleFromMessage(text)
            if (title) setHistory((prev) => prev.map((c) => (c.id === s.id && !c.title ? vault.AgentChat.createFrom({...c, title}) : c)))
            window.setTimeout(loadHistory, 600)
        },
        [loadHistory],
    )

    const onConversation = useCallback(
        (sessionId: string, conversationId: string) => {
            const s = sessionsRef.current.find((x) => x.id === sessionId)
            if (!s) return
            void afterCreation(s.id)
                .then(() => TouchAgentChat(s.id, conversationId))
                .then(loadHistory)
                .catch(() => {})
        },
        [afterCreation, loadHistory],
    )

    // Renombra la conversación `sessionId`. La fila existe desde que se creó la
    // conversación, así que el nombre se guarda en el acto (el backend también
    // actualiza el título de la sesión viva).
    const renameSession = useCallback(
        async (sessionId: string, raw: string) => {
            const title = cleanChatTitle(raw)
            const s = sessionsRef.current.find((x) => x.id === sessionId)
            if (!title || !s) return
            // Optimista: la pestaña y el historial muestran el nombre ya; si el
            // guardado falla, la relectura lo devuelve a como estaba.
            setHistory((prev) => prev.map((c) => (c.id === s.id ? vault.AgentChat.createFrom({...c, title}) : c)))
            await afterCreation(s.id)
            await renameChat(s.id, title)
            loadHistory()
        },
        [afterCreation, loadHistory],
    )
    const renameSessionRef = useRef(renameSession)
    renameSessionRef.current = renameSession
    const currentIdRef = useRef(currentId)
    currentIdRef.current = currentId

    // Un renombrado hecho desde afuera (barra lateral, «Activas») o el pedido de
    // una pestaña de la barra: lo primero relee el historial; lo segundo renombra
    // la conversación que ESTA pestaña tiene a la vista (sólo el panel principal).
    useEffect(() => onAgentChatsChanged(loadHistory), [loadHistory])
    useEffect(
        () =>
            secondary
                ? undefined
                : onRenameAiChatTabRequest((req) => {
                      if (req.tabId === paneId && currentIdRef.current) void renameSessionRef.current(currentIdRef.current, req.title)
                  }),
        [paneId, secondary],
    )

    // F2 en cualquier parte de esta pestaña renombra la conversación a la vista
    // (salvo mientras se escribe en un campo: ahí F2 no es de nadie).
    useEffect(() => {
        if (!visible || !shortcutsEnabled) return
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'F2' || e.metaKey || e.ctrlKey || e.altKey) return
            const target = e.target as HTMLElement | null
            if (!target || !rootRef.current?.contains(target) || target.closest('[data-inline-rename]')) return
            e.preventDefault()
            setEditingTitle(true)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [visible, shortcutsEnabled])

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
            void afterCreation(c.id)
                .then(() => DeleteAgentChat(c.id))
                .then(() => {
                    const rest = sessionsRef.current.filter((s) => s.id !== c.id)
                    setSessions(rest)
                    if (c.id === currentId) {
                        const draft = rest.find((s) => s.fresh)
                        setCurrentId(draft?.id ?? rest[rest.length - 1]?.id ?? '')
                    }
                    loadHistory()
                    notifyAgentChatsChanged()
                })
                .catch(() => {})
        },
        [afterCreation, currentId, loadHistory],
    )

    // «Cerrar chat»: la conversación se da por terminada. Corta lo que corra, la
    // saca de Chat de IA → Activas y la quita de esta pestaña; la entrada del historial
    // queda y se puede abrir de nuevo. NO es borrarla (eso es `removeChat`) ni
    // detener el turno (el botón Detener, que la deja abierta).
    const closeChat = useCallback(
        (sessionId: string) => {
            // Detrás del alta: cerrar una conversación recién creada antes de que
            // su INSERT termine la dejaría abierta para siempre.
            void afterCreation(sessionId)
                .then(() => CloseAgentSession(sessionId))
                .catch(() => {})
                .then(() => notifyAgentChatsChanged())
            setBusyIds((prev) => {
                if (!prev.has(sessionId)) return prev
                const next = new Set(prev)
                next.delete(sessionId)
                return next
            })
            const rest = sessionsRef.current.filter((s) => s.id !== sessionId)
            setSessions(rest)
            if (sessionId === currentId) {
                const draft = rest.find((s) => s.fresh)
                setCurrentId(draft?.id ?? rest[rest.length - 1]?.id ?? '')
            }
            loadHistory()
        },
        [afterCreation, currentId, loadHistory],
    )
    // La conversación se cerró o se eliminó desde la barra lateral (Abiertas): si
    // este panel la tiene a la vista, la suelta sin volver a avisarle al backend.
    useEffect(
        () =>
            onAiChatGone((id) => {
                const rest = sessionsRef.current.filter((s) => s.id !== id)
                if (rest.length === sessionsRef.current.length) return
                setSessions(rest)
                setBusyIds((prev) => {
                    if (!prev.has(id)) return prev
                    const next = new Set(prev)
                    next.delete(id)
                    return next
                })
                if (id === currentIdRef.current) setCurrentId(rest.find((s) => s.fresh)?.id ?? rest[rest.length - 1]?.id ?? '')
            }),
        [],
    )
    const askCloseChat = useCallback(
        (s: Session) => {
            if (busyIds.has(s.id)) setClosingChat(s)
            else closeChat(s.id)
        },
        [busyIds, closeChat],
    )

    // --- Dibujo ------------------------------------------------------------

    const modelOptions = (catalog?.models ?? [{id: MODEL_DEFAULT, label: t.agent.chat.modelDefault, description: '', efforts: []}]).map((m) => ({
        value: m.id,
        label: m.label,
        description: m.description || undefined,
    }))

    // Selector de proyecto: «Sin proyecto», los repositorios git, las carpetas
    // concedidas y, al final, las dos acciones. Una carpeta que ya no existe se
    // ve apagada y no se puede elegir (el tooltip dice por qué).
    const projectOf = (id: string) => {
        const repo = repos.find((r) => r.id === id)
        if (repo) return {name: repo.name, path: repo.path}
        const w = workspaces.find((x) => WORKSPACE_PREFIX + x.id === id)
        return w ? {name: w.name, path: w.path} : null
    }
    const currentProjectId = current?.context.id ?? ''
    const projectOptions: SelectOption[] = [{value: '', label: ta.header.noRepo, icon: <Icon name="chat_bubble_outline" size={14} />}]
    const withSeparator = (list: SelectOption[]) => list.map((o, i) => (i === list.length - 1 ? {...o, separatorAfter: true} : o))
    const repoOptions = repos.map((r) => ({value: r.id, label: r.name, hint: r.path, icon: <Icon name="account_tree" size={14} />}))
    const folderOptions = workspaces.map((w): SelectOption => ({
        value: WORKSPACE_PREFIX + w.id,
        label: w.name,
        // La ruta va en el tooltip: junto al nombre le quitaba lugar a lo que se busca.
        hint: w.exists ? undefined : ta.project.missing,
        disabled: !w.exists,
        title: w.exists ? w.path : ta.project.missingTitle({path: w.path}),
        icon: <Icon name={w.exists ? 'folder' : 'folder_off'} size={14} />,
    }))
    // Una conversación retomada puede apuntar a una carpeta que ya se quitó.
    const orphan =
        projectsLoaded && currentProjectId && !repos.some((r) => r.id === currentProjectId) && !workspaces.some((w) => WORKSPACE_PREFIX + w.id === currentProjectId)
            ? [{value: currentProjectId, label: current?.context.label || ta.project.removed, hint: ta.project.removed, icon: <Icon name="folder_off" size={14} />, title: ta.project.removedTitle} as SelectOption]
            : []
    const groups = [withSeparator(projectOptions), ...(orphan.length ? [withSeparator(orphan)] : []), ...(repoOptions.length ? [withSeparator(repoOptions)] : []), ...(folderOptions.length ? [withSeparator(folderOptions)] : [])]
    const allProjectOptions: SelectOption[] = [
        ...groups.flat(),
        {value: OPEN_FOLDER, label: ta.project.openFolder, title: ta.project.openFolderTitle, tone: 'text-primary', icon: <Icon name="create_new_folder" size={14} className="text-primary" />},
        {value: MANAGE_FOLDERS, label: ta.project.manage, title: ta.project.manageTitle, icon: <Icon name="folder_managed" size={14} />},
    ]

    const moduleOwned = current && current.context.kind !== 'utilities'
    const workingOf = (s: Session) => {
        if (s.context.kind !== 'utilities' || !s.context.id) return null
        const p = projectOf(s.context.id)
        return p ? {label: ta.repoBlock.label, text: ta.repoBlock.text({name: p.name, path: p.path})} : null
    }
    const currentFolder = workspaces.find((w) => WORKSPACE_PREFIX + w.id === currentProjectId)

    const {newChat: shortcut, newTab: shortcutNewWindow} = aiChatShortcuts()
    const activeChatId = current?.chatId || null
    const hasModelServer = available.some((a) => isModelServerAgent(a.id))
    const ms = t.settings.modelServers
    // Selectores de la cabecera: con espacio de sobra miden lo que su contenido
    // y topan a 14 rem; en una pestaña compacta se reparten el renglón.
    const fieldCls = compact ? 'min-w-0 flex-1 basis-32' : 'max-w-56 min-w-0'

    // Opción de cierre del selector de proveedor: no es un proveedor más, es el
    // camino a agregar uno. Si no estuviera, quien tiene un Ollama en otra
    // máquina vería solo los CLIs instalados y concluiría que hay que instalarlo.
    const providerOptions = [
        ...available.map((a, i) => ({
            value: a.id,
            label: a.label,
            hint: a.vendor || undefined,
            separatorAfter: i === available.length - 1,
            icon: isModelServerAgent(a.id) ? (
                <ProviderIconWithHealth icon={agentIconName(a.id)} health={optionsHealth[a.id] ?? null} server={a.label} />
            ) : (
                <Icon name={agentIconName(a.id)} size={14} />
            ),
        })),
        {value: ADD_SERVER, label: ms.addFromPicker, tone: 'text-primary', icon: <Icon name="add_circle" size={14} className="text-primary" />},
    ]
    const onProviderChange = (v: string) => (v === ADD_SERVER ? setServerDialog(true) : changeProvider(v))

    // Aviso del estado vacío cuando no hay ningún servidor de modelos.
    const noServerHint = !hasModelServer ? (
        <div data-no-server-hint className="mt-2 flex max-w-md flex-col items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2.5 text-ui-11 text-on-surface-variant">
            <p className="flex items-start gap-1.5 text-left">
                <Icon name="cloud" size={14} className="mt-px shrink-0 text-primary" />
                {ta.noServer.text}
            </p>
            <button
                type="button"
                data-add-server
                onClick={() => setServerDialog(true)}
                title={ta.noServer.buttonTitle}
                className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1 text-xs font-medium text-on-primary hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
                <Icon name="add" size={14} />
                {ta.noServer.button}
            </button>
        </div>
    ) : null

    // Una línea en el estado vacío: quien nunca vio el botón de otra pestaña
    // concluye que el chat es uno solo.
    const multiTabHint = (
        <p data-multi-chat-hint className="mt-1 flex max-w-sm items-start gap-1.5 text-left text-ui-11 text-on-surface-variant">
            <Icon name="tab_new_right" size={14} className="mt-px shrink-0 text-primary" />
            {t.aiSessions.tabs.emptyHint({shortcut: shortcutNewWindow})}
        </p>
    )

    const toggleHistory = () => {
        if (narrow) setDrawerOpen((v) => !v)
        else {
            const next = !historyOpen
            setHistoryOpen(next)
            writeHistoryOpen(next)
        }
    }
    const historyShownNow = narrow ? drawerOpen : historyOpen

    // El historial, igual en la columna y en el cajón.
    const historyPane = (
        <AiChatHistory
            paneId={paneId}
            chats={history}
            agents={agentList}
            lostLabels={lostLabels}
            resourceNames={resourceNames}
            activeChatId={activeChatId}
            busyChatIds={busyIds}
            onOpen={(c) => {
                openChat(c)
                // En el cajón, elegir una conversación es lo que se vino a hacer:
                // se cierra para dejar ver el chat.
                if (narrow) setDrawerOpen(false)
            }}
            onRename={setRenaming}
            onDelete={setDeleting}
            onOpenInNewTab={(c) => {
                requestOpenAiChat({chatId: c.id, newWindow: true})
                if (narrow) setDrawerOpen(false)
            }}
        />
    )
    const historyHandle = (
        <ResizeHandle
            value={historyShown}
            min={HISTORY_WIDTH_MIN}
            max={historyMax}
            defaultValue={HISTORY_WIDTH_DEFAULT}
            onChange={setHistoryWidth}
            onCommit={writeHistoryWidth}
            label={ta.historyResizeLabel}
            title={ta.historyResizeTitle}
            valueText={(px) => ta.historyResizeValue({px})}
        />
    )

    return (
        <div
            ref={rootRef}
            data-aichat-root
            data-layout={narrow ? 'narrow' : 'wide'}
            className="relative flex h-full w-full min-w-0 overflow-hidden bg-surface-container-lowest"
            role="region"
            aria-label={secondary ? `${t.utilities.tools.aiChat.name} — ${t.aiSessions.tabs.paneLabel({n: 2})}` : t.utilities.tools.aiChat.name}
        >
            {inlineHistory && (
                <aside data-aichat-history className="relative flex shrink-0 flex-col border-r border-outline-variant" style={{width: historyShown}}>
                    {historyPane}
                    {historyHandle}
                </aside>
            )}

            {/* Cajón: en una pestaña angosta el historial se abre SOBRE el chat,
                con un velo que lo cierra al tocarlo. */}
            {narrow && drawerOpen && (
                <div data-aichat-drawer className="absolute inset-0 z-30 flex">
                    <aside
                        className="relative flex h-full shrink-0 flex-col border-r border-outline-variant bg-surface-container-low shadow-xl"
                        style={{width: Math.min(historyShown, Math.max(HISTORY_WIDTH_MIN, rootWidth - 48))}}
                    >
                        {historyPane}
                        {historyHandle}
                    </aside>
                    <button
                        type="button"
                        onClick={() => setDrawerOpen(false)}
                        title={ta.closeHistoryTitle}
                        aria-label={ta.closeHistory}
                        className="min-w-0 flex-1 cursor-default bg-black/40"
                    />
                </div>
            )}

            <section className="flex min-w-0 flex-1 flex-col">
                <header ref={headerRef} className="flex shrink-0 flex-wrap items-center gap-2 border-b border-outline-variant bg-surface-container px-3 py-2">
                    <button
                        data-history-toggle
                        onClick={toggleHistory}
                        title={narrow ? ta.historyDrawerTitle : historyOpen ? ta.hideHistoryTitle : ta.showHistoryTitle}
                        aria-label={historyShownNow ? ta.hideHistory : ta.showHistory}
                        aria-pressed={historyShownNow}
                        className={`shrink-0 rounded-md p-1.5 hover:bg-surface-variant focus-visible:outline-2 focus-visible:outline-primary ${
                            historyShownNow ? 'bg-surface-variant text-on-surface' : 'text-on-surface-variant hover:text-on-surface'
                        }`}
                    >
                        <Icon name="view_sidebar" size={16} filled={historyShownNow} />
                    </button>

                    {/* El nombre de la conversación, con su lápiz: es el mismo que lleva
                        la pestaña. Clic, F2 o el lápiz lo editan en el lugar. */}
                    {current &&
                        (editingTitle ? (
                            <InlineRename
                                value={convTitle}
                                ariaLabel={t.aiSessions.tabs.renameField}
                                title={t.aiSessions.tabs.renameEditTitle}
                                onCommit={(title) => {
                                    setEditingTitle(false)
                                    void renameSession(current.id, title)
                                }}
                                onCancel={() => setEditingTitle(false)}
                                className={`py-1 text-xs font-medium ${compact ? 'flex-1 basis-32' : 'w-56'}`}
                            />
                        ) : (
                            <button
                                type="button"
                                data-chat-title
                                onClick={() => setEditingTitle(true)}
                                title={ta.header.titleButtonTitle({title: tabTitle})}
                                aria-label={`${ta.header.titleLabel}: ${tabTitle}`}
                                className={`group/title flex min-w-0 items-center gap-1.5 rounded-lg border border-transparent px-2 py-1 text-xs font-medium text-on-surface hover:border-outline-variant hover:bg-surface-variant focus-visible:outline-2 focus-visible:outline-primary ${
                                    compact ? 'flex-1 basis-32' : 'max-w-60'
                                }`}
                            >
                                <span className="min-w-0 truncate">{tabTitle}</span>
                                <Icon name="edit" size={12} className="shrink-0 text-on-surface-variant opacity-60 group-hover/title:opacity-100" />
                            </button>
                        ))}

                    {current && available.length > 0 && (
                        <>
                            <Select
                                value={current.lost ? '' : current.agentId}
                                onChange={onProviderChange}
                                title={ta.header.providerTitle}
                                ariaLabel={ta.header.providerLabel}
                                size="sm"
                                placeholder={ta.header.providerPlaceholder}
                                className={`${fieldCls} rounded-lg`}
                                menuMinWidth={240}
                                options={providerOptions}
                            />
                            {providerHealth && !current.lost && <HealthBadge health={providerHealth.health} server={current.agentLabel} />}
                            <Select
                                value={current.model}
                                onChange={(m) => changeModel(current.id, m)}
                                title={catalog?.models.find((m) => m.id === current.model)?.description || ta.header.modelTitle}
                                ariaLabel={ta.header.modelLabel}
                                size="sm"
                                leadingIcon="memory"
                                menuMinWidth={260}
                                className={`${fieldCls} rounded-lg`}
                                options={modelOptions}
                            />
                            {moduleOwned ? (
                                <span
                                    title={ta.header.repoModuleTitle({where: t.agent.historyPanel.groups[current.context.kind]?.toLowerCase() ?? ''})}
                                    className={`flex min-w-0 items-center gap-1.5 rounded-lg border border-outline-variant bg-surface-container-low px-2 py-1 text-xs text-on-surface-variant ${
                                        compact ? 'flex-1 basis-32' : 'max-w-64'
                                    }`}
                                >
                                    <Icon name={CONTEXT_ICONS[current.context.kind]} size={13} className="shrink-0" />
                                    <span className="truncate">{describeContext(current.context) || t.agent.historyPanel.groups[current.context.kind]}</span>
                                </span>
                            ) : (
                                <Select
                                    value={current.context.id}
                                    onChange={onProjectChange}
                                    title={ta.header.repoTitle}
                                    ariaLabel={ta.header.repoLabel}
                                    size="sm"
                                    leadingIcon="folder_open"
                                    menuMinWidth={300}
                                    menuMaxHeight={380}
                                    className={`${fieldCls} rounded-lg`}
                                    options={allProjectOptions}
                                />
                            )}
                        </>
                    )}

                    {/* Las acciones de la derecha viajan juntas: si no caben junto a los
                        selectores, bajan al renglón de abajo como un bloque. */}
                    <div className="ml-auto flex shrink-0 items-center gap-2">
                        {!secondary && (
                            <button
                                type="button"
                                data-new-window
                                onClick={() => requestOpenAiChat({newWindow: true})}
                                title={t.aiSessions.tabs.newWindowTitle({shortcut: shortcutNewWindow})}
                                aria-label={t.aiSessions.tabs.newWindow}
                                className={`flex shrink-0 items-center gap-1.5 rounded-md text-on-surface-variant hover:bg-surface-variant hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary ${
                                    labelNewTab ? 'border border-outline-variant px-2 py-1 text-xs' : 'p-1.5'
                                }`}
                            >
                                <Icon name="open_in_new" size={16} />
                                {labelNewTab && t.aiSessions.tabs.newWindowShort}
                            </button>
                        )}
                        {onToggleSplit && (
                            <button
                                type="button"
                                data-split-toggle
                                onClick={onToggleSplit}
                                title={secondary || split ? t.aiSessions.tabs.unsplitTitle : t.aiSessions.tabs.splitTitle}
                                aria-label={secondary ? t.aiSessions.tabs.unsplit : split ? t.aiSessions.tabs.unsplitShort : t.aiSessions.tabs.split}
                                aria-pressed={split}
                                className={`flex shrink-0 items-center gap-1.5 rounded-md hover:bg-surface-variant focus-visible:outline-2 focus-visible:outline-primary ${
                                    labelSplit ? 'border border-outline-variant px-2 py-1 text-xs' : 'p-1.5'
                                } ${split ? 'bg-surface-variant text-on-surface' : 'text-on-surface-variant hover:text-on-surface'}`}
                            >
                                <Icon name={secondary ? 'close' : 'vertical_split'} size={16} filled={split && !secondary} />
                                {labelSplit && (secondary ? t.aiSessions.tabs.unsplit : split ? t.aiSessions.tabs.unsplitShort : t.aiSessions.tabs.split)}
                            </button>
                        )}
                        <button
                            type="button"
                            data-usage-toggle
                            onClick={() => setBody((b) => (b === 'usage' ? 'chat' : 'usage'))}
                            title={body === 'usage' ? t.agent.host.backToChat : ta.usageTitle}
                            aria-label={ta.usage}
                            aria-pressed={body === 'usage'}
                            className={`shrink-0 rounded-md p-1.5 hover:bg-surface-variant focus-visible:outline-2 focus-visible:outline-primary ${
                                body === 'usage' ? 'bg-surface-variant text-on-surface' : 'text-on-surface-variant hover:text-on-surface'
                            }`}
                        >
                            <Icon name="monitoring" size={16} filled={body === 'usage'} />
                        </button>
                        {/* «Nuevo chat» con su menú: el clic principal abre la conversación
                            en ESTA pestaña; la ▾ dice, con texto, las otras dos formas
                            de tener varios chats a la vez. */}
                        <div className={`flex shrink-0 items-stretch rounded-lg bg-primary text-on-primary ${available.length === 0 ? 'opacity-40' : ''}`}>
                            <button
                                onClick={newChat}
                                disabled={available.length === 0}
                                data-new-chat
                                title={ta.newChatTitle({shortcut})}
                                aria-label={ta.newChat}
                                className="flex items-center gap-1.5 rounded-l-lg px-3 py-1.5 text-xs font-medium hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                            >
                                <Icon name="add" size={15} />
                                {!compact && ta.newChat}
                                {!compact && <kbd className="rounded bg-on-primary/20 px-1 font-sans text-ui-10">{shortcut}</kbd>}
                            </button>
                            <button
                                data-new-chat-menu
                                disabled={available.length === 0}
                                onClick={(e) =>
                                    newMenu.openAt(e, [
                                        {label: t.aiSessions.tabs.newInThisTab, icon: 'add', hint: shortcut, title: t.aiSessions.tabs.newInThisTabTitle({shortcut}), onSelect: newChat},
                                        {
                                            label: t.aiSessions.tabs.newInNewTab,
                                            icon: 'open_in_new',
                                            hint: shortcutNewWindow,
                                            title: t.aiSessions.tabs.newWindowTitle({shortcut: shortcutNewWindow}),
                                            onSelect: () => requestOpenAiChat({newWindow: true}),
                                        },
                                        ...(onToggleSplit
                                            ? [
                                                  {
                                                      label: secondary ? t.aiSessions.tabs.unsplit : split ? t.aiSessions.tabs.unsplitShort : t.aiSessions.tabs.splitMenu,
                                                      icon: secondary ? 'close' : 'vertical_split',
                                                      title: secondary || split ? t.aiSessions.tabs.unsplitTitle : t.aiSessions.tabs.splitTitle,
                                                      onSelect: onToggleSplit,
                                                  },
                                              ]
                                            : []),
                                    ])
                                }
                                title={t.aiSessions.tabs.newChatMenuTitle}
                                aria-label={t.aiSessions.tabs.newChatMenu}
                                aria-haspopup="menu"
                                className="flex items-center rounded-r-lg border-l border-on-primary/25 px-0.5 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                            >
                                <Icon name="arrow_drop_down" size={18} />
                            </button>
                        </div>
                    </div>
                </header>
                {newMenu.element}

                {projectError && (
                    <div
                        role="alert"
                        data-project-error
                        className="flex shrink-0 items-start gap-2 border-b border-error/40 bg-error-container/30 px-3 py-1.5 text-ui-11 text-error"
                    >
                        <Icon name="error" size={14} className="mt-px shrink-0" />
                        <span className="min-w-0 flex-1">{ta.project.openFailed({error: projectError})}</span>
                        <button
                            type="button"
                            onClick={() => setProjectError('')}
                            title={ta.project.dismissTitle}
                            aria-label={ta.project.dismissTitle}
                            className="shrink-0 rounded p-0.5 hover:bg-error-container/50"
                        >
                            <Icon name="close" size={13} />
                        </button>
                    </div>
                )}

                {body === 'chat' && current?.lost && (
                    <LostProviderBar
                        label={providerInfo[current.agentId]?.name ?? current.agentLabel}
                        disabled={providerInfo[current.agentId] !== undefined}
                        options={available.filter((a) => isModelServerAgent(a.id))}
                        onContinue={(id) => switchProvider(current.id, id)}
                        onAdd={() => setServerDialog(true)}
                    />
                )}

                {body === 'chat' && current && switchNote?.sessionId === current.id && !current.lost && (
                    <SwitchedBar from={switchNote.from} to={switchNote.to} onDismiss={() => setSwitchNote(null)} />
                )}

                {body === 'chat' && current && !moduleOwned && current.context.id && (
                    <ProjectContextBar
                        contextId={current.context.id}
                        isModelServer={isModelServerAgent(current.agentId)}
                        agentLabel={current.agentLabel}
                        visible={visible}
                        missing={!!currentFolder && !currentFolder.exists}
                    />
                )}

                {body === 'usage' && (
                    <div data-aichat-usage className="min-h-0 flex-1 overflow-y-auto bg-surface-container-low">
                        {/* El panel nació para un costado angosto; a todo el ancho
                            se centra en una columna legible. */}
                        <div className="mx-auto h-full w-full max-w-4xl">
                            <AgentUsagePanel
                                agentLabel={(id) => agentList.find((a) => a.id === id)?.label ?? id}
                                session={sessionUsage}
                                onClose={() => setBody('chat')}
                            />
                        </div>
                    </div>
                )}

                <div className={`min-h-0 flex-1 ${body === 'usage' ? 'hidden' : ''}`}>
                    {agentsLoaded && available.length === 0 && (
                        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-xs text-on-surface-variant">
                            <Icon name="smart_toy" size={32} className="opacity-40" />
                            <p className="text-sm text-on-surface">{t.agent.host.emptyNoAgent}</p>
                            <p className="max-w-md">{t.agent.host.emptyNoAgentHint}</p>
                            {noServerHint}
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
                                {/* A todo el ancho de la pestaña: el texto corrido de la
                                    respuesta se topa a ~100 caracteres (AgentChat,
                                    `fluid`), pero los bloques de código y las tablas
                                    usan el ancho entero. */}
                                <div className="h-full w-full bg-surface">
                                    <AgentChat
                                        sessionId={s.id}
                                        context={s.context}
                                        active={isCurrent && visible}
                                        agentId={s.agentId}
                                        agentLabel={s.agentLabel}
                                        blocked={s.lost}
                                        resumeConversationId={s.resumeConversationId}
                                        resumeChatId={s.resumeChatId}
                                        initialSettings={s.initialSettings}
                                        model={s.model}
                                        onModelChange={(m) => changeModel(s.id, m)}
                                        working={isCurrent ? workingOf(s) : null}
                                        onSend={(text) => onFirstSend(s.id, text)}
                                        onCloseChat={() => askCloseChat(s)}
                                        onConversation={(cid) => onConversation(s.id, cid)}
                                        onBusyChange={(b) => onBusyChange(s.id, b)}
                                        fluid
                                        onSessionUsage={isCurrent && visible ? setSessionUsage : undefined}
                                        emptyExtra={
                                            <>
                                                {multiTabHint}
                                                {noServerHint}
                                            </>
                                        }
                                    />
                                </div>
                            </div>
                        )
                    })}
                </div>
            </section>

            {manageFolders && (
                <ManageFoldersDialog
                    workspaces={workspaces}
                    onOpenFolder={() =>
                        void openFolder().then((id) => {
                            if (!id) return
                            changeProject(id)
                            setManageFolders(false)
                        })
                    }
                    onRemoved={() => loadNames()}
                    onClose={() => setManageFolders(false)}
                />
            )}

            {serverDialog && <ModelServerDialog onSaved={onServerSaved} onClose={() => setServerDialog(false)} />}

            {renaming && (
                <PromptDialog
                    title={ta.rename.title}
                    label={ta.rename.label}
                    initial={renaming.title}
                    confirmLabel={t.common.save}
                    description={ta.rename.description}
                    maxLength={MAX_CHAT_TITLE}
                    onSubmit={(value) => {
                        const id = renaming.id
                        setRenaming(null)
                        void renameChat(id, value).then(loadHistory)
                    }}
                    onClose={() => setRenaming(null)}
                />
            )}

            {closingChat && (
                <ConfirmDialog
                    title={t.aiSessions.sidebar.closeConfirm.title}
                    description={t.aiSessions.sidebar.closeConfirm.description({
                        title: history.find((c) => c.id === closingChat.chatId)?.title || ta.untitled,
                    })}
                    confirmLabel={t.aiSessions.sidebar.closeConfirm.confirm}
                    danger
                    onConfirm={() => closeChat(closingChat.id)}
                    onClose={() => setClosingChat(null)}
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
