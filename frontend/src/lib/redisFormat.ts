// Value formatters for the Redis inspector.
//
// Redis stores bytes and nothing else: the same key can hold a JSON
// document, a marshaled object, a counter, or a lock token that is not text
// at all. Rendering everything as a string makes the non-text cases look
// broken (a row of replacement characters), and rendering everything as hex
// makes the common case unreadable. So the viewer picks a default per value
// and lets it be overridden.
//
// Values reaching here already went through lossy UTF-8 replacement in the
// backend (see lib/binaryPreview.ts), which matters for one thing: HEX and
// BASE64 of a value that contained invalid UTF-8 show the REPLACED bytes,
// not the originals. That is called out in the UI rather than pretended
// away — a hex dump that silently lies is worse than no hex dump.

import {tryPrettyPrintJSON} from './prettyPrintJSON'

export type RedisFormat = 'auto' | 'text' | 'json' | 'hex' | 'base64'

export const REDIS_FORMATS: {value: RedisFormat; label: string; hint: string}[] = [
    {value: 'auto', label: 'Auto', hint: 'Elige el formato según el contenido: JSON si parsea, texto si es legible, hexadecimal si son bytes'},
    {value: 'text', label: 'Texto', hint: 'El valor tal cual, sin interpretar'},
    {value: 'json', label: 'JSON', hint: 'Formatea e indenta el valor como JSON. Si no parsea, se muestra tal cual con el error.'},
    {value: 'hex', label: 'Hex', hint: 'Volcado hexadecimal con la columna ASCII al costado — para valores binarios (locks, objetos serializados, contadores empaquetados)'},
    {value: 'base64', label: 'Base64', hint: 'El valor codificado en Base64, listo para copiar a otra herramienta'},
]

// U+FFFD, what the backend substitutes for bytes that are not valid UTF-8.
const REPLACEMENT = '�'

// looksBinary reports whether a value carries control characters or
// replacement characters — the signal that it was never text.
export function looksBinary(raw: string): boolean {
    if (raw.includes(REPLACEMENT)) return true
    for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i)
        // Tab, newline and carriage return are ordinary in text values.
        if (c < 0x20 && c !== 9 && c !== 10 && c !== 13) return true
    }
    return false
}

// isProbablyJSON reports whether a value parses as a JSON object or array.
// A bare number or quoted string is NOT treated as JSON: "42" is a counter,
// and formatting it as JSON gains nothing while making the viewer switch
// modes for no reason.
export function isProbablyJSON(raw: string): boolean {
    const t = raw.trim()
    if (!(t.startsWith('{') || t.startsWith('['))) return false
    try {
        JSON.parse(t)
        return true
    } catch {
        return false
    }
}

// resolveFormat is what 'auto' means for a given value.
export function resolveFormat(raw: string, chosen: RedisFormat): Exclude<RedisFormat, 'auto'> {
    if (chosen !== 'auto') return chosen
    if (looksBinary(raw)) return 'hex'
    if (isProbablyJSON(raw)) return 'json'
    return 'text'
}

// formatValue renders raw in the requested format. It never throws: a value
// that will not parse as JSON comes back unchanged, with the reason
// available separately via formatError.
export function formatValue(raw: string, format: RedisFormat): string {
    switch (resolveFormat(raw, format)) {
        case 'json':
            return tryPrettyPrintJSON(raw)
        case 'hex':
            return hexDump(raw)
        case 'base64':
            return toBase64(raw)
        default:
            return raw
    }
}

// formatError explains why a chosen format could not be applied, or "" when
// it applied cleanly. Only meaningful for an EXPLICIT choice — 'auto' never
// picks a format the value cannot take.
export function formatError(raw: string, format: RedisFormat): string {
    if (format === 'json' && !isProbablyJSON(raw)) {
        try {
            JSON.parse(raw.trim())
            return ''
        } catch (e) {
            return `No es JSON válido: ${String(e).replace(/^SyntaxError:\s*/, '')}`
        }
    }
    if ((format === 'hex' || format === 'base64') && raw.includes(REPLACEMENT)) {
        return 'Este valor tenía bytes que no son UTF-8 válido y ya fueron reemplazados al leerlo: lo que ves acá son los bytes reemplazados, no los originales.'
    }
    return ''
}

