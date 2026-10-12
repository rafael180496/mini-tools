import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import type {ReactNode} from 'react'
import {
    AgentChatHistory,
    AgentChatMessages,
    AgentChatModes,
    AgentModelCatalog,
    BrainStatus,
    CancelAgentChat,
    GitListWorkTree,
    ListModelServers,
    RespondAgentApproval,
    SaveChatAttachment,
    AgentResolveRefs,
    SetAgentChatBrain,
    SetAgentChatSettings,
    ResetAgentChat,
    SendAgentChat,
} from '../../../wailsjs/go/main/App'
import {EventsOn} from '../../../wailsjs/runtime'
import {agentctx, agentmodels, main} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import Select from '../Select'
import ConfirmDialog from '../ConfirmDialog'
import MarkdownPreview from '../MarkdownPreview'
import AgentRefPicker from './AgentRefPicker'
import AgentApprovalDialog, {type ApprovalRequest} from './AgentApprovalDialog'
import ChatCodeBlock from './ChatCodeBlock'
import ToolCallCard, {canonicalToolName, type ToolCall} from './ToolCallCard'
import {CONTEXT_ICONS, contextNoun, describeContext, repoIdOf, workRepoIdOf, type WorkContext} from './workContext'
import {rich} from './rich'
import {errorText, formatDateTime, formatNumber, useT} from '../../i18n'
import {isModelServerAgent, MODEL_SERVER_PREFIX} from '../../lib/modelServers'
import {useModelServerHealth} from '../../lib/modelServerHealth'
import {HealthBanner} from './HealthIndicators'
import {requestOpenSettings} from '../../lib/appBus'

// Espeja ChatEvent / Usage (backend/agentchat/types.go); ToolCall vive en
// ToolCallCard.tsx.
//
// Se escribe a mano y no sale de wailsjs/go/models por el mismo motivo que
// LocalTermEvent en LocalTerminalPanel.tsx: estos tipos viajan por un EVENTO
// de Wails, no por el valor de retorno de un binding, y el generador solo
// tipa lo segundo. Si cambia el Go, hay que cambiar esto — está anotado en
// .claude/specs/go-react-contract.md.
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
    utilities: ['school', 'bug_report', 'terminal', 'rate_review'],
    none: ['help'],
}

const isUserTurn = (turn: Turn) => turn.role === 'user'

// Aviso inicial de una respuesta: el backend antepone «_⚠ …_» (cursiva) cuando
// el servidor no admite herramientas y el turno sigue sin ellas. Como Markdown
// se vería como una línea más del texto del modelo; se separa para dibujarlo
// como lo que es, un aviso de la app y no algo que dijo el modelo.
function splitLeadingNotice(text: string): {notice: string; rest: string} {
    const m = /^_⚠\s*([^\n]*?)_(?:\n\n|\s*$)/.exec(text)
    return m ? {notice: m[1].trim(), rest: text.slice(m[0].length)} : {notice: '', rest: text}
}

function formatClock(at?: number): string {
    return at ? formatDateTime(new Date(at), {hour: '2-digit', minute: '2-digit'}) : ''
}

// Mensaje guardado de una conversación (AgentChatMessages). Estructural y no el
// tipo generado: así este archivo no depende de cómo lo nombre el generador.
interface StoredMessage {
    seq: number
    role: string
    content: string
    toolName: string
    usage?: Partial<ChatUsage> | null
    createdAt: number
}

// Rearma los turnos de la pantalla desde los mensajes que la app guardó. Una
// herramienta (`tool`) cuelga del turno del agente que la llamó, igual que se
// dibuja en vivo; la hora llega en segundos o milisegundos según quién la
// escribió, y se normaliza.
function turnsFromStored(messages: StoredMessage[]): Turn[] {
    const out: Turn[] = []
    const stamp = (v: number) => (v ? (v > 1e12 ? v : v * 1000) : undefined)
    for (const m of [...messages].sort((a, b) => a.seq - b.seq)) {
        if (m.role === 'user') {
            out.push({role: 'user', text: m.content, tools: [], at: stamp(m.createdAt)})
            continue
        }
        let last = out[out.length - 1]
        if (!last || last.role !== 'agent' || (m.role === 'assistant' && last.text)) {
            last = {role: 'agent', text: '', tools: [], at: stamp(m.createdAt)}
            out.push(last)
        }
        if (m.role === 'tool') {
            // La fila guarda «resumen\ndetalle» (backend/agentchat/record.go).
            const [summary, ...rest] = m.content.split('\n')
            last.tools.push({name: m.toolName, input: m.content, summary, detail: rest.join('\n')})
        } else {
            last.text = m.content
            if (m.usage) {
                const u = m.usage
                last.usage = {
                    input: u.input ?? 0,
                    output: u.output ?? 0,
                    cacheRead: u.cacheRead ?? 0,
                    thinking: u.thinking ?? 0,
                    total: u.total ?? 0,
                    costUsd: u.costUsd ?? 0,
                }
            }
        }
    }
    return out.filter((t) => t.text || t.tools.length > 0)
}

// Anillo de foco visible para los controles que son solo un ícono: un control
// que no se ve al navegar con el teclado no se puede usar con el teclado.
const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary'

const MODE_ICONS: Record<string, string> = {
    '': 'visibility',
    plan: 'map',
    approve: 'verified_user',
    auto: 'bolt',
    edit: 'edit_document',
}

