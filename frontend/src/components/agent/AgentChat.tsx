import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {
    AgentChatHistory,
    AgentChatModes,
    AgentModelCatalog,
    CancelAgentChat,
    GitListWorkTree,
    RespondAgentApproval,
    SaveChatAttachment,
    AgentResolveRefs,
    SetAgentChatSettings,
    ResetAgentChat,
    SendAgentChat,
} from '../../../wailsjs/go/main/App'
import {EventsOn} from '../../../wailsjs/runtime'
import {agentctx, agentmodels} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import Select from '../Select'
import ConfirmDialog from '../ConfirmDialog'
import MarkdownPreview from '../MarkdownPreview'
import AgentRefPicker from './AgentRefPicker'
import ChatCodeBlock from './ChatCodeBlock'
import {CONTEXT_ICONS, CONTEXT_NOUNS, describeContext, repoIdOf, type WorkContext} from './workContext'

// Espeja ChatEvent / ToolCall / Usage (backend/agentchat/types.go).
//
// Se escribe a mano y no sale de wailsjs/go/models por el mismo motivo que
// LocalTermEvent en LocalTerminalPanel.tsx: estos tipos viajan por un EVENTO
// de Wails, no por el valor de retorno de un binding, y el generador solo
// tipa lo segundo. Si cambia el Go, hay que cambiar esto — está anotado en
// .claude/specs/go-react-contract.md.
interface ToolCall {
    name: string
    input: string
    // Línea legible de lo que hizo (el archivo, el comando). Vacía cuando la
    // herramienta no se reconoce: ahí se muestra solo el nombre.
    summary: string
    // Efecto medible, cuando se puede calcular ("18 líneas").
    detail: string
}

interface ChatUsage {
    input: number
    output: number
    cacheRead: number
    thinking: number
    total: number
    // costUsd 0 significa "el CLI no lo informa", no "salió gratis": solo
    // Claude Code lo manda.
    costUsd: number
}

interface ChatEvent {
    kind: 'start' | 'text' | 'thinking' | 'tool' | 'done' | 'error'
    text: string
    tool?: ToolCall
    usage?: ChatUsage
    conversationId?: string
    model?: string
    tools?: string[]
    mcpServers?: string[]
    error?: string
}

// Chat con un agente, sobre el modo headless del CLI (backend/agentchat).
//
// Convive con la terminal, no la reemplaza: en el PTY se ve el CLI tal cual
// es, con su propio diálogo de permisos y su render; acá se ve la conversación
// entendida —texto, llamadas a herramienta plegables, tokens del turno— que un
// stream de bytes con ANSI no permite dibujar.
//
// **Cómo se maneja el permiso acá, que es la parte delicada.** Por defecto el
// agente no puede modificar nada: sin modo explícito, una edición que necesita
// confirmación no se puede aprobar desde un chat y el CLI la salta. Para que
// trabaje solo hay que elegirlo, y elegirlo abre una aprobación que dice qué
// va a poder hacer; una vez aprobada vale para la sesión, porque preguntar en
// cada mensaje volvería inútiles esos modos. Después de un turno autónomo se
// avisa cuántos archivos quedaron tocados y se ofrece revisarlos o
// descartarlos: los cambios caen en un repositorio git, así que esa vuelta
// atrás ya existía — esto solo la pone donde el usuario está mirando.
//
// Lo que NO se hace, ni siquiera con el modo más permisivo, es pasarle la
// bandera que saltea TODOS los permisos: esa cubre además ejecutar comandos
// arbitrarios, y no es lo mismo que editar archivos versionados.

// Etiquetas de los modos de permisos. El orden de la lista lo decide el
// backend (de menos a más permisivo) y no todos los agentes tienen todos:
// "auto" hoy es solo de Claude Code.
//
// PERMISSIVE son los modos en los que el agente actúa sin volver a
// preguntarte: hay que aprobarlos explícitamente antes de que queden activos.
//
// Que un agente trabaje solo es justamente para lo que sirven estos modos —y
// por eso existen— pero pasar a uno tiene que ser una decisión tomada, no el
// resultado de rozar un desplegable. La aprobación es del usuario y va
// primero; el modo se aplica después.
const PERMISSIVE = new Set(['auto', 'edit'])

// Tres arranques por módulo. No son plantillas mágicas: son las preguntas que
// uno hace igual, escritas para no tener que pensarlas frente a una caja vacía.
// Íconos de los arranques, en el mismo orden que STARTERS: se leen de un
// vistazo antes que el texto.
const STARTER_ICONS: Record<string, string[]> = {
    db: ['menu_book', 'speed', 'table_chart'],
    ssh: ['bolt', 'description', 'storage'],
    http: ['menu_book', 'troubleshoot', 'fact_check'],
    note: ['summarize', 'rule', 'add_notes'],
    git: ['difference', 'rate_review', 'commit'],
    none: ['help'],
}

function formatClock(at?: number): string {
    return at ? new Date(at).toLocaleTimeString('es', {hour: '2-digit', minute: '2-digit'}) : ''
}

const STARTERS: Record<string, string[]> = {
    db: ['Explicá esta consulta', 'Optimizá esta consulta', '¿Qué tablas tiene esta conexión?'],
    ssh: ['¿Qué falló acá?', 'Explicá este log', '¿Cómo reviso el uso de disco?'],
    http: ['Explicá esta respuesta', '¿Por qué falla esta petición?', 'Escribí pruebas para este endpoint'],
    note: ['Resumí esta nota', '¿Este procedimiento sigue teniendo sentido?', 'Ampliá el último paso'],
    git: ['¿Qué cambió en esta rama?', 'Revisá los cambios preparados', 'Escribí el mensaje del commit'],
    none: ['¿Qué podés hacer en mini-tools?'],
}

// Espeja agentapprove.Request: la acción que el agente quiere hacer y sobre la
// que hay que decidir. Viaja por evento, así que se escribe a mano igual que
// ChatEvent.
interface ApprovalRequest {
    id: string
    tool: string
    input: string
    summary: string
    detail: string
}

const MODE_ICONS: Record<string, string> = {
    '': 'visibility',
    plan: 'map',
    approve: 'verified_user',
    auto: 'bolt',
    edit: 'edit_document',
}

const MODE_LABELS: Record<string, {label: string; hint: string; danger?: boolean}> = {
    '': {
        label: 'Solo consulta',
        hint: 'Lee, razona y propone. Sin modo explícito, una edición que necesita confirmación no se puede aprobar desde el chat y el agente la salta.',
    },
    plan: {
        label: 'Plan',
        hint: 'Explora y arma un plan sin tocar ningún archivo. Es el modo honesto para "decime cómo harías esto".',
    },
    approve: {
        label: 'Aprobar cada acción',
        hint: 'El agente trabaja, pero te pregunta antes de CADA acción y espera tu respuesta. Es el modo con más control: no hace nada que no hayas autorizado, una por una.',
    },
    auto: {
        label: 'Automático',
        hint: 'El CLI aprueba solo lo que pasa su propio control de seguridad y frena en lo riesgoso. Lo decide él, no esta app.',
    },
    edit: {
        label: 'Aplicar ediciones',
        hint: 'El agente MODIFICA archivos del repositorio sin preguntar. Los cambios caen en el árbol de trabajo: se ven en Cambios y se descartan desde ahí. Nunca se le da permiso para ejecutar cualquier comando.',
        danger: true,
    },
}


// Bloque de contexto adjunto al próximo mensaje: lo que un módulo le pasa al
// chat al abrirlo (las líneas que se analizaron, la respuesta de un análisis
// anterior). Se ve como una ficha, se puede desplegar para leerlo entero y se
// quita con un clic antes de mandar — mismo criterio que las referencias `@`:
// lo que sale de la máquina tiene que poder verse antes.
export interface ChatContextBlock {
    label: string
    text: string
    language?: string
    icon?: string
}

interface Turn {
    role: 'user' | 'agent'
    text: string
    // Etiquetas de los bloques de contexto que viajaron con este mensaje. Solo
    // se muestran: el texto entero ya se vio en la ficha antes de mandarlo.
    contexts?: string[]
    // Cuándo se escribió o empezó a llegar. Los turnos redibujados desde el
    // historial de un CLI no lo traen, y ahí no se muestra hora: inventarla
    // sería peor que no tenerla.
    at?: number
    tools: ToolCall[]
    usage?: ChatUsage
    error?: string
}

