// Ancho de columna calculado a partir del contenido, al estilo DataGrip.
//
// Antes cada columna nacía con 160 px fijos: una de IDs de siete dígitos
// desperdiciaba la mitad y la de al lado cortaba la descripción a la tercera
// palabra. El ancho tiene que salir de lo que hay adentro, no de un número
// elegido de antemano.
//
// Las celdas son monoespaciadas (`font-mono` en el scroller de la grilla), así
// que su ancho es contar caracteres por el avance de un carácter — una sola
// medición de canvas para todas. La cabecera es proporcional (`font-sans`) y sí
// se mide texto por texto, que son tantas mediciones como columnas.

export const MIN_COL_WIDTH = 64
const MAX_COL_WIDTH = 420

// `px-3` a cada lado + el borde. El extra de la cabecera es la flecha de orden
// y el agarre de redimensión, que comen ancho sobre el texto del nombre.
const CELL_PADDING = 26
const HEADER_EXTRA = 24

// Cuántas filas se miran para decidir el ancho. Recorrer las 500 de la página
// no cambiaría el resultado en la práctica y sí se nota al abrir un resultado
// ancho; con 300 el caso "la fila 250 trae el valor más largo" sigue entrando.
const SAMPLE_ROWS = 300

let ctx: CanvasRenderingContext2D | null = null

function context(): CanvasRenderingContext2D | null {
    if (ctx) return ctx
    // En un entorno sin canvas (tests en node) se cae al heurístico de abajo
    // en vez de romper: un ancho aproximado es mejor que una grilla sin dibujar.
    try {
        ctx = document.createElement('canvas').getContext('2d')
    } catch {
        ctx = null
    }
    return ctx
}

// El cuerpo de la interfaz es ajustable (ver --ui-font-scale en globals.css):
// medir con 12 px fijos deja las columnas cortas para quien agrandó la letra.
function fontScale(): number {
    try {
        const raw = getComputedStyle(document.documentElement).getPropertyValue('--ui-font-scale')
        const n = parseFloat(raw)
        return Number.isFinite(n) && n > 0 ? n : 1
    } catch {
        return 1
    }
}

interface Metrics {
    char: number
    header: (text: string) => number
}

function metrics(): Metrics {
    // text-xs = 0.75rem = 12px, por la escala de la interfaz.
    const px = 12 * fontScale()
    const c = context()
    if (!c) {
        // Sin canvas: 0.62em por carácter es el avance típico de una
        // monoespaciada, y la cabecera se estima con el mismo criterio.
        const char = px * 0.62
        return {char, header: (t) => t.length * char}
    }
    c.font = `${px}px 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace`
    const char = c.measureText('0').width || px * 0.62
    return {
        char,
        header: (t) => {
            c.font = `600 ${px}px 'Hanken Grotesk', system-ui, sans-serif`
            const w = c.measureText(t).width
            c.font = `${px}px 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace`
            return w
        },
    }
}

// Largo en caracteres de una celda tal como se DIBUJA, que no siempre es el
// valor: un nulo se muestra como la palabra NULL.
function cellLength(value: unknown): number {
    if (value === null || value === undefined) return 4
    return String(value).length
}

function clamp(width: number): number {
    return Math.round(Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, width)))
}

/** Ancho que le corresponde a UNA columna según su nombre y sus valores. */
export function measureColumnWidth(name: string, index: number, rows: unknown[][], m: Metrics = metrics()): number {
    let maxChars = 0
    const limit = Math.min(rows.length, SAMPLE_ROWS)
    for (let r = 0; r < limit; r++) {
        const len = cellLength(rows[r]?.[index])
        if (len > maxChars) maxChars = len
    }
    const body = maxChars * m.char + CELL_PADDING
    const header = m.header(name) + CELL_PADDING + HEADER_EXTRA
    return clamp(Math.max(body, header))
}

/** Ancho de cada columna, indexado por nombre de columna. */
export function measureColumnWidths(columns: string[], rows: unknown[][]): Record<string, number> {
    const m = metrics()
    const out: Record<string, number> = {}
    columns.forEach((name, i) => {
        out[name] = measureColumnWidth(name, i, rows, m)
    })
    return out
}
