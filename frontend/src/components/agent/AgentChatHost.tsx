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
    DeleteAgentChat,
    ListAllAgentChats,
    ListConnections,
    GitListRepos,
    RenameAgentChat,
    ResumeAgentChat,
    SetAgentActive,
    SetAgentLayout,
    TouchAgentChat,
} from '../../../wailsjs/go/main/App'
import {agents as agentsModel, main, vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import AgentChat from './AgentChat'
import AgentUsagePanel from './AgentUsagePanel'
import AgentHistoryPanel from './AgentHistoryPanel'
import PromptDialog from '../git/PromptDialog'
import {CONTEXT_ICONS, contextKey, repoIdOf, type WorkContext, type WorkContextKind} from './workContext'

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
//     una terminal. Se monta UNA sola vez (Workspace.tsx) y sostiene **una
//     conversación por contexto de trabajo**.
//
// **Una conversación por contexto, no una sola que viaja.** Abrir el chat desde
// la conexión `tigochat` trae la conversación de `tigochat`; desde una terminal
// SSH, la de ese servidor; desde una nota, la de esa nota. Cambiar de pestaña
// cambia de hilo, no continúa el anterior — lo que se habla sobre una base de
// datos no tiene nada que ver con lo de un servidor, y arrastrarlo hace que el
// agente razone sobre contexto que no corresponde. Cada hilo mantiene su
// historial, su modelo y su modo.
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
    // Si este anfitrión aplica en el módulo activo.
    //
    // **En la pestaña Git es false, a propósito.** Ese módulo tiene el agente
    // integrado adentro, con su propio objetivo —trabajar sobre el código del
    // repositorio, con permisos y diff de por medio— y su propia solapa
    // "Agentes". Ofrecer ahí además el botón de la barra superior sería un
    // segundo lugar para abrir un segundo chat sobre lo mismo: ni el botón
    // aparece ni el atajo hace nada mientras la pestaña activa sea un
    // repositorio.
    isAvailable: boolean
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
            isAvailable: false,
            hasAgent: false,
            activeAgentLabel: '',
        }
    )
}

