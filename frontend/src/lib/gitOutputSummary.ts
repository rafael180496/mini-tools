// Parser de la salida de pull/merge de git: separa el diffstat (una línea por
// archivo más la línea de totales) del resto del texto, para que la UI pueda
// mostrar un resumen plegable en vez de volcar cientos de líneas en un banner.
//
// Depende de que el backend corra git con COLUMNS ancho (ver hardenedEnv): con
// el ancho por defecto git recorta las rutas largas a ".../resto" y ya no se
// pueden abrir.

export type StatFileKind = 'added' | 'deleted' | 'renamed' | 'modified'

export interface StatFile {
    // Ruta final (la nueva, en un rename).
    path: string
    // Ruta anterior, solo en un rename.
    from?: string
    kind: StatFileKind
    // Líneas cambiadas según git. null en un binario.
    changes: number | null
    // Reparto aproximado a partir del gráfico +/− de git, que está a escala:
    // la proporción es fiel aunque el conteo exacto por lado no viaja.
    insertions: number
    deletions: number
    binary?: string
}

export interface GitOutputSummary {
    range?: {from: string; to: string}
    fastForward: boolean
    files: StatFile[]
    totals: {files: number; insertions: number; deletions: number}
    // Líneas que no son parte del diffstat (avisos, "Already up to date", etc.).
    other: string[]
}

const statLine = /^\s(.+?)\s+\|\s+(?:(\d+)\s*([+-]*)|(Bin)(?:\s+(.*))?)$/
const totalsLine = /^\s*(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/
const modeLine = /^\s(create|delete) mode \d+ (.+)$/
const renameLine = /^\s(?:rename|copy) (.+) \((\d+)%\)$/
const updatingLine = /^Updating ([0-9a-f]+)\.\.([0-9a-f]+)$/

// expandRename convierte "dir/{viejo => nuevo}/x.rb" o "viejo => nuevo" en el
// par de rutas completas.
function expandRename(raw: string): {from: string; to: string} | null {
    const braced = raw.match(/^(.*)\{(.*) => (.*)\}(.*)$/)
    if (braced) {
        const [, pre, a, b, post] = braced
        const join = (mid: string) => (pre + mid + post).replace(/\/\//g, '/')
        return {from: join(a), to: join(b)}
    }
    const plain = raw.match(/^(.*) => (.*)$/)
    return plain ? {from: plain[1], to: plain[2]} : null
}

// parseGitOutput devuelve null cuando la salida no trae diffstat: en ese caso
// la UI la muestra como texto plano.
export function parseGitOutput(text: string): GitOutputSummary | null {
    const lines = text.replace(/\r/g, '').split('\n')
    const files: StatFile[] = []
    const byPath = new Map<string, StatFile>()
    const other: string[] = []
    let range: GitOutputSummary['range']
    let fastForward = false
    let totals: GitOutputSummary['totals'] | null = null

    for (const line of lines) {
        const up = line.match(updatingLine)
        if (up) {
            range = {from: up[1], to: up[2]}
            continue
        }
        if (line.trim() === 'Fast-forward') {
            fastForward = true
            continue
        }
        const tot = line.match(totalsLine)
        if (tot) {
            totals = {files: +tot[1], insertions: +(tot[2] ?? 0), deletions: +(tot[3] ?? 0)}
            continue
        }
        const mode = line.match(modeLine)
        if (mode) {
            const f = byPath.get(mode[2])
            if (f) f.kind = mode[1] === 'create' ? 'added' : 'deleted'
            continue
        }
        if (renameLine.test(line)) continue
        const st = !totals ? line.match(statLine) : null
        if (st) {
            const [, rawPath, count, graph, isBin, binDetail] = st
            const renamed = expandRename(rawPath.trim())
            const path = renamed ? renamed.to : rawPath.trim()
            const changes = isBin ? null : +count
            let insertions = 0
            let deletions = 0
            if (changes !== null) {
                const plus = (graph.match(/\+/g) ?? []).length
                const minus = (graph.match(/-/g) ?? []).length
                if (plus + minus > 0) {
                    insertions = Math.round((changes * plus) / (plus + minus))
                    deletions = changes - insertions
                }
            }
            const f: StatFile = {
                path,
                from: renamed?.from,
                kind: renamed ? 'renamed' : 'modified',
                changes,
                insertions,
                deletions,
                binary: isBin ? (binDetail ?? '').trim() : undefined,
            }
            files.push(f)
            byPath.set(path, f)
            continue
        }
        if (line.trim()) other.push(line)
    }

    if (files.length === 0) return null
    return {
        range,
        fastForward,
        files,
        totals: totals ?? {
            files: files.length,
            insertions: files.reduce((n, f) => n + f.insertions, 0),
            deletions: files.reduce((n, f) => n + f.deletions, 0),
        },
        other,
    }
}
