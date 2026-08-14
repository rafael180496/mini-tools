// Árbol de archivos a partir de una lista plana de rutas.
//
// El backend devuelve rutas planas a propósito (ver backend/git/files.go): el
// frontend ya arma árboles en otros dos lados —carpetas y ramas— y un tercer
// formato de árbol serializado sería una forma más que mantener en sincronía.
// Esto es la contraparte de esa decisión.
//
// Por qué importa: un repositorio real tiene miles de archivos. Una lista
// plana de 7.700 rutas no se navega, se sufre — hay que leer la ruta entera de
// cada fila para saber dónde está uno parado, y las rutas largas se cortan
// justo en la parte que las distingue.

export interface FileNode {
    name: string
    // path completo desde la raíz del repositorio. Para un directorio termina
    // en "/", lo que lo hace usable como clave de expansión sin ambigüedad
    // frente a un archivo del mismo nombre.
    path: string
    dir: boolean
    children: FileNode[]
}

// buildFileTree agrupa las rutas por carpeta.
//
// Los directorios quedan ordenados antes que los archivos y ambos
// alfabéticamente, que es el orden de cualquier explorador: mezclarlos hace
// que encontrar una carpeta dependa de dónde caiga por nombre.
export function buildFileTree(paths: string[]): FileNode[] {
    const root: FileNode = {name: '', path: '', dir: true, children: []}
    // Índice por ruta para no recorrer los hijos en cada segmento: con miles
    // de archivos, la búsqueda lineal por nivel es lo que vuelve lento esto.
    const index = new Map<string, FileNode>([['', root]])

    for (const path of paths) {
        const parts = path.split('/')
        let prefix = ''
        let parent = root

        for (let i = 0; i < parts.length; i++) {
            const isFile = i === parts.length - 1
            const name = parts[i]
            prefix += name + (isFile ? '' : '/')

            let node = index.get(prefix)
            if (!node) {
                node = {name, path: prefix, dir: !isFile, children: []}
                index.set(prefix, node)
                parent.children.push(node)
            }
            parent = node
        }
    }

    sortNodes(root.children)
    return root.children
}

function sortNodes(nodes: FileNode[]) {
    nodes.sort((a, b) => {
        if (a.dir !== b.dir) return a.dir ? -1 : 1
        return a.name.localeCompare(b.name, 'es')
    })
    for (const n of nodes) {
        if (n.children.length > 0) sortNodes(n.children)
    }
}

// Row es una fila ya lista para dibujar: el árbol aplanado según lo que esté
// expandido.
export interface FileRow {
    node: FileNode
    depth: number
}

// flatten recorre el árbol y devuelve SOLO lo visible.
//
// Se aplana acá y no se dibuja recursivamente para que la lista sea un array
// plano: es lo que permite recorrerla con el teclado y, si algún día hace
// falta, virtualizarla — un render recursivo no da ninguna de las dos cosas.
export function flatten(nodes: FileNode[], expanded: Set<string>, depth = 0): FileRow[] {
    const out: FileRow[] = []
    for (const node of nodes) {
        out.push({node, depth})
        if (node.dir && expanded.has(node.path)) {
            out.push(...flatten(node.children, expanded, depth + 1))
        }
    }
    return out
}

// ancestorsOf son las carpetas que hay que abrir para que una ruta se vea.
// Lo usa "revelar el archivo abierto": sin esto habría que abrirlas a mano.
export function ancestorsOf(path: string): string[] {
    const parts = path.split('/')
    const out: string[] = []
    let prefix = ''
    for (let i = 0; i < parts.length - 1; i++) {
        prefix += parts[i] + '/'
        out.push(prefix)
    }
    return out
}
