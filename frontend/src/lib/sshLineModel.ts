// Client-side reconstruction of the current SSH input line, for the ghost
// autocomplete suggestion. The terminal sends every keystroke raw to the PTY
// (with server-side echo), so there is no line buffer to read — this rebuilds
// one by observing the same keystrokes. It is deliberately best-effort and
// CONSERVATIVE: anything it can't track confidently (Tab completion, Up/Down
// history recall, unknown escape sequences) flips `desynced`, which suppresses
// the suggestion until the next Enter resets the line. A wrong suggestion is
// worse than none, so when unsure it shows nothing. Session-scoped in-memory
// history only — nothing is persisted (SSH commands can contain secrets).

export class SshLineModel {
    line = ''
    cursor = 0
    desynced = false
    history: string[] = []

    // suggestion returns the ghost suffix to show after the cursor, or '' when
    // there's nothing confident to suggest (desynced, cursor not at line end,
    // empty line, or no matching history entry).
    suggestion(): string {
        if (this.desynced || this.line.length === 0 || this.cursor !== this.line.length) return ''
        for (let i = this.history.length - 1; i >= 0; i--) {
            const h = this.history[i]
            if (h.length > this.line.length && h.startsWith(this.line)) return h.slice(this.line.length)
        }
        return ''
    }

    // currentLine returns the reconstructed line, or '' when the
    // reconstruction is not trustworthy.
    //
    // The desynced check is the whole point: after a Tab completion or a
    // history recall the real line changed out from under us, so `line` is a
    // guess. Callers use this to read a `cd` out of what was typed, and
    // publishing a directory from an unreliable line would send the file
    // pane somewhere the shell never went — worse than not following at all.
    currentLine(): string {
        return this.desynced ? '' : this.line
    }

    // accept records that the ghost suffix was accepted (its bytes are sent to
    // the PTY separately by the caller), advancing the reconstructed line.
    accept(ghost: string): void {
        this.line += ghost
        this.cursor = this.line.length
    }

    // onCommit, cuando se le asigna, recibe cada comando que el modelo pudo
    // reconstruir con confianza. Es el único punto de la app que sabe qué se
    // ejecutó de verdad en una terminal, así que es también el que alimenta el
    // historial persistido. Se deja como gancho en vez de llamar al binding
    // directo para que este archivo siga sin depender de Wails ni del vault:
    // es un modelo de texto, y así se lo puede razonar (y probar) suelto.
    onCommit: ((command: string) => void) | null = null

    private commit(): void {
        // Only record the command when the line was tracked confidently. If
        // desynced (a Tab completion or history recall changed the real line
        // out from under the reconstruction), `this.line` is unreliable —
        // recording it would poison future suggestions with a wrong string.
        const cmd = this.line.trim()
        if (!this.desynced && cmd && this.history[this.history.length - 1] !== cmd) {
            this.history.push(cmd)
            if (this.history.length > 500) this.history.shift()
            this.onCommit?.(cmd)
        }
        this.reset()
    }

    // seedHistory precarga comandos de sesiones anteriores, del más viejo al
    // más nuevo, para que la sugerencia fantasma sirva desde el primer Enter
    // de una terminal recién abierta en vez de tener que aprenderlo todo otra
    // vez cada vez. Lo ya cargado en esta sesión gana: se agrega adelante.
    seedHistory(commands: string[]): void {
        const known = new Set(this.history)
        const seed = commands.filter((c) => c && !known.has(c))
        this.history = [...seed, ...this.history]
        // Mismo tope que commit(), aplicado desde el frente: si el historial
        // viejo es enorme, lo que se descarta es lo más antiguo, no lo de esta
        // sesión, que es lo más probable que se repita.
        if (this.history.length > 500) this.history = this.history.slice(this.history.length - 500)
    }

    private reset(): void {
        this.line = ''
        this.cursor = 0
        this.desynced = false
    }

    // process folds one chunk of user input into the reconstructed line.
    process(data: string): void {
        let i = 0
        while (i < data.length) {
            const c = data[i]

            if (c === '\x1b') {
                const seq = data.slice(i)
                if (seq.startsWith('\x1b[C')) {
                    this.cursor = Math.min(this.cursor + 1, this.line.length)
                    i += 3
                    continue
                }
                if (seq.startsWith('\x1b[D')) {
                    this.cursor = Math.max(0, this.cursor - 1)
                    i += 3
                    continue
                }
                // Up/Down (history recall — remote rewrites the line), Home/End
                // variants, or any other escape: can't track reliably → desync.
                this.desynced = true
                return
            }

            const code = c.charCodeAt(0)
            if (c === '\r' || c === '\n') {
                this.commit()
                i++
                continue
            }
            if (c === '\x7f' || code === 8) {
                // backspace
                if (this.cursor > 0) {
                    this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor)
                    this.cursor--
                }
                i++
                continue
            }
            if (c === '\x03') {
                this.reset() // Ctrl-C
                i++
                continue
            }
            if (c === '\x15') {
                this.line = this.line.slice(this.cursor) // Ctrl-U: kill to start
                this.cursor = 0
                i++
                continue
            }
            if (c === '\x0b') {
                this.line = this.line.slice(0, this.cursor) // Ctrl-K: kill to end
                i++
                continue
            }
            if (c === '\x01') {
                this.cursor = 0 // Ctrl-A
                i++
                continue
            }
            if (c === '\x05') {
                this.cursor = this.line.length // Ctrl-E
                i++
                continue
            }
            if (code >= 0x20 && code !== 0x7f) {
                this.line = this.line.slice(0, this.cursor) + c + this.line.slice(this.cursor)
                this.cursor++
                i++
                continue
            }
            // Any other control byte (incl. Tab, handled specially by the
            // caller before this): can't track → desync.
            this.desynced = true
            return
        }
    }
}
