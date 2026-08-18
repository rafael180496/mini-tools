// Lectura de una tabla Markdown (estilo GitHub), compartida por las dos vistas
// de una nota.
//
// Vive acá y no adentro de la vista previa porque la MISMA tabla la dibujan dos
// lugares: el editor en vivo, que la muestra como tabla mientras se escribe, y
// la vista de lectura. Dos lectores del mismo formato terminan discrepando en
// algún borde —la barra escapada, la fila sin barras en los extremos— y ahí la
// tabla se ve de una forma mientras se escribe y de otra al leerla.

export type CellAlign = 'left' | 'center' | 'right'

// splitRow parte una fila en celdas.
//
// Respeta el `\|` escapado, que es la única forma de poner una barra vertical
// dentro de una celda: sin esto, una celda con una alternativa (`a \| b`)
// partía la fila en dos y desalineaba la tabla entera.
export function splitRow(line: string): string[] {
    const cells: string[] = []
    let cur = ''
    for (let i = 0; i < line.length; i++) {
        const c = line[i]
        if (c === '\\' && line[i + 1] === '|') {
            cur += '|'
            i++
            continue
        }
        if (c === '|') {
            cells.push(cur)
            cur = ''
            continue
        }
        cur += c
    }
    cells.push(cur)
    // Las barras de los extremos son decorativas: `| a | b |` y `a | b` son la
    // misma tabla, y las dos formas se escriben en la práctica.
    if (cells.length > 0 && cells[0].trim() === '') cells.shift()
    if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop()
    return cells.map((c) => c.trim())
}

// alignOf lee la fila de separadores (`|---|:--:|---:|`) y devuelve la
// alineación de cada columna, o null si esa línea no es un separador.
export function alignOf(line: string): CellAlign[] | null {
    if (!line.includes('-') || !line.includes('|')) return null
    const cells = splitRow(line)
    if (cells.length === 0) return null
    const out: CellAlign[] = []
    for (const c of cells) {
        if (!/^:?-+:?$/.test(c)) return null
        out.push(c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left')
    }
    return out
}

// isTableStart: una fila con barras seguida de la fila de separadores. Los dos
// renglones juntos son lo que distingue una tabla de un párrafo que casualmente
// tiene una barra vertical adentro.
export function isTableStart(lines: string[], i: number): boolean {
    if (i + 1 >= lines.length || !lines[i].includes('|')) return false
    return alignOf(lines[i + 1]) !== null
}

// parseTable devuelve el encabezado, las filas y hasta qué línea llega la
// tabla (exclusivo). Asume que `isTableStart(lines, start)` es cierto.
export function parseTable(
    lines: string[],
    start: number,
): {header: string[]; align: CellAlign[]; rows: string[][]; end: number} {
    const header = splitRow(lines[start])
    const align = alignOf(lines[start + 1]) ?? []
    const rows: string[][] = []
    let n = start + 2
    while (n < lines.length && lines[n].includes('|') && lines[n].trim() !== '') {
        rows.push(splitRow(lines[n]))
        n++
    }
    return {header, align, rows, end: n}
}
