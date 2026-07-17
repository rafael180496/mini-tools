import {sftpx} from '../../../wailsjs/go/models'

// LocalSession must match backend/sftpx.LocalSession — the reserved pane id
// that routes browse operations to the user's own machine (os.*).
export const LOCAL_SESSION = 'local'

// PaneHost is what a single explorer pane is currently pointed at: either the
// local machine or a saved SSH connection (reusing the exact same connId the
// terminal uses). sessionId is the browse-session key passed to every binding
// — LOCAL_SESSION for local, or a per-pane id for a remote host.
export interface PaneHost {
    kind: 'none' | 'local' | 'remote'
    connId: string | null
    connName: string
    sessionId: string
}

// TransferItem mirrors sftpx.Item — one file or directory to transfer.
export type TransferItem = sftpx.Item

// ProgressEvent mirrors sftpx.ProgressEvent (backend/sftpx/transfer.go). It is
// event-only (never a binding return/param), so Wails does not generate a
// class for it — declared here by hand, same as SshEvent in SshTerminalTab.
export interface ProgressEvent {
    type: 'start' | 'progress' | 'file-done' | 'done' | 'error' | 'cancelled'
    fileName?: string
    filesDone: number
    totalFiles: number
    bytesDone: number
    bytesTotal: number
    percent: number
    error?: string
}

// sepOf infers the path separator from an absolute path so the frontend can
// join/split without knowing whether the pane is a POSIX remote or a Windows
// local machine. Backend paths are always absolute and correctly separated.
export function sepOf(p: string): string {
    return p.includes('\\') && !p.includes('/') ? '\\' : '/'
}

// dirname returns p's parent directory, handling both '/' and '\' so it works
// for local (any OS) and remote (POSIX) panes alike.
export function dirname(p: string): string {
    const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
    if (idx < 0) return p
    if (idx === 0) return p.slice(0, 1) // keep root "/"
    return p.slice(0, idx)
}

// joinPath appends name to dir using dir's own separator.
export function joinPath(dir: string, name: string): string {
    const sep = sepOf(dir)
    if (dir.endsWith(sep)) return dir + name
    return dir + sep + name
}