interface AgentChatProps {
    sessionId: string
    // Sobre qué se está preguntando. Reemplaza al `repoId` obligatorio que
    // tenía este componente cuando vivía dentro del módulo Git: es el MISMO
    // componente el que ahora se abre desde el editor SQL, una terminal SSH o
    // una nota, donde no hay repositorio.
    //
    // El contexto es lo que separa los dos propósitos del agente. Sobre un
    // repositorio el trabajo es de CÓDIGO: se ofrecen los modos que editan,
    // porque lo que haga cae en el árbol de trabajo y se descarta desde
    // Cambios, y el selector de @ ofrece archivos. Fuera de un repositorio el
    // trabajo es CONSULTAR: no hay modos permisivos —no habría diff que mirar
    // ni nada que descartar—, el subproceso corre en un directorio vacío y el
    // selector ofrece conexiones, tablas y planes.
    //
    // **Hay una conversación por contexto**: cambiar de pestaña cambia de hilo,
    // no continúa el anterior. Ver AgentChatHost.
    context: WorkContext
    agentId: string
    agentLabel: string
    // Prompt que llega desde afuera (el botón Preguntar del editor o del
    // diff). Lleva token por el mismo motivo que en el editor: pedir dos veces
    // lo mismo tiene que volver a llenarlo.
    seed?: {text: string; token: number; attachments?: ChatContextBlock[]} | null
    // Avisa que el seed ya se aplicó, para que el anfitrión lo suelte.
    onSeedConsumed?: () => void
    // Conversación del CLI a la que pertenece este chat. Al retomarlo se usa
    // para volver a dibujar lo que ya se habló — la continuidad de la charla
    // no depende de esto, la maneja el backend con el mismo id.
    resumeConversationId?: string
    // Ajustes con los que venía este chat (migración 32). El MODO llega pero
    // no se aplica solo: ver el efecto de abajo.
    initialSettings?: {model: string; effort: string; mode: string}
    // Se llama al terminar un turno que corrió en un modo permisivo. Devuelve
    // cuántos archivos quedaron modificados en el árbol de trabajo.
    //
    // Es la otra mitad de dejar que un agente trabaje solo: aprobar el modo
    // antes sirve de poco si después no se ve qué tocó. Como los cambios caen
    // en un repositorio git, revisarlos y descartarlos ya es posible — esto
    // solo lo pone donde el usuario está mirando en ese momento.
    onTurnFinished?: () => Promise<number>
    // Lleva a la vista de Cambios, con el diff de lo que hizo el agente.
    onReviewChanges?: () => void
    // Manda un bloque de código de la respuesta a donde el usuario trabaja: el
    // editor SQL, la nota abierta. Sin esto los bloques solo se copian — que es
    // lo correcto en un módulo donde no hay dónde insertar nada.
    onInsertText?: (text: string) => void
    insertLabel?: string
    // Dónde cae lo insertado. En una terminal un salto de línea es un Enter, así
    // que ahí solo se ofrece insertar bloques de UN comando — ver ChatCodeBlock.
    insertTarget?: 'editor' | 'terminal'
    // Lo gastado en esta conversación, para que el panel de consumo pueda
    // mostrarlo junto al del mes. Lo calcula este componente porque es quien
    // recibe el informe de cada turno.
    onSessionUsage?: (usage: {total: number; output: number; cost: number}) => void
    // Abre OTRO chat, con otro agente, para que revise lo que este viene
    // haciendo. Es el caso de trabajar en paralelo: uno propone, otro valida.
    onValidateWithAnother?: (excludeAgentId: string) => void
    // Avisa el id de conversación que devolvió el CLI. Es lo que se guarda
    // para poder retomar el chat después de cerrar la app — sin esto el
    // historial tendría entradas que no llevan a ningún lado.
    onConversation?: (conversationId: string) => void
    // Se llama con el texto de CADA mensaje que sale. El anfitrión usa el
    // primero para crear la entrada del historial con ese texto como título:
    // una conversación a la que nunca se le escribió nada no es historial, es
    // una ventana que se abrió.
    onSend?: (text: string) => void
    // Lo que estás mirando AHORA en el módulo, adjuntado automáticamente al
    // mensaje: la consulta del editor SQL, por ejemplo.
    //
    // Es la diferencia entre "preguntale al agente sobre esta conexión" y
    // "preguntale sobre ESTA consulta". Va como ficha desplegable y se puede
    // sacar: adjuntar algo sin que se vea es lo mismo que mandarlo a escondidas.
    working?: {label: string; text: string; language?: string} | null
    // Si este chat es el que se está VIENDO. El anfitrión mantiene montada una
    // conversación por módulo —cambiar de pestaña no puede cortar un turno en
    // curso— y esconde con CSS las que no corresponden al módulo activo, así
    // que hay varias instancias vivas a la vez.
    //
    // Lo único que no puede duplicarse entre ellas es la petición de
    // aprobación: llega por un evento GLOBAL, sin id de sesión, así que si la
    // atendieran todas aparecerían tres diálogos para un solo permiso. La
    // atiende la visible, que es la que el usuario puede contestar.
    active?: boolean
}

// formatTokens abrevia los totales. Una sesión larga llega a millones, y
// "1.283.945" en una barra de estado es ruido: lo que importa es el orden de
// magnitud.
function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
    return String(n)
}

