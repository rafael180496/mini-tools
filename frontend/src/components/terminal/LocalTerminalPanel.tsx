import {useCallback, useEffect, useRef, useState} from 'react'
import {Terminal} from '@xterm/xterm'
import {FitAddon} from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {
    CloseLocalTerminal,
    LocalShellLabel,
    OpenAgentSession,
    OpenLocalTerminal,
    OpenLocalTerminalWith,
    ResizeLocalTerminal,
    WriteLocalTerminal,
} from '../../../wailsjs/go/main/App'
import {EventsOn} from '../../../wailsjs/runtime'
import type {Theme} from '../../hooks/useTheme'
import {resolveTerminalTheme} from '../../xterm/terminalThemes'
import Icon from '../Icon'
import {SshLineModel} from '../../lib/sshLineModel'

interface LocalTerminalPanelProps {
    // Identifica la sesión en el backend Y es el nombre del evento de Wails
    // por el que llegan los bytes — mismo doble uso que connId en
    // SshTerminalTab.tsx (ver localterm.Event). Lo genera quien monta este
    // panel y tiene que ser estable mientras la sesión siga abierta: si
    // cambia, se abre una shell nueva y se pierde el directorio en el que
    // estabas.
    sessionId: string
    // Repositorio en cuyo directorio arranca la shell. "" = el home del
    // usuario. Se manda el ID opaco, nunca la ruta: es la misma indirección
    // que usa todo el módulo Git.
    repoId: string
    // "shell" es una terminal común; "agent" arranca además el CLI de un
    // asistente de código (Claude Code, Codex, Gemini) DENTRO de esa misma
    // shell — ver el doc de backend/agents para por qué se ejecutan como
    // programas de terminal y no por su API.
    kind: 'shell' | 'agent'
    agentId?: string
    agentLabel?: string
    // Si el agente arranca solo al abrir la sesión. Es false cuando la sesión
    // viene restaurada del layout guardado: relanzar un asistente que consume
    // cuota porque la app se reinició no es algo que nadie haya pedido.
    autoStart?: boolean
    // Intérprete que abre ESTA sesión, elegido a mano. Vacío = el configurado
    // en Configuración → Terminal.
    //
    // Existe para el módulo SSH, donde una terminal local es una más entre
    // varias: en Windows conviven PowerShell, pwsh y cmd, y abrir siempre el
    // mismo obligaría a cambiar la preferencia global de la app para probar
    // algo en otro.
    shellOverride?: string
    // Se avisa cuando se ejecutó una línea (Enter). Es lo que alimenta el
    // historial persistido de las terminales locales; sin manejador, no se
    // registra nada.
    //
    // La línea se reconstruye del lado del cliente observando las teclas (ver
    // lib/sshLineModel): la shell hace el eco, así que no hay un buffer de
    // línea que leer. Es deliberadamente conservador — lo que no puede seguir
    // con confianza no lo reporta.
    onCommand?: (command: string) => void
    // Shell configurado en Configuración → Terminal (settings.localShell).
    // Solo se usa para ETIQUETAR la barra y para reabrir la sesión cuando
    // cambia — el backend lo relee del vault en cada apertura, este prop no
    // es la fuente de verdad.
    shellId: string
    theme: Theme
    // Tema y cuerpo de fuente son globales de la app y se ajustan desde la
    // barra del PANEL, no desde cada sesión: son una preferencia de "las
    // terminales", no de esta pestaña en particular.
    terminalThemeId: string
    fontSize: number
    // Si esta sesión está realmente a la vista. Cuando está oculta (el panel
    // cerrado, u otra sesión activa) el componente NO se desmonta —la shell y
    // su directorio sobreviven— pero tampoco se puede medir: un fit() sobre un
    // elemento con display:none calcula 0 columnas y deja el PTY en un tamaño
    // absurdo al que después el prompt se dibuja mal.
    visible: boolean
}

// Espeja localterm.Event (backend/localterm/sessions.go) — idéntico a
// SshEvent a propósito: el stream de una shell local y el de una remota
// tienen exactamente la misma forma.
interface LocalTermEvent {
    type: 'data' | 'closed' | 'error'
    data?: string
    error?: string
}

// event.data viene en base64 — una shell local puede emitir bytes no-UTF8
// igual que una remota (un `cat` de un binario, otra página de códigos en
// Windows), y eso rompería el encoding JSON si viajara como string.
function base64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
}

