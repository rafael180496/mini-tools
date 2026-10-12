// Preferencias de DISPOSICIÓN del Chat de IA: ancho del historial y si está
// abierto. Son de este equipo y de esta pantalla —cuánto lugar le das a una
// lista en TU monitor—, no datos de la cuenta, así que viven en localStorage y no
// en el vault: no hace falta una migración ni un método más en `App`, y si el
// almacenamiento no está (ventana privada, bloqueado) la pantalla simplemente
// arranca con los valores de siempre. Por eso cada acceso va envuelto.

const WIDTH_KEY = 'mini-tools:aiChat:historyWidth'
const OPEN_KEY = 'mini-tools:aiChat:historyOpen'

export const HISTORY_WIDTH_DEFAULT = 288
export const HISTORY_WIDTH_MIN = 220
export const HISTORY_WIDTH_MAX = 560

// Por debajo de este ancho de la PESTAÑA el historial deja de ser una columna y
// pasa a un cajón sobre el chat: con la columna al lado, el chat quedaría con
// menos de ~470 px y la barra de controles se rompería en tres renglones.
export const NARROW_BELOW = 760
// Por debajo de éste, la cabecera se compacta (botón «Nuevo chat» sin rótulo,
// selectores que se reparten el renglón).
export const COMPACT_BELOW = 560
// Ancho mínimo que se le deja al chat al lado de un historial inline.
export const CHAT_MIN = 420

export function readHistoryWidth(): number {
    try {
        const n = Number(localStorage.getItem(WIDTH_KEY))
        if (Number.isFinite(n) && n >= HISTORY_WIDTH_MIN && n <= HISTORY_WIDTH_MAX) return Math.round(n)
    } catch {
        // sin almacenamiento: vale el ancho por defecto
    }
    return HISTORY_WIDTH_DEFAULT
}

export function writeHistoryWidth(px: number): void {
    try {
        if (px === HISTORY_WIDTH_DEFAULT) localStorage.removeItem(WIDTH_KEY)
        else localStorage.setItem(WIDTH_KEY, String(Math.round(px)))
    } catch {
        // no se pudo recordar; la sesión sigue con el valor en memoria
    }
}

export function readHistoryOpen(): boolean {
    try {
        return localStorage.getItem(OPEN_KEY) !== '0'
    } catch {
        return true
    }
}

export function writeHistoryOpen(open: boolean): void {
    try {
        if (open) localStorage.removeItem(OPEN_KEY)
        else localStorage.setItem(OPEN_KEY, '0')
    } catch {
        // idem
    }
}
