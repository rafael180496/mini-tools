import {useEffect, useRef, useState} from 'react'
import {Terminal} from '@xterm/xterm'
import {FitAddon} from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {AppendSshHistory, CloseSSHTerminal, ConnectionEnvironment, ListSshHistory, OpenSSHTerminal, ResizeSSHTerminal, WriteSSHTerminal} from '../../../wailsjs/go/main/App'
import {EventsOn} from '../../../wailsjs/runtime'
import type {Theme} from '../../hooks/useTheme'
import {resolveTerminalTheme, type TerminalThemeId} from '../../xterm/terminalThemes'
import ProductionGuardDialog from './ProductionGuardDialog'
import SshSnippetsPanel from './SshSnippetsPanel'
import SshErrorAnalysis from './SshErrorAnalysis'
import SshHistoryPanel from './SshHistoryPanel'
import SshTerminalThemePicker from './SshTerminalThemePicker'
import Icon from '../Icon'
import {SshLineModel} from '../../lib/sshLineModel'
import {
    forgetSession,
    parseCdCommand,
    parseOsc7,
    publishCwd,
    currentCwd,
    markShellUsed,
    sessionHome,
    setTerminalLive,
} from '../../lib/sshSessionContext'
import {inspect, splitCommandLines, type Risk} from '../../lib/productionGuard'
import {environmentStyle} from '../../lib/environments'

interface SshTerminalTabProps {
    connId: string
    // Nombre visible del servidor. Se usa solo para redactar los textos del
    // panel de historial: "limpiar el historial de PRODMAIN" dice qué se va a
    // borrar, y "limpiar el historial" obliga a acordarse de en qué pestaña
    // estabas parado.
    connName: string
    theme: Theme
    // xterm.js color theme id (frontend/src/xterm/terminalThemes.ts's
    // registry) — one global setting shared by every open terminal tab,
    // same "auto follows the app theme" convention as the SQL editor's
    // editorThemeId. Changing it from this tab's own theme picker updates
    // every other open terminal too, since they all read the same prop
    // from Workspace.tsx.
    terminalThemeId: string
    onChangeTerminalTheme: (id: TerminalThemeId) => void
    // Cuerpo de fuente, compartido con la terminal local del módulo Git
    // (settings.terminalFontSize) — es el mismo widget, tener dos tamaños
    // distintos para "la terminal" no significaría nada para quien la usa.
    terminalFontSize: number
    // Reports the session's real connected/disconnected state up to
    // Workspace.tsx — used for the "Pestaña vinculada a" status line, which
    // otherwise only knew whether a connection was BOUND to the tab, not
    // whether the remote shell was actually still alive (it could have
    // dropped server-side, or never connected in the first place).
    onConnectedChange: (connected: boolean) => void
}

// Mirrors sshconn.Event (backend/sshconn/sessions.go) — connId doubles as
// the Wails event name, same pattern as ExecuteQuery/ExecuteRedisCommand's
// queryID (see their EventsOn calls in Workspace.tsx).
interface SshEvent {
    type: 'data' | 'closed' | 'error'
    data?: string
    error?: string
}

// event.data is base64 — the remote shell can emit non-UTF8 bytes (e.g.
// catting a binary file), which is why the backend never sends it as a
// plain JSON string (see sshconn.Event's doc comment).
function base64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
}