const MODE_KEYS: Record<string, 'query' | 'plan' | 'approve' | 'auto' | 'edit'> = {
    '': 'query',
    plan: 'plan',
    approve: 'approve',
    auto: 'auto',
    edit: 'edit',
}
// En un CLI solo `edit` es de peligro (nunca se le da permiso de correr
// comandos). Un servidor de modelos en `auto` además ejecuta comandos sin
// preguntar —salvo los de riesgo—, así que ahí también lo es.
const DANGER_MODES = new Set(['edit'])
const DANGER_MODES_LLM = new Set(['edit', 'auto'])
// Modos de un servidor de modelos que tocan archivos o comandos del repositorio
// de trabajo. Sin repositorio no se declara ninguna de esas herramientas, y
// ofrecer el modo sería ofrecer un permiso sobre nada.
const REPO_MODES = new Set(['approve', 'edit', 'auto'])
// Modos con los que el modelo recibe herramientas de archivos o comandos que
// escriben o ejecutan: son los que mandan contenido del repositorio a un
// servidor remoto (la lectura de archivos viaja en cualquier modo con repo).
const WRITE_MODES = new Set(['approve', 'edit', 'auto'])


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
    // Aviso de la propia app (no del modelo) que va al comienzo del turno. Hoy,
    // el de servidor remoto al usar herramientas por primera vez. No se guarda.
    notice?: string
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
    // Id de la conversación en el historial de la app. Con él, al retomar se
    // dibujan los mensajes que la app guardó (de cualquier proveedor, también
    // los servidores de modelos, que no tienen historial propio); si no hay,
    // se cae al historial del CLI por `resumeConversationId`.
    resumeChatId?: string
    // Modelo controlado desde afuera (la cabecera del Chat de IA). Con los dos
    // props el selector de modelo de la caja se esconde: tener dos para lo
    // mismo obligaría a decidir cuál manda.
    model?: string
    onModelChange?: (model: string) => void
    // Ajustes con los que venía este chat (migración 32). El MODO llega pero
    // no se aplica solo: ver el efecto de abajo.
    initialSettings?: {model: string; effort: string; mode: string; brain?: boolean}
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
    // Avisa cuando el agente empieza o termina de contestar. Lo usa el Chat de
    // IA para marcar en el historial qué conversaciones están respondiendo y
    // para reordenarlo al terminar.
    onBusyChange?: (busy: boolean) => void
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
    // Ocupar TODO el ancho del contenedor. Pensado para el Chat de IA, que es una
    // pestaña entera: la respuesta del agente deja de ser una tarjeta que se
    // estira de borde a borde y pasa a medir lo que mide su contenido, con el
    // tope de lectura del texto corrido (ver PROSE_CAP). Los bloques de código,
    // las tablas y las tarjetas de herramientas siguen pudiendo usar todo el
    // ancho. El panel lateral no lo pide: ahí el ancho ya es escaso.
    fluid?: boolean
    // Contenido extra bajo las sugerencias del estado vacío (el aviso de «agregá
    // un servidor» del Chat de IA).
    emptyExtra?: ReactNode
}

