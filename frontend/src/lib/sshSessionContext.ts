// Shared session context: the thin bus the terminal and the file panes use
// to talk to each other about ONE server.
//
// It exists so neither side has to know the other is mounted. A terminal
// tab publishes where the shell moved; a file pane subscribes IF the user
// turned the link on. With nobody subscribed, publishing is a no-op — which
// is what keeps the standalone terminal and standalone SFTP tabs behaving
// exactly as they did before any of this existed.
//
// A module-level store rather than React context on purpose: the two halves
// can live in different tabs, mounted and unmounted independently, and a
// provider would have to wrap the whole workspace to span them. The Redis
// key store (codemirror/redisKeysStore.ts) already established this shape
// in the project.

export interface SessionContext {
    // cwd is the shell's current directory, as last reported.
    cwd: string
    // source says how it was learned, because that decides how much to
    // trust it. 'shell' comes from the shell itself announcing it (OSC 7)
    // and is authoritative; 'guess' was inferred from a typed `cd` and can
    // be wrong on aliases, symlinks or scripts that change directory;
    // 'manual' was set by the user pressing the sync button.
    source: 'shell' | 'guess' | 'manual'
    atMs: number
}

type Listener = (ctx: SessionContext) => void

const contexts = new Map<string, SessionContext>()
const listeners = new Map<string, Set<Listener>>()
// The remote account's home directory, per connection.
//
// It is what `cd`, `cd ~` and `cd ~/algo` resolve to — the most common cd
// commands there are. Without it the whole heuristic silently returns null and
// the pane looks broken rather than uncertain. It is a stable fact of the
// account, not a guess about where the shell currently is, which is why it is
// stored apart from the cwd and never expires with a session.
const homes = new Map<string, string>()

// setSessionHome records the remote home directory. Published by whoever
// learns it first — in practice the SFTP pane, which is told it when its
// browse session opens.
export function setSessionHome(connId: string, home: string): void {
    if (!home) return
    homes.set(connId, home)

    // Seed the cwd too, but only while nothing is known yet.
    //
    // A relative `cd` — `cd ..`, `cd fuentes` — needs a base to resolve
    // against, and with no base the parse returns null. That is what made the
    // very first cd of a session, which is usually a relative one, do nothing
    // at all. A shell starts in its own home, so home is the correct base at
    // exactly this moment, and it is published as a 'guess' so a real OSC 7
    // announcement from the shell still wins over it.
    //
    // The "only if nothing is known" guard is what keeps this from clobbering a
    // real position: if the file pane opens after the user has already been
    // moving around, the cwd already recorded stands.
    if (!contexts.has(connId) && !usedShells.has(connId)) publishCwd(connId, home, 'guess')
}

// Connections whose shell has already run at least one command.
//
// "The shell is in its home" is only true before anything has been typed. If
// the file pane opens after the user has been moving around — the drawer starts
// closed, so this is ordinary — seeding home would assert a position that is
// simply wrong. Recording that the shell has been used is what makes the
// difference between an assertion and a fabrication.
const usedShells = new Set<string>()

export function markShellUsed(connId: string): void {
    usedShells.add(connId)
}

export function sessionHome(connId: string): string {
    return homes.get(connId) ?? ''
}

// Whether a connection has an interactive shell running right now.
//
// The file pane's terminal-sync buttons only mean anything while there IS a
// shell: with none, "follow the terminal" waits forever and "send cd" writes
// into a session that does not exist. Published here rather than threaded down
// as a prop because the pane and the terminal are siblings in some layouts
// (the hybrid tab) and in entirely separate tabs in others.
const liveTerminals = new Set<string>()
const liveListeners = new Map<string, Set<(live: boolean) => void>>()

export function setTerminalLive(connId: string, live: boolean): void {
    const was = liveTerminals.has(connId)
    if (was === live) return
    if (live) liveTerminals.add(connId)
    else liveTerminals.delete(connId)
    liveListeners.get(connId)?.forEach((l) => l(live))
}

export function isTerminalLive(connId: string): boolean {
    return liveTerminals.has(connId)
}

export function subscribeTerminalLive(connId: string, listener: (live: boolean) => void): () => void {
    let set = liveListeners.get(connId)
    if (!set) {
        set = new Set()
        liveListeners.set(connId, set)
    }
    set.add(listener)
    return () => {
        set!.delete(listener)
        if (set!.size === 0) liveListeners.delete(connId)
    }
}

