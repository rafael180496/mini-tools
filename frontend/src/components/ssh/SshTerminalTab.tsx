import {useEffect, useRef, useState} from 'react'
import {Terminal} from '@xterm/xterm'
import {FitAddon} from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {CloseSSHTerminal, OpenSSHTerminal, ResizeSSHTerminal, WriteSSHTerminal} from '../../../wailsjs/go/main/App'
import {EventsOn} from '../../../wailsjs/runtime'
import type {Theme} from '../../hooks/useTheme'
import {resolveTerminalTheme, type TerminalThemeId} from '../../xterm/terminalThemes'
import SshSnippetsPanel from './SshSnippetsPanel'
import SshTerminalThemePicker from './SshTerminalThemePicker'
import Icon from '../Icon'
import {SshLineModel} from '../../lib/sshLineModel'

interface SshTerminalTabProps {
    connId: string
    theme: Theme
    // xterm.js color theme id (frontend/src/xterm/terminalThemes.ts's
    // registry) — one global setting shared by every open terminal tab,
    // same "auto follows the app theme" convention as the SQL editor's
    // editorThemeId. Changing it from this tab's own theme picker updates
    // every other open terminal too, since they all read the same prop
    // from Workspace.tsx.
    terminalThemeId: string
    onChangeTerminalTheme: (id: TerminalThemeId) => void
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
export default function SshTerminalTab({connId, theme, terminalThemeId, onChangeTerminalTheme, onConnectedChange}: SshTerminalTabProps) {
    const containerRef = useRef<HTMLDivElement>(null)
    const wrapperRef = useRef<HTMLDivElement>(null)
    const termRef = useRef<Terminal | null>(null)
    // Reconstructs the current input line from raw keystrokes to drive the
    // ghost autocomplete suggestion (see lib/sshLineModel.ts). One per session.
    const modelRef = useRef(new SshLineModel())
    const [ghostText, setGhostText] = useState('')
    const [ghostPos, setGhostPos] = useState<{left: number; top: number; cellH: number} | null>(null)
    const [showSnippets, setShowSnippets] = useState(false)
    const [showThemePicker, setShowThemePicker] = useState(false)

    useEffect(() => {
        const container = containerRef.current
        if (!container) return

        const term = new Terminal({
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 13,
            cursorBlink: true,
            theme: resolveTerminalTheme(terminalThemeId, theme),
        })
        const fitAddon = new FitAddon()
        term.loadAddon(fitAddon)
        term.open(container)
        fitAddon.fit()
        termRef.current = term

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
                term.write(base64ToBytes(event.data), () => positionGhost())
            } else if (event.type === 'closed') {
                term.write('\r\n\x1b[90m[sesión cerrada]\x1b[0m\r\n')
                setGhostText('')
                setGhostPos(null)
                onConnectedChange(false)
            } else if (event.type === 'error') {
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
            model.process(data)
            setGhostText(model.suggestion())
            void WriteSSHTerminal(connId, data)
        })

        OpenSSHTerminal(connId, term.cols, term.rows)
            .then(() => onConnectedChange(true))
            .catch((err) => {
                term.write(`\r\n\x1b[31m[error] ${String(err)}\x1b[0m\r\n`)
                onConnectedChange(false)
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
            onConnectedChange(false)
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

    return (
        <div className="flex h-full min-h-0 w-full">
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="flex items-center gap-1 border-b border-outline-variant bg-surface-container px-2 py-1">
                    <div className="flex-1" />
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
            {showSnippets && <SshSnippetsPanel connId={connId} onClose={() => setShowSnippets(false)} />}
            {showThemePicker && (
                <SshTerminalThemePicker
                    value={terminalThemeId}
                    appTheme={theme}
                    onChange={(id) => onChangeTerminalTheme(id)}
                    onClose={() => setShowThemePicker(false)}
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