// Tope de lectura del texto corrido de una respuesta cuando el chat es fluido:
// ~100 caracteres por línea, que es donde la vista empieza a perder el renglón.
// Solo toca párrafos, títulos, listas y citas; un bloque de código o una tabla no
// se parte por leerse mal, y obligarlos a la columna angosta los haría scrollear
// de lado en una pantalla que sobra de ancho.
const PROSE_CAP =
    '[&_p]:max-w-[100ch] [&_ul]:max-w-[100ch] [&_ol]:max-w-[100ch] [&_blockquote]:max-w-[100ch] [&_summary]:max-w-[100ch]'

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
    resumeChatId,
    model: modelProp,
    onModelChange,
    initialSettings,
    onTurnFinished,
    onReviewChanges,
    onValidateWithAnother,
    onConversation,
    onSend,
    onBusyChange,
    working,
    onInsertText,
    insertLabel,
    insertTarget,
    onSessionUsage,
    active = true,
    fluid = false,
    emptyExtra,
}: AgentChatProps) {
    const t = useT()
    // Etiqueta y explicación de un modo en el idioma activo. Un modo que el
    // backend agregue y esta tabla no conozca se muestra con su id crudo.
    // Un servidor de modelos no es un CLI: sus modos gobiernan herramientas de
    // archivos y comandos que corren en ESTA máquina, y lo que cada uno permite
    // es otra cosa (`edit` sí corre comandos, pero preguntando; `auto` no
    // pregunta salvo en los de riesgo). Los textos son propios.
    const isLLM = isModelServerAgent(agentId)
    // Salud del servidor mientras este chat está a la vista (a un CLI no se lo
    // sondea). `refresh` salta la caché del backend: se usa tras un fallo de
    // envío para que el aviso refleje lo que acaba de pasar.
    const serverHealth = useModelServerHealth(agentId, active)
    const refreshHealthRef = useRef<(() => void) | undefined>(undefined)
    refreshHealthRef.current = serverHealth?.refresh
    const modeLabel = (m: string) => {
        const key = MODE_KEYS[m]
        if (!key) return undefined
        const table = isLLM ? t.agent.chat.llmModes : t.agent.chat.modes
        return {...table[key], danger: (isLLM ? DANGER_MODES_LLM : DANGER_MODES).has(m)}
    }
    const [turns, setTurns] = useState<Turn[]>([])
    // Hay recurso que nombrar en el encabezado y en el estado vacío.
    const hasContext = context.kind !== 'none' && !!context.label
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
        if (!tool) return t.agent.chat.thinking({agent: agentLabel})
        const name = canonicalToolName(tool.name)
        return tool.summary ? `${name} · ${tool.summary}` : `${name}…`
    }, [turns, agentLabel, t])

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
    const onBusyChangeRef = useRef(onBusyChange)
    onBusyChangeRef.current = onBusyChange
    useEffect(() => {
        onBusyChangeRef.current?.(busy)
    }, [busy])
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
    const [modelLocal, setModelLocal] = useState('')
    const modelControlled = modelProp !== undefined && !!onModelChange
    const model = modelControlled ? modelProp : modelLocal
    const setModel = (m: string) => (modelControlled ? onModelChange?.(m) : setModelLocal(m))
    const [modes, setModes] = useState<string[]>([''])
    // Repositorio sobre el que el agente puede tocar archivos y correr comandos.
    // Mientras `repoId` es solo el del módulo Git, este incluye el elegido en la
    // cabecera del Chat de IA.
    const workRepo = workRepoIdOf(context)
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
    // --- Servidor de modelos: remoto, sin repositorio ---------------------
    //
    // Un servidor remoto recibe todo lo que el agente lee: el contenido de los
    // archivos y la salida de los comandos viajan en el mensaje de la
    // herramienta. Se averigua una vez por agente (`isLocal` lo calcula Go) y se
    // avisa antes del primer envío con herramientas, una sola vez por sesión.
    const [serverRemote, setServerRemote] = useState<{name: string; baseUrl: string} | null>(null)
    const [remoteAck, setRemoteAck] = useState(false)
    useEffect(() => {
        if (!isLLM) {
            setServerRemote(null)
            return
        }
        let cancelled = false
        ListModelServers()
            .then((list) => {
                const srv = (list ?? []).find((x) => MODEL_SERVER_PREFIX + x.id === agentId)
                if (!cancelled) setServerRemote(srv && !srv.isLocal ? {name: srv.name, baseUrl: srv.baseUrl} : null)
            })
            .catch(() => !cancelled && setServerRemote(null))
        return () => {
            cancelled = true
        }
    }, [agentId, isLLM])
    const [noRepoDismissed, setNoRepoDismissed] = useState(false)

    // --- Cerebro ----------------------------------------------------------
    //
    // «Guardar en mi cerebro» es un interruptor POR CONVERSACIÓN: apagado por
    // defecto y recordado en la fila del historial. Solo se puede encender con
    // el servidor MCP y el permiso de escritura de notas activos (lo que el
    // agente escribe entra por esas herramientas), y eso se ve en
    // Configuración → IA, no acá.
    const [brain, setBrain] = useState(false)
    // Lo último que se guardó con éxito en la fila. `brain` es lo que el usuario
    // quiere; si difieren, falta persistirlo (la fila de una conversación nueva
    // no existe hasta el primer mensaje).
    const brainPersistedRef = useRef(false)
    const [brainStatus, setBrainStatus] = useState<main.BrainStatus | null>(null)
    const refreshBrain = useCallback(() => {
        BrainStatus()
            .then(setBrainStatus)
            .catch(() => setBrainStatus(null))
    }, [])
    const brainAvailable = !!brainStatus?.mcpEnabled && !!brainStatus?.notesWrite
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
    //
    // Un servidor de modelos va un paso más allá: sin repositorio de trabajo no
    // se declara NINGUNA herramienta de archivos ni de comandos, así que tampoco
    // se ofrece `aprobar cada acción` (solo aprobaría herramientas MCP, que no
    // preguntan). Los modos que quedan son consulta y plan.
    useEffect(() => {
        AgentChatModes(agentId)
            .then((m) => {
                const all = m?.length ? m : ['']
                const usable = workRepo
                    ? all
                    : all.filter((x) => !PERMISSIVE.has(x) && !(isLLM && REPO_MODES.has(x)))
                setModes(usable.length ? usable : [''])
            })
            .catch(() => setModes(['']))
    }, [agentId, workRepo, isLLM])

    // Si el contexto deja de ser un repositorio con un modo que lo necesita
    // activo, el modo se baja solo. Mantenerlo sería conservar un permiso que se
    // concedió para otra cosa.
    useEffect(() => {
        if (!workRepo && (PERMISSIVE.has(mode) || (isLLM && REPO_MODES.has(mode)))) setMode('')
    }, [workRepo, mode, isLLM])

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
                        // Si el servidor dejó de contestar a mitad de turno, el
                        // aviso de la caja tiene que enterarse ya.
                        refreshHealthRef.current?.()
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
        brainPersistedRef.current = !!initialSettings.brain
        setBrain(!!initialSettings.brain)
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
        if (!resumeConversationId && !resumeChatId) return
        let cancelled = false
        const apply = (loaded: Turn[]): boolean => {
            if (cancelled || loaded.length === 0) return false
            setTurns((prev) => (prev.length > 0 ? prev : loaded))
            return true
        }
        const fromCli = (): Promise<boolean> =>
            resumeConversationId
                ? AgentChatHistory(agentId, resumeConversationId).then((past) =>
                      apply(
                          (past ?? []).map((t) => ({
                              role: t.role === 'user' ? ('user' as const) : ('agent' as const),
                              text: t.text,
                              tools: t.tools ?? [],
                          })),
                      ),
                  )
                : Promise.resolve(false)
        // Primero lo que la app guardó: es lo único que existe para un servidor
        // de modelos y trae el consumo de cada turno. Si no hay nada (una
        // conversación anterior a que la app guardara mensajes) se pregunta al CLI.
        const run = resumeChatId
            ? AgentChatMessages(resumeChatId)
                  .then((msgs) => apply(turnsFromStored((msgs ?? []) as StoredMessage[])))
                  .catch(() => false)
                  .then((ok) => ok || fromCli())
            : fromCli()
        run.catch(() => {})
        return () => {
            cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resumeConversationId, resumeChatId, agentId])

    // Las peticiones de aprobación llegan por un evento GLOBAL y no por el de
    // la sesión: el hook corre en otro proceso y no sabe de qué chat salió.
    // Con una sola sesión pidiendo permiso a la vez —el agente está bloqueado
    // esperando— alcanza con que las atienda el chat visible, que además es el
    // único que puede contestar (ver `active`).
    useEffect(() => {
        if (!active) return
        const off = EventsOn('agent-approval', (req: ApprovalRequest) => setApproval(req))
        // Una pregunta que dejó de esperar respuesta (se cortó el turno o venció
        // el plazo de 5 minutos): el diálogo se cierra solo. Contestar tarde se
        // ignora del lado de Go, así que no hace falta responder nada.
        const offDismiss = EventsOn('agent-approval-dismiss', (id: string) => {
            setApproval((cur) => {
                if (cur?.id !== id) return cur
                answeredRef.current = id
                return null
            })
        })
        return () => {
            off()
            offDismiss()
        }
    }, [active])

    // El estado del cerebro se relee al entrar al chat y al volver a la ventana:
    // el usuario enciende el servidor MCP o el permiso en Configuración y vuelve.
    useEffect(() => {
        if (!active) return
        refreshBrain()
        window.addEventListener('focus', refreshBrain)
        return () => window.removeEventListener('focus', refreshBrain)
    }, [active, refreshBrain])

    // Autoscroll al final mientras llega la respuesta, SOLO si ya estabas al
    // final. Quien subió a releer algo no quiere que cada fragmento nuevo lo
    // devuelva abajo; en ese caso aparece un botón para volver cuando él quiera.
    const stickRef = useRef(true)
    const [atBottom, setAtBottom] = useState(true)
    const onScrollLog = useCallback(() => {
        const el = scrollRef.current
        if (!el) return
        const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        stickRef.current = near
        setAtBottom(near)
    }, [])
    const scrollToLatest = useCallback(() => {
        const el = scrollRef.current
        stickRef.current = true
        setAtBottom(true)
        if (el) el.scrollTop = el.scrollHeight
    }, [])
    useEffect(() => {
        const el = scrollRef.current
        if (el && stickRef.current) el.scrollTop = el.scrollHeight
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

    // Guarda el interruptor del cerebro de esta conversación. El backend lo
    // acepta aunque la fila del historial todavía no exista (la conversación
    // nace en el primer envío) y lo persiste cuando aparece; solo rechaza
    // ENCENDERLO sin el servidor MCP o sin el permiso de escritura de notas.
    // Devuelve el motivo del rechazo, o '' si quedó guardado.
    const persistBrain = useCallback(
        async (value: boolean): Promise<string> => {
            try {
                await SetAgentChatBrain(sessionId, value)
                brainPersistedRef.current = value
                return ''
            } catch (e) {
                return errorText(e)
            }
        },
        [sessionId],
    )

    const toggleBrain = async () => {
        // Sin servidor MCP o sin permiso de escritura no hay nada que encender:
        // el clic lleva a donde se arregla.
        if (!brainAvailable) {
            requestOpenSettings('ai')
            return
        }
        const next = !brain
        setBrain(next)
        const failure = await persistBrain(next)
        if (failure) {
            // El estado de los permisos cambió desde la última lectura: se
            // vuelve al valor anterior y se dice por qué.
            setBrain(!next)
            refreshBrain()
            setTurns((prev) => [
                ...prev,
                {role: 'agent', text: '', tools: [], error: t.agent.chat.brain.applyFailed({error: failure})},
            ])
        }
    }

    const sendText = useCallback(
        async (raw: string) => {
        const text = raw.trim()
        if (!text) return
        // Mandar es pedir ver la respuesta: vuelve a pegarse al final.
        stickRef.current = true
        const blocks = contextBlocks
        // Primer envío con herramientas contra un servidor remoto: queda
        // asentado en la conversación, además del aviso que ya estaba sobre la
        // caja. Una vez por sesión.
        const remoteNotice =
            serverRemote && (workRepo || WRITE_MODES.has(mode)) && !remoteAck
                ? t.agent.chat.remote.recorded({server: serverRemote.name})
                : ''
        if (remoteNotice) setRemoteAck(true)
        setTurns((prev) => [
            ...prev,
            {role: 'user', text, tools: [], contexts: blocks.length ? blocks.map((b) => b.label) : undefined, at: Date.now()},
            ...(remoteNotice ? [{role: 'agent' as const, text: '', tools: [], notice: remoteNotice, at: Date.now()}] : []),
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
        // Si el interruptor quedó distinto de lo guardado (p. ej. una
        // conversación retomada con el cerebro encendido cuyo permiso se apagó
        // después), se vuelve a guardar ANTES de mandar: el mensaje que le pide
        // al agente registrar notas se arma al enviar.
        if (brain !== brainPersistedRef.current) {
            const failure = await persistBrain(brain)
            if (failure) {
                const wanted = brain
                setBrain(brainPersistedRef.current)
                setTurns((prev) => [
                    ...prev,
                    {role: 'agent', text: '', tools: [], error: t.agent.chat.brain.applyFailed({error: failure})},
                ])
                // Si lo que falló fue APAGARLO, no se manda: seguir con el cerebro
                // encendido sería escribir notas que el usuario acaba de negar.
                if (!wanted) {
                    setBusy(false)
                    setQueueHeld(true)
                    return
                }
            }
        }
        try {
            await SendAgentChat(sessionId, context.kind, context.id, agentId, outgoing, mode, effort, model.trim(), attachments)
            setAttachments([])
        } catch (e) {
            // errorText y no String(e): el rechazo del binding trae el prefijo
            // «Error: » y el código invisible del backend, que no son parte del
            // mensaje. El corte rápido por servidor caído llega por acá.
            setTurns((prev) => [...prev, {role: 'agent', text: '', tools: [], error: errorText(e)}])
            setBusy(false)
            refreshHealthRef.current?.()
            // Ver `queueHeld`: lo que quedaba encolado no sale solo detrás de
            // un fallo.
            setQueueHeld(true)
        }
        },
        [sessionId, context.kind, context.id, agentId, mode, effort, model, attachments, onSend, attachWorking, working, contextBlocks, serverRemote, workRepo, remoteAck, brain, persistBrain, t],
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
                {hasContext && (
                    <span
                        className="flex min-w-0 shrink items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-medium text-primary"
                        title={t.agent.chat.workingOn({noun: contextNoun(context.kind), label: context.label})}
                    >
                        <Icon name={CONTEXT_ICONS[context.kind]} size={12} className="shrink-0" />
                        <span className="truncate">{describeContext(context)}</span>
                    </span>
                )}
                {info?.model && <span className="truncate font-mono text-ui-10 text-on-surface-variant">{info.model}</span>}
                {serverRemote && (
                    <span
                        data-remote-chip
                        title={t.agent.chat.remote.chipTitle({server: serverRemote.name, url: serverRemote.baseUrl})}
                        className="flex shrink-0 items-center gap-1 rounded-full border border-tertiary/40 bg-tertiary/10 px-1.5 py-px text-ui-10 text-tertiary"
                    >
                        <Icon name="cloud" size={11} />
                        {t.agent.chat.remote.chip}
                    </span>
                )}
                {info && info.mcp.length > 0 && (
                    <span
                        className="truncate text-on-surface-variant"
                        title={t.agent.chat.mcpTitle({servers: info.mcp.join('\n')})}
                    >
                        {t.agent.chat.mcpCount({n: info.mcp.length})}
                    </span>
                )}
                {/* Segundo agente en paralelo. Cada chat es su propio proceso
                    y su propia conversación, así que el que revisa no
                    interrumpe al que trabaja — y al ser otro modelo, no
                    arrastra los mismos puntos ciegos. */}
                {onValidateWithAnother && (
                    <button
                        onClick={() => onValidateWithAnother(agentId)}
                        title={t.agent.chat.validateTitle}
                        className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-ui-11 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="fact_check" size={12} />
                        {t.agent.chat.validate}
                    </button>
                )}
                <button
                    onClick={() => setSearch((v) => (v === null ? '' : null))}
                    title={t.agent.chat.searchTitle}
                    aria-label={t.agent.chat.a11y.search}
                    aria-pressed={search !== null}
                    className={`shrink-0 rounded p-0.5 ${FOCUS} ${
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
                    title={t.agent.chat.resetTitle}
                    aria-label={t.agent.chat.a11y.reset}
                    className={`shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface ${FOCUS}`}
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
                        placeholder={t.agent.chat.searchPlaceholder}
                        title={t.agent.chat.searchInputTitle}
                        className="min-w-0 flex-1 bg-transparent text-on-surface outline-none placeholder:text-on-surface-variant/60"
                    />
                    {!!search.trim() && (
                        <span className="shrink-0 tabular-nums text-on-surface-variant">
                            {t.agent.chat.searchCount({shown: visibleTurns.length, total: turns.length})}
                        </span>
                    )}
                    <button
                        onClick={() => setSearch(null)}
                        title={t.agent.chat.searchCloseTitle}
                        className="shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="close" size={13} />
                    </button>
                </div>
            )}

            <div className="relative min-h-0 flex-1">
            <div
                ref={scrollRef}
                onScroll={onScrollLog}
                role="log"
                // `off`: un log anuncia cada adición, y una respuesta que llega
                // a pedazos lo convertiría en una ráfaga. Lo que se anuncia es
                // el indicador de trabajo de abajo.
                aria-live="off"
                aria-label={t.agent.chat.a11y.messages}
                className="h-full overflow-y-auto px-2 py-1.5 text-xs"
            >
                {turns.length === 0 && (
                    <div className="flex min-h-full flex-col items-center justify-center gap-2 px-4 py-8 text-center text-ui-11 text-on-surface-variant">
                        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                            <Icon name="auto_awesome" size={22} />
                        </span>
                        <p>
                            {hasContext
                                ? // El primer resaltado es el nombre del recurso,
                                  // que va con el color del texto y no en negrita.
                                  rich(t.agent.chat.emptyWithContext({noun: contextNoun(context.kind), label: context.label}), (s, n) =>
                                      n === 0 ? <span className="text-on-surface">{s}</span> : <strong>{s}</strong>,
                                  )
                                : rich(t.agent.chat.empty)}
                        </p>
                        <p className="opacity-70">
                            {rich(t.agent.chat.emptyHint({paste: navigator.platform.includes('Mac') ? '⌘V' : 'Ctrl+V'}))}
                        </p>
                        {/* Sugerencias para empezar. Frente a una caja en blanco
                            uno no sabe por dónde arrancar, y tres o cuatro
                            preguntas del módulo lo resuelven mejor que un
                            párrafo. Viven en el estado vacío y no pegadas a la
                            caja: se ven mientras no hay nada que leer, y se
                            van con el primer mensaje. */}
                        {!busy && !input.trim() && (
                            <div role="group" aria-label={t.agent.chat.startersLabel} className="mt-2 flex w-full max-w-sm flex-col gap-1.5">
                                {(t.agent.chat.starters[context.kind] ?? t.agent.chat.starters.none).map((st, si) => (
                                    <button
                                        key={st}
                                        onClick={() => {
                                            setInput(st)
                                            inputRef.current?.focus()
                                        }}
                                        title={t.agent.chat.starterTitle}
                                        className={`flex items-center gap-2 rounded-lg border border-outline-variant bg-surface-container px-3 py-1.5 text-left text-ui-11 text-on-surface-variant hover:border-primary/50 hover:bg-surface-container-high hover:text-on-surface ${FOCUS}`}
                                    >
                                        <Icon
                                            name={(STARTER_ICONS[context.kind] ?? STARTER_ICONS.none)[si] ?? 'chat'}
                                            size={14}
                                            className="shrink-0 text-primary"
                                        />
                                        <span className="min-w-0 flex-1">{st}</span>
                                    </button>
                                ))}
                            </div>
                        )}
                        {emptyExtra}
                    </div>
                )}

                {visibleTurns.map(({t: turn, i}) => {
                    const lead = turn.role === 'agent' ? splitLeadingNotice(turn.text) : {notice: '', rest: turn.text}
                    return (
                    <div key={i} className={`group mb-3 flex flex-col ${turn.role === 'user' ? 'items-end' : 'items-stretch'}`}>
                        <div
                            className={`mb-1 flex w-full items-center gap-1.5 text-ui-10 text-on-surface-variant ${
                                turn.role === 'user' ? 'flex-row-reverse' : ''
                            }`}
                        >
                            {turn.role === 'user' ? (
                                <span className="font-semibold uppercase tracking-wider">{t.agent.chat.you}</span>
                            ) : (
                                <>
                                    <Icon name="auto_awesome" size={12} className="shrink-0 text-primary" />
                                    <span className="font-semibold uppercase tracking-wider text-primary">{agentLabel}</span>
                                </>
                            )}
                            {turn.at && <span className="shrink-0 tabular-nums opacity-60">· {formatClock(turn.at)}</span>}

                            {/* Acciones del mensaje. Aparecen al pasar por
                                encima para no ensuciar la lectura, y las dos
                                trabajan sobre el TEXTO —no sobre el Markdown
                                renderizado— que es lo que sirve para pegar o
                                reescribir. */}
                            {turn.text && (
                                <span
                                    // Siempre en el árbol (opacidad 0) y no `display:none`: así
                                    // se llega con Tab, y al enfocar uno aparece la barra.
                                    className={`flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none ${turn.role === 'user' ? 'mr-auto' : 'ml-auto'}`}
                                >
                                    {/* Volver a mandar algo que ya preguntaste,
                                        casi siempre con un cambio. **No rebobina
                                        la conversación**: el hilo vive en el CLI.
                                        Trae el texto a la caja sin pisar lo que
                                        ya tengas escrito. */}
                                    {isUserTurn(turn) && (
                                        <button
                                            onClick={() => {
                                                setInput((prev) => (prev.trim() ? `${prev.replace(/\s+$/, '')}\n${turn.text}` : turn.text))
                                                inputRef.current?.focus()
                                            }}
                                            title={t.agent.chat.reuseTitle}
                                            className="flex items-center gap-1 rounded px-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                                        >
                                            <Icon name="reply" size={11} />
                                            {t.agent.chat.reuse}
                                        </button>
                                    )}
                                    <button
                                        onClick={() => {
                                            void navigator.clipboard.writeText(turn.text)
                                            setCopiedTurn(i)
                                        }}
                                        title={t.agent.chat.copyTitle}
                                        className="flex items-center gap-1 rounded px-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                                    >
                                        <Icon name={copiedTurn === i ? 'check' : 'content_copy'} size={11} />
                                        {copiedTurn === i ? t.agent.chat.copied : t.agent.chat.copy}
                                    </button>
                                </span>
                            )}
                        </div>

                        {/* Cada acción del agente como una tarjeta de terminal:
                            qué herramienta, sobre qué, y de qué tamaño. Plegada
                            por defecto: de un vistazo importa la secuencia, no
                            el argumento entero. */}
                        {turn.tools.map((tool, j) => (
                            <ToolCallCard key={j} tool={tool} />
                        ))}

                        {/* Aviso de la propia app al comienzo del turno (hoy: el
                            servidor es remoto y lo que lea el agente viaja). */}
                        {turn.notice && (
                            <p
                                data-turn-notice
                                className="mb-1.5 flex items-start gap-1.5 rounded-lg border border-tertiary/40 bg-tertiary/10 px-2 py-1 text-ui-11 text-on-surface"
                            >
                                <Icon name="cloud_upload" size={13} className="mt-px shrink-0 text-tertiary" />
                                <span className="min-w-0 flex-1 break-words">{turn.notice}</span>
                            </p>
                        )}

                        {/* El «no admite herramientas» del backend llega como
                            texto en cursiva al comienzo de la respuesta: acá se
                            separa y se dibuja como aviso de la app. */}
                        {lead.notice && (
                            <p
                                data-turn-notice
                                className="mb-1.5 flex items-start gap-1.5 rounded-lg border border-tertiary/40 bg-tertiary/10 px-2 py-1 text-ui-11 text-on-surface"
                            >
                                <Icon name="warning" size={13} className="mt-px shrink-0 text-tertiary" />
                                <span className="min-w-0 flex-1 break-words">{lead.notice}</span>
                            </p>
                        )}

                        {lead.rest && (
                            // Lo propio es una burbuja a la derecha; lo del
                            // agente, una tarjeta a todo el ancho. Quién habla se
                            // distingue por la forma, sin leer el encabezado.
                            <div
                                className={`break-words ${
                                    turn.role === 'user'
                                        ? 'max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-sm border border-primary/30 bg-primary/15 px-3 py-1.5 text-on-surface'
                                        : `rounded-xl rounded-tl-sm border border-outline-variant bg-surface-container px-3 py-2 ${
                                              fluid ? `w-fit max-w-full ${PROSE_CAP}` : ''
                                          }`
                                }`}
                            >
                                {/* La respuesta del agente viene en Markdown y
                                    se renderiza; el mensaje PROPIO no: tiene que
                                    verse tal cual lo mandaste. */}
                                {turn.role === 'user' ? (
                                    <>
                                        {turn.contexts && turn.contexts.length > 0 && (
                                            <span className="mb-1 flex flex-wrap justify-end gap-1">
                                                {turn.contexts.map((label, ci) => (
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
                                        {turn.text}
                                    </>
                                ) : (
                                    <MarkdownPreview
                                        source={lead.rest}
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

                        {turn.error && (
                            <p className="mt-1 flex items-start gap-1 rounded-lg border border-error/30 bg-error-container/30 px-2 py-1 text-ui-11 text-error">
                                <Icon name="error" size={12} className="mt-px shrink-0" />
                                <span className="min-w-0 flex-1 break-words">{turn.error}</span>
                            </p>
                        )}

                        {turn.usage && (
                            <p className="mt-1 text-ui-10 text-on-surface-variant/70" title={t.agent.chat.turnUsageTitle}>
                                {t.agent.chat.turnUsage({total: formatNumber(turn.usage.total), output: formatNumber(turn.usage.output)})}
                                {/* Costo solo si el CLI lo informa: cero acá
                                    significa "no lo dice", no "salió gratis". */}
                                {turn.usage.costUsd > 0 && t.agent.chat.cost({usd: turn.usage.costUsd.toFixed(4)})}
                            </p>
                        )}
                    </div>
                    )
                })}

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
                                    className="size-1 animate-bounce rounded-full bg-primary motion-reduce:animate-none"
                                    // Desfasados: los tres al unísono se leen
                                    // como un parpadeo, no como progreso.
                                    style={{animationDelay: `${i * 150}ms`, animationDuration: '900ms'}}
                                />
                            ))}
                        </span>
                        {/* Solo la etiqueta se anuncia: el contador cambia cada
                            segundo y leerlo sería una ráfaga. */}
                        <span role="status" className="min-w-0 flex-1 truncate">
                            {workingLabel}
                        </span>
                        <span className="shrink-0 tabular-nums opacity-70" aria-hidden>
                            {formatElapsed(elapsed)}
                        </span>
                    </div>
                )}
            </div>
            {!atBottom && turns.length > 0 && (
                <button
                    onClick={scrollToLatest}
                    title={t.agent.chat.jumpLatestTitle}
                    aria-label={t.agent.chat.a11y.jumpLatest}
                    className={`absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-outline-variant bg-surface-container-high px-2.5 py-1 text-ui-11 text-on-surface shadow-md hover:border-primary/60 ${FOCUS}`}
                >
                    <Icon name="arrow_downward" size={13} />
                    {busy && <span className="tabular-nums">{formatElapsed(elapsed)}</span>}
                </button>
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
                            {t.agent.chat.blockLines({n: contextBlocks[openBlock].text.trim().split('\n').length})}
                        </span>
                        <button
                            onClick={() => setOpenBlock(null)}
                            title={t.agent.chat.closePreview}
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
                                    ? t.agent.chat.workingAttachedTitle
                                    : t.agent.chat.workingDetachedTitle
                            }
                            className="shrink-0 rounded px-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                        >
                            {attachWorking ? t.agent.chat.attached : t.agent.chat.notAttached}
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
                                        {t.agent.chat.chars({n: formatNumber(r.body.length)})}
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
                                title={t.agent.chat.dequeueTitle}
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
                                {t.agent.chat.queueHeld}
                            </span>
                            <button
                                onClick={() => setQueueHeld(false)}
                                title={t.agent.chat.sendAnywayTitle}
                                className="shrink-0 rounded border border-outline-variant px-1.5 py-0.5 hover:text-on-surface"
                            >
                                {t.agent.chat.sendAnyway}
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* Avisos de un servidor de modelos. Van arriba de los controles y
                no en el encabezado porque dependen de lo que se elige ahí
                abajo: el modo y el repositorio. */}
            {isLLM && !workRepo && context.kind === 'utilities' && !noRepoDismissed && (
                <div
                    data-no-repo-notice
                    className="flex shrink-0 items-start gap-2 border-t border-outline-variant bg-surface-container-low px-2 py-1.5 text-ui-11 text-on-surface-variant"
                >
                    <Icon name="folder_off" size={14} className="mt-px shrink-0 text-primary" />
                    <span className="min-w-0 flex-1">
                        {rich(brainStatus && !brainStatus.mcpEnabled ? t.agent.chat.noRepo.noTools : t.agent.chat.noRepo.onlyMcp)}
                    </span>
                    <button
                        onClick={() => setNoRepoDismissed(true)}
                        title={t.agent.chat.noRepo.dismissTitle}
                        aria-label={t.agent.chat.noRepo.dismissTitle}
                        className={`shrink-0 rounded p-0.5 hover:bg-surface-variant hover:text-on-surface ${FOCUS}`}
                    >
                        <Icon name="close" size={13} />
                    </button>
                </div>
            )}
            {isLLM && serverHealth && serverHealth.health.error !== '' && (serverHealth.health.status === 'error' || serverHealth.health.status === 'checking') && (
                <HealthBanner health={serverHealth.health} server={agentLabel} onRetry={serverHealth.refresh} />
            )}
            {serverRemote && (workRepo || WRITE_MODES.has(mode)) && !remoteAck && (
                <div
                    data-remote-warning
                    className="flex shrink-0 items-start gap-2 border-t border-tertiary/40 bg-tertiary/10 px-2 py-1.5 text-ui-11 text-on-surface"
                >
                    <Icon name="cloud_upload" size={14} className="mt-px shrink-0 text-tertiary" />
                    <span className="min-w-0 flex-1">
                        {rich(t.agent.chat.remote.banner({server: serverRemote.name, url: serverRemote.baseUrl}))}
                    </span>
                    <button
                        onClick={() => setRemoteAck(true)}
                        title={t.agent.chat.remote.ackTitle}
                        className={`shrink-0 rounded border border-outline-variant px-1.5 py-0.5 text-on-surface-variant hover:text-on-surface ${FOCUS}`}
                    >
                        {t.agent.chat.remote.ack}
                    </button>
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
                    title={modeLabel(mode)?.hint}
                    size="sm"
                    leadingIcon={MODE_ICONS[mode] ?? 'visibility'}
                    menuMinWidth={280}
                    className={`rounded-lg ${modeLabel(mode)?.danger ? 'border-error! bg-error-container/30' : ''}`}
                    options={modes.map((m) => ({
                        value: m,
                        label: modeLabel(m)?.label ?? m,
                        description: modeLabel(m)?.hint,
                        danger: modeLabel(m)?.danger,
                        icon: <Icon name={MODE_ICONS[m] ?? 'visibility'} size={14} />,
                    }))}
                />

                {/* Cerebro: el agente anota solo lo que valga la pena conservar.
                    Es un interruptor y no un modo: se combina con cualquiera. */}
                <button
                    type="button"
                    data-brain-toggle
                    onClick={() => void toggleBrain()}
                    aria-pressed={brain}
                    title={
                        !brainAvailable
                            ? brainStatus && !brainStatus.mcpEnabled
                                ? t.agent.chat.brain.blockedMcp
                                : t.agent.chat.brain.blockedNotes
                            : brain
                              ? t.agent.chat.brain.titleOn({root: brainStatus?.root || 'Cerebro'})
                              : t.agent.chat.brain.titleOff({root: brainStatus?.root || 'Cerebro'})
                    }
                    className={`flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1 text-xs ${FOCUS} ${
                        !brainAvailable
                            ? brain
                                ? 'border-tertiary/60 text-tertiary'
                                : 'border-dashed border-outline-variant text-on-surface-variant/70 hover:text-on-surface-variant'
                            : brain
                              ? 'border-primary bg-primary/15 text-primary'
                              : 'border-outline-variant bg-surface text-on-surface-variant hover:border-primary/60 hover:text-on-surface'
                    }`}
                >
                    <Icon name="psychology" size={14} filled={brain && brainAvailable} />
                    {t.agent.chat.brain.label}
                    {!brainAvailable && <Icon name="lock" size={11} />}
                </button>

                {/* Esfuerzo como puntos y no como lista: es una escala, y una
                    escala se entiende mejor viéndola entera que abriendo un
                    desplegable. El primer punto es "el del CLI". */}
                {efforts.length > 0 && (
                    <span className="flex items-center gap-1" title={t.agent.chat.effortTitle}>
                        <Icon name="tune" size={12} className="text-on-surface-variant" />
                        <span className="text-on-surface-variant">
                            {t.agent.chat.effort}
                            {effort ? ` (${effort})` : ''}
                        </span>
                        <span className="flex items-center gap-1">
                            {['', ...efforts].map((e) => (
                                <button
                                    key={e || 'default'}
                                    onClick={() => setEffort(e)}
                                    title={e === '' ? t.agent.chat.effortDefault : e}
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
                    title={t.agent.chat.imageTitle}
                    className="flex shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-outline-variant bg-surface px-2 py-1 text-xs text-on-surface-variant hover:border-primary/60 hover:text-on-surface"
                >
                    <Icon name="image" size={14} />
                    {t.agent.chat.image}
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
                    mano — que era el motivo por el que antes era texto libre.
                    Con el modelo controlado desde afuera no se dibuja. */}
                {!modelControlled && (
                    <Select
                        value={model}
                        onChange={setModel}
                        title={
                            catalog?.models.find((m) => m.id === model)?.description ||
                            t.agent.chat.modelTitle
                        }
                        size="sm"
                        leadingIcon="memory"
                        menuMinWidth={260}
                        className="max-w-52 min-w-0 rounded-lg"
                        options={(catalog?.models ?? [{id: '', label: t.agent.chat.modelDefault, description: '', efforts: []}]).map((m) => ({
                            value: m.id,
                            label: m.label,
                            description: m.description || undefined,
                        }))}
                    />
                )}

                {/* Mientras el modo permisivo está activo se avisa en todos
                    los turnos, no solo al activarlo: una sesión larga hace
                    olvidar en qué modo quedó. */}
                {PERMISSIVE.has(mode) && (
                    <span
                        className={`flex items-center gap-1 ${isLLM || mode === 'edit' ? 'text-error' : 'text-on-surface-variant'}`}
                        title={modeLabel(mode)?.hint}
                    >
                        <Icon name="warning" size={12} />
                        {isLLM
                            ? mode === 'edit'
                                ? t.agent.chat.willEditFilesLlm
                                : t.agent.chat.actsAloneLlm
                            : mode === 'edit'
                              ? t.agent.chat.willEditFiles
                              : t.agent.chat.actsAlone}
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
                            ? t.agent.chat.sessionUsageTitle
                            : t.agent.chat.sessionUsageEmptyTitle
                    }
                >
                    <Icon name="monitoring" size={12} />
                    {sessionUsage.total > 0 ? (
                        <>
                            {t.agent.chat.inSession({n: formatTokens(sessionUsage.total)})}
                            <span className="opacity-70">{t.agent.chat.outputShort({n: formatTokens(sessionUsage.output)})}</span>
                            {sessionUsage.cost > 0 && <span className="opacity-70">{t.agent.chat.cost({usd: sessionUsage.cost.toFixed(4)})}</span>}
                        </>
                    ) : (
                        <span className="opacity-70">{t.agent.chat.noUsageYet}</span>
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
                        {rich(t.agent.chat.touched({n: touched}), (s) => <span className="text-on-surface">{s}</span>)}
                    </span>
                    {onReviewChanges && (
                        <button
                            onClick={() => {
                                setTouched(null)
                                onReviewChanges()
                            }}
                            title={t.agent.chat.reviewTitle}
                            className="shrink-0 rounded bg-primary px-2 py-0.5 text-on-primary"
                        >
                            {t.agent.chat.review}
                        </button>
                    )}
                    <button
                        onClick={() => setTouched(null)}
                        title={t.agent.chat.dismissTouchedTitle}
                        className="shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="close" size={14} />
                    </button>
                </div>
            )}

            {approval && (
                <AgentApprovalDialog
                    request={approval}
                    agentLabel={agentLabel}
                    onAllow={() => {
                        answeredRef.current = approval.id
                        void RespondAgentApproval(approval.id, true, '')
                        setApproval(null)
                    }}
                    // Cerrar es DENEGAR, no descartar: del otro lado hay un
                    // proceso bloqueado esperando, y no contestar lo colgaría
                    // hasta que venza el tiempo.
                    onDeny={() => {
                        if (answeredRef.current !== approval.id) {
                            answeredRef.current = approval.id
                            void RespondAgentApproval(approval.id, false, t.agent.approvalDeniedReason)
                        }
                        setApproval(null)
                    }}
                />
            )}

            {pendingMode && (
                <ConfirmDialog
                    title={pendingMode === 'edit' ? t.agent.chat.allowEditsTitle : t.agent.chat.allowAutoTitle}
                    description={
                        pendingMode === 'edit'
                            ? isLLM
                                ? t.agent.chat.allowEditsDescriptionLlm({agent: agentLabel})
                                : t.agent.chat.allowEditsDescription({agent: agentLabel})
                            : isLLM
                              ? t.agent.chat.allowAutoDescriptionLlm({agent: agentLabel})
                              : t.agent.chat.allowAutoDescription({agent: agentLabel})
                    }
                    confirmLabel={pendingMode === 'edit' ? t.agent.chat.allowEdits : t.agent.chat.allow}
                    danger={pendingMode === 'edit' || (isLLM && pendingMode === 'auto')}
                    onConfirm={() => setMode(pendingMode)}
                    onClose={() => setPendingMode(null)}
                />
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
                                    title={t.agent.chat.blockChipTitle({label: b.label, n: b.text.trim().split('\n').length})}
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
                                    title={t.agent.chat.removeBlockTitle}
                                    className="shrink-0 rounded hover:text-error"
                                >
                                    <Icon name="close" size={11} />
                                </button>
                            </span>
                        ))}
                        {attachments.map((path) => (
                            <span
                                key={path}
                                title={t.agent.chat.attachmentTitle({path})}
                                className="flex max-w-full items-center gap-1 rounded-md border border-outline-variant bg-surface-container px-1.5 py-0.5 text-ui-10 text-on-surface-variant"
                            >
                                <Icon name="image" size={11} className="shrink-0 text-primary" />
                                <span className="truncate">{path.split('/').pop()}</span>
                                <button
                                    onClick={() => setAttachments((prev) => prev.filter((p) => p !== path))}
                                    title={t.agent.chat.removeAttachmentTitle}
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
                        // Enter que confirma una composición (IME) no es «enviar».
                        if (e.key === 'Enter' && e.nativeEvent.isComposing) return
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
                    aria-label={t.agent.chat.a11y.composer}
                    placeholder={
                        busy
                            ? t.agent.chat.busyPlaceholder({agent: agentLabel})
                            : t.agent.chat.placeholder({agent: agentLabel})
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
                            title={t.agent.chat.enqueueTitle}
                            aria-label={t.agent.chat.a11y.enqueue}
                            className={`shrink-0 rounded-lg border border-outline-variant p-1.5 text-on-surface-variant hover:text-on-surface disabled:opacity-40 ${FOCUS}`}
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
                            title={t.agent.chat.stopTitle}
                            aria-label={t.agent.chat.a11y.stop}
                            className={`shrink-0 rounded-lg bg-error p-1.5 text-on-error ${FOCUS}`}
                        >
                            <Icon name="stop" size={14} />
                        </button>
                    </>
                ) : (
                    <button
                        onClick={send}
                        disabled={!input.trim()}
                        title={t.agent.chat.sendTitle}
                        aria-label={t.agent.chat.a11y.send}
                        data-chat-send
                        className={`shrink-0 rounded-lg bg-primary p-1.5 text-on-primary disabled:opacity-40 ${FOCUS}`}
                    >
                        <Icon name="send" size={14} />
                    </button>
                )}
                </div>
            </div>
        </div>
    )
}
