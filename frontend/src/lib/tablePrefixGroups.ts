// Agrupar las tablas de un esquema por prefijo, como «Schema Objects by
// Prefix» de DataGrip 2026.2.
//
// En los esquemas del SGC los nombres ya vienen agrupados por convención —
// TMP_*, AUD_*, BATCH_*, ERR$_*— y una lista plana de trescientas tablas en
// orden alfabético los mezcla con todo lo demás. Agrupando, cada familia es
// una fila que se despliega.

// El prefijo es el texto hasta el primer delimitador (incluido): `_`, `-` o
// `$`. Un nombre sin delimitador, o que empieza con uno, no tiene prefijo.
export function tablePrefix(name: string): string | null {
    const m = /^[^_\-$]+[_\-$]/.exec(name)
    if (!m || m[0].length >= name.length) return null
    return m[0]
}

export type PrefixEntry<T> = {kind: 'group'; prefix: string; items: T[]} | {kind: 'item'; item: T}

// groupByPrefix arma la lista a dibujar: un grupo por prefijo que comparten al
// menos `min` tablas, y el resto sueltas en su lugar alfabético. Un "grupo"
// de una sola tabla sería un clic más para llegar a lo mismo.
export function groupByPrefix<T>(items: T[], nameOf: (t: T) => string, min = 2): PrefixEntry<T>[] {
    const byPrefix = new Map<string, T[]>()
    for (const it of items) {
        const p = tablePrefix(nameOf(it))
        if (!p) continue
        const key = p.toUpperCase()
        const list = byPrefix.get(key)
        if (list) list.push(it)
        else byPrefix.set(key, [it])
    }
    const out: PrefixEntry<T>[] = []
    const emitted = new Set<string>()
    for (const it of items) {
        const p = tablePrefix(nameOf(it))
        const key = p?.toUpperCase()
        const group = key ? byPrefix.get(key) : undefined
        if (key && group && group.length >= min) {
            if (!emitted.has(key)) {
                emitted.add(key)
                out.push({kind: 'group', prefix: p as string, items: group})
            }
            continue
        }
        out.push({kind: 'item', item: it})
    }
    return out
}

const PREF_KEY = 'mini-tools.schemaTree.groupByPrefix'

// Preferencia de la vista del árbol, por máquina. Es comodidad de interfaz,
// no un dato: si el almacenamiento no está disponible, simplemente no se
// recuerda.
export function loadGroupByPrefix(): boolean {
    try {
        return localStorage.getItem(PREF_KEY) === '1'
    } catch {
        return false
    }
}

export function saveGroupByPrefix(on: boolean) {
    try {
        localStorage.setItem(PREF_KEY, on ? '1' : '0')
    } catch {
        // sin almacenamiento: queda solo para esta sesión
    }
}
