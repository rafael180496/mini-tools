import {useEffect, useRef} from 'react'
import {Terminal} from '@xterm/xterm'
import {FitAddon} from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {CloseSSHTerminal, OpenSSHTerminal, ResizeSSHTerminal, WriteSSHTerminal} from '../../../wailsjs/go/main/App'
import {EventsOn} from '../../../wailsjs/runtime'
import type {Theme} from '../../hooks/useTheme'

interface SshTerminalTabProps {
    connId: string
    theme: Theme
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

const XTERM_THEME: Record<Theme, {background: string; foreground: string; cursor: string}> = {
    dark: {background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5'},
    light: {background: '#ffffff', foreground: '#1a1b26', cursor: '#1a1b26'},
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
export default function SshTerminalTab({connId, theme, onConnectedChange}: SshTerminalTabProps) {
    const containerRef = useRef<HTMLDivElement>(null)
    const termRef = useRef<Terminal | null>(null)

    useEffect(() => {
        const container = containerRef.current
        if (!container) return

        const term = new Terminal({
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 13,
            cursorBlink: true,
            theme: XTERM_THEME[theme],
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
        const unsubscribe = EventsOn(connId, (event: SshEvent) => {
            if (event.type === 'data' && event.data) {
                term.write(base64ToBytes(event.data))
            } else if (event.type === 'closed') {
                term.write('\r\n\x1b[90m[sesión cerrada]\x1b[0m\r\n')
                onConnectedChange(false)
            } else if (event.type === 'error') {
                term.write(`\r\n\x1b[31m[error] ${event.error ?? 'desconocido'}\x1b[0m\r\n`)
                onConnectedChange(false)
            }
        })

        const dataDisposable = term.onData((data) => {
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
    // dark/light mode mid-session — cheap, and the app's dark-mode rule
    // ("toda clase de color tiene su par dark") is in the same spirit even
    // though xterm's theme isn't a Tailwind class.
    useEffect(() => {
        if (termRef.current) termRef.current.options.theme = XTERM_THEME[theme]
    }, [theme])

    return <div ref={containerRef} className="h-full w-full overflow-hidden bg-surface p-1" />
}

// Closes connId's live remote session — called from Workspace.tsx's
// closeTab when an 'ssh-terminal' tab is actually closed (unlike a Redis
// pool, a live shell is a real remote process, not cheap to leave running
// unattended — see CloseSSHTerminal's doc comment in app.go).
export function closeSshTerminalSession(connId: string) {
    void CloseSSHTerminal(connId)
}
