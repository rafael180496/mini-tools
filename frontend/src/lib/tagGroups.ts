import type {git} from '../../wailsjs/go/models'

// Agrupación de tags por versión.
//
// Los tags no se parecen a las ramas y por eso no usan `buildBranchTree`: casi
// nunca tienen barras. Un repositorio real de esta app tiene 138 tags con la
// forma `1.31.5-prd-3.11.0`, así que agrupar por "/" los dejaría a los 138 en
// una lista plana — que es exactamente el problema que se quería resolver.
//
// Lo que sí tienen es una versión adelante, y ahí está la agrupación natural:
// `major.minor`. Las 138 filas pasan a ser una docena de carpetas plegables
// (`1.31`, `1.30`, `1.29`…), y adentro de cada una quedan los parches, que es
// como uno los busca ("la última 1.31", no "la número 87 de la lista").
//
// Solo agrupa; no ordena. El backend ya devuelve los tags por fecha de
// creación descendente (`for-each-ref --sort=-creatordate`), y ese orden —el
// más reciente primero— es el correcto tanto entre grupos como dentro de cada
// uno, así que respetarlo es más fiel que reordenar por nombre.

export interface TagGroup {
    // Clave estable para el estado de plegado y texto de la fila. Vacía para
    // el grupo de los que no encajan en ningún patrón.
    key: string
    tags: git.Tag[]
}

// groupKeyOf decide de qué carpeta cuelga un tag, probando de la convención
// más explícita a la más implícita:
//
//   `release/2026-07`      → "release"   (hay prefijo con barra: es la carpeta)
//   `v1.31.5` / `1.31.5-x` → "1.31"      (versión: agrupa por major.minor)
//   `produccion-final`     → ""          (sin patrón: queda suelto)
//
// El "sin patrón" es deliberadamente su propio caso y no un grupo llamado
// "otros": meter tres tags sueltos en una carpeta que hay que abrir es peor
// que dejarlos a la vista.
export function groupKeyOf(name: string): string {
    const slash = name.indexOf('/')
    if (slash > 0) return name.slice(0, slash)

    const version = name.match(/^v?(\d+)\.(\d+)/i)
    if (version) return `${version[1]}.${version[2]}`

    return ''
}

// groupTags reparte los tags en grupos preservando el orden de entrada, tanto
// dentro de cada grupo como entre grupos (un grupo aparece donde apareció su
// primer tag). Los que no tienen grupo se devuelven aparte para dibujarlos
// planos.
export function groupTags(tags: git.Tag[]): {groups: TagGroup[]; loose: git.Tag[]} {
    // Primera pasada solo para contar: un grupo de uno no gana nada por ser
    // carpeta —cuesta un click y una fila extra para mostrar una sola cosa que
    // ya entraba—, y eso hay que saberlo antes de empezar a repartir para que
    // el tag suelto conserve su lugar en el orden por fecha en vez de caer al
    // final de la lista.
    const counts = new Map<string, number>()
    for (const tag of tags) {
        const key = groupKeyOf(tag.name)
        if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
    }

    const groups: TagGroup[] = []
    const byKey = new Map<string, TagGroup>()
    const loose: git.Tag[] = []

    for (const tag of tags) {
        const key = groupKeyOf(tag.name)
        if (!key || (counts.get(key) ?? 0) < 2) {
            loose.push(tag)
            continue
        }
        let group = byKey.get(key)
        if (!group) {
            group = {key, tags: []}
            byKey.set(key, group)
            groups.push(group)
        }
        group.tags.push(tag)
    }

    return {groups, loose}
}