interface Props {
    // Contexto del módulo activo, derivado de la pestaña abierta en Workspace.
    // Cambiar de pestaña cambia de conversación: hay una por contexto.
    context: WorkContext
    // Lo que el usuario está mirando en ese módulo —la consulta del editor
    // SQL— para adjuntarlo al mensaje. Es la diferencia entre preguntar "sobre
    // esta conexión" y preguntar "sobre ESTA consulta".
    working?: {label: string; text: string; language?: string} | null
    dock: AgentDock
    size: number
    onLayoutChange: (dock: AgentDock, size: number) => void
    // Inserta texto donde el usuario está trabajando: el editor SQL, la nota
    // abierta. Es lo que convierte un bloque de código de la respuesta en algo
    // que se usa, en vez de algo que hay que seleccionar y pegar a mano.
    // Devuelve la etiqueta de dónde lo puso, o null si no hay dónde.
    onInsertText?: ((text: string) => void) | null
    insertLabel?: string
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

export default function AgentChatHost({
    context,
    working,
    dock,
    size,
    onLayoutChange,
    onInsertText,
    insertLabel,
    children,
}: Props) {
    const [open, setOpen] = useState(false)
    // Una sesión POR contexto de trabajo, indexadas por su clave. El hilo de
    // una conexión sobrevive a irse a otra pestaña y volver.
    const [sessions, setSessions] = useState<Record<string, Session>>({})
    const [seed, setSeed] = useState<{text: string; token: number} | null>(null)
    const [agentList, setAgentList] = useState<agentsModel.Agent[]>([])
    const [active, setActive] = useState<main.ActiveAgent | null>(null)
    const [history, setHistory] = useState<vault.AgentChat[]>([])
    // Qué ocupa el cuerpo del panel. Son SOLAPAS y no capas apiladas: consumo e
    // historial son pantallas para leer, y mostrarlas encima del chat dejaba a
    // los dos a medias —la lista cortada arriba y la conversación espiando
    // abajo— en un panel que ya es angosto.
    //
    // **El chat no se desmonta al cambiar de solapa, se esconde**: tiene
    // adentro los turnos, lo que se esté escribiendo y la suscripción al stream
    // del CLI. Desmontarlo para mirar el consumo cortaría una respuesta en
    // curso, que es exactamente lo que nadie espera de una solapa.
    const [tab, setTab] = useState<'chat' | 'usage' | 'history'>('chat')
    const usageOpen = tab === 'usage'
    const historyOpen = tab === 'history'
    const [sessionUsage, setSessionUsage] = useState({total: 0, output: 0, cost: 0})
    // Conversación que se está renombrando. El título sale de lo primero que se
    // escribió, que casi nunca es cómo uno la va a buscar después.
    const [renaming, setRenaming] = useState<vault.AgentChat | null>(null)
    // Nombre visible del recurso de cada conversación, resuelto AHORA: una
    // conexión renombrada tiene que verse con su nombre nuevo.
    const [resourceNames, setResourceNames] = useState<Record<string, string>>({})
    // Contexto con el que se abrió el chat cuando el llamador pasó uno
    // explícito. Se prefiere al del módulo activo hasta que el usuario cambie
    // de pestaña, que es cuando el suyo vuelve a mandar.
    const [pinned, setPinned] = useState<WorkContext | null>(null)
    // La sesión vigente para los manejadores que se registran una sola vez o
    // que corren fuera del ciclo de render: el id de conversación puede llegar
    // antes de que React vuelva a renderizar, y una copia vieja lo escribiría
    // en el chat equivocado (o en ninguno).
    const sessionRef = useRef<Session | null>(null)

    const effective = pinned ?? context
    const key = contextKey(effective)
    const session = sessions[key] ?? null
    sessionRef.current = session

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

    // El contexto se fija al crear la conversación y no vuelve a moverse: la
    // conversación ES de ese recurso. (La versión anterior la reasignaba al
    // cambiar de pestaña, cuando había un solo hilo para toda la app.)

    const available = useMemo(() => agentList.filter((a) => a.available), [agentList])
    const activeAgent = useMemo(
        () => available.find((a) => a.id === active?.id) ?? null,
        [available, active?.id],
    )

    const startSession = useCallback(
        (agent: agentsModel.Agent, forKey: string, resume?: vault.AgentChat) => {
            const id = resume?.id ?? `agent-chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
            setSessions((prev) => ({
                ...prev,
                [forKey]: {
                    id,
                    agentId: agent.id,
                    agentLabel: agent.label,
                    // Retomar una conversación reusa SU entrada del historial;
                    // una nueva todavía no tiene, y se crea con el primer
                    // mensaje.
                    chatId: resume?.id ?? '',
                    resumeConversationId: resume?.conversationId || undefined,
                    initialSettings: resume
                        ? {model: resume.model, effort: resume.effort, mode: resume.mode}
                        : undefined,
                },
            }))
            if (resume?.conversationId) void ResumeAgentChat(id, resume.conversationId).catch(() => {})
        },
        [],
    )

    // La pestaña Git tiene el agente adentro, con su propia solapa y su propio
    // objetivo. Este anfitrión se apaga ahí en vez de superponerse.
    const gitOwnsChat = context.kind === 'git'

    // Y si estaba abierto cuando se entra a un repositorio, se cierra: dejarlo
    // encima del banco de trabajo de Git sería mostrar dos chats a la vez.
    useEffect(() => {
        if (gitOwnsChat) setOpen(false)
    }, [gitOwnsChat])

    const openChat = useCallback(
        (opts?: OpenChatOptions) => {
            if (gitOwnsChat) return
            if (opts?.context) setPinned(opts.context)
            setOpen(true)
            if (opts?.prompt) setSeed({text: opts.prompt, token: Date.now()})
        },
        [gitOwnsChat],
    )

    // Al abrir sin sesión, arrancar una con el agente activo. Si no hay
    // ninguno elegido no se elige por el usuario: el panel abre mostrando la
    // lista, que es la pregunta que corresponde hacer.
    useEffect(() => {
        if (!open || session || !activeAgent) return
        startSession(activeAgent, key)
    }, [open, session, activeAgent, startSession, key])

    const api = useMemo<AgentChatApi>(
        () => ({
            open: openChat,
            close: () => setOpen(false),
            toggle: () => !gitOwnsChat && setOpen((v) => !v),
            isOpen: open,
            isAvailable: !gitOwnsChat,
            hasAgent: available.length > 0,
            activeAgentLabel: activeAgent?.label ?? '',
        }),
        [openChat, open, gitOwnsChat, available.length, activeAgent?.label],
    )

    // Atajo global. Cmd/Ctrl+L y no una tecla de función: es el mismo gesto en
    // las dos plataformas y no choca con nada que el editor ya use.
    //
    // No hace nada en la pestaña Git: ahí el chat lo tiene el módulo.
    useEffect(() => {
        if (gitOwnsChat) return
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l') {
                e.preventDefault()
                setOpen((v) => !v)
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [gitOwnsChat])

    const loadHistory = useCallback(() => {
        ListAllAgentChats()
            .then((h) => setHistory(h ?? []))
            .catch(() => setHistory([]))
        // Los nombres se resuelven contra lo que existe HOY: conexiones, SSH y
        // repositorios. Lo que ya no está simplemente no aparece, y la fila se
        // muestra sin recurso en vez de con un nombre que no corresponde a nada.
        Promise.all([ListConnections().catch(() => []), GitListRepos().catch(() => [])])
            .then(([conns, repos]) => {
                const map: Record<string, string> = {}
                for (const c of conns ?? []) map[c.id] = c.name
                for (const r of repos ?? []) map[r.id] = r.name
                setResourceNames(map)
            })
            .catch(() => {})
    }, [])

    // El primer mensaje es lo que crea la entrada del historial, con el texto
    // como título — la misma convención que ya usaba la pestaña Git.
    //
    // La escritura va FUERA del actualizador de estado. Un actualizador de
    // React tiene que ser puro: en modo estricto se lo invoca dos veces, así
    // que meter el INSERT adentro dejaría dos filas por conversación. La
    // guarda contra el doble registro es el ref, no el valor del estado, que
    // todavía no se actualizó cuando llega el segundo evento.
    const creatingChatRef = useRef('')
    const onFirstSend = useCallback(
        (text: string) => {
            const s = sessionRef.current
            if (!s || s.chatId || creatingChatRef.current === s.id) return
            creatingChatRef.current = s.id
            const title = text.trim().split('\n')[0].slice(0, 80)
            void CreateAgentChat(s.id, repoIdOf(effective), s.agentId, title, effective.kind, effective.id).catch(() => {})
            setSessions((prev) =>
                prev[key]?.id === s.id ? {...prev, [key]: {...prev[key], chatId: s.id}} : prev,
            )
        },
        [effective, key],
    )

    const chooseAgent = useCallback(
        (agentId: string) => {
            const agent = available.find((a) => a.id === agentId)
            if (!agent) return
            void SetAgentActive(agentId, '', '')
                .then(() => AgentActive())
                .then(setActive)
                .catch(() => {})
            // Cambiar de agente abre una conversación nueva EN ESTE contexto:
            // la continuidad la guarda cada CLI en su propio almacenamiento,
            // así que no hay forma honesta de seguir con otro lo que venía uno.
            startSession(agent, key)
        },
        [available, startSession, key],
    )

    const panel = (
        <div className="flex h-full min-h-0 min-w-0 flex-col bg-surface">
            <div className="flex shrink-0 items-center gap-1.5 border-b border-outline-variant bg-surface-container px-2 py-1 text-ui-11">
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
                    onClick={() => setTab((t) => (t === 'usage' ? 'chat' : 'usage'))}
                    title={
                        usageOpen
                            ? 'Vuelve a la conversación, que siguió corriendo detrás'
                            : 'Cuánta cuota llevás usada y cuántos tokens gastaste con cada CLI, con tu plan al lado. Ocupa el panel como una solapa: el chat sigue donde estaba.'
                    }
                    className={`shrink-0 rounded p-0.5 ${
                        usageOpen ? 'bg-surface-variant text-on-surface' : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
                    }`}
                >
                    <Icon name="monitoring" size={14} />
                </button>

                <button
                    onClick={() => {
                        if (!historyOpen) loadHistory()
                        setTab((t) => (t === 'history' ? 'chat' : 'history'))
                    }}
                    title={
                        historyOpen
                            ? 'Vuelve a la conversación, que siguió corriendo detrás'
                            : 'Conversaciones anteriores de TODOS los módulos, no solo de este. Retomar una la continúa donde había quedado. Ocupa el panel como una solapa.'
                    }
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

            <div className="flex min-h-0 flex-1 flex-col">
            {usageOpen && (
                <AgentUsagePanel
                    agentLabel={(id) => agentList.find((a) => a.id === id)?.label ?? id}
                    session={sessionUsage}
                    onClose={() => setTab('chat')}
                />
            )}

            {historyOpen && (
                <AgentHistoryPanel
                    // Al abrirlo desde un módulo arranca filtrado a ESE módulo:
                    // quien viene de una conexión busca la conversación de esa
                    // conexión, no las nueve de todo el programa. El botón del
                    // encabezado del panel muestra el resto.
                    chats={history}
                    initialFilterKind={effective.kind}
                    agents={agentList}
                    resourceNames={resourceNames}
                    onOpen={(c) => {
                        const agent = agentList.find((a) => a.id === c.agentId)
                        if (!agent) return
                        // Se retoma EN SU contexto, no en el que estés mirando:
                        // una conversación pertenece al recurso donde nació.
                        //
                        // **Y hay que FIJAR ese contexto, no solo guardar la
                        // sesión bajo su clave.** El cuerpo del panel dibuja
                        // `sessions[contextKey(effective)]`: guardarla bajo la
                        // clave de la conversación sin mover `effective` la
                        // deja en un casillero que nadie está mirando, y el
                        // clic no hace nada visible. Era el motivo por el que
                        // el historial "no cargaba" — la conversación se
                        // retomaba de verdad (hasta se llamaba a
                        // ResumeAgentChat), simplemente no se mostraba.
                        const kind = (c.module || 'none') as WorkContextKind
                        const chatContext: WorkContext = {
                            kind,
                            // 'none' no tiene recurso: contextKey lo ignora, y
                            // arrastrar un id acá haría que dos conversaciones
                            // viejas parecieran de contextos distintos.
                            id: kind === 'none' ? '' : c.contextId,
                            label: resourceNames[c.contextId] ?? '',
                        }
                        setPinned(chatContext)
                        startSession(agent, contextKey(chatContext), c)
                        setTab('chat')
                    }}
                    onRename={(c) => setRenaming(c)}
                    onDelete={(c) => {
                        void DeleteAgentChat(c.id)
                            .then(loadHistory)
                            .catch(() => {})
                    }}
                    onClose={() => setTab('chat')}
                />
            )}

            {/* `hidden` y no un desmontaje: ver el comentario de `tab`. */}
            <div className={`min-h-0 flex-1 ${tab === 'chat' ? '' : 'hidden'}`}>
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
                        working={working}
                        onInsertText={onInsertText ?? undefined}
                        onSessionUsage={setSessionUsage}
                        insertLabel={insertLabel}
                        onSend={onFirstSend}
                        onConversation={(conversationId) => {
                            // Por el ref y no por `session`: el id de
                            // conversación llega apenas el CLI contesta, que
                            // puede ser antes de que el render con el chatId
                            // recién creado haya ocurrido.
                            const chatId = sessionRef.current?.chatId
                            if (chatId) void TouchAgentChat(chatId, conversationId).catch(() => {})
                        }}
                    />
                ) : (
                    // Estado vacío honesto: dice CUÁL falta y dónde se
                    // configura, en vez de una caja de texto que no contesta.
                    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-ui-11 text-on-surface-variant">
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

            {renaming && (
                <PromptDialog
                    title="Cambiar el nombre de la conversación"
                    label="Nombre"
                    initial={renaming.title}
                    confirmLabel="Guardar"
                    description="Es solo el nombre con el que la vas a encontrar acá. No toca la conversación que el CLI tiene guardada."
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
    // En la pestaña Git no se dibuja: ese módulo ya tiene el agente adentro,
    // con su solapa "Agentes" y su propio objetivo. Un segundo botón arriba
    // sería un segundo lugar para abrir un segundo chat sobre lo mismo.
    if (!chat.isAvailable) return null
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

