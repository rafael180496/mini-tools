import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {
    AgentChatHistory,
    AgentChatModes,
    AgentModelCatalog,
    CancelAgentChat,
    GitListWorkTree,
    RespondAgentApproval,
    SaveChatAttachment,
    SetAgentChatSettings,
    ResetAgentChat,
    SendAgentChat,
} from '../../../wailsjs/go/main/App'
import {EventsOn} from '../../../wailsjs/runtime'
import {agentmodels} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import ConfirmDialog from '../ConfirmDialog'

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


interface Turn {
    role: 'user' | 'agent'
    text: string
    tools: ToolCall[]
    usage?: ChatUsage
    error?: string
}

interface AgentChatProps {
    sessionId: string
    repoId: string
    agentId: string
    agentLabel: string
    // Prompt que llega desde afuera (el botón Preguntar del editor o del
    // diff). Lleva token por el mismo motivo que en el editor: pedir dos veces
    // lo mismo tiene que volver a llenarlo.
    seed?: {text: string; token: number} | null
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
    // Abre OTRO chat, con otro agente, para que revise lo que este viene
    // haciendo. Es el caso de trabajar en paralelo: uno propone, otro valida.
    onValidateWithAnother?: (excludeAgentId: string) => void
    // Avisa el id de conversación que devolvió el CLI. Es lo que se guarda
    // para poder retomar el chat después de cerrar la app — sin esto el
    // historial tendría entradas que no llevan a ningún lado.
    onConversation?: (conversationId: string) => void
}

