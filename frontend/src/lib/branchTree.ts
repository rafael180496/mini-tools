import type {git} from '../../wailsjs/go/models'

// Árbol de ramas agrupadas por los segmentos de su nombre.
//
// Los equipos que usan convenciones tipo `feature/TIGOCHAT-11607`,
// `fix/123/algo` o `release/2026-07` terminan con listas planas de cientos de
// ramas donde el prefijo se repite en cada línea y no aporta nada: en un
// repositorio real de esta app la lista de remotas tiene 364 entradas y la
// mitad del ancho de cada fila es la palabra "origin/agpr-". Agrupar por
// segmento convierte eso en unas pocas carpetas plegables y deja a la vista
// la parte del nombre que de verdad distingue una rama de otra.
//
// Es solo estructura: el árbol no reordena ni filtra, así que quien lo
// consume sigue decidiendo qué mostrar (ramas ancladas arriba, filtro de
// texto, etc.).

export interface BranchTreeNode {
    // Ruta completa de la carpeta, que además es su clave estable para el
    // estado de plegado ("feature", "origin/feature").
    path: string
    // Último(s) segmento(s) — lo único que se dibuja en la fila. Puede tener
    // barras cuando la carpeta viene compactada (ver compactación abajo).
    label: string
    folders: BranchTreeNode[]
    // Ramas que cuelgan directamente de esta carpeta, con el nombre completo
    // intacto: quien las dibuja necesita el nombre real para hacer checkout,
    // y el corto solo para mostrar.
    branches: git.Branch[]
}

// displayName es el nombre del que cuelga la agrupación. stripPrefix existe
// para la sección de remotos, donde el remoto ya es una fila propia y repetir
// "origin/" adentro sería una carpeta con un solo hijo en cada rama. Nunca
// reemplaza a branch.name: el checkout siempre usa el nombre real.
function displayName(branch: git.Branch, stripPrefix: string): string {
    if (stripPrefix && branch.name.startsWith(`${stripPrefix}/`)) {
        return branch.name.slice(stripPrefix.length + 1)
    }
    return branch.name
}

// leafLabel es lo que se muestra en la fila de una rama dentro del árbol: el
// nombre sin el prefijo de su carpeta. `feature/TIGOCHAT-11607` bajo la
// carpeta `feature` se dibuja como `TIGOCHAT-11607`.
export function leafLabel(branch: git.Branch, folderPath: string, stripPrefix = ''): string {
    const name = displayName(branch, stripPrefix)
    if (!folderPath) return name
    return name.startsWith(`${folderPath}/`) ? name.slice(folderPath.length + 1) : name
}

// buildBranchTree agrupa por segmentos separados por "/". El último segmento
// es siempre la rama, nunca una carpeta — `feature/a` y `feature/a/b` pueden
// coexistir en git (no, en realidad no pueden: git rechaza crear `feature/a/b`
// si existe `feature/a`), pero si el caso llegara igual desde un repositorio
// raro, la rama gana y la carpeta homónima se ignora, en vez de perder la
// rama de la lista.
export function buildBranchTree(branches: git.Branch[], stripPrefix = ''): BranchTreeNode {
    const root: BranchTreeNode = {path: '', label: '', folders: [], branches: []}

    for (const branch of branches) {
        const parts = displayName(branch, stripPrefix).split('/')
        let node = root
        // Todos los segmentos menos el último son carpetas.
        for (let i = 0; i < parts.length - 1; i++) {
            const path = parts.slice(0, i + 1).join('/')
            let next = node.folders.find((f) => f.path === path)
            if (!next) {
                next = {path, label: parts[i], folders: [], branches: []}
                node.folders.push(next)
            }
            node = next
        }
        node.branches.push(branch)
    }

    return compact(root)
}

// compact fusiona una carpeta que solo contiene otra carpeta en una sola fila
// ("agpr" → "agpr/2026"), como hace el explorador de VS Code. Sin esto, una
// convención de nombres con tres niveles produce dos filas que no se pueden
// plegar por separado de forma útil y solo consumen indentación.
//
// La raíz nunca se compacta: es el contenedor de la sección, no una fila.
function compact(node: BranchTreeNode): BranchTreeNode {
    node.folders = node.folders.map(compact)

    if (node.path !== '' && node.branches.length === 0 && node.folders.length === 1) {
        const only = node.folders[0]
        return {
            path: only.path,
            label: `${node.label}/${only.label}`,
            folders: only.folders,
            branches: only.branches,
        }
    }
    return node
}

// countBranches es cuántas ramas hay en toda la rama del árbol, para el
// contador de la fila de carpeta — sin él, plegar una carpeta esconde cuántas
// cosas hay adentro, que es justo lo que uno necesita saber para decidir si
// abrirla.
export function countBranches(node: BranchTreeNode): number {
    return node.branches.length + node.folders.reduce((sum, f) => sum + countBranches(f), 0)
}

// expandedForBranch devuelve las rutas de carpeta que hay que abrir para que
// `branchName` quede a la vista — se usa para que la rama actual no aparezca
// escondida dentro de una carpeta plegada al abrir la pestaña.
//
// Toma las rutas del árbol YA construido en vez de partir el nombre a mano,
// porque la compactación cambia qué rutas existen realmente: con `agpr` y
// `agpr/2026` fusionadas, la ruta a abrir es `agpr/2026` y `agpr` sola no
// existe como fila.
export function expandedForBranch(node: BranchTreeNode, branchName: string): string[] {
    for (const folder of node.folders) {
        if (branchName === folder.path || branchName.startsWith(`${folder.path}/`)) {
            return [folder.path, ...expandedForBranch(folder, branchName)]
        }
    }
    return []
}
