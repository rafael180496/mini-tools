import {useEffect, useState, type MouseEvent as ReactMouseEvent} from 'react'
import {AnalyzeSSHError} from '../../../wailsjs/go/main/App'
import {main} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import MarkdownPreview from '../MarkdownPreview'
import AskAgentPicker from '../agent/AskAgentPicker'
import {useAgentChat} from '../agent/AgentChatHost'

// Analizar un error de la terminal SSH con el agente.
//
// **Lo que hace útil a esto y no a copiar el error en un chat cualquiera: el
// contexto del sistema operativo.** El mismo error se arregla distinto en
// SunOS, RHEL, Ubuntu y Alpine —cambian el gestor de paquetes, las rutas, el
// init y hasta las banderas de comandos que existen en los cuatro—, y un
// agente sin ese dato contesta con la distribución más común de su
// entrenamiento, que sobre un Solaris de producción no existe.
//
// **Y lo que NO hace: escribir en la terminal.** El comando propuesto se copia
// o se inserta sin ejecutar. Un asistente que escribe y manda Enter en una
// sesión de producción es exactamente lo que nadie pidió.
//
// **Panel lateral con ancho acotado, no franja inferior.** Se monta como una
// columna más al lado de la terminal, igual que el historial y los snippets.
// Antes no tenía ancho propio: una línea larga de la respuesta lo estiraba
// hasta dejar la terminal en cero columnas, justo cuando lo que se quiere es
// leer la explicación con el error a la vista.

interface Props {
    connId: string
    connName: string
    // La terminal concreta cuyo buffer se analiza. Con varias abiertas contra
    // el mismo servidor, mandar solo el connId analizaría el error de otra
    // pestaña — la última en la que se tecleó, que no tiene por qué ser esta.
    sessionId: string
    // Texto seleccionado en xterm.js, si el usuario marcó algo. Vacío = las
    // últimas líneas del buffer, que es el caso de "acaba de fallar algo".
    selection: string
    onClose: () => void
    // Inserta un comando en la terminal SIN ejecutarlo: queda escrito y el
    // Enter lo pone el usuario.
    onInsertCommand: (command: string) => void
}

const WIDTH_DEFAULT = 460
const WIDTH_MIN = 320
const WIDTH_MAX = 1000

// Ancho elegido, recordado mientras la app está abierta: el panel se desmonta
// al cerrarlo y volver a arrastrarlo en cada análisis cansa.
let rememberedWidth = WIDTH_DEFAULT

