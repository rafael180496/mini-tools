// Diff por líneas para mostrar QUÉ cambió en una propuesta del agente.
//
// Escrito a mano y no con una librería por la regla 12 de
// .claude/rules/technical.md (dependencias mínimas): son cuarenta líneas y el
// caso de uso es acotado —dos versiones de una misma consulta, decenas de
// líneas, no un archivo—. Traer un motor de diff completo para eso pesaría más
// que el propio editor.
//
// Por qué existe: una propuesta que reemplaza el editor sin decir qué tocó
// obliga a releer la consulta entera para encontrar el cambio. Y ahí es donde
// se cuela lo que el agente cambió sin que nadie se lo pidiera.

export type DiffKind = 'same' | 'added' | 'removed'

export interface DiffLine {
    kind: DiffKind
    text: string
}

// diffLines compara dos textos línea por línea con la subsecuencia común más
// larga. Es O(n·m) en memoria: acotado a propósito con MAX_LINES, porque una
// consulta de mil líneas no es el caso de uso y una matriz de un millón de
// celdas en el hilo de la UI sí es un problema.
const MAX_LINES = 400

export function diffLines(before: string, after: string): DiffLine[] {
    const a = before.split('\n')
    const b = after.split('\n')

    // Sin versión previa, todo es nuevo: no hay nada con qué comparar y
    // marcar cada línea como "agregada" sería ruido.
    if (before.trim() === '') return b.map((text) => ({kind: 'same' as const, text}))

    if (a.length > MAX_LINES || b.length > MAX_LINES) {
        // Demasiado grande para comparar: se muestra la propuesta tal cual y se
        // dice que no se pudo comparar, en vez de mentir marcando todo igual.
        return b.map((text) => ({kind: 'same' as const, text}))
    }

    // lcs[i][j] = largo de la subsecuencia común de a[i:] y b[j:]
    const lcs: number[][] = Array.from({length: a.length + 1}, () => new Array<number>(b.length + 1).fill(0))
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
        }
    }

    const out: DiffLine[] = []
    let i = 0
    let j = 0
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            out.push({kind: 'same', text: a[i]})
            i++
            j++
        } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
            out.push({kind: 'removed', text: a[i]})
            i++
        } else {
            out.push({kind: 'added', text: b[j]})
            j++
        }
    }
    while (i < a.length) out.push({kind: 'removed', text: a[i++]})
    while (j < b.length) out.push({kind: 'added', text: b[j++]})
    return out
}

// countChanges es cuántas líneas se agregan y cuántas se sacan, para poder
// decir "3 líneas nuevas, 1 quitada" sin obligar a contar a ojo.
export function countChanges(lines: DiffLine[]): {added: number; removed: number} {
    let added = 0
    let removed = 0
    for (const l of lines) {
        if (l.kind === 'added') added++
        else if (l.kind === 'removed') removed++
    }
    return {added, removed}
}