// formatElapsed muestra el tiempo del turno en curso. Pasa a minutos porque
// "184s" obliga a hacer la cuenta justo cuando uno está evaluando si esperar.
function formatElapsed(sec: number): string {
    if (sec < 60) return `${sec}s`
    return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`
}

export default function AgentChat({
    sessionId,
    context,
    agentId,
    agentLabel,
    seed,
    onSeedConsumed,
    resumeConversationId,
    initialSettings,
    onTurnFinished,
    onReviewChanges,
    onValidateWithAnother,
    onConversation,
    onSend,
    working,
    onInsertText,
    insertLabel,
    insertTarget,
    onSessionUsage,
    active = true,
}: AgentChatProps) {
    const [turns, setTurns] = useState<Turn[]>([])
    // Qué mensaje se acaba de copiar, para confirmarlo en el botón. Sin la
    // confirmación no hay forma de saber si el clic hizo algo: el portapapeles
    // no se ve.
    const [copiedTurn, setCopiedTurn] = useState<number | null>(null)
    // Acumulado de la conversación: la suma de lo que informó cada turno.
    //
    // Es lo consumido, **no lo que queda del plan**. Cuánto queda no está en
    // ningún archivo local — lo sabe el servidor, y cada CLI lo contesta con
    // su propio comando (`/status`, `/usage`). Inventar acá un "te queda 18%"
    // sería la clase de número que se lee mal y se cree igual, así que se
    // muestra lo que sí es verificable y se dice dónde ver el resto.

    // Se avisa hacia afuera cada vez que cambia: el panel de consumo vive en
    // el anfitrión, que no ve los turnos.
    const onSessionUsageRef = useRef(onSessionUsage)
    onSessionUsageRef.current = onSessionUsage

    // Qué mostrar mientras trabaja: la última herramienta que llamó en este
    // turno, que es lo que explica la demora, o "pensando" si todavía no
    // llamó a ninguna.
    const workingLabel = useMemo(() => {
        const last = turns[turns.length - 1]
        const tool = last && last.role === 'agent' ? last.tools?.[last.tools.length - 1] : undefined
        if (!tool) return `${agentLabel} está pensando…`
        return tool.summary ? `${tool.name} · ${tool.summary}` : `${tool.name}…`
    }, [turns, agentLabel])

    const sessionUsage = useMemo(
        () =>
            turns.reduce(
                (acc, t) => ({
                    total: acc.total + (t.usage?.total ?? 0),
                    output: acc.output + (t.usage?.output ?? 0),
                    cost: acc.cost + (t.usage?.costUsd ?? 0),
                }),
                {total: 0, output: 0, cost: 0},
            ),
        [turns],
    )

    useEffect(() => {
        onSessionUsageRef.current?.(sessionUsage)
    }, [sessionUsage])

    const [input, setInput] = useState('')
    const [busy, setBusy] = useState(false)
    // Segundos que lleva el turno en curso. Un agente puede tardar minutos
    // leyendo archivos, y sin un número en pantalla no hay forma de
    // distinguir "está pensando" de "se colgó" — que es la duda que hace que
    // uno cancele y vuelva a empezar sin necesidad.
    const [elapsed, setElapsed] = useState(0)

    useEffect(() => {
        if (!busy) {
            setElapsed(0)
            return
        }
        // Se cuenta acá y no con un timestamp de inicio para que el intervalo
        // exista solo mientras el turno corre: un chat abierto sin actividad
        // no tiene por qué estar despertando a React cada segundo.
        const t = setInterval(() => setElapsed((n) => n + 1), 1000)
        return () => clearInterval(t)
    }, [busy])
    const [info, setInfo] = useState<{model: string; tools: number; mcp: string[]} | null>(null)
    // Controles del turno. Arrancan en lo menos permisivo y en el default del
    // CLI: que la app elija por el usuario un modo que escribe archivos, o un
    // modelo que cuesta distinto, no es algo que nadie haya pedido.
    const [mode, setMode] = useState('')
    const [effort, setEffort] = useState('')
    const [model, setModel] = useState('')
    const [modes, setModes] = useState<string[]>([''])
    // Catálogo del agente: modelos y niveles de esfuerzo, sacados del propio
    // CLI. Ver backend/agentmodels para por qué no está escrito a mano.
    const [catalog, setCatalog] = useState<agentmodels.Catalog | null>(null)
    // Modo permisivo elegido y todavía SIN aprobar. Hasta que el usuario
    // confirme, el modo activo sigue siendo el anterior.
    const [pendingMode, setPendingMode] = useState<string | null>(null)
    // Cuántos archivos quedaron modificados después de un turno autónomo, o
    // null cuando no hay nada que revisar.
    const [touched, setTouched] = useState<number | null>(null)
    // Acción esperando tu decisión. El proceso del agente está BLOQUEADO
    // mientras esto está abierto, así que el diálogo no se puede descartar
    // sin contestar: cerrarlo es denegar.
    const [approval, setApproval] = useState<ApprovalRequest | null>(null)
    // ConfirmDialog llama onConfirm y DESPUÉS onClose, así que confirmar
    // dispararía las dos ramas: permitir y luego denegar. Este guard hace que
    // la primera respuesta sea la única — y del otro lado hay un proceso
    // bloqueado esperando, así que mandar dos veredictos contradictorios no es
    // un detalle cosmético.
    const answeredRef = useRef('')
    // Rutas del repositorio para el selector de @. Se piden una vez al abrir
    // el chat y no en cada tecla: el árbol no cambia mientras escribís, y
    // pedirlo por pulsación haría una llamada al backend por letra.
    const [paths, setPaths] = useState<string[]>([])
    // Consulta activa del selector: lo que hay escrito después de la última @.
    // null cuando no se está escribiendo una referencia.
    const [mention, setMention] = useState<string | null>(null)
    // Primera sugerencia utilizable del selector, que es la que elige Enter.
    // La calcula el selector —él tiene la lista— y la reporta acá.
    const [firstSuggestion, setFirstSuggestion] = useState<{insert: string; partial: boolean} | null>(null)
    // Referencias `@tipo:valor` ya resueltas por el backend, para las fichas
    // desplegables del compositor.
    const [resolvedRefs, setResolvedRefs] = useState<agentctx.Resolved[]>([])
    // Si el contexto de trabajo va adjunto al próximo mensaje. Arranca en sí
    // cuando hay algo que adjuntar —es lo que estás mirando— y se saca con un
    // clic.
    const [attachWorking, setAttachWorking] = useState(true)
    const inputRef = useRef<HTMLTextAreaElement>(null)
    // Imágenes adjuntas al próximo mensaje: rutas ya escritas en el disco,
    // porque los tres CLIs las reciben por ruta y no en memoria.
    const [attachments, setAttachments] = useState<string[]>([])
    // Bloques de contexto que trajo el módulo que abrió el chat. Viajan con el
    // próximo mensaje y se vacían al mandarlo.
    const [contextBlocks, setContextBlocks] = useState<ChatContextBlock[]>([])
    // Ficha de contexto desplegada arriba de la caja, para leer entera.
    const [openBlock, setOpenBlock] = useState<number | null>(null)
    // Mensajes escritos MIENTRAS el agente trabaja. Se mandan solos cuando
    // termina el turno, en orden.
    //
    // **El vacío que llena.** Enter con el agente ocupado no hacía nada: se
    // escribía la corrección que a uno se le acababa de ocurrir, se apretaba
    // Enter y el texto se quedaba ahí, sin que nada dijera por qué. La opción
    // de mandarlo igual no existe —el CLI atiende un turno a la vez— así que
    // lo que corresponde es guardarlo y mandarlo cuando se pueda.
    const [queue, setQueue] = useState<string[]>([])
    // Un turno que falló corta el envío automático: mandar los cinco mensajes
    // encolados contra un CLI que acaba de morir produce cinco errores más y
    // ninguna respuesta. Se quedan en la cola con un botón para insistir.
    const [queueHeld, setQueueHeld] = useState(false)
    // Búsqueda dentro de la conversación. Una sesión de una hora son decenas de
    // mensajes y hasta ahora la única forma de volver a uno era scrollear
    // hasta encontrarlo — justo lo que no se puede hacer con la mano ocupada.
    //
    // Filtra en vez de resaltar: el texto pasa por el renderizador de Markdown,
    // así que marcar dentro obligaría a intervenir el árbol renderizado. Ver
    // qué mensajes coinciden y poder copiarlos o reusarlos resuelve lo que uno
    // vino a hacer.
    const [search, setSearch] = useState<string | null>(null)
    const scrollRef = useRef<HTMLDivElement>(null)
    // El modo vigente para el manejador de eventos, que se registra una sola
    // vez y no puede cerrarse sobre el `mode` de un render viejo.
    const modeRef = useRef(mode)
    modeRef.current = mode
    const onTurnFinishedRef = useRef(onTurnFinished)
    onTurnFinishedRef.current = onTurnFinished
    const onConversationRef = useRef(onConversation)
    onConversationRef.current = onConversation

    // El árbol de archivos solo existe cuando el contexto es un repositorio.
    // En una conexión de base de datos o una terminal SSH no hay rutas locales
    // que referenciar, y pedirlas igual devolvería un error por un repositorio
    // que nadie nombró.
    const repoId = repoIdOf(context)
    useEffect(() => {
        if (!repoId) {
            setPaths([])
            return
        }
        GitListWorkTree(repoId)
            .then((t) => setPaths(t?.files ?? []))
            .catch(() => setPaths([]))
    }, [repoId])

    // Qué modos soporta ESTE agente lo decide el backend: no son los mismos
    // para todos y duplicar la tabla acá se desincronizaría.
    useEffect(() => {
        AgentModelCatalog(agentId)
            .then(setCatalog)
            .catch(() => setCatalog(null))
    }, [agentId])

    // Los modos permisivos se ofrecen SOLO sobre un repositorio.
    //
    // Lo que hace aceptable dejar que un agente edite sin preguntar es que el
    // resultado cae en el árbol de trabajo de un repositorio git: se ve en
    // Cambios y se descarta con un clic. Fuera de un repositorio esa vuelta
    // atrás no existe — no habría diff que mirar ni nada que descartar—, así
    // que el modo no se ofrece en vez de ofrecerse sin su red.
    useEffect(() => {
        AgentChatModes(agentId)
            .then((m) => {
                const all = m?.length ? m : ['']
                const usable = repoId ? all : all.filter((x) => !PERMISSIVE.has(x))
                setModes(usable.length ? usable : [''])
            })
            .catch(() => setModes(['']))
    }, [agentId, repoId])

    // Si el contexto deja de ser un repositorio con un modo permisivo activo,
    // el modo se baja solo. Mantenerlo sería conservar un permiso que se
    // concedió para otra cosa.
    useEffect(() => {
        if (!repoId && PERMISSIVE.has(mode)) setMode('')
    }, [repoId, mode])

    // Suscripción ANTES de mandar nada: el primer evento puede llegar antes de
    // que termine el await, misma carrera que resuelven la terminal y las
    // queries suscribiéndose primero.
    useEffect(() => {
        const off = EventsOn(sessionId, (ev: ChatEvent) => {
            // Se retiene apenas aparece y no al final del turno: si el turno se
            // corta a la mitad, el chat igual queda retomable.
            if (ev.conversationId) onConversationRef.current?.(ev.conversationId)
            setTurns((prev) => {
                const next = [...prev]
                let last = next[next.length - 1]
                if (!last || last.role !== 'agent') {
                    last = {role: 'agent', text: '', tools: [], at: Date.now()}
                    next.push(last)
                } else {
                    // Los turnos son inmutables para React: mutar el último en
                    // el lugar no dispararía el re-render.
                    last = {...last, tools: [...last.tools]}
                    next[next.length - 1] = last
                }

                switch (ev.kind) {
                    case 'start':
                        setInfo({model: ev.model ?? '', tools: ev.tools?.length ?? 0, mcp: ev.mcpServers ?? []})
                        break
                    case 'text':
                        // Se concatena: Antigravity manda deltas incrementales
                        // y Claude bloques enteros; las dos cosas funcionan
                        // igual concatenando.
                        last.text += ev.text
                        break
                    case 'thinking':
                        break
                    case 'tool':
                        if (ev.tool) last.tools.push(ev.tool)
                        break
                    case 'done':
                        last.usage = ev.usage
                        setBusy(false)
                        // Solo tras un turno que PUDO tocar archivos: en modo
                        // consulta no hay nada que revisar y el aviso sería
                        // ruido en cada respuesta.
                        if (PERMISSIVE.has(modeRef.current)) {
                            void onTurnFinishedRef.current?.().then((n) => setTouched(n > 0 ? n : null))
                        }
                        break
                    case 'error':
                        last.error = ev.error
                        setBusy(false)
                        break
                }
                return next
            })
        })
        return () => {
            off()
        }
    }, [sessionId])

    // Restaurar los ajustes con los que venía el chat.
    //
    // El modelo y el esfuerzo se reponen tal cual: retomar una conversación
    // con el modelo en su default, cuando se había elegido otro, la continúa
    // de una forma distinta de como venía y eso no se nota hasta que la
    // respuesta llega peor.
    //
    // **El MODO no se restaura si era permisivo.** Guardar "podía editar" y
    // reactivarlo solo porque se reabrió una pestaña sería conceder un permiso
    // que nadie volvió a dar. Se vuelve a pedir, que cuesta un clic.
    useEffect(() => {
        if (!initialSettings) return
        setModel(initialSettings.model || '')
        setEffort(initialSettings.effort || '')
        setMode(PERMISSIVE.has(initialSettings.mode) ? '' : initialSettings.mode || '')
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId])

    // Guardar los ajustes cuando cambian, para el próximo turno y para la
    // próxima vez que se abra la app.
    useEffect(() => {
        void SetAgentChatSettings(sessionId, model, effort, mode).catch(() => {})
    }, [sessionId, model, effort, mode])

    // Volver a dibujar la conversación anterior al retomar un chat.
    //
    // Solo al montar y solo si el chat todavía está vacío: si el usuario ya
    // escribió algo, pisarle la pantalla con el historial sería peor que
    // dejarlo. Un historial vacío NO es un error — una conversación borrada
    // desde el propio CLI abre en blanco y sigue encadenando igual, porque eso
    // lo hace el id y no esto.
    useEffect(() => {
        if (!resumeConversationId) return
        let cancelled = false
        AgentChatHistory(agentId, resumeConversationId)
            .then((past) => {
                if (cancelled || !past?.length) return
                setTurns((prev) =>
                    prev.length > 0
                        ? prev
                        : past.map((t) => ({
                              role: t.role === 'user' ? ('user' as const) : ('agent' as const),
                              text: t.text,
                              tools: t.tools ?? [],
                          })),
                )
            })
            .catch(() => {})
        return () => {
            cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resumeConversationId, agentId])

    // Las peticiones de aprobación llegan por un evento GLOBAL y no por el de
    // la sesión: el hook corre en otro proceso y no sabe de qué chat salió.
    // Con una sola sesión pidiendo permiso a la vez —el agente está bloqueado
    // esperando— alcanza con que las atienda el chat visible, que además es el
    // único que puede contestar (ver `active`).
    useEffect(() => {
        if (!active) return
        const off = EventsOn('agent-approval', (req: ApprovalRequest) => setApproval(req))
        return () => {
            off()
        }
    }, [active])

    // Autoscroll al final mientras llega la respuesta.
    useEffect(() => {
        const el = scrollRef.current
        if (el) el.scrollTop = el.scrollHeight
    }, [turns])

    // Lo que llega de afuera se SUMA: pisar lo que el usuario estaba
    // escribiendo por abrir el chat desde otro botón borra trabajo sin avisar.
    useEffect(() => {
        if (!seed) return
        if (seed.attachments?.length) {
            setContextBlocks((prev) => {
                const fresh = seed.attachments!.filter(
                    (b) => b.text.trim() && !prev.some((p) => p.label === b.label && p.text === b.text),
                )
                return [...prev, ...fresh]
            })
        }
        if (seed.text) setInput((prev) => (prev.trim() ? `${prev.replace(/\s+$/, '')} ${seed.text}` : seed.text))
        onSeedConsumed?.()
        // Foco con el cursor al final: se abre el chat para escribir la
        // pregunta, no para ir a buscar la caja con el mouse.
        window.setTimeout(() => {
            const el = inputRef.current
            if (!el) return
            el.focus()
            el.setSelectionRange(el.value.length, el.value.length)
        }, 0)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [seed?.token])

    // Resolver las referencias del mensaje mientras se escribe, para poder
    // mostrar qué se va a mandar. Con retardo porque cada resolución puede
    // leer un archivo o el esquema de una base: hacerlo por pulsación
    // convertiría escribir en una ráfaga de consultas.
    useEffect(() => {
        if (!input.includes('@')) {
            setResolvedRefs([])
            return
        }
        let cancelled = false
        const t = setTimeout(() => {
            AgentResolveRefs(input, context.kind, context.id)
                .then((refs) => {
                    if (!cancelled) setResolvedRefs(refs ?? [])
                })
                .catch(() => {
                    if (!cancelled) setResolvedRefs([])
                })
        }, 350)
        return () => {
            cancelled = true
            clearTimeout(t)
        }
    }, [input, context.kind, context.id])

    // insertMention reemplaza el `@loquesea` que se está escribiendo por lo
    // que se eligió en el selector.
    //
    // `partial` distingue elegir un TIPO (`@db:`) o una conexión (`@db:Prod/`)
    // —donde falta la mitad y el selector se queda abierto para ofrecer el
    // resto— de elegir una referencia completa, que cierra el selector.
    const insertMention = useCallback((insert: string, partial: boolean) => {
        if (!insert) return
        setInput((prev) => {
            const at = prev.lastIndexOf('@')
            if (at < 0) return prev
            return prev.slice(0, at) + insert
        })
        setMention(partial ? insert.replace(/^@/, '') : null)
        inputRef.current?.focus()
    }, [])

    // Los niveles de esfuerzo dependen del MODELO en Codex (su terra acepta
    // `ultra` y los demás no) y del agente en Claude Code. Antigravity no
    // tiene: sus modelos ya llevan el nivel en el nombre.
    const efforts = useMemo(() => {
        const perModel = catalog?.models.find((m) => m.id === model)?.efforts ?? []
        return perModel.length > 0 ? perModel : (catalog?.efforts ?? [])
    }, [catalog, model])

    // Un esfuerzo que el modelo nuevo no acepta se limpia en vez de mandarse:
    // el CLI lo rechazaría y el error saldría por algo que el usuario no
    // eligió.
    useEffect(() => {
        if (effort && efforts.length > 0 && !efforts.includes(effort)) setEffort('')
    }, [efforts, effort])

    // Adjuntar una imagen pegada. Se extrae acá para poder usarlo desde el
    // panel entero y no solo desde la caja de texto: quien acaba de sacar una
    // captura la pega donde tenga el foco, y perderla porque el cursor no
    // estaba en el lugar exacto es una fricción tonta.
    const attachFromClipboard = useCallback((data: DataTransfer | null): boolean => {
        const file = Array.from(data?.items ?? [])
            .find((i) => i.type.startsWith('image/'))
            ?.getAsFile()
        if (!file) return false

        const reader = new FileReader()
        reader.onload = () => {
            const name = file.name || `pegado.${file.type.split('/')[1] || 'png'}`
            void SaveChatAttachment(name, String(reader.result ?? ''))
                .then((path) => setAttachments((prev) => [...prev, path]))
                .catch((err) => setTurns((prev) => [...prev, {role: 'agent', text: '', tools: [], error: String(err)}]))
        }
        reader.readAsDataURL(file)
        return true
    }, [])

    const sendText = useCallback(
        async (raw: string) => {
        const text = raw.trim()
        if (!text) return
        const blocks = contextBlocks
        setTurns((prev) => [
            ...prev,
            {role: 'user', text, tools: [], contexts: blocks.length ? blocks.map((b) => b.label) : undefined, at: Date.now()},
        ])
        setBusy(true)
        setQueueHeld(false)
        // El contexto de trabajo se antepone al mensaje, no lo reemplaza: el
        // agente ve primero qué estás mirando y después qué le preguntás.
        const fence = '```'
        const block = (label: string, body: string, lang?: string) =>
            `${label}:\n\n${fence}${lang ?? ''}\n${body}\n${fence}\n\n`
        const outgoing =
            blocks.map((b) => block(b.label, b.text, b.language)).join('') +
            (attachWorking && working?.text.trim() ? block(working.label, working.text, working.language) : '') +
            text
        setContextBlocks([])
        // Antes de mandar y no después: si el turno falla, la conversación
        // igual existe y se puede reintentar desde el historial.
        onSend?.(text)
        try {
            await SendAgentChat(sessionId, context.kind, context.id, agentId, outgoing, mode, effort, model.trim(), attachments)
            setAttachments([])
        } catch (e) {
            setTurns((prev) => [...prev, {role: 'agent', text: '', tools: [], error: String(e)}])
            setBusy(false)
            // Ver `queueHeld`: lo que quedaba encolado no sale solo detrás de
            // un fallo.
            setQueueHeld(true)
        }
        },
        [sessionId, context.kind, context.id, agentId, mode, effort, model, attachments, onSend, attachWorking, working, contextBlocks],
    )

    // Los turnos que se muestran. Se conserva el índice REAL de cada uno: los
    // botones de copiar y reusar lo usan, y renumerarlos al filtrar haría que
    // "copiado" se encendiera en el mensaje equivocado.
    const visibleTurns = useMemo(() => {
        const q = (search ?? '').trim().toLowerCase()
        const all = turns.map((t, i) => ({t, i}))
        if (!q) return all
        return all.filter(
            ({t}) =>
                t.text.toLowerCase().includes(q) ||
                // También se busca en lo que HIZO el agente: media conversación
                // son llamadas a herramientas, y "¿en qué archivo era?" se
                // contesta ahí y no en la prosa.
                t.tools.some((tool) => `${tool.name} ${tool.detail ?? ''}`.toLowerCase().includes(q)),
        )
    }, [turns, search])

    // Enter con el agente ocupado ENCOLA en vez de no hacer nada.
    const send = useCallback(() => {
        const text = input.trim()
        if (!text) return
        setInput('')
        if (busy) {
            setQueue((prev) => [...prev, text])
            return
        }
        void sendText(text)
    }, [input, busy, sendText])

    // Cuando el turno termina sale el siguiente de la cola. Un solo mensaje por
    // vez: el CLI atiende un turno a la vez y encimarlos sería pedirle algo que
    // no puede hacer.
    // El pestillo evita el envío doble: en desarrollo React monta y corre los
    // efectos dos veces (StrictMode), y sin él el primer mensaje de la cola
    // salía repetido. Vale también fuera de StrictMode — entre que se decide
    // sacar uno y que `busy` vuelve a ser true hay un render de por medio.
    const dequeuingRef = useRef(false)
    useEffect(() => {
        if (busy || queueHeld || queue.length === 0 || dequeuingRef.current) return
        dequeuingRef.current = true
        const [next, ...rest] = queue
        setQueue(rest)
        void sendText(next).finally(() => {
            dequeuingRef.current = false
        })
    }, [busy, queueHeld, queue, sendText])

    return (
        <div
            className="flex h-full min-h-0 flex-col"
            // Pegar y arrastrar funcionan en TODO el panel, no solo en la caja:
            // quien acaba de sacar una captura la suelta donde esté mirando.
            onPaste={(e) => {
                if (attachFromClipboard(e.clipboardData)) e.preventDefault()
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
                if (attachFromClipboard(e.dataTransfer)) e.preventDefault()
            }}
        >
            <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-2 py-1.5 text-ui-11">
                {/* El nombre del agente NO se repite acá: ya está en el
                    selector del encabezado del panel, una línea más arriba.
                    Repetirlo gastaba la línea más visible del chat en un dato
                    que ya estaba a la vista. */}
                {/* Sobre qué está trabajando AHORA. Es la contracara de tener
                    un solo chat para toda la app: la conversación no se
                    reinicia al cambiar de módulo, así que sin esto no habría
                    forma de saber a qué repositorio o a qué conexión se refiere
                    "acá" en el próximo mensaje. */}
                {context.kind !== 'none' && context.label && (
                    <span
                        className="flex min-w-0 shrink items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-medium text-primary"
                        title={`El agente está trabajando sobre ${CONTEXT_NOUNS[context.kind]} «${context.label}». Cambia solo cuando cambiás de módulo, y no reinicia la conversación.`}
                    >
                        <Icon name={CONTEXT_ICONS[context.kind]} size={12} className="shrink-0" />
                        <span className="truncate">{describeContext(context)}</span>
                    </span>
                )}
                {info?.model && <span className="truncate font-mono text-ui-10 text-on-surface-variant">{info.model}</span>}
                {info && info.mcp.length > 0 && (
                    <span
                        className="truncate text-on-surface-variant"
                        title={`Servidores MCP que el CLI reporta al arrancar, con su estado real:\n${info.mcp.join('\n')}`}
                    >
                        · MCP: {info.mcp.length}
                    </span>
                )}
                {/* Segundo agente en paralelo. Cada chat es su propio proceso
                    y su propia conversación, así que el que revisa no
                    interrumpe al que trabaja — y al ser otro modelo, no
                    arrastra los mismos puntos ciegos. */}
                {onValidateWithAnother && (
                    <button
                        onClick={() => onValidateWithAnother(agentId)}
                        title="Abre un chat con OTRO agente para que revise los cambios sin commitear. Corre en paralelo: este chat sigue como está."
                        className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-ui-11 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="fact_check" size={12} />
                        Validar con otro
                    </button>
                )}
                <button
                    onClick={() => setSearch((v) => (v === null ? '' : null))}
                    title="Buscar en esta conversación. Filtra los mensajes que contienen lo que escribas — útil para volver a un comando o a una explicación de hace media hora."
                    className={`shrink-0 rounded p-0.5 ${
                        search !== null ? 'bg-surface-variant text-on-surface' : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
                    } ${onValidateWithAnother ? '' : 'ml-auto'}`}
                >
                    <Icon name="search" size={14} />
                </button>
                <button
                    onClick={() => {
                        void ResetAgentChat(sessionId)
                        setTurns([])
                        setInfo(null)
                        // La cola también se va: un mensaje escrito para la
                        // conversación anterior, mandado dentro de una que
                        // arranca de cero, llega sin el contexto que le daba
                        // sentido.
                        setQueue([])
                        setQueueHeld(false)
                    }}
                    title="Olvida la conversación: el próximo mensaje arranca de cero en vez de encadenar con lo anterior."
                    className="shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="restart_alt" size={14} />
                </button>
            </div>

            {search !== null && (
                <div className="flex shrink-0 items-center gap-1.5 border-b border-outline-variant bg-surface-container-low px-2 py-1 text-ui-11">
                    <Icon name="search" size={13} className="shrink-0 text-on-surface-variant" />
                    <input
                        autoFocus
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Escape') setSearch(null)
                        }}
                        placeholder="Buscar en esta conversación… (Esc cierra)"
                        title="Muestra solo los mensajes que contienen este texto. La conversación no se toca: es un filtro de lectura."
                        className="min-w-0 flex-1 bg-transparent text-on-surface outline-none placeholder:text-on-surface-variant/60"
                    />
                    {!!search.trim() && (
                        <span className="shrink-0 tabular-nums text-on-surface-variant">
                            {visibleTurns.length} de {turns.length}
                        </span>
                    )}
                    <button
                        onClick={() => setSearch(null)}
                        title="Cierra la búsqueda y vuelve a mostrar la conversación entera"
                        className="shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="close" size={13} />
                    </button>
                </div>
            )}

            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5 text-xs">
                {turns.length === 0 && (
                    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-ui-11 text-on-surface-variant">
                        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                            <Icon name="auto_awesome" size={22} />
                        </span>
                        <p>
                            {context.kind !== 'none' && context.label ? (
                                <>
                                    Sobre {CONTEXT_NOUNS[context.kind]}{' '}
                                    <span className="text-on-surface">«{context.label}»</span>. Empieza en{' '}
                                    <strong>solo consulta</strong>: lee y propone, no toca nada.
                                </>
                            ) : (
                                <>
                                    Empieza en <strong>solo consulta</strong>: lee y propone, no toca nada.
                                </>
                            )}
                        </p>
                        <p className="opacity-70">
                            <strong>@</strong> referencia tablas, notas y terminales ·{' '}
                            {navigator.platform.includes('Mac') ? '⌘V' : 'Ctrl+V'} pega una captura
                        </p>
                    </div>
                )}

                {visibleTurns.map(({t, i}) => (
                    <div key={i} className={`group mb-3 flex flex-col ${t.role === 'user' ? 'items-end' : 'items-stretch'}`}>
                        <div
                            className={`mb-1 flex w-full items-center gap-1.5 text-ui-10 text-on-surface-variant ${
                                t.role === 'user' ? 'flex-row-reverse' : ''
                            }`}
                        >
                            {t.role === 'user' ? (
                                <span className="font-semibold uppercase tracking-wider">Vos</span>
                            ) : (
                                <>
                                    <Icon name="auto_awesome" size={12} className="shrink-0 text-primary" />
                                    <span className="font-semibold uppercase tracking-wider text-primary">{agentLabel}</span>
                                </>
                            )}
                            {t.at && <span className="shrink-0 tabular-nums opacity-60">· {formatClock(t.at)}</span>}

                            {/* Acciones del mensaje. Aparecen al pasar por
                                encima para no ensuciar la lectura, y las dos
                                trabajan sobre el TEXTO —no sobre el Markdown
                                renderizado— que es lo que sirve para pegar o
                                reescribir. */}
                            {t.text && (
                                <span className={`hidden shrink-0 items-center gap-1 group-hover:flex ${t.role === 'user' ? 'mr-auto' : 'ml-auto'}`}>
                                    {/* Volver a mandar algo que ya preguntaste,
                                        casi siempre con un cambio. **No rebobina
                                        la conversación**: el hilo vive en el CLI.
                                        Trae el texto a la caja sin pisar lo que
                                        ya tengas escrito. */}
                                    {t.role === 'user' && (
                                        <button
                                            onClick={() => {
                                                setInput((prev) => (prev.trim() ? `${prev.replace(/\s+$/, '')}\n${t.text}` : t.text))
                                                inputRef.current?.focus()
                                            }}
                                            title="Trae este mensaje a la caja para mandarlo otra vez, corregido si hace falta. No borra lo que ya tengas escrito ni deshace la conversación: la respuesta anterior sigue estando."
                                            className="flex items-center gap-1 rounded px-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                                        >
                                            <Icon name="reply" size={11} />
                                            Reusar
                                        </button>
                                    )}
                                    <button
                                        onClick={() => {
                                            void navigator.clipboard.writeText(t.text)
                                            setCopiedTurn(i)
                                        }}
                                        title="Copia este mensaje al portapapeles"
                                        className="flex items-center gap-1 rounded px-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                                    >
                                        <Icon name={copiedTurn === i ? 'check' : 'content_copy'} size={11} />
                                        {copiedTurn === i ? 'Copiado' : 'Copiar'}
                                    </button>
                                </span>
                            )}
                        </div>

                        {/* Cada acción del agente como una tarjeta de terminal:
                            qué herramienta, sobre qué, y de qué tamaño. Plegada
                            por defecto: de un vistazo importa la secuencia, no
                            el argumento entero. */}
                        {t.tools.map((tool, j) => (
                            <details key={j} className="group/tool mb-1.5 overflow-hidden rounded-lg border border-outline-variant bg-surface-container-low">
                                <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1 text-ui-11 hover:bg-surface-variant/50">
                                    <Icon name="terminal" size={12} className="shrink-0 text-primary" />
                                    <span className="shrink-0 font-mono font-medium text-on-surface">{tool.name}</span>
                                    {tool.summary && (
                                        <span className="min-w-0 flex-1 truncate font-mono text-on-surface-variant" title={tool.summary}>
                                            {tool.summary}
                                        </span>
                                    )}
                                    {tool.detail && (
                                        <span className="shrink-0 rounded bg-surface-variant px-1 font-mono text-ui-10 text-on-surface-variant">
                                            {tool.detail}
                                        </span>
                                    )}
                                    <Icon
                                        name="expand_more"
                                        size={14}
                                        className="ml-auto shrink-0 text-on-surface-variant transition-transform group-open/tool:rotate-180"
                                    />
                                </summary>
                                <pre className="overflow-x-auto border-t border-outline-variant px-2 py-1.5 font-mono text-ui-10 whitespace-pre-wrap break-words text-on-surface-variant">
                                    {tool.input}
                                </pre>
                            </details>
                        ))}

                        {t.text && (
                            // Lo propio es una burbuja a la derecha; lo del
                            // agente, una tarjeta a todo el ancho. Quién habla se
                            // distingue por la forma, sin leer el encabezado.
                            <div
                                className={`break-words ${
                                    t.role === 'user'
                                        ? 'max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-sm border border-primary/30 bg-primary/15 px-3 py-1.5 text-on-surface'
                                        : 'rounded-xl rounded-tl-sm border border-outline-variant bg-surface-container px-3 py-2'
                                }`}
                            >
                                {/* La respuesta del agente viene en Markdown y
                                    se renderiza; el mensaje PROPIO no: tiene que
                                    verse tal cual lo mandaste. */}
                                {t.role === 'user' ? (
                                    <>
                                        {t.contexts && t.contexts.length > 0 && (
                                            <span className="mb-1 flex flex-wrap justify-end gap-1">
                                                {t.contexts.map((label, ci) => (
                                                    <span
                                                        key={ci}
                                                        className="inline-flex items-center gap-0.5 rounded-full bg-primary/15 px-1.5 py-px text-ui-10 text-primary"
                                                    >
                                                        <Icon name="attach_file" size={10} />
                                                        {label}
                                                    </span>
                                                ))}
                                            </span>
                                        )}
                                        {t.text}
                                    </>
                                ) : (
                                    <MarkdownPreview
                                        source={t.text}
                                        // Los bloques de código llevan su
                                        // propia barra: copiar y mandar al
                                        // editor. Ver ChatCodeBlock.
                                        renderCodeBlock={({lang, code, key}) => (
                                            <ChatCodeBlock
                                                key={key}
                                                lang={lang}
                                                code={code}
                                                onInsert={onInsertText}
                                                insertLabel={insertLabel}
                                                insertTarget={insertTarget}
                                            />
                                        )}
                                    />
                                )}
                            </div>
                        )}

                        {t.error && (
                            <p className="mt-1 flex items-start gap-1 rounded-lg border border-error/30 bg-error-container/30 px-2 py-1 text-ui-11 text-error">
                                <Icon name="error" size={12} className="mt-px shrink-0" />
                                <span className="min-w-0 flex-1 break-words">{t.error}</span>
                            </p>
                        )}

                        {t.usage && (
                            <p className="mt-1 text-ui-10 text-on-surface-variant/70" title="Tokens de este turno, informados por el propio CLI">
                                {t.usage.total.toLocaleString('es')} tokens · {t.usage.output.toLocaleString('es')} de salida
                                {/* Costo solo si el CLI lo informa: cero acá
                                    significa "no lo dice", no "salió gratis". */}
                                {t.usage.costUsd > 0 && ` · US$${t.usage.costUsd.toFixed(4)}`}
                            </p>
                        )}
                    </div>
                ))}

                {/* Mientras el turno corre. Antes lo único que cambiaba era el
                    botón de mandar, que pasaba a ser un stop: había que
                    mirarlo para saber que el agente estaba trabajando, y en
                    una respuesta larga la pantalla se quedaba quieta sin
                    ninguna señal de vida.

                    Dice QUÉ está haciendo y no solo que espere: mientras hay
                    una herramienta corriendo se muestra esa —que es la que
                    explica la demora— y si todavía no llamó a ninguna, que
                    está pensando. El contador de segundos es lo que separa
                    "tarda" de "se colgó", que es la duda que hace cancelar y
                    volver a empezar sin necesidad. */}
                {busy && (
                    <div className="flex items-center gap-2 px-1 py-1.5 text-ui-11 text-on-surface-variant">
                        <span className="flex shrink-0 items-end gap-0.5" aria-hidden>
                            {[0, 1, 2].map((i) => (
                                <span
                                    key={i}
                                    className="size-1 animate-bounce rounded-full bg-primary"
                                    // Desfasados: los tres al unísono se leen
                                    // como un parpadeo, no como progreso.
                                    style={{animationDelay: `${i * 150}ms`, animationDuration: '900ms'}}
                                />
                            ))}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{workingLabel}</span>
                        <span className="shrink-0 tabular-nums opacity-70">{formatElapsed(elapsed)}</span>
                    </div>
                )}
            </div>

            {mention !== null && (
                <AgentRefPicker
                    query={mention}
                    paths={paths}
                    context={context}
                    onPick={insertMention}
                    onFirstChange={setFirstSuggestion}
                />
            )}

            {/* Lo que dice una ficha de contexto, entero. Se abre desde la
                ficha dentro de la caja: lo que sale de la máquina tiene que
                poder leerse antes de mandarlo. */}
            {openBlock !== null && contextBlocks[openBlock] && (
                <div className="mx-2 mt-1.5 flex max-h-48 shrink-0 flex-col overflow-hidden rounded-lg border border-primary/25 bg-primary/5">
                    <div className="flex shrink-0 items-center gap-1.5 border-b border-primary/15 px-2 py-1 text-ui-10">
                        <Icon name={contextBlocks[openBlock].icon ?? 'attach_file'} size={12} className="shrink-0 text-primary" />
                        <span className="min-w-0 flex-1 truncate font-medium text-on-surface">{contextBlocks[openBlock].label}</span>
                        <span className="shrink-0 tabular-nums text-on-surface-variant/70">
                            {contextBlocks[openBlock].text.trim().split('\n').length} líneas · se manda tal cual
                        </span>
                        <button
                            onClick={() => setOpenBlock(null)}
                            title="Cerrar la vista previa"
                            className="shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                        >
                            <Icon name="close" size={12} />
                        </button>
                    </div>
                    <pre className="min-h-0 overflow-auto px-2 py-1 font-mono text-ui-10 whitespace-pre-wrap text-on-surface-variant">
                        {contextBlocks[openBlock].text}
                    </pre>
                </div>
            )}

            {working?.text.trim() && (
                <details className="shrink-0 border-t border-outline-variant px-1.5 pt-1">
                    <summary className="flex cursor-pointer items-center gap-1.5 text-ui-10">
                        <Icon
                            name={attachWorking ? 'attach_file' : 'block'}
                            size={11}
                            className={`shrink-0 ${attachWorking ? 'text-primary' : 'text-on-surface-variant'}`}
                        />
                        <span className="shrink-0 font-medium text-on-surface">{working.label}</span>
                        <span className="min-w-0 flex-1 truncate font-mono text-on-surface-variant">
                            {working.text.trim().split('\n')[0]}
                        </span>
                        <button
                            onClick={(e) => {
                                e.preventDefault()
                                setAttachWorking((v) => !v)
                            }}
                            title={
                                attachWorking
                                    ? 'Se va a adjuntar al próximo mensaje. Hacé clic para NO mandarlo.'
                                    : 'No se va a adjuntar. Hacé clic para incluirlo.'
                            }
                            className="shrink-0 rounded px-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                        >
                            {attachWorking ? 'adjunto' : 'sin adjuntar'}
                        </button>
                    </summary>
                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-ui-10 text-on-surface-variant">
                        {working.text}
                    </pre>
                </details>
            )}

            {/* Fichas de lo que se va a mandar. No es decoración: una
                referencia que se expande en silencio es indistinguible de una
                fuga, así que lo que sale de la máquina tiene que poder verse
                ANTES de mandarlo — y desplegarse entero, no resumido. */}
            {resolvedRefs.length > 0 && (
                <div className="flex shrink-0 flex-col gap-1 border-t border-outline-variant px-1.5 pt-1">
                    {resolvedRefs.map((r) => (
                        <details
                            key={r.raw}
                            className={`rounded border px-1.5 py-0.5 text-ui-10 ${
                                r.err
                                    ? 'border-error/40 bg-error-container/20'
                                    : 'border-outline-variant bg-surface-container'
                            }`}
                        >
                            <summary className="flex cursor-pointer items-center gap-1.5">
                                <Icon
                                    name={r.err ? (r.blocked ? 'lock' : 'error') : 'attachment'}
                                    size={11}
                                    className={`shrink-0 ${r.err ? 'text-error' : 'text-primary'}`}
                                />
                                <span className="shrink-0 font-mono text-on-surface">{r.raw}</span>
                                <span className="min-w-0 flex-1 truncate text-on-surface-variant">
                                    {r.err ? r.err : r.title}
                                </span>
                                {!r.err && (
                                    <span className="shrink-0 rounded bg-surface-variant px-1 text-on-surface-variant">
                                        {r.body.length.toLocaleString('es')} car.
                                    </span>
                                )}
                            </summary>
                            {!r.err && (
                                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-ui-10 text-on-surface-variant">
                                    {r.body}
                                </pre>
                            )}
                        </details>
                    ))}
                </div>
            )}

            {/* Lo que espera turno. Se ve —y se puede sacar— antes de que salga:
                un mensaje encolado que uno ya no quiere mandar es lo primero
                que se necesita poder deshacer. */}
            {queue.length > 0 && (
                <div className="flex shrink-0 flex-col gap-1 border-t border-outline-variant px-1.5 pt-1">
                    {queue.map((q, i) => (
                        <div
                            key={i}
                            className="flex items-start gap-1.5 rounded border border-outline-variant bg-surface-container px-1.5 py-1 text-ui-10 text-on-surface-variant"
                        >
                            <Icon name="schedule_send" size={11} className="mt-0.5 shrink-0 text-primary" />
                            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{q}</span>
                            <button
                                onClick={() => setQueue((prev) => prev.filter((_, n) => n !== i))}
                                title="Sacar de la cola: este mensaje no se manda"
                                className="shrink-0 rounded hover:text-on-surface"
                            >
                                <Icon name="close" size={10} />
                            </button>
                        </div>
                    ))}
                    {queueHeld && (
                        <div className="flex items-center gap-1.5 text-ui-10 text-tertiary">
                            <Icon name="warning" size={11} className="shrink-0" />
                            <span className="min-w-0 flex-1">
                                La cola quedó esperando: el turno anterior falló o lo cortaste.
                            </span>
                            <button
                                onClick={() => setQueueHeld(false)}
                                title="Manda igual lo que quedó en cola, uno por uno"
                                className="shrink-0 rounded border border-outline-variant px-1.5 py-0.5 hover:text-on-surface"
                            >
                                Mandar igual
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* Controles del turno. Van pegados a la caja de texto y no en un
                menú escondido porque cambian lo que el agente TIENE PERMITIDO
                hacer: es lo último que hay que mirar antes de mandar. */}
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-outline-variant px-2 pt-1.5 text-ui-11">
<Select
                    value={mode}
                    onChange={(next) => {
                        if (PERMISSIVE.has(next)) setPendingMode(next)
                        else setMode(next)
                    }}
                    title={MODE_LABELS[mode]?.hint}
                    size="sm"
                    leadingIcon={MODE_ICONS[mode] ?? 'visibility'}
                    menuMinWidth={280}
                    className={`rounded-lg ${MODE_LABELS[mode]?.danger ? 'border-error! bg-error-container/30' : ''}`}
                    options={modes.map((m) => ({
                        value: m,
                        label: MODE_LABELS[m]?.label ?? m,
                        description: MODE_LABELS[m]?.hint,
                        danger: MODE_LABELS[m]?.danger,
                        icon: <Icon name={MODE_ICONS[m] ?? 'visibility'} size={14} />,
                    }))}
                />

                {/* Esfuerzo como puntos y no como lista: es una escala, y una
                    escala se entiende mejor viéndola entera que abriendo un
                    desplegable. El primer punto es "el del CLI". */}
                {efforts.length > 0 && (
                    <span className="flex items-center gap-1" title="Esfuerzo de razonamiento para este turno">
                        <Icon name="tune" size={12} className="text-on-surface-variant" />
                        <span className="text-on-surface-variant">
                            Esfuerzo{effort ? ` (${effort})` : ''}
                        </span>
                        <span className="flex items-center gap-1">
                            {['', ...efforts].map((e) => (
                                <button
                                    key={e || 'default'}
                                    onClick={() => setEffort(e)}
                                    title={e === '' ? 'El que tenga configurado el CLI' : e}
                                    className={`h-2 w-2 rounded-full ${
                                        effort === e ? 'bg-primary' : 'bg-outline-variant hover:bg-on-surface-variant'
                                    }`}
                                />
                            ))}
                        </span>
                    </span>
                )}

                {/* Subir desde el equipo. Es un input de archivo oculto y no
                    un diálogo nativo del backend porque el archivo hay que
                    leerlo igual para escribirlo en el directorio de adjuntos:
                    pedirle la ruta al sistema no ahorraría ese paso. */}
                <label
                    title="Adjunta una imagen desde el equipo. También podés pegarla directamente en la caja de texto."
                    className="flex shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-outline-variant bg-surface px-2 py-1 text-xs text-on-surface-variant hover:border-primary/60 hover:text-on-surface"
                >
                    <Icon name="image" size={14} />
                    Imagen
                    <input
                        type="file"
                        accept="image/png,image/jpeg,image/gif,image/webp"
                        multiple
                        className="hidden"
                        onChange={(e) => {
                            for (const file of Array.from(e.target.files ?? [])) {
                                const reader = new FileReader()
                                reader.onload = () => {
                                    void SaveChatAttachment(file.name, String(reader.result ?? ''))
                                        .then((path) => setAttachments((prev) => [...prev, path]))
                                        .catch((err) =>
                                            setTurns((prev) => [
                                                ...prev,
                                                {role: 'agent', text: '', tools: [], error: String(err)},
                                            ]),
                                        )
                                }
                                reader.readAsDataURL(file)
                            }
                            // Se limpia el valor para poder elegir el MISMO
                            // archivo dos veces seguidas: sin esto el segundo
                            // change no dispara.
                            e.target.value = ''
                        }}
                    />
                </label>

                {/* Lista y no campo libre: la lista la arma cada CLI (alias
                    en Claude Code, su cache de modelos en Codex, `agy models`
                    en Antigravity), así que no envejece como una escrita a
                    mano — que era el motivo por el que antes era texto libre. */}
<Select
                    value={model}
                    onChange={setModel}
                    title={
                        catalog?.models.find((m) => m.id === model)?.description ||
                        'Modelo para este turno. La lista la informa el propio CLI.'
                    }
                    size="sm"
                    leadingIcon="memory"
                    menuMinWidth={260}
                    className="max-w-52 min-w-0 rounded-lg"
                    options={(catalog?.models ?? [{id: '', label: 'Por defecto', description: '', efforts: []}]).map((m) => ({
                        value: m.id,
                        label: m.label,
                        description: m.description || undefined,
                    }))}
                />

                {/* Mientras el modo permisivo está activo se avisa en todos
                    los turnos, no solo al activarlo: una sesión larga hace
                    olvidar en qué modo quedó. */}
                {PERMISSIVE.has(mode) && (
                    <span className={`flex items-center gap-1 ${mode === 'edit' ? 'text-error' : 'text-on-surface-variant'}`} title={MODE_LABELS[mode]?.hint}>
                        <Icon name="warning" size={12} />
                        {mode === 'edit' ? 'Va a modificar archivos' : 'Actúa sin volver a preguntarte'}
                    </span>
                )}

                {/* Lo gastado en esta conversación, siempre a la vista.
                    Deliberadamente NO dice "te quedan X": el saldo del plan no
                    está en ningún archivo local, lo contesta el servidor. Se
                    muestra lo verificable y el tooltip dice dónde ver el
                    resto. */}
                <span
                    className="ml-auto flex shrink-0 items-center gap-1 text-on-surface-variant"
                    title={
                        sessionUsage.total > 0
                            ? `Consumo de los turnos de esta ventana, informado por el propio CLI. Una conversación retomada empieza a contar desde acá: los turnos anteriores los corrió el CLI y no informó su consumo al reabrirlos.\n\nNo es cuánto te queda del plan: ese saldo lo sabe el servidor, no un archivo local. Se ve con /status en Claude Code y /usage en Antigravity.`
                            : 'Acá se acumulan los tokens de esta conversación en cuanto el agente conteste el primer turno.'
                    }
                >
                    <Icon name="monitoring" size={12} />
                    {sessionUsage.total > 0 ? (
                        <>
                            {formatTokens(sessionUsage.total)} en la sesión
                            <span className="opacity-70">· {formatTokens(sessionUsage.output)} de salida</span>
                            {sessionUsage.cost > 0 && <span className="opacity-70">· US${sessionUsage.cost.toFixed(4)}</span>}
                        </>
                    ) : (
                        <span className="opacity-70">sin consumo todavía</span>
                    )}
                </span>
            </div>

            {/* Cierre del círculo de un turno autónomo: qué tocó y qué hacer
                con eso. Va arriba de la caja de texto porque es lo que hay que
                mirar antes de seguir pidiéndole cosas. */}
            {touched !== null && (
                <div className="flex shrink-0 items-center gap-2 border-t border-outline-variant bg-surface-container-high px-2 py-1 text-ui-11">
                    <Icon name="edit_note" size={13} className="shrink-0 text-primary" />
                    <span className="min-w-0 flex-1 truncate text-on-surface-variant">
                        El agente dejó <span className="text-on-surface">{touched}</span> archivo{touched === 1 ? '' : 's'} modificado
                        {touched === 1 ? '' : 's'} sin commitear.
                    </span>
                    {onReviewChanges && (
                        <button
                            onClick={() => {
                                setTouched(null)
                                onReviewChanges()
                            }}
                            title="Lleva a Cambios, con el diff de lo que tocó — revisarlo antes de commitear es todo el punto de que trabaje solo sobre un repositorio"
                            className="shrink-0 rounded bg-primary px-2 py-0.5 text-on-primary"
                        >
                            Revisar
                        </button>
                    )}
                    <button
                        onClick={() => setTouched(null)}
                        title="Oculta el aviso. Los cambios siguen en el árbol de trabajo."
                        className="shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="close" size={14} />
                    </button>
                </div>
            )}

            {approval && (
                <ConfirmDialog
                    title={`¿Permitir ${approval.tool}?`}
                    description={
                        `${agentLabel} quiere ejecutar ${approval.tool}` +
                        (approval.summary ? ` sobre ${approval.summary}` : '') +
                        (approval.detail ? ` (${approval.detail})` : '') +
                        '. El agente está esperando tu respuesta: si cancelás, no lo hace y se le dice por qué.'
                    }
                    confirmLabel="Permitir"
                    onConfirm={() => {
                        answeredRef.current = approval.id
                        void RespondAgentApproval(approval.id, true, '')
                    }}
                    // Cerrar es DENEGAR, no descartar: del otro lado hay un
                    // proceso bloqueado esperando, y no contestar lo colgaría
                    // hasta que venza el tiempo.
                    onClose={() => {
                        if (answeredRef.current !== approval.id) {
                            void RespondAgentApproval(approval.id, false, 'el usuario no autorizó esta acción')
                        }
                        setApproval(null)
                    }}
                />
            )}

            {pendingMode && (
                <ConfirmDialog
                    title={pendingMode === 'edit' ? 'Permitir que modifique archivos' : 'Permitir que actúe automáticamente'}
                    description={
                        pendingMode === 'edit'
                            ? `${agentLabel} va a editar archivos de este repositorio sin volver a preguntarte, durante toda esta sesión de chat. Los cambios quedan en el árbol de trabajo: los vas a ver en Cambios y los podés descartar desde ahí. Nunca se le da permiso para ejecutar cualquier comando.`
                            : `${agentLabel} va a aprobar por su cuenta las acciones que pasen su propio control de seguridad, y a frenar solo en lo que considere riesgoso — ese criterio lo aplica el CLI, no esta app. Vale para toda esta sesión de chat.`
                    }
                    confirmLabel={pendingMode === 'edit' ? 'Permitir ediciones' : 'Permitir'}
                    danger={pendingMode === 'edit'}
                    onConfirm={() => setMode(pendingMode)}
                    onClose={() => setPendingMode(null)}
                />
            )}

            {/* Sugerencias arriba de la caja mientras la conversación está
                vacía: frente a una caja en blanco uno no sabe por dónde
                empezar, y tres preguntas del módulo lo resuelven mejor que un
                párrafo de instrucciones. */}
            {turns.length === 0 && !busy && !input.trim() && (
                <div className="flex shrink-0 flex-wrap gap-1.5 px-2 pt-1.5">
                    {(STARTERS[context.kind] ?? STARTERS.none).map((st, si) => (
                        <button
                            key={st}
                            onClick={() => {
                                setInput(st)
                                inputRef.current?.focus()
                            }}
                            title="Escribe esto en la caja de mensaje. Podés editarlo antes de mandarlo."
                            className="flex items-center gap-1 rounded-lg border border-outline-variant bg-surface-container px-2 py-1 text-ui-11 text-on-surface-variant hover:border-primary/50 hover:text-on-surface"
                        >
                            <Icon
                                name={(STARTER_ICONS[context.kind] ?? STARTER_ICONS.none)[si] ?? 'chat'}
                                size={13}
                                className="shrink-0 text-primary"
                            />
                            {st}
                        </button>
                    ))}
                </div>
            )}

            <div className="m-2 flex shrink-0 flex-col rounded-xl border border-outline-variant bg-surface-container-low transition-colors focus-within:border-primary">
                {/* Fichas de lo que viaja con el mensaje, DENTRO de la caja: el
                    contexto adjunto y las imágenes son parte del mensaje, no
                    algo aparte. Clic en una ficha la despliega; la × la quita. */}
                {(contextBlocks.length > 0 || attachments.length > 0) && (
                    <div className="flex flex-wrap gap-1 px-2 pt-2">
                        {contextBlocks.map((b, bi) => (
                            <span
                                key={`${b.label}-${bi}`}
                                className={`flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-ui-10 ${
                                    openBlock === bi ? 'border-primary bg-primary/20 text-primary' : 'border-primary/30 bg-primary/10 text-primary'
                                }`}
                            >
                                <button
                                    onClick={() => setOpenBlock((v) => (v === bi ? null : bi))}
                                    title={`${b.label} — ${b.text.trim().split('\n').length} líneas. Clic para leer exactamente lo que se va a mandar.`}
                                    className="flex min-w-0 items-center gap-1"
                                >
                                    <Icon name={b.icon ?? 'attach_file'} size={11} className="shrink-0" />
                                    <span className="truncate">{b.label}</span>
                                </button>
                                <button
                                    onClick={() => {
                                        setContextBlocks((prev) => prev.filter((_, n) => n !== bi))
                                        setOpenBlock(null)
                                    }}
                                    title="Quitar este contexto — no se va a mandar"
                                    className="shrink-0 rounded hover:text-error"
                                >
                                    <Icon name="close" size={11} />
                                </button>
                            </span>
                        ))}
                        {attachments.map((path) => (
                            <span
                                key={path}
                                title={`${path} — se le pasa al agente por su ruta; el archivo vive en los datos de la app, no en el repositorio`}
                                className="flex max-w-full items-center gap-1 rounded-md border border-outline-variant bg-surface-container px-1.5 py-0.5 text-ui-10 text-on-surface-variant"
                            >
                                <Icon name="image" size={11} className="shrink-0 text-primary" />
                                <span className="truncate">{path.split('/').pop()}</span>
                                <button
                                    onClick={() => setAttachments((prev) => prev.filter((p) => p !== path))}
                                    title="Quitar del mensaje"
                                    className="shrink-0 rounded hover:text-error"
                                >
                                    <Icon name="close" size={11} />
                                </button>
                            </span>
                        ))}
                    </div>
                )}
                <div className="flex items-end gap-1 p-1.5">
                <textarea
                    ref={inputRef}
                    value={input}
                    onChange={(e) => {
                        const v = e.target.value
                        setInput(v)
                        // El selector se abre con @ y se cierra en cuanto hay
                        // un espacio: `@src/a.go` es una referencia, `hola @ `
                        // no es nada.
                        const at = v.lastIndexOf('@')
                        const tail = at >= 0 ? v.slice(at + 1) : ''
                        // Salvo dentro de comillas abiertas (`@db:"Mi base/`):
                        // ahí el espacio es parte del nombre, no el final.
                        const openQuote = /^[a-z]+:"[^"\n]*$/.test(tail)
                        setMention(at >= 0 && (openQuote || (!tail.includes(' ') && !tail.includes('\n'))) ? tail : null)
                    }}
                    onPaste={(e) => {
                        // Si lo pegado es una imagen se adjunta y se corta el
                        // pegado de texto: si no, quedaría además el nombre del
                        // archivo escrito en la caja.
                        if (attachFromClipboard(e.clipboardData)) e.preventDefault()
                    }}
                    onKeyDown={(e) => {
                        if (e.key === 'Escape' && mention !== null) {
                            e.preventDefault()
                            setMention(null)
                            return
                        }
                        // Con el selector abierto, Enter ELIGE la primera
                        // sugerencia en vez de mandar el mensaje: es lo que
                        // uno espera de un autocompletado, y mandar a medio
                        // escribir una referencia no le sirve a nadie.
                        if (e.key === 'Enter' && !e.shiftKey && mention !== null && firstSuggestion) {
                            e.preventDefault()
                            insertMention(firstSuggestion.insert, firstSuggestion.partial)
                            return
                        }
                        // Enter manda, Shift+Enter hace salto de línea — lo
                        // habitual en un chat, y lo contrario de la terminal,
                        // donde Enter es del programa.
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault()
                            send()
                        }
                    }}
                    rows={2}
                    placeholder={
                        busy
                            ? `${agentLabel} está trabajando — escribí y Enter lo deja en cola para cuando termine`
                            : `Preguntale a ${agentLabel}… (Enter manda, Shift+Enter salta de línea)`
                    }
                    className="max-h-40 min-w-0 flex-1 resize-none bg-transparent px-1.5 py-1 text-xs text-on-surface outline-none placeholder:text-on-surface-variant/60"
                />
                {busy ? (
                    <>
                        {/* Encolar también con el mouse: con el agente ocupado
                            el botón principal es Detener, así que sin esto la
                            única forma de encolar sería saber que Enter lo
                            hace. */}
                        <button
                            onClick={send}
                            disabled={!input.trim()}
                            title="Deja este mensaje en cola: sale solo cuando termine el turno en curso"
                            className="shrink-0 rounded-lg border border-outline-variant p-1.5 text-on-surface-variant hover:text-on-surface disabled:opacity-40"
                        >
                            <Icon name="schedule_send" size={14} />
                        </button>
                        <button
                            onClick={() => {
                                void CancelAgentChat(sessionId)
                                // Frenar la cola es parte de cortar: quien
                                // detiene un turno casi nunca quiere que el
                                // siguiente salga solo un segundo después, y
                                // sobre todo no antes de ver por qué cortó.
                                // Queda con el botón de "Mandar igual".
                                setQueueHeld(true)
                            }}
                            title="Corta el turno en curso. Lo que haya en cola no sale solo: queda esperando con un botón para mandarlo."
                            className="shrink-0 rounded-lg bg-error p-1.5 text-on-error"
                        >
                            <Icon name="stop" size={14} />
                        </button>
                    </>
                ) : (
                    <button
                        onClick={send}
                        disabled={!input.trim()}
                        title="Manda el mensaje (Enter)"
                        className="shrink-0 rounded-lg bg-primary p-1.5 text-on-primary disabled:opacity-40"
                    >
                        <Icon name="send" size={14} />
                    </button>
                )}
                </div>
            </div>
        </div>
    )
}
