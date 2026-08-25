import {useEffect, useState} from 'react'
import {vault} from '../../../wailsjs/go/models'
import type {Theme} from '../../hooks/useTheme'
import Icon from '../Icon'
import SftpTab from '../sftp/SftpTab'
import type {PaneHost} from '../sftp/types'
import SshTerminalTab from './SshTerminalTab'
import {WriteSSHTerminal} from '../../../wailsjs/go/main/App'
import type {TerminalThemeId} from '../../xterm/terminalThemes'

interface SshHybridTabProps {
    connId: string
    connName: string
    connections: vault.ConnectionSummary[]
    theme: Theme
    terminalThemeId: string
    // Se pasa tal cual a la terminal de esta sesión — ver
    // SshTerminalTabProps.terminalFontSize.
    terminalFontSize: number
    onChangeTerminalTheme: (id: TerminalThemeId) => void
    onConnectedChange: (connected: boolean) => void
    onOpenRemoteFile: (host: PaneHost, path: string) => void
}

// Terminal and file explorer for one server, in the same tab.
//
// Additive by construction: the standalone "Abrir terminal" and "Abrir
// SFTP" tabs are untouched and keep working exactly as before. This is a
// third way to open the same two components, sharing one SSH connection
// (which they already do since the pool landed) and one screen.
//
// The file half is a DRAWER rather than a permanent split: a terminal is
// what people look at most of the time, and permanently giving half the
// window to a file list is the layout nobody keeps. It opens with
// Ctrl+Shift+F, and the height is dragged and remembered for the session.
export default function SshHybridTab({
    connId,
    connName,
    connections,
    theme,
    terminalThemeId,
    terminalFontSize,
    onChangeTerminalTheme,
    onConnectedChange,
    onOpenRemoteFile,
}: SshHybridTabProps) {
    const [drawerOpen, setDrawerOpen] = useState(false)
    // Proportional to the window rather than a fixed number of pixels: a file
    // browser given 320px on a 1400px-tall screen shows two rows and its own
    // column headers, which reads as broken rather than as compact. Clamped so
    // it still leaves the terminal usable on a small window.
    const [drawerHeight, setDrawerHeight] = useState(() => Math.max(240, Math.min(520, Math.round(window.innerHeight * 0.42))))

    // Ctrl+Shift+F toggles the files drawer. Registered on the window
    // because the terminal swallows most keys — xterm sends them to the
    // remote shell, so a handler on the container would never see them.
    // Shift is what keeps it off Ctrl+F, which a remote editor (vi, less)
    // legitimately uses.
    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
                e.preventDefault()
                setDrawerOpen((v) => !v)
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [])

    function startResize(e: React.MouseEvent) {
        e.preventDefault()
        const startY = e.clientY
        const startHeight = drawerHeight

        function onMove(ev: MouseEvent) {
            // Dragging UP grows the drawer, so the delta is inverted. Clamped
            // so it can never be dragged to zero (which would look like the
            // drawer vanished) or over the whole tab.
            const next = startHeight + (startY - ev.clientY)
            setDrawerHeight(Math.max(140, Math.min(window.innerHeight - 200, next)))
        }
        function onUp() {
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
    }

    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant bg-surface-container-lowest px-2 py-1 text-ui-11">
                <Icon name="dns" size={13} className="shrink-0 text-primary" />
                <span className="font-mono text-on-surface">{connName}</span>
                <span
                    className="text-on-surface-variant/70"
                    title="La consola y los archivos comparten una única conexión SSH: no se autentica dos veces ni se abre un segundo socket contra el servidor."
                >
                    consola y archivos sobre una sola conexión
                </span>

                <button
                    onClick={() => setDrawerOpen((v) => !v)}
                    title="Muestra u oculta el explorador de archivos de este servidor (Ctrl+Shift+F). La consola sigue viva detrás mientras esté abierto."
                    className={`ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 ${
                        drawerOpen ? 'bg-primary/15 text-primary' : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
                    }`}
                >
                    <Icon name="folder_open" size={13} />
                    Archivos
                    <span className="font-mono opacity-60">Ctrl+Shift+F</span>
                </button>
            </div>

            {/* The terminal is never unmounted when the drawer opens — doing
                so would kill the interactive shell and its scrollback. It
                only gets shorter. */}
            <div className="min-h-0 flex-1 overflow-hidden">
                <SshTerminalTab
                    connId={connId}
                    connName={connName}
                    theme={theme}
                    terminalThemeId={terminalThemeId}
                    terminalFontSize={terminalFontSize}
                    onChangeTerminalTheme={onChangeTerminalTheme}
                    onConnectedChange={onConnectedChange}
                />
            </div>

            {drawerOpen && (
                <>
                    <div
                        onMouseDown={startResize}
                        title="Arrastrar para cambiar el alto del explorador"
                        className="group flex h-1.5 shrink-0 cursor-row-resize items-center justify-center bg-surface-container-low hover:bg-primary/30"
                    >
                        <div className="h-0.5 w-8 rounded-full bg-outline-variant group-hover:bg-primary" />
                    </div>
                    <div style={{height: drawerHeight}} className="flex min-h-0 shrink-0 flex-col overflow-hidden border-t border-outline-variant">
                        {/* La sincronización solo se ofrece acá: es la pestaña
                            donde hay una terminal viva al lado. En una pestaña
                            SFTP suelta no hay ninguna terminal que seguir, así
                            que el control no aparece en vez de aparecer
                            deshabilitado sin explicación. */}
                        <SftpTab
                            tabId={`hybrid-${connId}`}
                            initialConnId={connId}
                            connections={connections}
                            onOpenRemoteFile={onOpenRemoteFile}
                            followTerminalConnId={connId}
                            // Sin el retorno de carro: el `cd` queda escrito y
                            // el Enter lo pone el usuario. Misma decisión que
                            // el historial y que los comandos que propone el
                            // agente — nada se ejecuta solo en una terminal.
                            onOpenTerminalAt={(path) => void WriteSSHTerminal(connId, `cd ${shellQuote(path)}`)}
                        />
                    </div>
                </>
            )}
        </div>
    )
}

// shellQuote entrecomilla una ruta para que un espacio o un paréntesis no la
// partan en dos argumentos. Comillas simples y escape de la comilla simple:
// es la forma que funciona igual en sh, bash, ksh y zsh — que son las cuatro
// que uno se encuentra en los servidores donde esto se usa.
function shellQuote(path: string): string {
    return "'" + path.split("'").join(`'\\''`) + "'"
}