export default function AgentChat({
    sessionId,
    repoId,
    agentId,
    agentLabel,
    seed,
    resumeConversationId,
    initialSettings,
    onTurnFinished,
    onReviewChanges,
    onValidateWithAnother,
    onConversation,
}: AgentChatProps) {
    const [turns, setTurns] = useState<Turn[]>([])
    const [input, setInput] = useState('')
    const [busy, setBusy] = useState(false)
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
    const inputRef = useRef<HTMLTextAreaElement>(null)
    // Imágenes adjuntas al próximo mensaje: rutas ya escritas en el disco,
    // porque los tres CLIs las reciben por ruta y no en memoria.
    const [attachments, setAttachments] = useState<string[]>([])
    const scrollRef = useRef<HTMLDivElement>(null)
    // El modo vigente para el manejador de eventos, que se registra una sola
    // vez y no puede cerrarse sobre el `mode` de un render viejo.
    const modeRef = useRef(mode)
    modeRef.current = mode
    const onTurnFinishedRef = useRef(onTurnFinished)
    onTurnFinishedRef.current = onTurnFinished
    const onConversationRef = useRef(onConversation)
    onConversationRef.current = onConversation

    useEffect(() => {
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

    useEffect(() => {
        AgentChatModes(agentId)
            .then((m) => setModes(m?.length ? m : ['']))
            .catch(() => setModes(['']))
    }, [agentId])

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
                    last = {role: 'agent', text: '', tools: []}
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
    // dejarlo. Un historial vacío NO es un error — Antigravity guarda sus
    // pasos en un formato que no se puede leer, y ahí el chat abre en blanco y
    // la conversación sigue encadenando igual.
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
    // esperando— alcanza con que las atienda el chat visible.
    useEffect(() => {
        const off = EventsOn('agent-approval', (req: ApprovalRequest) => setApproval(req))
        return () => {
            off()
        }
    }, [])

    // Autoscroll al final mientras llega la respuesta.
    useEffect(() => {
        const el = scrollRef.current
        if (el) el.scrollTop = el.scrollHeight
    }, [turns])

    useEffect(() => {
        if (seed?.text) setInput(seed.text)
    }, [seed?.token, seed?.text])

    // Sugerencias para el selector de @: archivos Y carpetas, como en un
    // explorador. Las carpetas se derivan de las rutas —el backend devuelve
    // archivos— porque referenciar un directorio entero es una forma normal de
    // darle contexto a un agente ("mirá backend/git/").
    const suggestions = useMemo(() => {
        if (mention === null) return []
        const q = mention.toLowerCase()

        const dirs = new Set<string>()
        for (const p of paths) {
            const parts = p.split('/')
            for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/')
        }

        const all = [...dirs, ...paths]
        const matched = q ? all.filter((p) => p.toLowerCase().includes(q)) : all
        // Tope bajo a propósito: una lista larga no se lee, se filtra. Se
        // ordena por ruta más corta, que suele ser la más general y la que uno
        // busca cuando escribe poco.
        return matched.sort((a, b) => a.length - b.length).slice(0, 12)
    }, [mention, paths])

    // insertMention reemplaza el `@loquesea` que se está escribiendo por la
    // ruta elegida. Se manda la RUTA y no el contenido: el agente ya sabe
    // abrir archivos, y pegarlos gastaría contexto duplicando lo que va a leer.
    const insertMention = useCallback(
        (path: string) => {
            setInput((prev) => {
                const at = prev.lastIndexOf('@')
                if (at < 0) return prev
                return prev.slice(0, at) + '@' + path + ' '
            })
            setMention(null)
            inputRef.current?.focus()
        },
        [],
    )

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

    const send = useCallback(async () => {
        const text = input.trim()
        if (!text || busy) return
        setTurns((prev) => [...prev, {role: 'user', text, tools: []}])
        setInput('')
        setBusy(true)
        try {
            await SendAgentChat(sessionId, repoId, agentId, text, mode, effort, model.trim(), attachments)
            setAttachments([])
        } catch (e) {
            setTurns((prev) => [...prev, {role: 'agent', text: '', tools: [], error: String(e)}])
            setBusy(false)
        }
    }, [input, busy, sessionId, repoId, agentId, mode, effort, model, attachments])

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
            <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-2 py-1 text-[11px]">
                <Icon name="smart_toy" size={13} className="shrink-0 text-primary" />
                <span className="font-medium text-on-surface">{agentLabel}</span>
                {info?.model && <span className="text-on-surface-variant">{info.model}</span>}
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
                        className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="fact_check" size={12} />
                        Validar con otro
                    </button>
                )}
                <button
                    onClick={() => {
                        void ResetAgentChat(sessionId)
                        setTurns([])
                        setInfo(null)
                    }}
                    title="Olvida la conversación: el próximo mensaje arranca de cero en vez de encadenar con lo anterior."
                    className="shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="restart_alt" size={14} />
                </button>
            </div>

            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5 text-xs">
                {turns.length === 0 && (
                    <p className="p-3 text-center text-[11px] text-on-surface-variant">
                        Preguntale a {agentLabel} sobre este repositorio.
                        <br />
                        Empieza en <strong>solo consulta</strong>: lee y propone, no toca nada. Para que edite, elegí un modo
                        abajo — cada uno te dice qué le vas a permitir antes de activarlo.
                        <br />
                        Podés pegar una captura con {navigator.platform.includes('Mac') ? '⌘V' : 'Ctrl+V'} o escribir{' '}
                        <strong>@</strong> para referenciar un archivo del repo.
                    </p>
                )}

                {turns.map((t, i) => (
                    <div key={i} className={`mb-2 ${t.role === 'user' ? 'text-on-surface' : ''}`}>
                        <div className="mb-0.5 flex items-center gap-1 text-[10px] uppercase tracking-wider text-on-surface-variant">
                            <Icon name={t.role === 'user' ? 'person' : 'smart_toy'} size={11} />
                            {t.role === 'user' ? 'Vos' : agentLabel}
                        </div>

                        {/* Cada acción del agente en una línea: qué herramienta,
                            sobre qué, y de qué tamaño. Es lo que hace legible
                            un turno en el que trabaja solo — plegado por
                            defecto, porque lo que importa de un vistazo es la
                            secuencia y no el argumento entero. */}
                        {t.tools.map((tool, j) => (
                            <details key={j} className="mb-1 rounded border border-outline-variant bg-surface-container px-1.5 py-0.5">
                                <summary className="flex cursor-pointer items-center gap-1.5 text-[11px]">
                                    <Icon name="build" size={11} className="shrink-0 text-on-surface-variant" />
                                    <span className="shrink-0 font-medium text-on-surface">{tool.name}</span>
                                    {tool.summary && (
                                        <span className="min-w-0 flex-1 truncate font-mono text-on-surface-variant" title={tool.summary}>
                                            {tool.summary}
                                        </span>
                                    )}
                                    {tool.detail && (
                                        <span className="shrink-0 rounded bg-surface-variant px-1 text-[10px] text-on-surface-variant">
                                            {tool.detail}
                                        </span>
                                    )}
                                </summary>
                                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-[10px] text-on-surface-variant">
                                    {tool.input}
                                </pre>
                            </details>
                        ))}

                        {t.text && (
                            // El mensaje propio se marca con una barra a la
                            // izquierda y fondo más fuerte: en la versión
                            // anterior los dos lados eran bloques casi iguales
                            // y había que leer el encabezado para saber quién
                            // hablaba, que es justo lo que un chat evita.
                            <div
                                className={`whitespace-pre-wrap break-words rounded px-2 py-1 ${
                                    t.role === 'user'
                                        ? 'border-l-2 border-primary bg-primary/15 text-on-surface'
                                        : 'bg-surface-container'
                                }`}
                            >
                                {t.text}
                            </div>
                        )}

                        {t.error && <p className="mt-0.5 rounded bg-error-container/40 px-2 py-1 text-[11px] text-error">{t.error}</p>}

                        {t.usage && (
                            <p
                                className="mt-0.5 text-[10px] text-on-surface-variant"
                                title="Tokens de este turno, informados por el propio CLI"
                            >
                                {t.usage.total.toLocaleString('es')} tokens · {t.usage.output.toLocaleString('es')} de salida
                                {/* Costo solo si el CLI lo informa: cero acá
                                    significa "no lo dice", no "salió gratis". */}
                                {t.usage.costUsd > 0 && ` · US$${t.usage.costUsd.toFixed(4)}`}
                            </p>
                        )}
                    </div>
                ))}
            </div>

            {mention !== null && suggestions.length > 0 && (
                <div className="max-h-48 shrink-0 overflow-y-auto border-t border-outline-variant bg-surface-container">
                    {suggestions.map((p) => {
                        const isDir = p.endsWith('/')
                        const name = isDir ? p.slice(0, -1).split('/').pop() + '/' : p.split('/').pop()
                        const dir = p.slice(0, p.length - (name?.length ?? 0))
                        return (
                            <button
                                key={p}
                                onClick={() => insertMention(p)}
                                title={p}
                                className="flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] hover:bg-surface-container-high"
                            >
                                <Icon name={isDir ? 'folder' : 'description'} size={12} className="shrink-0 text-on-surface-variant" />
                                <span className="shrink-0 text-on-surface">{name}</span>
                                {dir && <span className="min-w-0 flex-1 truncate text-on-surface-variant/70">{dir}</span>}
                            </button>
                        )
                    })}
                </div>
            )}

            {attachments.length > 0 && (
                <div className="flex shrink-0 flex-wrap items-center gap-1 border-t border-outline-variant px-1.5 pt-1">
                    {attachments.map((path) => (
                        <span
                            key={path}
                            title={`${path} — se le pasa al agente por su ruta; el archivo vive en los datos de la app, no en el repositorio`}
                            className="flex items-center gap-1 rounded border border-outline-variant bg-surface-container px-1.5 py-0.5 text-[10px] text-on-surface-variant"
                        >
                            <Icon name="image" size={11} className="shrink-0 text-primary" />
                            {path.split('/').pop()}
                            <button
                                onClick={() => setAttachments((prev) => prev.filter((p) => p !== path))}
                                title="Quitar del mensaje"
                                className="rounded hover:text-on-surface"
                            >
                                <Icon name="close" size={10} />
                            </button>
                        </span>
                    ))}
                </div>
            )}

            {/* Controles del turno. Van pegados a la caja de texto y no en un
                menú escondido porque cambian lo que el agente TIENE PERMITIDO
                hacer: es lo último que hay que mirar antes de mandar. */}
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-outline-variant px-1.5 pt-1 text-[11px]">
                <select
                    value={mode}
                    onChange={(e) => {
                        const next = e.target.value
                        // Pasar a un modo permisivo NO lo activa: abre la
                        // aprobación. El modo actual no cambia hasta que el
                        // usuario diga que sí.
                        if (PERMISSIVE.has(next)) setPendingMode(next)
                        else setMode(next)
                    }}
                    title={MODE_LABELS[mode]?.hint}
                    className={`rounded border px-1 py-0.5 outline-none focus:border-primary ${
                        MODE_LABELS[mode]?.danger
                            ? 'border-error bg-error-container/30 text-on-surface'
                            : 'border-outline-variant bg-surface text-on-surface'
                    }`}
                >
                    {modes.map((m) => (
                        <option key={m} value={m}>
                            {MODE_LABELS[m]?.label ?? m}
                        </option>
                    ))}
                </select>

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
                    className="flex shrink-0 cursor-pointer items-center gap-1 rounded border border-outline-variant px-1.5 py-0.5 text-on-surface-variant hover:text-on-surface"
                >
                    <Icon name="image" size={12} />
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
                <select
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    title={
                        catalog?.models.find((m) => m.id === model)?.description ||
                        'Modelo para este turno. La lista la informa el propio CLI.'
                    }
                    className="max-w-44 rounded border border-outline-variant bg-surface px-1 py-0.5 text-on-surface outline-none focus:border-primary"
                >
                    {(catalog?.models ?? [{id: '', label: 'Por defecto', description: '', efforts: []}]).map((m) => (
                        <option key={m.id || 'default'} value={m.id} title={m.description}>
                            {m.label}
                        </option>
                    ))}
                </select>

                {/* Mientras el modo permisivo está activo se avisa en todos
                    los turnos, no solo al activarlo: una sesión larga hace
                    olvidar en qué modo quedó. */}
                {PERMISSIVE.has(mode) && (
                    <span className={`flex items-center gap-1 ${mode === 'edit' ? 'text-error' : 'text-on-surface-variant'}`} title={MODE_LABELS[mode]?.hint}>
                        <Icon name="warning" size={12} />
                        {mode === 'edit' ? 'Va a modificar archivos' : 'Actúa sin volver a preguntarte'}
                    </span>
                )}
            </div>

            {/* Cierre del círculo de un turno autónomo: qué tocó y qué hacer
                con eso. Va arriba de la caja de texto porque es lo que hay que
                mirar antes de seguir pidiéndole cosas. */}
            {touched !== null && (
                <div className="flex shrink-0 items-center gap-2 border-t border-outline-variant bg-surface-container-high px-2 py-1 text-[11px]">
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

            <div className="flex shrink-0 items-end gap-1 border-t border-outline-variant p-1.5">
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
                        setMention(at >= 0 && !tail.includes(' ') && !tail.includes('\n') ? tail : null)
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
                        if (e.key === 'Enter' && !e.shiftKey && mention !== null && suggestions.length > 0) {
                            e.preventDefault()
                            insertMention(suggestions[0])
                            return
                        }
                        // Enter manda, Shift+Enter hace salto de línea — lo
                        // habitual en un chat, y lo contrario de la terminal,
                        // donde Enter es del programa.
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault()
                            void send()
                        }
                    }}
                    rows={2}
                    placeholder={`Preguntale a ${agentLabel}… (Enter manda, Shift+Enter salta de línea)`}
                    className="min-w-0 flex-1 resize-none rounded border border-outline-variant bg-surface px-2 py-1 text-xs text-on-surface outline-none focus:border-primary"
                />
                {busy ? (
                    <button
                        onClick={() => void CancelAgentChat(sessionId)}
                        title="Corta el turno en curso"
                        className="shrink-0 rounded bg-error px-2 py-1.5 text-xs text-on-error"
                    >
                        <Icon name="stop" size={14} />
                    </button>
                ) : (
                    <button
                        onClick={() => void send()}
                        disabled={!input.trim()}
                        title="Manda el mensaje (Enter)"
                        className="shrink-0 rounded bg-primary px-2 py-1.5 text-xs text-on-primary disabled:opacity-40"
                    >
                        <Icon name="send" size={14} />
                    </button>
                )}
            </div>
        </div>
    )
}
