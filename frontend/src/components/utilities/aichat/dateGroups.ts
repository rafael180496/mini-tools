// Agrupación del historial por antigüedad: Hoy / Ayer / Últimos 7 días /
// Anteriores. Se cuenta en días de CALENDARIO locales y no en bloques de 24
// horas: una conversación de anoche a las 23:50 es «Ayer» aunque hayan pasado
// diez minutos, y es así como la recuerda quien la busca.

export type DateGroupId = 'today' | 'yesterday' | 'last7' | 'older'

export const DATE_GROUP_ORDER: DateGroupId[] = ['today', 'yesterday', 'last7', 'older']

// `unixSeconds` es como guarda el vault los instantes.
export function dateGroupOf(unixSeconds: number, now: Date = new Date()): DateGroupId {
    const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    const days = Math.round((startOfDay(now) - startOfDay(new Date(unixSeconds * 1000))) / 86_400_000)
    if (days <= 0) return 'today'
    if (days === 1) return 'yesterday'
    if (days < 7) return 'last7'
    return 'older'
}