export default function SshErrorAnalysis({connId, connName, sessionId, selection, onClose, onInsertCommand}: Props) {
    const [result, setResult] = useState<main.SSHErrorAnalysis | null>(null)
    const [busy, setBusy] = useState(true)
    const [error, setError] = useState('')
    const [showSent, setShowSent] = useState(false)
    // Proveedor de ESTE análisis. Vacío = el activo de la app. Cambiarlo
    // relanza la pregunta: pedir la misma explicación a otro modelo es
    // justamente para lo que sirve.
    const [askAgent, setAskAgent] = useState('')
    // Sube para relanzar la misma pregunta (botón Reintentar).
    const [attempt, setAttempt] = useState(0)
    const [width, setWidth] = useState(rememberedWidth)
    const [copied, setCopied] = useState<number | null>(null)
    const chat = useAgentChat()
    // Segundos desde que se lanzó la pregunta. Un agente de línea de comandos
    // tarda de 20 s a un minuto en contestar esto, y un spinner quieto durante
    // ese rato se lee como colgado: el número que avanza es lo que dice que no.
    const [elapsed, setElapsed] = useState(0)

    useEffect(() => {
        if (!busy) return
        const started = Date.now()
        setElapsed(0)
        const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
        return () => window.clearInterval(id)
    }, [busy])

    useEffect(() => {
        let cancelled = false
        setBusy(true)
        setResult(null)
        setError('')
        setShowSent(false)
        AnalyzeSSHError(connId, sessionId, selection, 60, askAgent)
            .then((r) => !cancelled && setResult(r))
            .catch((e) => !cancelled && setError(String(e)))
            .finally(() => !cancelled && setBusy(false))
        return () => {
            cancelled = true
        }
    }, [connId, sessionId, selection, askAgent, attempt])

    function startResize(e: ReactMouseEvent) {
        e.preventDefault()
        const startX = e.clientX
        const startWidth = width
        const max = () => Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, window.innerWidth * 0.7))
        const clamp = (px: number) => Math.round(Math.min(max(), Math.max(WIDTH_MIN, px)))
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
        function onMove(ev: MouseEvent) {
            setWidth(clamp(startWidth + (startX - ev.clientX)))
        }
        function onUp(ev: MouseEvent) {
            rememberedWidth = clamp(startWidth + (startX - ev.clientX))
            document.body.style.cursor = ''
            document.body.style.userSelect = ''
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
    }

    function copyCommand(c: string, i: number) {
        void navigator.clipboard.writeText(c).then(() => {
            setCopied(i)
            window.setTimeout(() => setCopied((v) => (v === i ? null : v)), 1500)
        })
    }

    // Los comandos que propuso el agente, sacados de los bloques de código.
    const commands = extractCommands(result?.answer ?? '')
    const smallButton =
        'flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-ui-11 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50'

    return (
        <div className="relative flex h-full min-w-0 shrink-0 flex-col border-l border-outline-variant bg-surface-container" style={{width}}>
            {/* Tirador superpuesto sobre el borde, igual que el de snippets. */}
            <div
                onMouseDown={startResize}
                onDoubleClick={() => {
                    setWidth(WIDTH_DEFAULT)
                    rememberedWidth = WIDTH_DEFAULT
                }}
                title="Arrastrar para cambiar el ancho del panel. Doble clic vuelve al ancho por defecto"
                className="absolute inset-y-0 -left-0.5 z-10 w-1.5 cursor-col-resize hover:bg-primary/30"
            />

            {/* Cabecera: qué es y de dónde. */}
            <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-3 py-2">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
                    <Icon name="troubleshoot" size={15} />
                </span>
                <div className="min-w-0 flex-1 leading-tight">
                    <p className="text-xs font-semibold text-on-surface">Análisis del error</p>
                    <p className="truncate text-ui-10 text-on-surface-variant" title={connName}>
                        {selection.trim() ? 'Selección de ' : 'Últimas líneas de '}
                        {connName}
                    </p>
                </div>
                <button
                    onClick={onClose}
                    title="Cierra el análisis. La terminal no se toca."
                    className="shrink-0 rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="close" size={16} />
                </button>
            </div>

            {/* Barra de acciones: con qué agente, qué se mandó, y seguir. */}
            <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-outline-variant bg-surface-container-low px-2 py-1">
                <AskAgentPicker value={askAgent} onChange={setAskAgent} disabled={busy} />
                <button
                    onClick={() => setAttempt((n) => n + 1)}
                    disabled={busy}
                    title="Vuelve a hacer la misma pregunta — relee las últimas líneas de la terminal"
                    className={smallButton}
                >
                    <Icon name="refresh" size={13} />
                    Reintentar
                </button>
                {result && (
                    <button
                        onClick={() => setShowSent((v) => !v)}
                        title="Muestra exactamente qué líneas de la terminal se le mandaron al agente. Lo que sale de tu máquina tiene que poder verse."
                        className={`${smallButton} ${showSent ? 'bg-surface-variant text-on-surface' : ''}`}
                    >
                        <Icon name="visibility" size={13} />
                        {result.lines.length} líneas
                    </button>
                )}
                {!!result?.redacted && (
                    <span
                        className="flex shrink-0 items-center gap-1 rounded-md bg-tertiary/15 px-1.5 py-1 text-ui-11 text-tertiary"
                        title="Se encontraron valores que parecen secretos en la salida de la terminal (una contraseña en la línea de comandos, un token en una cabecera, una clave privada pegada) y NO se le mandaron al agente. Si la respuesta parece incompleta, puede ser por esto."
                    >
                        <Icon name="shield" size={12} filled />
                        {result.redacted} {result.redacted === 1 ? 'oculto' : 'ocultos'}
                    </span>
                )}
                <div className="flex-1" />
                {result && (
                    <button
                        onClick={() =>
                            chat.open({
                                context: {kind: 'ssh', id: connId, label: connName},
                                // Se adjunta EXACTAMENTE lo que se analizó —las
                                // mismas líneas ya redactadas, el sistema que se
                                // detectó y la respuesta—, no una referencia
                                // `@ssh:`: esa se resuelve al mandar contra la
                                // terminal donde se tecleó por última vez, que
                                // puede ser otra pestaña y ya no tiene la
                                // selección ni sabe qué contestó el análisis.
                                attachments: [
                                    {
                                        label: result.osInfo
                                            ? `Salida analizada de ${connName} (${result.lines.length} líneas)`
                                            : `Salida analizada de ${connName} (${result.lines.length} líneas, SO no detectado)`,
                                        text:
                                            (result.osInfo ? `# Sistema operativo detectado\n${result.osInfo}\n\n# Salida\n` : '') +
                                            result.lines.join('\n'),
                                        icon: 'terminal',
                                    },
                                    ...(result.answer
                                        ? [{label: 'Análisis anterior del agente', text: result.answer, language: 'markdown', icon: 'troubleshoot'}]
                                        : []),
                                ],
                            })
                        }
                        title="Abre el chat con la salida analizada, el sistema detectado y esta respuesta ya adjuntos, para repreguntar sin volver a explicar nada"
                        className={smallButton}
                    >
                        <Icon name="forum" size={13} />
                        Seguir en el chat
                    </button>
                )}
            </div>

            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-3 py-2 text-xs">
                {busy && (
                    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                        <span aria-hidden className="h-6 w-6 animate-spin rounded-full border-2 border-t-transparent border-primary" />
                        <p className="text-xs text-on-surface">
                            {elapsed < 3 ? 'Leyendo la salida y el sistema del servidor…' : 'El agente está analizando el error…'}
                        </p>
                        <p className="font-mono text-ui-11 tabular-nums text-on-surface-variant">{elapsed} s</p>
                        {elapsed >= 15 && (
                            <p className="max-w-xs text-ui-10 text-on-surface-variant/70">
                                Es normal que tarde hasta un minuto: el agente corre en tu máquina y razona antes de
                                contestar. Si pasan 3 minutos sin respuesta, se corta solo y avisa.
                            </p>
                        )}
                    </div>
                )}

                {error && !busy && (
                    <div className="flex flex-col gap-2 rounded-lg border border-error/40 bg-error-container/30 p-2.5">
                        <p className="flex items-center gap-1.5 text-xs font-medium text-error">
                            <Icon name="error" size={14} />
                            No se pudo analizar
                        </p>
                        <p className="wrap-break-word text-ui-11 text-on-surface-variant">{error}</p>
                        <button
                            onClick={() => setAttempt((n) => n + 1)}
                            className="flex w-fit items-center gap-1 rounded-md bg-primary px-2 py-1 text-ui-11 font-medium text-on-primary hover:opacity-90"
                        >
                            <Icon name="refresh" size={13} />
                            Reintentar
                        </button>
                    </div>
                )}

                {result && !result.osInfo && !busy && (
                    <p
                        className="mb-2 flex gap-1.5 rounded-lg border border-outline-variant bg-surface-container-low px-2 py-1.5 text-ui-10 text-on-surface-variant"
                        title="El sistema se deduce de lo que la terminal ya imprimió (el banner de login, un uname que hayas corrido). No se ejecuta nada por tu cuenta: escribir en tu sesión interactiva aparecería en tu pantalla y podría caer dentro de un editor abierto."
                    >
                        <Icon name="info" size={13} className="mt-px shrink-0" />
                        <span>
                            No se pudo determinar el sistema operativo del servidor, así que la respuesta puede no ser
                            específica. Corré <span className="font-mono text-on-surface">uname -a</span> y reintentá.
                        </span>
                    </p>
                )}

                {showSent && result && (
                    <pre className="mb-2 max-h-48 overflow-auto rounded-lg border border-outline-variant bg-surface-container-low px-2 py-1.5 font-mono text-ui-10 text-on-surface-variant">
                        {result.osInfo && `# sistema detectado\n${result.osInfo}\n\n# salida\n`}
                        {result.lines.join('\n')}
                    </pre>
                )}

                {result?.answer && (
                    <div className="min-w-0 wrap-break-word leading-relaxed">
                        <MarkdownPreview source={result.answer} />
                    </div>
                )}
            </div>

            {/* Comandos propuestos, fijos al pie: son lo accionable, y con la
                explicación larga quedaban al final de un scroll. */}
            {commands.length > 0 && !busy && (
                <div className="flex max-h-[40%] shrink-0 flex-col border-t border-outline-variant bg-surface-container-low">
                    <p className="shrink-0 px-3 pt-2 pb-1 text-ui-10 text-on-surface-variant">
                        <span className="font-semibold uppercase tracking-wider">Comandos propuestos</span> · ninguno se
                        ejecuta solo: <em>Insertar</em> lo escribe y el Enter lo ponés vos
                    </p>
                    <div className="min-h-0 overflow-y-auto px-2 pb-2">
                        {commands.map((c, i) => (
                            <div key={i} className="group flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-surface-variant/60">
                                <code
                                    title={c}
                                    className="min-w-0 flex-1 truncate font-mono text-ui-11 text-on-surface"
                                >
                                    <span className="select-none text-on-surface-variant/50">$ </span>
                                    {c}
                                </code>
                                <button
                                    onClick={() => copyCommand(c, i)}
                                    title="Copia el comando al portapapeles"
                                    className="shrink-0 rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                                >
                                    <Icon name={copied === i ? 'check' : 'content_copy'} size={13} />
                                </button>
                                <button
                                    onClick={() => onInsertCommand(c)}
                                    title="Escribe el comando en la terminal SIN ejecutarlo — podés leerlo y editarlo antes de apretar Enter"
                                    className="shrink-0 rounded-md bg-primary/15 px-2 py-0.5 text-ui-11 font-medium text-primary hover:bg-primary hover:text-on-primary"
                                >
                                    Insertar
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
}

// extractCommands saca las líneas de comando de los bloques de código de la
// respuesta.
//
// Se filtran los comentarios y las líneas vacías, y se acota a unos pocos: una
// respuesta que propone quince comandos no se resuelve con quince botones —
// para eso está el bloque de código completo, que se lee entero arriba.
function extractCommands(answer: string): string[] {
    const out: string[] = []
    let inFence = false
    for (const line of answer.split('\n')) {
        if (line.trimStart().startsWith('```')) {
            inFence = !inFence
            continue
        }
        if (!inFence) continue
        const t = line.trim()
        if (!t || t.startsWith('#')) continue
        // Un prompt copiado (`$ comando`) se limpia: insertarlo con el `$`
        // adelante haría que el shell lo rechace.
        out.push(t.replace(/^\$\s+/, ''))
        if (out.length >= 6) break
    }
    return out
}
