import {useEffect, useState} from 'react'
import {AnalyzeSSHError} from '../../../wailsjs/go/main/App'
import {main} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import MarkdownPreview from '../MarkdownPreview'
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

interface Props {
    connId: string
    connName: string
    // Texto seleccionado en xterm.js, si el usuario marcó algo. Vacío = las
    // últimas líneas del buffer, que es el caso de "acaba de fallar algo".
    selection: string
    onClose: () => void
    // Inserta un comando en la terminal SIN ejecutarlo: queda escrito y el
    // Enter lo pone el usuario.
    onInsertCommand: (command: string) => void
}

export default function SshErrorAnalysis({connId, connName, selection, onClose, onInsertCommand}: Props) {
    const [result, setResult] = useState<main.SSHErrorAnalysis | null>(null)
    const [busy, setBusy] = useState(true)
    const [error, setError] = useState('')
    const [showSent, setShowSent] = useState(false)
    const chat = useAgentChat()

    useEffect(() => {
        let cancelled = false
        AnalyzeSSHError(connId, selection, 60)
            .then((r) => !cancelled && setResult(r))
            .catch((e) => !cancelled && setError(String(e)))
            .finally(() => !cancelled && setBusy(false))
        return () => {
            cancelled = true
        }
    }, [connId, selection])

    // Los comandos que propuso el agente, sacados de los bloques de código.
    const commands = extractCommands(result?.answer ?? '')

    return (
        <div className="flex max-h-[60%] shrink-0 flex-col border-t border-outline-variant bg-surface-container-low">
            <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-2 py-1 text-[11px]">
                <Icon name="troubleshoot" size={13} className="shrink-0 text-primary" />
                <span className="font-medium text-on-surface">Análisis del error</span>
                <span className="truncate text-on-surface-variant">· {connName}</span>

                {!!result?.redacted && (
                    <span
                        className="flex shrink-0 items-center gap-1 rounded bg-tertiary/15 px-1.5 py-0.5 text-tertiary"
                        title="Se encontraron valores que parecen secretos en la salida de la terminal (una contraseña en la línea de comandos, un token en una cabecera, una clave privada pegada) y NO se le mandaron al agente. Si la respuesta parece incompleta, puede ser por esto."
                    >
                        <Icon name="shield" size={11} filled />
                        {result.redacted} {result.redacted === 1 ? 'valor oculto' : 'valores ocultos'}
                    </span>
                )}

                {result && (
                    <button
                        onClick={() => setShowSent((v) => !v)}
                        title="Muestra exactamente qué líneas de la terminal se le mandaron al agente. Lo que sale de tu máquina tiene que poder verse."
                        className={`shrink-0 rounded px-1.5 py-0.5 ${
                            showSent ? 'bg-surface-variant text-on-surface' : 'text-on-surface-variant hover:bg-surface-variant'
                        }`}
                    >
                        {result.lines.length} líneas enviadas
                    </button>
                )}

                {result && (
                    <button
                        onClick={() =>
                            chat.open({
                                context: {kind: 'ssh', id: connId, label: connName},
                                prompt: `@ssh:${connName}/last_error `,
                            })
                        }
                        title="Abre el chat con las últimas líneas de esta terminal ya referenciadas, para repreguntar"
                        className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="forum" size={12} />
                        Seguir en el chat
                    </button>
                )}

                <button
                    onClick={onClose}
                    title="Cierra el análisis. La terminal no se toca."
                    className="ml-auto shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="close" size={14} />
                </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5 text-xs">
                {busy && (
                    <p className="flex items-center gap-2 text-[11px] text-on-surface-variant">
                        <span aria-hidden className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-t-transparent border-primary" />
                        Leyendo la salida y el sistema del servidor…
                    </p>
                )}

                {error && <p className="rounded bg-error-container/40 px-2 py-1 text-[11px] text-error">{error}</p>}

                {result && !result.osInfo && !busy && (
                    <p
                        className="mb-1.5 rounded border border-outline-variant bg-surface-container px-2 py-1 text-[10px] text-on-surface-variant"
                        title="El sistema se deduce de lo que la terminal ya imprimió (el banner de login, un uname que hayas corrido). No se ejecuta nada por tu cuenta: escribir en tu sesión interactiva aparecería en tu pantalla y podría caer dentro de un editor abierto."
                    >
                        No se pudo determinar el sistema operativo del servidor, así que la respuesta puede no ser
                        específica. Corré <span className="font-mono text-on-surface">uname -a</span> y volvé a pedir el
                        análisis para una respuesta ajustada.
                    </p>
                )}

                {showSent && result && (
                    <pre className="mb-1.5 max-h-40 overflow-auto rounded border border-outline-variant bg-surface-container px-2 py-1 font-mono text-[10px] text-on-surface-variant">
                        {result.osInfo && `# sistema detectado\n${result.osInfo}\n\n# salida\n`}
                        {result.lines.join('\n')}
                    </pre>
                )}

                {result?.answer && <MarkdownPreview source={result.answer} />}

                {commands.length > 0 && (
                    <div className="mt-2 flex flex-col gap-1 border-t border-outline-variant pt-1.5">
                        <p className="text-[10px] text-on-surface-variant">
                            Comandos propuestos — <strong>ninguno se ejecuta solo</strong>: insertarlo lo deja escrito en
                            la terminal y el Enter lo ponés vos.
                        </p>
                        {commands.map((c, i) => (
                            <div key={i} className="flex items-center gap-1.5">
                                <code className="min-w-0 flex-1 truncate rounded bg-surface-container-highest px-1.5 py-0.5 font-mono text-[11px] text-on-surface">
                                    {c}
                                </code>
                                <button
                                    onClick={() => void navigator.clipboard.writeText(c)}
                                    title="Copia el comando al portapapeles"
                                    className="shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                                >
                                    <Icon name="content_copy" size={13} />
                                </button>
                                <button
                                    onClick={() => onInsertCommand(c)}
                                    title="Escribe el comando en la terminal SIN ejecutarlo — podés leerlo y editarlo antes de apretar Enter"
                                    className="shrink-0 rounded bg-primary px-2 py-0.5 text-[11px] text-on-primary"
                                >
                                    Insertar
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </div>
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
