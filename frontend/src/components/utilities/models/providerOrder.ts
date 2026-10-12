import type {main} from '../../../../wailsjs/go/models'
import {providerGroup, type ProviderGroup} from '../../../lib/modelServers'

// Orden de los proveedores de IA.
//
// La lista guarda UN orden para todos (`sortOrder` en el vault, lo que escribe
// `ReorderModelServers`), pero se muestra en tres grupos: locales, remotos y
// nube. Reordenar dentro de un grupo no puede mover los de los otros, así que
// el orden nuevo se arma sobre la lista completa: los lugares que ocupaba el
// grupo se rellenan, en secuencia, con sus miembros ya reordenados. Lo demás
// queda donde estaba.

export const GROUP_ORDER: ProviderGroup[] = ['local', 'remote', 'cloud']

export function groupOf(s: main.ModelServer): ProviderGroup {
    return providerGroup(s)
}

// Los proveedores ordenados como los guarda el vault. `Array.sort` es estable,
// así que a igual `sortOrder` se respeta el orden en que llegaron.
export function sortedServers(list: main.ModelServer[]): main.ModelServer[] {
    return [...list].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
}

export function splitByGroup(list: main.ModelServer[]): Record<ProviderGroup, main.ModelServer[]> {
    const out: Record<ProviderGroup, main.ModelServer[]> = {local: [], remote: [], cloud: []}
    for (const s of list) out[groupOf(s)].push(s)
    return out
}

// Ids de la lista completa tras mover `id` a la posición de `targetId` dentro
// de su grupo. null si no cambia nada (mismo lugar, otro grupo o id inexistente).
export function moveToTarget(all: main.ModelServer[], id: string, targetId: string): string[] | null {
    const moving = all.find((s) => s.id === id)
    const target = all.find((s) => s.id === targetId)
    if (!moving || !target || id === targetId || groupOf(moving) !== groupOf(target)) return null
    const group = all.filter((s) => groupOf(s) === groupOf(moving)).map((s) => s.id)
    const from = group.indexOf(id)
    const to = group.indexOf(targetId)
    const next = [...group]
    next.splice(from, 1)
    next.splice(to, 0, id)
    return rebuild(all, groupOf(moving), next)
}

// Lo mismo, pero un lugar hacia arriba (-1) o hacia abajo (+1): el atajo de
// teclado Alt+↑ / Alt+↓. Devuelve además la posición nueva (1-based) y el
// tamaño del grupo, para anunciarlo.
export function moveByStep(all: main.ModelServer[], id: string, step: -1 | 1): {ids: string[]; position: number; total: number} | null {
    const moving = all.find((s) => s.id === id)
    if (!moving) return null
    const group = all.filter((s) => groupOf(s) === groupOf(moving)).map((s) => s.id)
    const from = group.indexOf(id)
    const to = from + step
    if (to < 0 || to >= group.length) return null
    const next = [...group]
    next.splice(from, 1)
    next.splice(to, 0, id)
    return {ids: rebuild(all, groupOf(moving), next), position: to + 1, total: group.length}
}

function rebuild(all: main.ModelServer[], group: ProviderGroup, reordered: string[]): string[] {
    let i = 0
    return all.map((s) => (groupOf(s) === group ? reordered[i++] : s.id))
}

// La lista con el orden nuevo ya aplicado (`sortOrder` renumerado), para
// pintarlo sin esperar al backend.
export function applyOrder(all: main.ModelServer[], ids: string[]): main.ModelServer[] {
    const byId = new Map(all.map((s) => [s.id, s]))
    const out: main.ModelServer[] = []
    ids.forEach((id, n) => {
        const s = byId.get(id)
        if (s) out.push({...s, sortOrder: n} as main.ModelServer)
    })
    // Lo que el pedido no nombra (llegó otro proveedor mientras tanto) se queda al final.
    for (const s of all) if (!ids.includes(s.id)) out.push(s)
    return out
}