// publishCwd records where a connection's shell is and notifies subscribers.
//
// A 'guess' never overwrites a 'shell' reading from the same moment: if the
// shell is announcing its directory, a heuristic parse of what was typed
// has nothing to add and can only make it wrong.
export function publishCwd(connId: string, cwd: string, source: SessionContext['source']): void {
    if (!connId || !cwd) return

    const previous = contexts.get(connId)
    if (previous && previous.source === 'shell' && source === 'guess') return

    const ctx: SessionContext = {cwd, source, atMs: Date.now()}
    contexts.set(connId, ctx)

    for (const listener of listeners.get(connId) ?? []) {
        // One failing subscriber must not stop the others from being told.
        try {
            listener(ctx)
        } catch {
            // ignored
        }
    }
}

export function currentCwd(connId: string): SessionContext | null {
    return contexts.get(connId) ?? null
}

// subscribeCwd registers a listener and returns the unsubscribe. Callers
// wire it in an effect, so a pane that unmounts stops listening.
export function subscribeCwd(connId: string, listener: Listener): () => void {
    let set = listeners.get(connId)
    if (!set) {
        set = new Set()
        listeners.set(connId, set)
    }
    set.add(listener)

    return () => {
        set?.delete(listener)
        if (set && set.size === 0) listeners.delete(connId)
    }
}

// forgetSession drops a connection's context — called when its terminal
// closes, so a pane that reconnects later does not follow a stale path from
// a session that no longer exists.
export function forgetSession(connId: string): void {
    contexts.delete(connId)
    // A new session starts fresh in its home, so the used flag goes with the
    // old one. The home itself stays: it is a fact about the account.
    usedShells.delete(connId)
}

// --- terminal → context ----------------------------------------------------

// OSC 7 is how a properly-configured shell announces its directory:
//   ESC ] 7 ; file://host/path BEL   (or ST instead of BEL)
// It is authoritative — the shell is telling us, not us guessing — so it is
// tried first and, when present, makes the `cd` heuristic unnecessary.
// Plenty of shells never emit it (a stock Solaris ksh will not), which is
// exactly why the heuristic and the manual button still exist.
// Written with explicit \x escapes, never the literal control
// characters: a raw ESC/BEL byte in a source file makes it binary to
// ordinary text tooling (grep stops matching, diffs get noisy) — the
// same gotcha already documented in the project's SKILL.
const OSC7_RE = /\x1b\]7;file:\/\/[^/]*(\/[^\x07\x1b]*)(?:\x07|\x1b\\)/g

export function parseOsc7(chunk: string): string | null {
    let last: string | null = null
    let m: RegExpExecArray | null
    OSC7_RE.lastIndex = 0
    while ((m = OSC7_RE.exec(chunk))) {
        last = m[1]
    }
    return last ? decodeURIComponent(last) : null
}

// parseCdCommand reads a committed command line and reports the directory it
// would move to, given where the shell currently is.
//
// Best-effort by construction: it cannot know about aliases, functions,
// symlinked paths, or a script that cds on its own. That is why the result
// is published as a 'guess' and why the UI keeps a manual sync button —
// silently following a wrong path is worse than not following at all.
export function parseCdCommand(line: string, cwd: string, home: string, previous: string): string | null {
    const trimmed = line.trim()
    // Only a line that IS a cd. "ls && cd /x" or "sudo cd" are not handled:
    // guessing at compound commands is where a heuristic starts being wrong
    // more often than right.
    if (!/^cd(\s|$)/.test(trimmed)) return null

    const arg = trimmed.slice(2).trim()
    if (arg === '' || arg === '~') return home || null
    if (arg === '-') return previous || null

    // A variable or a glob is checked BEFORE the absolute/relative split —
    // putting it after let "cd /var/lo*" through the absolute branch and
    // publish a path that does not exist. Quoted paths ARE handled, since
    // a directory with a space is ordinary.
    const unquoted = arg.replace(/^["']|["']$/g, '')
    if (/[$*?]/.test(unquoted)) return null

    if (unquoted.startsWith('~/')) return home ? joinPath(home, unquoted.slice(2)) : null
    if (unquoted.startsWith('/')) return normalizePath(unquoted)
    return cwd ? joinPath(cwd, unquoted) : null
}

// joinPath resolves a relative path against a base, collapsing "." and "..".
export function joinPath(base: string, rel: string): string {
    return normalizePath(rel.startsWith('/') ? rel : `${base}/${rel}`)
}

// normalizePath collapses . and .. segments. POSIX only — these are remote
// paths on the server, never Windows ones.
export function normalizePath(path: string): string {
    const absolute = path.startsWith('/')
    const out: string[] = []

    for (const segment of path.split('/')) {
        if (segment === '' || segment === '.') continue
        if (segment === '..') {
            if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
            else if (!absolute) out.push('..')
            continue
        }
        out.push(segment)
    }

    const joined = out.join('/')
    return absolute ? '/' + joined : joined || '.'
}