// Mounted once per open SSH terminal tab and kept alive (hidden via CSS,
// never unmounted) for as long as the tab stays open — see Workspace.tsx's
// render block, the same "never unmount" treatment RedisBrowserTab.tsx gets
// so its state survives switching tabs. That means this component's mount
// effect below runs exactly once per session, not on every tab-focus.
export default function SshTerminalTab({connId, connName, theme, terminalThemeId, onChangeTerminalTheme, terminalFontSize, onConnectedChange}: SshTerminalTabProps) {
    const containerRef = useRef<HTMLDivElement>(null)
    const wrapperRef = useRef<HTMLDivElement>(null)
    const termRef = useRef<Terminal | null>(null)
    // Análisis del error abierto: `selection` es lo que estaba marcado al
    // pedirlo (vacío = las últimas líneas del buffer). Se congela al abrir para
    // que seguir usando la terminal no cambie lo que se está analizando.
    const [analysis, setAnalysis] = useState<{selection: string} | null>(null)
    // Si hay algo seleccionado ahora mismo, para ofrecer "analizar lo marcado"
    // en vez de las últimas líneas.
    const [hasSelection, setHasSelection] = useState(false)
    // El FitAddon se guarda en un ref además de usarse dentro del efecto de
    // montaje: cambiar el cuerpo de fuente obliga a remedir desde afuera de
    // ese efecto (ver más abajo).
    const fitRef = useRef<FitAddon | null>(null)
    // Reconstructs the current input line from raw keystrokes to drive the
    // ghost autocomplete suggestion (see lib/sshLineModel.ts). One per session.
    const modelRef = useRef(new SshLineModel())
    // The previous directory is what `cd -` resolves against. A ref, not
    // state: it is read inside the once-registered onData handler, where a
    // stale closure would resolve against an old value. (Home comes from
    // sessionHome() — it is shared with the file pane, which is what learns it
    // when its browse session opens.)
    const previousCwdRef = useRef('')
    const [ghostText, setGhostText] = useState('')
    const [ghostPos, setGhostPos] = useState<{left: number; top: number; cellH: number} | null>(null)
    const [showHistory, setShowHistory] = useState(false)
    const [showSnippets, setShowSnippets] = useState(false)
    const [showThemePicker, setShowThemePicker] = useState(false)
    // Environment marking of this connection. Kept in BOTH a ref and state:
    // the ref is what the once-registered onData handler reads (a state value
    // captured there would stay at its mount-time ''), the state is what
    // renders the banner.
    const [environment, setEnvironment] = useState('')
    const envRef = useRef('')
    // A command held back by the production guard, waiting for confirmation.
    const [held, setHeld] = useState<{data: string; commands: {command: string; risks: Risk[]}[]} | null>(null)
    // Sends the held input for real. Assigned inside the mount effect, where
    // the terminal and its line model live.
    const deliverRef = useRef<(data: string) => void>(() => {})

    // El historial persistido cumple dos funciones y por eso se engancha acá,
    // una sola vez por sesión:
    //
    //  - lo que se ejecuta se guarda (onCommit → AppendSshHistory). El backend
    //    decide si corresponde: descarta lo que parece traer un secreto y
    //    respeta el interruptor de registro, así que desde acá se manda todo y
    //    no hay dos lugares que puedan discrepar sobre qué se guarda.
    //  - lo ya guardado precarga las sugerencias (seedHistory), para que la
    //    terminal recién abierta ya sepa completar el comando largo de ayer en
    //    vez de tener que volver a aprenderlo desde cero.
    useEffect(() => {
        const model = modelRef.current
        model.onCommit = (command) => {
            // Fire and forget: guardar el historial nunca puede demorar ni
            // romper la ejecución del comando, que ya salió hacia el PTY.
            AppendSshHistory(connId, command).catch(() => {})
        }
        ListSshHistory(connId, 500)
            // El backend los devuelve del más reciente al más viejo y
            // seedHistory espera el orden inverso (la sugerencia recorre desde
            // el final, o sea desde lo más nuevo).
            .then((list) => model.seedHistory((list ?? []).map((e) => e.command).reverse()))
            .catch(() => {})
        return () => {
            model.onCommit = null
        }
    }, [connId])

    useEffect(() => {
        const container = containerRef.current
        if (!container) return

        const term = new Terminal({
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: terminalFontSize,
            cursorBlink: true,
            theme: resolveTerminalTheme(terminalThemeId, theme),
        })
        const fitAddon = new FitAddon()
        fitRef.current = fitAddon
        term.loadAddon(fitAddon)
        term.open(container)
        fitAddon.fit()
        termRef.current = term
        // El botón de analizar cambia de texto según haya o no una selección:
        // "analizar lo seleccionado" y "analizar el último error" son dos
        // acciones distintas y conviene que se note antes de apretarlo.
        term.onSelectionChange(() => setHasSelection(term.hasSelection()))

        // EventsOn BEFORE OpenSSHTerminal — avoids the race between the
        // first emitted chunk and the subscription, same contract as
        // ExecuteQuery/ExecuteRedisCommand's queryID (see their doc
        // comments in Workspace.tsx).
        // Reposition the ghost overlay at the terminal cursor. Called after
        // each server echo (the cursor only moves once the PTY echoes back).
        const positionGhost = () => {
            const wrap = wrapperRef.current
            if (!wrap) return
            const ghost = modelRef.current.suggestion()
            if (!ghost) {
                setGhostPos(null)
                return
            }
            const screen = wrap.querySelector('.xterm-screen') as HTMLElement | null
            if (!screen) {
                setGhostPos(null)
                return
            }
            const wrapRect = wrap.getBoundingClientRect()
            const screenRect = screen.getBoundingClientRect()
            const cellW = screenRect.width / term.cols
            const cellH = screenRect.height / term.rows
            const buf = term.buffer.active
            setGhostPos({
                left: screenRect.left - wrapRect.left + buf.cursorX * cellW,
                top: screenRect.top - wrapRect.top + buf.cursorY * cellH,
                cellH,
            })
        }

        const unsubscribe = EventsOn(connId, (event: SshEvent) => {
            if (event.type === 'data' && event.data) {
                const bytes = base64ToBytes(event.data)
                // OSC 7 is the shell ANNOUNCING its directory — authoritative,
                // unlike parsing what was typed. Shells that emit it (bash and
                // zsh with the usual prompt setup) make the cd heuristic below
                // unnecessary; plenty do not, which is why both exist.
                const announced = parseOsc7(new TextDecoder().decode(bytes))
                if (announced) publishCwd(connId, announced, 'shell')
                term.write(bytes, () => positionGhost())
            } else if (event.type === 'closed') {
                // Drop the shared context so a pane that reconnects later does
                // not follow a path from a session that no longer exists.
                forgetSession(connId)
                setTerminalLive(connId, false)
                term.write('\r\n\x1b[90m[sesión cerrada]\x1b[0m\r\n')
                setGhostText('')
                setGhostPos(null)
                onConnectedChange(false)
            } else if (event.type === 'error') {
                setTerminalLive(connId, false)
                term.write(`\r\n\x1b[31m[error] ${event.error ?? 'desconocido'}\x1b[0m\r\n`)
                setGhostText('')
                setGhostPos(null)
                onConnectedChange(false)
            }
        })

        const dataDisposable = term.onData((data) => {
            const model = modelRef.current
            // Accept the ghost suggestion on Tab or Right-arrow when one is
            // showing — send its bytes as if typed. When no ghost is showing,
            // Tab/→ fall through to the remote shell unchanged (Tab keeps doing
            // the remote's own completion).
            if (data === '\x1b[C' || data === '\t') {
                const ghost = model.suggestion()
                if (ghost) {
                    model.accept(ghost)
                    setGhostText('')
                    void WriteSSHTerminal(connId, ghost)
                    return
                }
            }
            // Enter commits the line; that is the moment a `cd` can be read
            // out of it. Published as a GUESS — it cannot know about aliases,
            // symlinks or scripts that move on their own, so the file pane
            // labels it as inferred and keeps a manual sync button.
            if (data === '\r' || data === '\n') {
                // From here on the shell may be anywhere, so "it is still in
                // its home" stops being assertable — see markShellUsed.
                markShellUsed(connId)
                const line = model.currentLine()
                const ctx = currentCwd(connId)
                const guessed = parseCdCommand(line, ctx?.cwd ?? '', sessionHome(connId), previousCwdRef.current)
                if (guessed) {
                    previousCwdRef.current = ctx?.cwd ?? ''
                    publishCwd(connId, guessed, 'guess')
                }
            }

            // Production guard. Only a chunk that would EXECUTE something is
            // inspected — a chunk with no newline is still being typed, and
            // warning about a half-written command would fire on every letter.
            if (envRef.current === 'prod' && /[\r\n]/.test(data)) {
                // The line model holds what was typed before this chunk, so a
                // guarded command is caught whether it was typed and entered
                // or pasted whole.
                const lines = splitCommandLines(model.currentLine() + data)
                // A trailing fragment with no newline after it is not run yet.
                const executed = /[\r\n]$/.test(data) ? lines : lines.slice(0, -1)
                const flagged = executed
                    .map((command) => ({command, risks: inspect(command)}))
                    .filter((c) => c.risks.length > 0)
                if (flagged.length > 0) {
                    // Nothing is sent and nothing enters the line model: a
                    // cancelled paste must not half-apply.
                    setHeld({data, commands: flagged})
                    return
                }
            }

            deliver(data)
        })

        // deliver applies input to the local line model and forwards it to the
        // remote shell. Split out from onData so the guard's "confirmar" can
        // replay exactly what was held back.
        function deliver(data: string) {
            const model = modelRef.current
            model.process(data)
            setGhostText(model.suggestion())
            void WriteSSHTerminal(connId, data)
        }
        deliverRef.current = deliver

        // Read once per session: the marking changes only when the user edits
        // the connection, and re-reading it per keystroke would put a binding
        // call in the terminal's input path.
        ConnectionEnvironment(connId)
            .then((env) => {
                envRef.current = env
                setEnvironment(env)
            })
            .catch(() => {
                // An unreadable marking is treated as unmarked rather than as
                // production: a guard that fires on a connection the user never
                // marked teaches them to dismiss it.
                envRef.current = ''
            })

        OpenSSHTerminal(connId, term.cols, term.rows)
            .then(() => {
                onConnectedChange(true)
                setTerminalLive(connId, true)
                // A shell starts in its own home, so this is the one moment
                // where that can be asserted rather than guessed. Without it a
                // relative first command (`cd ..`, `cd fuentes`) has no base to
                // resolve against and the file pane never moves — the case that
                // also reappears after a reconnect, since closing the session
                // clears the recorded position but not the home.
                const home = sessionHome(connId)
                if (home && !currentCwd(connId)) publishCwd(connId, home, 'guess')
            })
            .catch((err) => {
                term.write(`\r\n\x1b[31m[error] ${String(err)}\x1b[0m\r\n`)
                onConnectedChange(false)
                setTerminalLive(connId, false)
            })

        const resizeObserver = new ResizeObserver(() => {
            fitAddon.fit()
            void ResizeSSHTerminal(connId, term.cols, term.rows)
        })
        resizeObserver.observe(container)

        return () => {
            resizeObserver.disconnect()
            dataDisposable.dispose()
            unsubscribe()
            term.dispose()
            termRef.current = null
            fitRef.current = null
            onConnectedChange(false)
            setTerminalLive(connId, false)
        }
        // Deliberately connId-only — this effect must run exactly once per
        // mounted session (see the component doc comment above), not
        // re-run when the app-wide theme toggles or when onConnectedChange's
        // identity changes (it closes over a stable setState setter, so an
        // older render's closure still updates the right state).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connId])

    // Keep an already-open terminal's colors in sync if the user toggles
    // dark/light mode mid-session, or picks a different terminal theme from
    // this tab's own theme picker (which updates ALL open terminals, since
    // terminalThemeId is one global prop from Workspace.tsx) — cheap, and
    // the app's dark-mode rule ("toda clase de color tiene su par dark") is
    // in the same spirit even though xterm's theme isn't a Tailwind class.
    useEffect(() => {
        if (termRef.current) termRef.current.options.theme = resolveTerminalTheme(terminalThemeId, theme)
    }, [theme, terminalThemeId])

    // El cuerpo de fuente cambia el tamaño de la celda, así que además de
    // aplicarlo hay que remedir: el ResizeObserver de arriba no dispara
    // (el contenedor no cambió de tamaño) y el PTY se quedaría creyendo que
    // entran las columnas de antes.
    useEffect(() => {
        const term = termRef.current
        if (!term) return
        term.options.fontSize = terminalFontSize
        fitRef.current?.fit()
        void ResizeSSHTerminal(connId, term.cols, term.rows)
    }, [terminalFontSize, connId])

    const envStyle = environmentStyle(environment)

    return (
        <div className="flex h-full min-h-0 w-full">
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {envStyle && (
                    <div className={`flex shrink-0 items-center gap-2 border-b px-3 py-1 text-[11px] font-medium ${envStyle.banner}`}>
                        <span className={`h-2 w-2 shrink-0 rounded-full ${envStyle.dot}`} />
                        {envStyle.label}
                        {envStyle.id === 'prod' && (
                            <span className="font-normal opacity-80">
                                — los comandos destructivos piden confirmación antes de ejecutarse
                            </span>
                        )}
                    </div>
                )}
                <div className="flex items-center gap-1 border-b border-outline-variant bg-surface-container px-2 py-1">
                    <div className="flex-1" />
                    <button
                        onClick={() => {
                            setShowHistory((v) => !v)
                            if (!showHistory) {
                                setShowSnippets(false)
                                setShowThemePicker(false)
                            }
                        }}
                        title="Historial: los comandos que ejecutaste en este servidor, buscables y reutilizables. Se guarda cifrado y se puede limpiar o apagar desde el panel."
                        className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${
                            showHistory ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-variant'
                        }`}
                    >
                        <Icon name="history" size={14} />
                        Historial
                    </button>
                    {/* Analizar con el agente. El texto cambia según haya o no
                        una selección: analizar lo marcado y analizar el último
                        error son dos cosas distintas, y conviene que se note
                        antes de apretar. */}
                    <button
                        onClick={() =>
                            setAnalysis({selection: termRef.current?.getSelection() ?? ''})
                        }
                        title={
                            hasSelection
                                ? 'Le manda al agente exactamente lo que tenés seleccionado, junto con el sistema operativo del servidor, y explica qué falló. No ejecuta nada.'
                                : 'Le manda al agente las últimas líneas de esta terminal, junto con el sistema operativo del servidor, y explica qué falló. No ejecuta nada.'
                        }
                        className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${
                            analysis ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-variant'
                        }`}
                    >
                        <Icon name="troubleshoot" size={14} />
                        {hasSelection ? 'Analizar selección' : 'Analizar error'}
                    </button>
                    <button
                        onClick={() => {
                            setShowSnippets((v) => !v)
                            if (!showSnippets) setShowThemePicker(false)
                        }}
                        title="Snippets: comandos/scripts guardados que podés ejecutar o pegar en esta terminal"
                        className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${
                            showSnippets ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-variant'
                        }`}
                    >
                        <Icon name="data_object" size={14} />
                        Snippets
                    </button>
                    <button
                        onClick={() => {
                            setShowThemePicker((v) => !v)
                            if (!showThemePicker) setShowSnippets(false)
                        }}
                        title="Elegir el esquema de colores de esta terminal — aplica a todas las sesiones SSH abiertas"
                        className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${
                            showThemePicker ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-variant'
                        }`}
                    >
                        <Icon name="palette" size={14} />
                        Tema
                    </button>
                </div>
                <div ref={wrapperRef} className="relative min-h-0 flex-1 overflow-hidden bg-surface p-1">
                    <div ref={containerRef} className="h-full w-full" />
                    {ghostText && ghostPos && (
                        <span
                            aria-hidden
                            style={{
                                position: 'absolute',
                                left: ghostPos.left,
                                top: ghostPos.top,
                                height: ghostPos.cellH,
                                lineHeight: `${ghostPos.cellH}px`,
                                fontFamily: '"JetBrains Mono", monospace',
                                fontSize: 13,
                                color: 'rgba(130,130,130,0.85)',
                                whiteSpace: 'pre',
                                pointerEvents: 'none',
                                zIndex: 5,
                            }}
                        >
                            {ghostText}
                        </span>
                    )}
                </div>
            </div>
            {showHistory && (
                <SshHistoryPanel
                    connId={connId}
                    connName={connName}
                    onClose={() => setShowHistory(false)}
                    // Pegar deja la línea escrita pero sin ejecutar: reusar un
                    // comando del historial casi siempre es reusarlo con un
                    // argumento distinto, y ejecutar de un click lo que puede
                    // ser un `rm -rf` de la semana pasada no es un atajo, es
                    // una trampa. Ejecutar es un gesto aparte (doble click o
                    // el botón ▶).
                    onPaste={(cmd) => void WriteSSHTerminal(connId, cmd)}
                    onRun={(cmd) => void WriteSSHTerminal(connId, cmd + '\r')}
                />
            )}
            {showSnippets && <SshSnippetsPanel connId={connId} onClose={() => setShowSnippets(false)} />}
            {analysis && (
                <SshErrorAnalysis
                    connId={connId}
                    connName={connName}
                    selection={analysis.selection}
                    onClose={() => setAnalysis(null)}
                    // Se escribe SIN el retorno de carro: el comando queda en
                    // la línea, se puede leer y editar, y el Enter lo pone el
                    // usuario. Es la misma decisión que el panel de historial.
                    onInsertCommand={(cmd) => void WriteSSHTerminal(connId, cmd)}
                />
            )}
            {showThemePicker && (
                <SshTerminalThemePicker
                    value={terminalThemeId}
                    appTheme={theme}
                    onChange={(id) => onChangeTerminalTheme(id)}
                    onClose={() => setShowThemePicker(false)}
                />
            )}
            {held && (
                <ProductionGuardDialog
                    commands={held.commands}
                    onConfirm={() => {
                        const data = held.data
                        setHeld(null)
                        deliverRef.current(data)
                    }}
                    onCancel={() => setHeld(null)}
                />
            )}
        </div>
    )
}

// Closes connId's live remote session — called from Workspace.tsx's
// closeTab when an 'ssh-terminal' tab is actually closed (unlike a Redis
// pool, a live shell is a real remote process, not cheap to leave running
// unattended — see CloseSSHTerminal's doc comment in app.go).
export function closeSshTerminalSession(connId: string) {
    void CloseSSHTerminal(connId)
}