// hexDump renders the classic offset / hex / ASCII layout, 16 bytes per
// row. Encodes to UTF-8 first so a multi-byte character shows the bytes
// actually stored, not the JavaScript code units.
function hexDump(raw: string): string {
    const bytes = new TextEncoder().encode(raw)
    const lines: string[] = []

    for (let off = 0; off < bytes.length; off += 16) {
        const chunk = bytes.subarray(off, off + 16)
        const hex: string[] = []
        let ascii = ''
        for (let i = 0; i < 16; i++) {
            if (i < chunk.length) {
                hex.push(chunk[i].toString(16).padStart(2, '0'))
                ascii += chunk[i] >= 0x20 && chunk[i] < 0x7f ? String.fromCharCode(chunk[i]) : '.'
            } else {
                hex.push('  ')
                ascii += ' '
            }
            // Split the hex column in half, the way every hex viewer does —
            // it is what makes a 16-byte row countable at a glance.
            if (i === 7) hex.push('')
        }
        lines.push(`${off.toString(16).padStart(8, '0')}  ${hex.join(' ')}  |${ascii}|`)
    }

    return lines.length > 0 ? lines.join('\n') : '(vacío)'
}

function toBase64(raw: string): string {
    const bytes = new TextEncoder().encode(raw)
    let binary = ''
    for (const b of bytes) binary += String.fromCharCode(b)
    try {
        return btoa(binary)
    } catch {
        return raw
    }
}

// --- TTL -------------------------------------------------------------------

// Redis's own sentinels, surfaced verbatim by db.GetRedisKeyInfo rather
// than collapsed to 0.
export const TTL_NO_EXPIRY = -1
export const TTL_MISSING = -2

export interface TTLDisplay {
    label: string
    // tone drives the colour: 'none' for a permanent key, 'ok' for plenty of
    // time left, 'warn' under an hour, 'danger' under five minutes.
    tone: 'none' | 'ok' | 'warn' | 'danger'
    hint: string
}

// describeTTL turns a raw TTL into what the UI shows. The thresholds exist
// so "about to expire" is visible at a glance instead of requiring the user
// to read and mentally convert a seconds count.
export function describeTTL(ttlSeconds: number): TTLDisplay {
    if (ttlSeconds === TTL_MISSING) {
        return {label: 'no existe', tone: 'danger', hint: 'Redis dice que la clave no existe — lo más probable es que haya vencido desde que se listó.'}
    }
    if (ttlSeconds === TTL_NO_EXPIRY) {
        return {label: 'sin vencimiento', tone: 'none', hint: 'La clave es permanente: no tiene TTL configurado.'}
    }

    let tone: TTLDisplay['tone'] = 'ok'
    if (ttlSeconds < 300) tone = 'danger'
    else if (ttlSeconds < 3600) tone = 'warn'

    return {
        label: formatDuration(ttlSeconds),
        tone,
        hint: `Vence en ${formatDuration(ttlSeconds)} (${ttlSeconds.toLocaleString('es')} segundos).`,
    }
}

// formatDuration writes a seconds count the way a person reads a countdown:
// the two largest units that matter, never six of them.
export function formatDuration(seconds: number): string {
    if (seconds < 0) return '—'
    if (seconds < 60) return `${seconds}s`

    const d = Math.floor(seconds / 86400)
    const h = Math.floor((seconds % 86400) / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = seconds % 60

    if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
    if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
    return s > 0 ? `${m}m ${s}s` : `${m}m`
}

// parseTTLInput reads what the user typed into the TTL box, accepting the
// shorthand people actually write ("30m", "2h", "7d") as well as a bare
// seconds count. Returns null when it cannot be read as a duration.
export function parseTTLInput(raw: string): number | null {
    const t = raw.trim().toLowerCase()
    if (t === '') return null

    const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/.exec(t)
    if (!m) return null

    const n = parseFloat(m[1])
    if (isNaN(n) || n <= 0) return null

    switch (m[2]) {
        case 'd':
            return Math.round(n * 86400)
        case 'h':
            return Math.round(n * 3600)
        case 'm':
            return Math.round(n * 60)
        default:
            return Math.round(n)
    }
}
