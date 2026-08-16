import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react'
import {
    AgentActive,
    CreateAgentChat,
    ListAgents,
    ListAllAgentChats,
    ResumeAgentChat,
    SetAgentActive,
    SetAgentChatContext,
    SetAgentLayout,
    TouchAgentChat,
} from '../../../wailsjs/go/main/App'
import {agents as agentsModel, main, vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import AgentChat from './AgentChat'
import {CONTEXT_ICONS, describeContext, repoIdOf, NO_CONTEXT, type WorkContext} from './workContext'

// Anfitrión del chat de nivel APLICACIÓN: una conversación que acompaña al
// usuario por los módulos donde el agente CONSULTA (bases de datos, SSH,
// notas), sobre el mismo componente `AgentChat` que usa la pestaña Git.
//
// Hasta 1.3.x ese componente solo se montaba dentro de la pestaña Git, así que
// el chat solo existía mientras hubiera un repositorio abierto y solo sabía de
// repositorios. Ahora el componente es uno solo y lo montan dos anfitriones
// distintos, cada uno con su propósito:
//
//   - **La pestaña Git** sigue montando el suyo, y tiene que seguir
//     montándolo: ahí el agente trabaja sobre un PROYECTO DE CÓDIGO —edita con
//     permisos, se le aprueba acción por acción, se abren dos agentes en
//     paralelo para que uno revise al otro, y todo lo que hace se ve en el diff
//     y se descarta con un clic. Eso es el banco de trabajo agéntico y no se
//     mueve de ahí.
//   - **Este anfitrión** cubre todo lo demás, donde el trabajo es consultar:
//     escribir una consulta, entender un plan de ejecución, leer un error de
//     una terminal. Se monta UNA sola vez (Workspace.tsx) y acompaña al
//     usuario entre pestañas: cambiar de pestaña **no reinicia la
//     conversación**, cambia el contexto de trabajo, que es lo que se ve en el
//     encabezado y lo que decide el directorio de trabajo del subproceso.
//
// Lo que se unificó es la IMPLEMENTACIÓN, no la cantidad de paneles: un solo
// componente, un solo historial, un solo selector de `@`, un solo sistema de
// modos y un solo lugar donde arreglar un bug.
//
// **Desviación de la convención de estado (.claude/rules/conventions.md).** El
// resto de la app pasa todo por props desde Workspace. Acá hay un contexto de
// React, y no por gusto: los puntos de entrada al chat viven en el panel de
// resultados, en el visor de EXPLAIN, en la terminal SSH y en el panel SFTP —
// cinco niveles de profundidad desde Workspace, por ramas distintas. Drillear
// un callback hasta cada uno es exactamente el caso que la convención deja
// abierto ("salvo que el prop-drilling se vuelva un problema real"). Esto NO es
// una librería de estado global: es la API de React, y el estado sigue siendo
// useState acá adentro.

export type AgentDock = 'right' | 'left' | 'bottom' | 'float'

interface OpenChatOptions {
    // Texto con el que se abre la caja de mensaje, sin mandarlo. Que el turno
    // no salga solo es deliberado: un botón "preguntar al agente" que además
    // manda no deja leer lo que se está por mandar.
    prompt?: string
    // Contexto explícito. Sin esto se usa el del módulo activo, que es lo
    // correcto casi siempre; se pasa a mano cuando el botón sabe más que la
    // pestaña (por ejemplo el visor de EXPLAIN, que sabe de qué conexión es el
    // plan aunque la pestaña activa sea otra).
    context?: WorkContext
}

interface AgentChatApi {
    // Abre el panel (y lo enfoca si ya estaba abierto).
    open: (opts?: OpenChatOptions) => void
    close: () => void
    toggle: () => void
    isOpen: boolean
    // Si hay al menos un agente instalado. Los módulos lo usan para no ofrecer
    // un botón que solo puede terminar en "no hay ningún agente".
    hasAgent: boolean
    activeAgentLabel: string
}

const AgentChatContext = createContext<AgentChatApi | null>(null)

// useAgentChat es cómo cualquier módulo abre el chat único.
//
// Devuelve un no-op fuera del proveedor en vez de tirar: el banco de capturas
// (uishot.tsx) renderiza componentes sueltos para fotografiarlos, y hacerlos
// fallar por no tener el chat montado convertiría una herramienta de
// diagnóstico en una fuente de errores propios.
export function useAgentChat(): AgentChatApi {
    return (
        useContext(AgentChatContext) ?? {
            open: () => {},
            close: () => {},
            toggle: () => {},
            isOpen: false,
            hasAgent: false,
            activeAgentLabel: '',
        }
    )
}

interface Props {
    // Contexto del módulo activo, derivado de la pestaña abierta en
    // Workspace. Cambia al cambiar de pestaña; la conversación no.
    context: WorkContext
    dock: AgentDock
    size: number
    onLayoutChange: (dock: AgentDock, size: number) => void
    children: ReactNode
}

// Sesión viva del chat. `chatId` es la entrada del historial en el vault, que
// se crea recién con el primer mensaje: una conversación a la que nunca se le
// escribió nada no es historial, es una ventana que se abrió.
interface Session {
    id: string
    agentId: string
    agentLabel: string
    chatId: string
    resumeConversationId?: string
    initialSettings?: {model: string; effort: string; mode: string}
}

export default function AgentChatHost({context, dock, size, onLayoutChange, children}: Props) {
    const [open, setOpen] = useState(false)
    const [session, setSession] = useState<Session | null>(null)
    const [seed, setSeed] = useState<{text: string; token: number} | null>(null)
    const [agentList, setAgentList] = useState<agentsModel.Agent[]>([])
    const [active, setActive] = useState<main.ActiveAgent | null>(null)
    const [history, setHistory] = useState<vault.AgentChat[]>([])
    const [historyOpen, setHistoryOpen] = useState(false)
    // Contexto con el que se abrió el chat cuando el llamador pasó uno
    // explícito. Se prefiere al del módulo activo hasta que el usuario cambie
    // de pestaña, que es cuando el suyo vuelve a mandar.
    const [pinned, setPinned] = useState<WorkContext | null>(null)

    const effective = pinned ?? context

    useEffect(() => {
        ListAgents()
            .then((list) => setAgentList(list ?? []))
            .catch(() => setAgentList([]))
        AgentActive()
            .then(setActive)
            .catch(() => setActive(null))
    }, [])

    // El contexto fijado se suelta al cambiar de pestaña: quedó fijado para
    // una acción puntual ("analizá este plan"), no para siempre.
    useEffect(() => {
        setPinned(null)
    }, [context.kind, context.id])

    // La conversación se mueve con el usuario. No se abre una nueva por
    // módulo: se reasigna de dónde es, que es lo que hace que el historial la
    // muestre donde uno la fue a buscar último.
    useEffect(() => {
        if (!session?.chatId) return
        void SetAgentChatContext(session.chatId, effective.kind, effective.id).catch(() => {})
    }, [session?.chatId, effective.kind, effective.id])

    const available = useMemo(() => agentList.filter((a) => a.available), [agentList])
    const activeAgent = useMemo(
        () => available.find((a) => a.id === active?.id) ?? null,
        [available, active?.id],
    )

    const startSession = useCallback(
        (agent: agentsModel.Agent, resume?: vault.AgentChat) => {
            const id = resume?.id ?? `agent-chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
            setSession({
                id,
                agentId: agent.id,
                agentLabel: agent.label,
                // Retomar una conversación reusa SU entrada del historial; una
                // nueva todavía no tiene, y se crea con el primer mensaje.
                chatId: resume?.id ?? '',
                resumeConversationId: resume?.conversationId || undefined,
                initialSettings: resume
                    ? {model: resume.model, effort: resume.effort, mode: resume.mode}
                    : undefined,
            })
            if (resume?.conversationId) void ResumeAgentChat(id, resume.conversationId).catch(() => {})
        },
        [],
    )

    const openChat = useCallback(
        (opts?: OpenChatOptions) => {
            if (opts?.context) setPinned(opts.context)
            setOpen(true)
            if (opts?.prompt) setSeed({text: opts.prompt, token: Date.now()})
        },
        [],
    )

    // Al abrir sin sesión, arrancar una con el agente activo. Si no hay
    // ninguno elegido no se elige por el usuario: el panel abre mostrando la
    // lista, que es la pregunta que corresponde hacer.
    useEffect(() => {
        if (!open || session || !activeAgent) return
        startSession(activeAgent)
    }, [open, session, activeAgent, startSession])

    const api = useMemo<AgentChatApi>(
        () => ({
            open: openChat,
            close: () => setOpen(false),
            toggle: () => setOpen((v) => !v),
            isOpen: open,
            hasAgent: available.length > 0,
            activeAgentLabel: activeAgent?.label ?? '',
        }),
        [openChat, open, available.length, activeAgent?.label],
    )

    // Atajo global. Cmd/Ctrl+L y no una tecla de función: es el mismo gesto en
    // las dos plataformas y no choca con nada que el editor ya use.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l') {
                e.preventDefault()
                setOpen((v) => !v)
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [])

    const loadHistory = useCallback(() => {
        ListAllAgentChats()
            .then((h) => setHistory(h ?? []))
            .catch(() => setHistory([]))
    }, [])

    // El primer mensaje es lo que crea la entrada del historial, con el texto
    // como título — la misma convención que ya usaba la pestaña Git.
    const onFirstSend = useCallback(
        (text: string) => {
            setSession((prev) => {
                if (!prev || prev.chatId) return prev
                const title = text.trim().split('\n')[0].slice(0, 80)
                void CreateAgentChat(prev.id, repoIdOf(effective), prev.agentId, title, effective.kind, effective.id).catch(
                    () => {},
                )
                return {...prev, chatId: prev.id}
            })
        },
        [effective],
    )

    const chooseAgent = useCallback(
        (agentId: string) => {
            const agent = available.find((a) => a.id === agentId)
            if (!agent) return
            void SetAgentActive(agentId, '', '')
                .then(() => AgentActive())
                .then(setActive)
                .catch(() => {})
            // Cambiar de agente abre una conversación nueva: la continuidad la
            // guarda cada CLI en su propio almacenamiento, así que no hay forma
            // honesta de seguir con otro lo que venía uno.
            startSession(agent)
        },
        [available, startSession],
    )

    const panel = (
        <div className="flex h-full min-h-0 min-w-0 flex-col bg-surface">
            <div className="flex shrink-0 items-center gap-1.5 border-b border-outline-variant bg-surface-container px-2 py-1 text-[11px]">
                <Icon name="forum" size={13} className="shrink-0 text-primary" />
                <span className="font-medium text-on-surface">Agente</span>

                {/* Selector del agente activo de la APP. Vive acá y no suelto en
                    el toolbar principal por la regla de configuración de
                    .claude/rules/conventions.md: es un ajuste del chat, y su
                    lugar natural es la barra del chat. */}
                <select
                    value={active?.id ?? ''}
                    onChange={(e) => chooseAgent(e.target.value)}
                    title={
                        available.length === 0
                            ? 'No hay ningún CLI agéntico instalado en esta máquina. Configuralos en Configuración → Agentes.'
                            : 'Con qué agente hablás. Cambiarlo empieza una conversación nueva: el historial lo guarda cada CLI por su cuenta, así que otro no puede continuar la anterior.'
                    }
                    disabled={available.length === 0}
                    className="max-w-40 rounded border border-outline-variant bg-surface px-1 py-0.5 text-on-surface outline-none focus:border-primary disabled:opacity-50"
                >
                    <option value="">{available.length === 0 ? 'Ninguno instalado' : 'Elegí un agente'}</option>
                    {available.map((a) => (
                        <option key={a.id} value={a.id}>
                            {a.label}
                        </option>
                    ))}
                </select>

                <button
                    onClick={() => {
                        setHistoryOpen((v) => !v)
                        if (!historyOpen) loadHistory()
                    }}
                    title="Conversaciones anteriores de TODOS los módulos, no solo de este. Retomar una la continúa donde había quedado."
                    className={`shrink-0 rounded p-0.5 ${
                        historyOpen ? 'bg-surface-variant text-on-surface' : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
                    }`}
                >
                    <Icon name="history" size={14} />
                </button>

                <span className="ml-auto flex shrink-0 items-center gap-0.5">
                    {(['left', 'right', 'bottom', 'float'] as AgentDock[]).map((d) => (
                        <button
                            key={d}
                            onClick={() => onLayoutChange(d, size)}
                            title={
                                d === 'float'
                                    ? 'Ventana flotante: el chat queda por encima del contenido, sin quitarle ancho'
                                    : `Anclar el panel a la ${d === 'left' ? 'izquierda' : d === 'right' ? 'derecha' : 'parte de abajo'}`
                            }
                            className={`rounded p-0.5 ${
                                dock === d ? 'bg-primary/20 text-primary' : 'text-on-surface-variant hover:bg-surface-variant'
                            }`}
                        >
                            <Icon
                                name={
                                    d === 'float'
                                        ? 'picture_in_picture'
                                        : d === 'bottom'
                                          ? 'dock_to_bottom'
                                          : d === 'left'
                                            ? 'dock_to_left'
                                            : 'dock_to_right'
                                }
                                size={13}
                            />
                        </button>
                    ))}
                    <button
                        onClick={() => setOpen(false)}
                        title="Cierra el panel. La conversación queda como está: volver a abrirlo la retoma."
                        className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="close" size={14} />
                    </button>
                </span>
            </div>

            {historyOpen && (
                <div className="max-h-56 shrink-0 overflow-y-auto border-b border-outline-variant bg-surface-container-low">
                    {history.length === 0 ? (
                        <p className="px-2 py-2 text-[11px] text-on-surface-variant">
                            Todavía no hay conversaciones guardadas. Una entra al historial con su primer mensaje.
                        </p>
                    ) : (
                        history.map((c) => {
                            const agent = agentList.find((a) => a.id === c.agentId)
                            const kind = (c.module || 'none') as WorkContext['kind']
                            return (
                                <button
                                    key={c.id}
                                    onClick={() => {
                                        if (!agent) return
                                        startSession(agent, c)
                                        setHistoryOpen(false)
                                    }}
                                    disabled={!agent}
                                    title={
                                        agent
                                            ? `Retoma esta conversación con ${agent.label}. Los mensajes los tiene el CLI: se vuelven a dibujar al abrirla.`
                                            : `Esta conversación es de ${c.agentId}, que no está instalado en esta máquina.`
                                    }
                                    className="flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] hover:bg-surface-container-high disabled:opacity-50"
                                >
                                    <Icon
                                        name={CONTEXT_ICONS[kind] ?? 'smart_toy'}
                                        size={12}
                                        className="shrink-0 text-on-surface-variant"
                                    />
                                    <span className="min-w-0 flex-1 truncate text-on-surface">
                                        {c.title || 'Sin título'}
                                    </span>
                                    <span className="shrink-0 text-on-surface-variant/70">{agent?.label ?? c.agentId}</span>
                                </button>
                            )
                        })
                    )}
                </div>
            )}

            <div className="min-h-0 flex-1">
                {session ? (
                    <AgentChat
                        key={session.id}
                        sessionId={session.id}
                        context={effective}
                        agentId={session.agentId}
                        agentLabel={session.agentLabel}
                        seed={seed}
                        resumeConversationId={session.resumeConversationId}
                        initialSettings={session.initialSettings}
                        onSend={onFirstSend}
                        onConversation={(conversationId) => {
                            if (session.chatId) void TouchAgentChat(session.chatId, conversationId).catch(() => {})
                        }}
                    />
                ) : (
                    // Estado vacío honesto: dice CUÁL falta y dónde se
                    // configura, en vez de una caja de texto que no contesta.
                    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-[11px] text-on-surface-variant">
                        <Icon name="smart_toy" size={28} className="opacity-40" />
                        {available.length === 0 ? (
                            <>
                                <p className="text-on-surface">No hay ningún agente instalado</p>
                                <p>
                                    mini-tools usa los CLIs que ya tengas: Claude Code, Codex o Antigravity. Instalá uno y
                                    aparecerá acá — la autenticación la sigue manejando cada CLI.
                                </p>
                            </>
                        ) : (
                            <p>Elegí un agente arriba para empezar.</p>
                        )}
                    </div>
                )}
            </div>
        </div>
    )

    // El panel arrastrable comparte el ancho con el contenido; el flotante se
    // superpone. Son dos disposiciones y no dos componentes: adentro es
    // exactamente el mismo chat, con la misma conversación.
    const docked = open && dock !== 'float'
    const floating = open && dock === 'float'

    const onResize = (e: React.MouseEvent) => {
        e.preventDefault()
        const horizontal = dock !== 'bottom'
        const start = horizontal ? e.clientX : e.clientY
        const initial = size
        const move = (ev: MouseEvent) => {
            const delta = horizontal ? (dock === 'right' ? start - ev.clientX : ev.clientX - start) : start - ev.clientY
            const next = Math.min(1200, Math.max(240, initial + delta))
            onLayoutChange(dock, next)
        }
        const up = () => {
            window.removeEventListener('mousemove', move)
            window.removeEventListener('mouseup', up)
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
    }

    const handle = (
        <div
            onMouseDown={onResize}
            title="Arrastrar para cambiar el tamaño del panel — queda guardado"
            className={`group flex shrink-0 items-center justify-center bg-surface-container-low hover:bg-primary/30 ${
                dock === 'bottom' ? 'h-1.5 w-full cursor-row-resize' : 'h-full w-1.5 cursor-col-resize'
            }`}
        >
            <div
                className={`rounded-full bg-outline-variant group-hover:bg-primary ${
                    dock === 'bottom' ? 'h-0.5 w-8' : 'h-8 w-0.5'
                }`}
            />
        </div>
    )

    return (
        <AgentChatContext.Provider value={api}>
            <div className={`flex min-h-0 min-w-0 flex-1 ${dock === 'bottom' ? 'flex-col' : 'flex-row'}`}>
                {docked && dock === 'left' && (
                    <>
                        <div className="min-h-0 shrink-0" style={{width: size}}>
                            {panel}
                        </div>
                        {handle}
                    </>
                )}

                <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>

                {docked && dock === 'bottom' && (
                    <>
                        {handle}
                        <div className="min-h-0 shrink-0" style={{height: size}}>
                            {panel}
                        </div>
                    </>
                )}
                {docked && dock === 'right' && (
                    <>
                        {handle}
                        <div className="min-h-0 shrink-0" style={{width: size}}>
                            {panel}
                        </div>
                    </>
                )}
            </div>

            {floating && (
                <div
                    className="fixed bottom-4 right-4 z-20 flex flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface shadow-lg"
                    style={{width: size, height: '70vh'}}
                >
                    {panel}
                </div>
            )}
        </AgentChatContext.Provider>
    )
}

// AgentChatButton es el punto de entrada genérico al chat: sirve desde
// cualquier módulo porque no sabe de ninguno.
//
// Los botones CONTEXTUALES —"analizá este error", "explicá este plan"— llegan
// con las fases que los necesitan (2 y 5), y todos terminan llamando al mismo
// useAgentChat().open({prompt}).
export function AgentChatButton({context}: {context?: WorkContext}) {
    const chat = useAgentChat()
    return (
        <button
            onClick={() => chat.open(context ? {context} : undefined)}
            title={
                chat.hasAgent
                    ? `Abre el chat con ${chat.activeAgentLabel || 'el agente'} (${
                          navigator.platform.includes('Mac') ? '⌘L' : 'Ctrl+L'
                      }). Es la misma conversación en todos los módulos: cambiar de pestaña no la reinicia.`
                    : 'No hay ningún CLI agéntico instalado. mini-tools usa Claude Code, Codex o Antigravity — instalá uno para habilitar el chat.'
            }
            className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${
                chat.isOpen
                    ? 'bg-primary/20 text-primary'
                    : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
            }`}
        >
            <Icon name="forum" size={14} />
            Agente
        </button>
    )
}

// describeContext se re-exporta para los módulos que quieran mostrar sobre qué
// abriría el chat sin importar el archivo de contexto.
export {describeContext, NO_CONTEXT}
