import type {vault} from '../../wailsjs/go/models'

// El árbol de notas se arma con los ENLACES, no solo con las carpetas.
//
// **Por qué.** Una base de conocimiento al estilo Obsidian se organiza sola:
// una nota índice enlaza sus procedimientos, cada procedimiento enlaza sus
// pasos. Esa estructura ya está escrita en el texto —es el `[[…]]`— y mostrar
// la lista plana la tira a la basura: el usuario ve treinta títulos en fila y
// tiene que recordar cuál cuelga de cuál. Las carpetas siguen siendo la
// organización explícita; adentro de cada una, los enlaces dan la jerarquía.
//
// **Reglas del armado**, todas por el mismo motivo —que ninguna nota
// desaparezca de la lista, que es el peor error posible en un árbol:
//
//   - El anidado es **dentro del mismo contenedor**. Una nota enlazada que
//     vive en otra carpeta no se muda acá: sigue estando donde el usuario la
//     puso, y duplicarla en dos ramas haría creer que hay dos notas.
//   - Raíces = las que **nadie del contenedor enlaza**. Si una nota es hija de
//     otra, no se repite arriba.
//   - Los **ciclos** (A enlaza a B y B a A) se cortan por el camino: una nota
//     no se dibuja adentro de sí misma. Y si un ciclo se quedó sin raíz —todas
//     tienen quien las enlace— se lo saca a la superficie igual, que es
//     preferible a que el grupo entero se vuelva invisible.
//   - Una nota enlazada desde dos lugares aparece en los dos. No es un error:
//     es lo que dice el texto, y esconder una de las dos ramas mentiría sobre
//     la estructura.

export interface NoteTreeRow {
    hit: vault.NoteHit
    depth: number
    // Camino único hasta esta fila (`idPadre/idHijo`). Es la clave de React y
    // la del estado de plegado: la misma nota colgando de dos padres son dos
    // filas distintas y se pliegan por separado.
    path: string
    // Cuántas notas cuelgan de esta. 0 = hoja, y no se dibuja el chevron.
    children: number
}

// childrenIndex arma padre → hijos a partir de las aristas del grafo.
export function childrenIndex(edges: vault.NoteGraphEdge[]): Map<string, string[]> {
    const map = new Map<string, string[]>()
    for (const e of edges) {
        if (e.source === e.target) continue
        const list = map.get(e.source)
        if (!list) map.set(e.source, [e.target])
        else if (!list.includes(e.target)) list.push(e.target)
    }
    return map
}

// buildNoteLinkTree aplana el árbol de un contenedor a filas listas para
// dibujar. `isCollapsed` decide qué ramas no se recorren.
export function buildNoteLinkTree(
    notes: vault.NoteHit[],
    children: Map<string, string[]>,
    isCollapsed: (path: string) => boolean,
    baseDepth = 0,
): NoteTreeRow[] {
    const byId = new Map(notes.map((n) => [n.id, n]))
    // Solo cuentan los enlaces cuyo destino está en ESTE contenedor.
    const kidsOf = (id: string) => (children.get(id) ?? []).filter((c) => byId.has(c) && c !== id)

    const linked = new Set<string>()
    for (const n of notes) for (const c of kidsOf(n.id)) linked.add(c)

    const rows: NoteTreeRow[] = []
    const drawn = new Set<string>()

    const walk = (id: string, depth: number, parentPath: string, ancestors: Set<string>) => {
        const hit = byId.get(id)
        if (!hit) return
        const path = parentPath ? `${parentPath}/${id}` : id
        // Un ciclo se corta acá: la nota se dibuja, pero sin volver a bajar por
        // una rama que ya la contiene.
        const kids = ancestors.has(id) ? [] : kidsOf(id)
        rows.push({hit, depth, path, children: kids.length})
        drawn.add(id)
        if (!kids.length || isCollapsed(path)) return
        const next = new Set(ancestors)
        next.add(id)
        for (const k of kids) walk(k, depth + 1, path, next)
    }

    for (const n of notes) if (!linked.has(n.id)) walk(n.id, baseDepth, '', new Set())
    // Ciclos sin raíz: si quedó alguna sin dibujar, se la sube a la superficie.
    // Nunca desaparece una nota de la lista.
    for (const n of notes) if (!drawn.has(n.id)) walk(n.id, baseDepth, '', new Set())

    return rows
}