// Una sesión del panel: una shell de verdad con PTY contra esta máquina, o
// esa misma shell con un asistente de código corriendo adentro.
//
// Existe para cerrar el hueco que dejaba el panel "Comandos ejecutados" del
// módulo Git: ese panel es una auditoría —muestra qué corrió la app por
// debajo y su salida— pero no deja hacer nada. En cuanto hace falta un
// `git rebase -i`, entrar a una subcarpeta, correr los tests o pedirle algo a
// un agente, había que salir a otra ventana y volver.
//
// Reusa la misma mecánica que SshTerminalTab.tsx (xterm.js + FitAddon +
// eventos base64 + resize del PTY); lo que cambia es de dónde sale el
// proceso: un shell del sistema en vez de un canal SSH.
export default function LocalTerminalPanel({
    sessionId,
    repoId,
    kind,
    shellOverride,
    onCommand,
    agentId,
    agentLabel,
    autoStart,
    shellId,
    theme,
    terminalThemeId,
    fontSize,
    visible,
}: LocalTerminalPanelProps) {
    const containerRef = useRef<HTMLDivElement>(null)
    const termRef = useRef<Terminal | null>(null)
    const fitRef = useRef<FitAddon | null>(null)
    const [alive, setAlive] = useState(false)
    const [error, setError] = useState('')
    const [shellLabel, setShellLabel] = useState('')
    // Token que fuerza reabrir la sesión sin remontar el componente: lo suben
    // "Reiniciar", "Iniciar <agente>" y el cambio de shell en Configuración.
    const [openToken, setOpenToken] = useState(0)
    // Si el agente se arrancó en esta sesión. Un ref además de estado porque
    // lo lee el efecto de apertura, donde un valor capturado del render
    // anterior sería el viejo.
    const startAgentRef = useRef(!!autoStart)
    // Reconstrucción de la línea que se está escribiendo, para saber qué
    // comando se ejecutó. Vive en un ref porque lo lee el manejador de teclas,
    // que se registra UNA vez: una copia capturada ahí se quedaría con el
    // estado del montaje para siempre.
    const lineModelRef = useRef(new SshLineModel())
    const onCommandRef = useRef(onCommand)
    onCommandRef.current = onCommand
    const [agentStarted, setAgentStarted] = useState(!!autoStart)

    // El widget se crea UNA vez por sesión y se mantiene vivo mientras el
    // componente siga montado, aunque esté oculto — es lo que hace que cambiar
    // de sesión o cerrar el panel no pierda ni el scrollback ni el directorio.
    useEffect(() => {
        const container = containerRef.current
        if (!container) return

        const term = new Terminal({
            fontFamily: '"JetBrains Mono", monospace',
            fontSize,
            cursorBlink: true,
            // Suficiente para que un `git log` largo, la salida de unos tests
            // o una conversación entera con un agente sigan estando ahí
            // después de seguir trabajando.
            scrollback: 10000,
            theme: resolveTerminalTheme(terminalThemeId, theme),
        })
        const fitAddon = new FitAddon()
        term.loadAddon(fitAddon)
        term.open(container)
        termRef.current = term
        fitRef.current = fitAddon

        // Copiar/pegar con el atajo del sistema. Sin esto, Cmd/Ctrl+C va al
        // proceso como un ^C y MATA lo que esté corriendo en vez de copiar —
        // el error más frustrante posible cuando lo que querías era copiar la
        // salida de algo que tardó dos minutos, o la respuesta de un agente.
        // La regla es la misma que usan las terminales reales: si hay
        // selección, el atajo copia; si no, pasa de largo y el ^C sigue
        // interrumpiendo.
        term.attachCustomKeyEventHandler((e) => {
            if (e.type !== 'keydown') return true
            const mod = e.metaKey || e.ctrlKey
            if (!mod) return true
            if (e.key === 'c' && term.hasSelection()) {
                void navigator.clipboard.writeText(term.getSelection())
                return false
            }
            if (e.key === 'v') {
                void navigator.clipboard.readText().then((text) => {
                    if (text) void WriteLocalTerminal(sessionId, text)
                })
                return false
            }
            return true
        })

        const dataDisposable = term.onData((data) => {
            // El modelo mira las mismas teclas que van al PTY y avisa cuando
            // una línea se ejecutó. No intercepta nada: los bytes salen igual.
            lineModelRef.current.process(data)
            void WriteLocalTerminal(sessionId, data)
        })

        return () => {
            dataDisposable.dispose()
            term.dispose()
            termRef.current = null
            fitRef.current = null
        }
        // Solo sessionId: el tema y el tamaño de fuente se sincronizan en su
        // propio efecto más abajo, y re-crear el widget por un cambio de color
        // borraría todo lo que hay en pantalla.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId])

    // El aviso de "se ejecutó esto" se engancha una sola vez y llama SIEMPRE al
    // manejador vigente a través del ref: si se enganchara el prop directo, un
    // cambio de manejador dejaría de registrar comandos sin que se note.
    useEffect(() => {
        lineModelRef.current.onCommit = (command) => onCommandRef.current?.(command)
    }, [])

    // Suscripción + apertura del proceso. Separado del efecto de arriba
    // porque se repite en cada "Reiniciar"/"Iniciar" (openToken), mientras que
    // el widget se crea una sola vez.
    useEffect(() => {
        const term = termRef.current
        if (!term) return

        let closed = false

        // EventsOn ANTES de abrir: el primer chunk puede llegar antes de que
        // resuelva la promesa (el prompt del shell sale inmediatamente), y
        // suscribirse después lo perdería. Mismo contrato que
        // OpenSSHTerminal/ExecuteQuery.
        const unsubscribe = EventsOn(sessionId, (event: LocalTermEvent) => {
            if (closed) return
            if (event.type === 'data' && event.data) {
                term.write(base64ToBytes(event.data))
            } else if (event.type === 'closed') {
                setAlive(false)
                term.write('\r\n\x1b[90m[la shell terminó — usá Reiniciar para abrir otra]\x1b[0m\r\n')
            } else if (event.type === 'error') {
                setAlive(false)
                setError(event.error ?? 'desconocido')
                term.write(`\r\n\x1b[31m[error] ${event.error ?? 'desconocido'}\x1b[0m\r\n`)
            }
        })

        setError('')
        // Si la sesión arranca oculta todavía no hay medidas reales; 80x24 es
        // el tamaño estándar de un PTY y el primer fit visible lo corrige.
        const cols = term.cols || 80
        const rows = term.rows || 24
        const runAgent = startAgentRef.current
        const opening =
            kind === 'agent' && agentId
                ? OpenAgentSession(sessionId, repoId, agentId, cols, rows, runAgent)
                : shellOverride
                  ? OpenLocalTerminalWith(sessionId, shellOverride, cols, rows)
                  : OpenLocalTerminal(sessionId, repoId, cols, rows)

        opening
            .then(() => {
                if (closed) return
                setAlive(true)
                if (runAgent) setAgentStarted(true)
            })
            .catch((err) => {
                if (closed) return
                setAlive(false)
                setError(String(err))
                term.write(`\r\n\x1b[31m[error] ${String(err)}\x1b[0m\r\n`)
            })

        return () => {
            closed = true
            unsubscribe()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId, repoId, kind, agentId, shellOverride, openToken])

    // Cerrar la shell al desmontar (se cerró la sesión o la pestaña de Git).
    // Es un proceso del sistema operativo, no un objeto en memoria: dejarlo
    // vivo deja una shell —o un agente— huérfano corriendo.
    useEffect(() => {
        return () => {
            void CloseLocalTerminal(sessionId)
        }
    }, [sessionId])

    // Etiqueta del shell que el backend realmente va a abrir — se pregunta en
    // vez de derivarla del id porque el backend cae al default del sistema
    // cuando el guardado no está instalado en esta máquina, y la barra tiene
    // que decir la verdad sobre lo que está corriendo.
    useEffect(() => {
        LocalShellLabel(shellId)
            .then(setShellLabel)
            .catch(() => setShellLabel(''))
    }, [shellId])

    // Reabrir cuando cambia el shell configurado: cambiar el intérprete de un
    // proceso vivo no existe, así que la única forma de que la preferencia
    // nueva se note es levantar una shell nueva. Se salta el primer render
    // (la sesión ya se abre en el efecto de arriba) para no abrir dos.
    const firstShellRef = useRef(true)
    useEffect(() => {
        if (firstShellRef.current) {
            firstShellRef.current = false
            return
        }
        setOpenToken((t) => t + 1)
    }, [shellId])

    // Mantener los colores en sync si el usuario cambia el tema de la app o el
    // de la terminal con una sesión abierta.
    useEffect(() => {
        if (termRef.current) termRef.current.options.theme = resolveTerminalTheme(terminalThemeId, theme)
    }, [theme, terminalThemeId])

    // Medir y reflowar el PTY. Solo cuando la sesión está a la vista: oculta
    // mide 0 y dejaría el PTY en un tamaño imposible (ver el prop `visible`).
    const refit = useCallback(() => {
        if (!visible) return
        const fit = fitRef.current
        const term = termRef.current
        const el = containerRef.current
        if (!fit || !term || !el) return
        if (el.clientWidth === 0 || el.clientHeight === 0) return
        fit.fit()
        void ResizeLocalTerminal(sessionId, term.cols, term.rows)
    }, [sessionId, visible])

    useEffect(() => {
        const el = containerRef.current
        if (!el) return
        const observer = new ResizeObserver(() => refit())
        observer.observe(el)
        // Al pasar de oculta a visible el tamaño del elemento no cambia, así
        // que el observer no dispara — hay que medir a mano.
        refit()
        return () => observer.disconnect()
    }, [refit])

    // Cambiar el cuerpo de fuente cambia el tamaño de la celda, así que hay
    // que remedir: si no, el PTY sigue creyendo que entran las columnas de
    // antes y todo lo que se acomode al ancho (prompts, tablas, barras de
    // progreso) se dibuja cortado.
    useEffect(() => {
        const term = termRef.current
        if (!term) return
        term.options.fontSize = fontSize
        refit()
    }, [fontSize, refit])

    // Al volverse visible, además de medir conviene devolverle el foco: abrir
    // una sesión para escribir un comando y tener que hacer clic adentro
    // primero es fricción pura.
    useEffect(() => {
        if (visible) termRef.current?.focus()
    }, [visible])

    const isAgent = kind === 'agent'

    return (
        <div className="flex h-full min-h-0 flex-col bg-surface-container-lowest">
            <div className="flex shrink-0 items-center gap-1.5 border-b border-outline-variant px-2 py-1 text-ui-11">
                <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${alive ? 'bg-secondary' : 'bg-outline'}`}
                    title={alive ? 'La sesión está corriendo' : 'No hay ningún proceso corriendo en esta sesión'}
                />
                <span
                    className="min-w-0 shrink truncate font-mono text-on-surface-variant"
                    title={
                        isAgent
                            ? `Sesión de ${agentLabel ?? agentId} corriendo dentro de ${shellLabel || 'tu shell'}, en la raíz del repositorio. El agente corre DENTRO del shell: si lo cortás con Ctrl+C te queda la terminal viva en el mismo directorio.`
                            : `Intérprete en uso: ${shellLabel}. Se cambia en Configuración → Terminal; cambiarlo reinicia esta sesión, porque no se puede cambiar el intérprete de un proceso que ya está corriendo.`
                    }
                >
                    {isAgent ? (agentLabel ?? agentId) : shellLabel}
                </span>
                {error && (
                    <span className="min-w-0 truncate text-error" title={error}>
                        {error}
                    </span>
                )}

                <div className="ml-auto flex shrink-0 items-center gap-0.5">
                    {isAgent && !agentStarted && (
                        <button
                            onClick={() => {
                                startAgentRef.current = true
                                setOpenToken((t) => t + 1)
                            }}
                            title={`Arranca ${agentLabel ?? agentId} en esta sesión. No se lanzó solo porque la sesión viene restaurada del layout guardado, y un asistente consume cuota: arrancarlo es una decisión tuya, no un efecto de reabrir la app.`}
                            className="flex items-center gap-1 rounded bg-primary px-1.5 py-0.5 text-on-primary hover:opacity-90"
                        >
                            <Icon name="play_arrow" size={13} />
                            Iniciar
                        </button>
                    )}
                    <button
                        onClick={() => termRef.current?.clear()}
                        title="Borra lo que hay en pantalla y el historial de scroll. No cancela lo que esté corriendo ni cierra la sesión — para eso, Ctrl+C."
                        className="rounded px-1 py-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="ink_eraser" size={14} />
                    </button>
                    <button
                        onClick={() => {
                            startAgentRef.current = isAgent && agentStarted
                            setOpenToken((t) => t + 1)
                        }}
                        title={
                            alive
                                ? `Cierra esta sesión y abre una nueva en la raíz del repositorio${isAgent && agentStarted ? `, con ${agentLabel ?? agentId} de nuevo` : ''} — se pierde el directorio en el que estabas y todo lo que esté corriendo`
                                : 'Abre una sesión nueva: la anterior terminó (con exit, o porque el proceso murió)'
                        }
                        className="rounded px-1 py-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="restart_alt" size={14} />
                    </button>
                </div>
            </div>

            <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden p-1" />
        </div>
    )
}
