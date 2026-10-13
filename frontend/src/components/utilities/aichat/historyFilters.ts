import type {vault} from '../../../../wailsjs/go/models'
import {dateGroupOf} from './dateGroups'

// Filtros del historial del Chat de IA, y cómo se recuerdan.
//
// Se guardan en localStorage por PESTAÑA (cada pestaña de Chat de IA tiene su
// propio historial a la vista y puede estar mirando otra cosa) y además como
// «último usado», con el que arranca una pestaña nueva: quien filtró por un
// proveedor ayer no quiere volver a hacerlo en la pestaña que abre hoy. Es una
// comodidad por espectador, no un dato: cada acceso va envuelto, y si el
// almacenamiento no está (ventana privada, bloqueado) los filtros simplemente
// arrancan vacíos.

export type DateFilter = 'all' | 'today' | 'd7' | 'd30'
export type StateFilter = 'any' | 'working' | 'unread' | 'background'
export type OrderFilter = 'recent' | 'name'

export interface HistoryFilters {
    // Ids de agente. Vacío = todos.
    providers: string[]
    // Claves de origen (ver originKey). Vacío = todos.
    origins: string[]
    date: DateFilter
    state: StateFilter
    order: OrderFilter
}

export const EMPTY_FILTERS: HistoryFilters = {providers: [], origins: [], date: 'all', state: 'any', order: 'recent'}

const KEY = 'mini-tools:aiChat:historyFilters'
// Cuántas pestañas se recuerdan: los ids de pestaña no sobreviven a un reinicio,
// así que sin tope la clave crecería para siempre.
const MAX_PANES = 12

const DATES: DateFilter[] = ['all', 'today', 'd7', 'd30']
const STATES: StateFilter[] = ['any', 'working', 'unread', 'background']
const ORDERS: OrderFilter[] = ['recent', 'name']

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

function sanitize(v: unknown): HistoryFilters {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
    return {
        providers: strings(o.providers),
        origins: strings(o.origins),
        date: DATES.includes(o.date as DateFilter) ? (o.date as DateFilter) : 'all',
        state: STATES.includes(o.state as StateFilter) ? (o.state as StateFilter) : 'any',
        order: ORDERS.includes(o.order as OrderFilter) ? (o.order as OrderFilter) : 'recent',
    }
}

interface Stored {
    last?: unknown
    panes?: Record<string, unknown>
    order?: string[]
}

function readStore(): Stored {
    try {
        const raw = JSON.parse(window.localStorage.getItem(KEY) ?? 'null')
        return raw && typeof raw === 'object' ? (raw as Stored) : {}
    } catch {
        return {}
    }
}

export function readFilters(paneId: string): HistoryFilters {
    const s = readStore()
    const own = s.panes?.[paneId]
    return sanitize(own ?? s.last)
}

export function writeFilters(paneId: string, f: HistoryFilters): void {
    try {
        const s = readStore()
        const panes = {...(s.panes ?? {}), [paneId]: f}
        const order = [...(s.order ?? []).filter((id) => id !== paneId), paneId]
        while (order.length > MAX_PANES) delete panes[order.shift() as string]
        window.localStorage.setItem(KEY, JSON.stringify({last: f, panes, order}))
    } catch {
        // no se pudo recordar; la sesión sigue con los filtros en memoria
    }
}

// Cuántos criterios hay puestos (cada proveedor y cada origen cuenta uno). El
// orden no cuenta: ordena, no filtra.
export function activeCount(f: HistoryFilters): number {
    return f.providers.length + f.origins.length + (f.date !== 'all' ? 1 : 0) + (f.state !== 'any' ? 1 : 0)
}

export const isDefault = (f: HistoryFilters): boolean => activeCount(f) === 0 && f.order === 'recent'

// De dónde salió la conversación, como clave estable: módulo + recurso. «Sin
// módulo» (las anteriores al chat unificado) es una sola clave.
export function originKey(c: Pick<vault.AgentChat, 'module' | 'contextId'>): string {
    const kind = c.module || 'none'
    return kind === 'none' ? 'none|' : `${kind}|${c.contextId ?? ''}`
}

export function matchesDate(updatedAt: number, d: DateFilter, now = new Date()): boolean {
    if (d === 'all') return true
    if (d === 'today') return dateGroupOf(updatedAt, now) === 'today'
    if (d === 'd7') return dateGroupOf(updatedAt, now) !== 'older'
    return now.getTime() / 1000 - updatedAt <= 30 * 86400
}
