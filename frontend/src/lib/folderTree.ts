import type {vault} from '../../wailsjs/go/models'

export interface FolderNode {
    folder: vault.Folder
    children: FolderNode[]
}

// Groups the flat folder list (as returned by ListFolders — folders.parentId
// is "" for root) into a tree, sorted by sortOrder then name at every level.
// Pure/standalone, same style as likePattern.ts/connStringParser.ts.
export function buildFolderTree(folders: vault.Folder[]): FolderNode[] {
    const byParent = new Map<string, vault.Folder[]>()
    for (const f of folders) {
        const key = f.parentId ?? ''
        const siblings = byParent.get(key) ?? []
        siblings.push(f)
        byParent.set(key, siblings)
    }
    for (const siblings of byParent.values()) {
        siblings.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    }

    function build(parentId: string): FolderNode[] {
        const siblings = byParent.get(parentId) ?? []
        return siblings.map((folder) => ({folder, children: build(folder.id)}))
    }

    return build('')
}

// countConnectionsIn es cuántas conexiones cuelgan de una carpeta contando sus
// subcarpetas — el número que la fila de carpeta muestra plegada, que es lo que
// permite decidir si vale la pena abrirla sin abrirla.
//
// Recibe el predicado de coincidencia en vez de aplicarlo adentro para que sirva
// igual con y sin búsqueda activa: con un filtro puesto, el número pasa a ser
// cuántas COINCIDENCIAS hay adentro, que es lo que interesa en ese momento.
export function countConnectionsIn<T extends {folderId?: string}>(
    node: FolderNode,
    items: T[],
    matches: (item: T) => boolean,
): number {
    const own = items.filter((c) => c.folderId === node.folder.id && matches(c)).length
    return own + node.children.reduce((sum, child) => sum + countConnectionsIn(child, items, matches), 0)
}
