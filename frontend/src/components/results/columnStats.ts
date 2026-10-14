// Estadísticas de una columna del resultado, para el panel «Estadísticas» de
// la grilla (lo que DataGrip muestra como agregados de la selección).
//
// Se calcula en el navegador sobre las filas que ya están en memoria: es
// instantáneo y no vuelve a consultar la base. La contracara está dicha en la
// interfaz: con un resultado paginado, son las estadísticas de lo cargado, no
// de la tabla.

export interface ColumnStats {
    rows: number
    nonNull: number
    nulls: number
    distinct: number
    // Solo si TODOS los valores no nulos son números (o texto que se lee como
    // número: Oracle devuelve NUMBER grandes como texto para no perder
    // precisión). Una columna mixta no tiene suma que signifique algo.
    numeric: boolean
    sum?: number
    avg?: number
    min?: string
    max?: string
    // Para texto: el largo, que es lo que se mira cuando hay que dimensionar
    // una columna o adivinar por qué un INSERT revienta con ORA-12899.
    minLen?: number
    maxLen?: number
}

const NUMERIC_RE = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/

function asNumber(v: unknown): number | null {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null
    if (typeof v === 'bigint') return Number(v)
    if (typeof v === 'string' && NUMERIC_RE.test(v)) return Number(v)
    return null
}

export function columnStats(rows: unknown[][], colIndex: number): ColumnStats {
    const values: unknown[] = []
    let nulls = 0
    for (const r of rows) {
        const v = r[colIndex]
        if (v === null || v === undefined) nulls++
        else values.push(v)
    }
    const distinct = new Set(values.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v)))).size
    const stats: ColumnStats = {rows: rows.length, nonNull: values.length, nulls, distinct, numeric: false}
    if (values.length === 0) return stats

    const nums = values.map(asNumber)
    if (nums.every((n) => n !== null)) {
        const ns = nums as number[]
        let sum = 0
        let min = ns[0]
        let max = ns[0]
        for (const n of ns) {
            sum += n
            if (n < min) min = n
            if (n > max) max = n
        }
        stats.numeric = true
        stats.sum = sum
        stats.avg = sum / ns.length
        stats.min = String(min)
        stats.max = String(max)
        return stats
    }

    // Texto (o fechas, que llegan como texto de pared): mínimo y máximo por
    // orden del texto —para una fecha `YYYY-MM-DD` es el orden cronológico— y
    // el rango de largos.
    const texts = values.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v)))
    let min = texts[0]
    let max = texts[0]
    let minLen = texts[0].length
    let maxLen = texts[0].length
    for (const s of texts) {
        if (s < min) min = s
        if (s > max) max = s
        if (s.length < minLen) minLen = s.length
        if (s.length > maxLen) maxLen = s.length
    }
    stats.min = min
    stats.max = max
    stats.minLen = minLen
    stats.maxLen = maxLen
    return stats
}

// rowMatches es el filtro rápido: alguna celda contiene el texto, sin
// distinguir mayúsculas. NULL se busca como "null", que es como se ve.
export function rowMatches(row: unknown[], needle: string): boolean {
    for (const v of row) {
        const s = v === null || v === undefined ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v)
        if (s.toLowerCase().includes(needle)) return true
    }
    return false
}
