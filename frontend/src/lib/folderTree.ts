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
