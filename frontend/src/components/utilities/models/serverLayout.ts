// Preferencias de DISPOSICIÓN de la columna de servidores de «Modelos»: ancho y
// si está abierta. Mismo criterio que las del Chat de IA (aichat/layoutPrefs):
// son de este equipo y de esta pantalla, no datos de la cuenta, así que viven en
// localStorage y no en el vault. Si el almacenamiento no está, la pantalla
// arranca con los valores de siempre; por eso cada acceso va envuelto.

const WIDTH_KEY = 'mini-tools:modelManager:serversWidth'
const OPEN_KEY = 'mini-tools:modelManager:serversOpen'

export const SERVERS_WIDTH_DEFAULT = 264
export const SERVERS_WIDTH_MIN = 208
export const SERVERS_WIDTH_MAX = 420

// Por debajo de este ancho de la PESTAÑA la columna deja de ocupar lugar y pasa a
// un cajón sobre la tabla: con la columna al lado, la tabla de modelos quedaría
// con menos de ~480 px y perdería casi todas sus columnas.
export const SERVERS_NARROW_BELOW = 760
// Ancho mínimo que se le deja a la tabla de modelos al lado de la columna.
export const MODELS_MIN = 460

export function readServersWidth(): number {
    try {
        const n = Number(localStorage.getItem(WIDTH_KEY))
        if (Number.isFinite(n) && n >= SERVERS_WIDTH_MIN && n <= SERVERS_WIDTH_MAX) return Math.round(n)
    } catch {
        // sin almacenamiento: vale el ancho por defecto
    }
    return SERVERS_WIDTH_DEFAULT
}

export function writeServersWidth(px: number): void {
    try {
        if (px === SERVERS_WIDTH_DEFAULT) localStorage.removeItem(WIDTH_KEY)
        else localStorage.setItem(WIDTH_KEY, String(Math.round(px)))
    } catch {
        // no se pudo recordar; la sesión sigue con el valor en memoria
    }
}

export function readServersOpen(): boolean {
    try {
        return localStorage.getItem(OPEN_KEY) !== '0'
    } catch {
        return true
    }
}

export function writeServersOpen(open: boolean): void {
    try {
        if (open) localStorage.removeItem(OPEN_KEY)
        else localStorage.setItem(OPEN_KEY, '0')
    } catch {
        // idem
    }
}
