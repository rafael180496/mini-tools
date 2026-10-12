import type {llm} from '../../../../wailsjs/go/models'
import {formatDateTime, formatNumber, locale} from '../../../i18n'

// Helpers de la utilidad «Modelos»: comparar nombres, ordenar y dar forma a
// fechas e intervalos. Nada de acá toca la red.

export type SortKey = 'name' | 'size' | 'modified'

// Ollama sin etiqueta usa `:latest`: `llama3.2` y `llama3.2:latest` son el
// mismo modelo, y la lista de cargados puede traer una forma y la de instalados
// la otra.
export function canonicalName(name: string): string {
    const n = name.trim().toLowerCase()
    return n.includes(':') ? n : `${n}:latest`
}

// Instante de una fecha RFC 3339 del servidor; 0 si no la informa o no se lee.
export function instantOf(iso: string): number {
    if (!iso) return 0
    const ms = Date.parse(iso)
    return Number.isNaN(ms) ? 0 : ms
}

// «12 oct 2026» para la celda; el título lleva la fecha completa con hora.
export function shortDate(iso: string): string {
    const ms = instantOf(iso)
    return ms ? formatDateTime(new Date(ms), {dateStyle: 'medium'}) : ''
}

export function fullDate(iso: string): string {
    const ms = instantOf(iso)
    return ms ? formatDateTime(new Date(ms), {dateStyle: 'long', timeStyle: 'medium'}) : ''
}

// «en 4 minutos» / «in 4 minutes», para cuándo se libera un modelo cargado.
// Vacío si no hay fecha o ya pasó: un «hace 3 s» no ayuda a decidir nada.
export function inFuture(iso: string, now: number): string {
    const ms = instantOf(iso)
    if (!ms || ms <= now) return ''
    const secs = Math.round((ms - now) / 1000)
    const rtf = new Intl.RelativeTimeFormat(locale(), {numeric: 'auto'})
    if (secs < 90) return rtf.format(secs, 'second')
    const mins = Math.round(secs / 60)
    if (mins < 90) return rtf.format(mins, 'minute')
    return rtf.format(Math.round(mins / 60), 'hour')
}

export function sortModels(list: llm.ManagedModel[], key: SortKey, dir: 'asc' | 'desc'): llm.ManagedModel[] {
    const sign = dir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
        const cmp =
            key === 'size' ? a.size - b.size : key === 'modified' ? instantOf(a.modifiedAt) - instantOf(b.modifiedAt) : a.name.localeCompare(b.name)
        // Desempate por nombre: dos modelos del mismo tamaño no cambian de
        // lugar entre una lectura y la siguiente.
        return cmp * sign || a.name.localeCompare(b.name)
    })
}

export function matchesModel(m: llm.ManagedModel, q: string): boolean {
    if (!q) return true
    return [m.name, m.family, m.parameterSize, m.quantizationLevel, m.format].some((v) => v.toLowerCase().includes(q))
}

// El host de la URL del servidor, para decir en qué máquina cae un borrado o
// una descarga.
export function hostOf(baseUrl: string): string {
    try {
        return new URL(baseUrl).host
    } catch {
        return baseUrl
    }
}

// Mismo criterio que backend/llm.ValidateModelName: se rechaza antes de ir al
// backend para poder explicarlo en el botón; el backend vuelve a validar.
const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/

export function isValidModelName(raw: string): boolean {
    const n = raw.trim()
    return n.length > 0 && n.length <= 255 && MODEL_NAME_RE.test(n) && !n.includes('//') && !n.includes('..')
}

// Tamaños en base 10, como los muestra Ollama (`ollama list`) y su biblioteca:
// 4,7 GB y no 4,4 GB. El formateador de Docker usa base 2, que acá haría que el
// número de la tabla no coincidiera con el del catálogo con el que se eligió.
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatModelSize(n: number): string {
    let v = Math.max(0, n)
    let i = 0
    while (v >= 1000 && i < SIZE_UNITS.length - 1) {
        v /= 1000
        i++
    }
    const digits = i === 0 || v >= 100 ? 0 : 1
    return `${formatNumber(v, {minimumFractionDigits: digits, maximumFractionDigits: digits})} ${SIZE_UNITS[i]}`
}
