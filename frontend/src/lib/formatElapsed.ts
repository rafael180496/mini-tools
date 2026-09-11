// Duración de una ejecución, en unidades que se leen de un vistazo.
//
// La consola informaba siempre en milisegundos crudos, y un índice que tarda
// una hora salía como `completado en 4166452ms`: para saber cuánto fue eso
// había que dividir a mano dos veces. Nadie piensa una corrida larga en
// milisegundos, pero una corta sí — de ahí que la unidad dependa de la
// magnitud en vez de ser fija.
//
// Los milisegundos NO se pierden al crecer la escala: son la diferencia entre
// dos corridas de la misma sentencia, y es exactamente lo que se compara
// cuando se mide si un cambio mejoró algo.
export function formatElapsed(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '—'
    const total = Math.round(ms)
    if (total < 1000) return `${total}ms`

    const h = Math.floor(total / 3_600_000)
    const m = Math.floor((total % 3_600_000) / 60_000)
    const s = Math.floor((total % 60_000) / 1000)
    const rest = total % 1000

    const parts: string[] = []
    if (h > 0) parts.push(`${h}h`)
    if (h > 0 || m > 0) parts.push(`${m}m`)
    parts.push(`${s}s`)
    // Un `0ms` final no aporta nada; el resto de las unidades sí van aunque
    // estén en cero, porque `1h 0m 3s` se lee y `1h 3s` se malinterpreta.
    if (rest > 0) parts.push(`${rest}ms`)
    return parts.join(' ')
}
