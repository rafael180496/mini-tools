import {useCallback, useEffect, useMemo, useState, type ReactNode} from 'react'
import {CreateNote, CreateNoteInFolder, DeleteNote, NotesGraph, SearchNotesSmart, SetNoteFolder} from '../../../wailsjs/go/main/App'
import {vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import SidebarSection from '../sidebar/SidebarSection'
import MoveToFolderMenu from '../sidebar/MoveToFolderMenu'
import ConfirmDialog from '../ConfirmDialog'
import FolderNotesDialog from './FolderNotesDialog'
import PromptDialog from '../git/PromptDialog'
import {buildFolderTree, type FolderNode} from '../../lib/folderTree'
import {buildNoteLinkTree, childrenIndex, type NoteTreeRow} from '../../lib/noteLinkTree'

// Módulo "Notas" del sidebar: el buscador y la lista de la base de
// conocimiento.
//
// Es un módulo hermano de Conexiones y de SSH, y no una pantalla aparte, por
// una razón concreta: buscar en la documentación propia pasa MIENTRAS se está
// haciendo otra cosa —depurando una consulta, mirando un log— y mandar al
// usuario a otra pantalla para eso rompe justo lo que vino a hacer.

interface Props {
    // Nota abierta, para marcarla en la lista.
    activeNoteId: string | null
    onOpenNote: (id: string) => void
    // Búsqueda global de la barra, dibujada por el marco (Sidebar.tsx). Acá
    // no es solo un filtro: alimenta SearchNotesSmart, que busca en títulos y
    // cuerpos, y además es el título que se propone al crear una nota o una
    // carpeta desde el buscador. Por eso el módulo también necesita poder
    // limpiarla: cuando el texto se convierte en el nombre de algo, dejarlo
    // puesto escondería justamente lo que se acaba de crear.
    filter: string
    onClearFilter: () => void
    // Cuántos elementos coinciden con la búsqueda global. Se informa hacia
    // arriba porque el contador vive en el menú master (SidebarMasterMenu):
    // con un módulo a la vez, es lo único que dice que lo que se busca está
    // en otro módulo y no perdido.
    onMatchCount: (n: number | null) => void
    // Se dispara al crear una nota, para que el workspace la abra.
    onCreated: (id: string) => void
    // Token que fuerza recargar la lista desde afuera (al guardar una nota).
    reloadToken: number
    onOpenGraph: () => void
    // Carpetas del scope 'note'. Reusan la misma tabla y el mismo CRUD que las
    // de conexiones, SSH y repositorios — cada módulo tiene su propio árbol.
    folders: vault.Folder[]
    onCreateFolder: (name: string, parentId: string) => void
    onRenameFolder: (id: string, name: string) => void
    onDeleteFolder: (id: string) => void
    onChanged: () => void
}

// flatten aplana el árbol para el menú "mover a carpeta", que necesita la
// lista con su profundidad para sangrar las opciones.
function flatten(nodes: FolderNode[], depth = 0): {folder: vault.Folder; depth: number}[] {
    const out: {folder: vault.Folder; depth: number}[] = []
    for (const n of nodes) {
        out.push({folder: n.folder, depth})
        out.push(...flatten(n.children, depth + 1))
    }
    return out
}

export default function NotesTree({
    activeNoteId,
    onOpenNote,
    filter,
    onClearFilter,
    onMatchCount,
    onCreated,
    reloadToken,
    onOpenGraph,
    folders,
    onCreateFolder,
    onRenameFolder,
    onDeleteFolder,
    onChanged,
}: Props) {
    const query = filter
    const [hits, setHits] = useState<vault.NoteHit[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')
    const [showHelp, setShowHelp] = useState(false)
    // Nota que se está por borrar. Con confirmación: borrar una nota no se
    // deshace, y las que la enlazaban van a quedar con el enlace roto.
    const [deleting, setDeleting] = useState<vault.NoteHit | null>(null)
    // Carpeta que se está renombrando. Con el diálogo de la app y no un
    // window.prompt: un diálogo nativo dentro del webview no se percibe como
    // un diálogo (ver .claude/rules/conventions.md).
    const [renamingFolder, setRenamingFolder] = useState<vault.Folder | null>(null)
    // Carpeta abierta en la vista de tabla: el clic en el NOMBRE la abre, el
    // chevron sigue plegando. Es lo que hace cualquier explorador de archivos.
    const [openedFolder, setOpenedFolder] = useState<vault.Folder | null>(null)

    // Con retardo: cada búsqueda descifra las notas en memoria (ver
    // backend/vault/notesearch.go), así que buscar por pulsación las
    // descifraría todas por cada letra.
    useEffect(() => {
        let cancelled = false
        const t = setTimeout(() => {
            setLoading(true)
            // Sin búsqueda se piden TODAS (hasta 500): la lista está agrupada
            // por carpeta y ordenada alfabéticamente, así que un tope de 60
            // dejaría carpetas enteras vacías por empezar con una letra tarde.
            // Buscando alcanza con 60: ahí manda la relevancia y lo que
            // importa son los primeros resultados.
            SearchNotesSmart(query, query.trim() ? 60 : 500)
                .then((h) => !cancelled && setHits(h ?? []))
                .catch((e) => !cancelled && setError(String(e)))
                .finally(() => !cancelled && setLoading(false))
        }, query ? 180 : 0)
        return () => {
            cancelled = true
            clearTimeout(t)
        }
    }, [query, reloadToken])

    const createNote = useCallback(() => {
        // El título sale de lo que se venía buscando: quien busca "Runbook
        // SGC", no lo encuentra y aprieta "+", quiere crear justamente esa.
        const title = query.trim() || 'Nota sin título'
        CreateNote(title, '')
            .then((id) => {
                // Limpiar la búsqueda es parte de crear: el texto acaba de
                // convertirse en el título de la nota nueva, y dejarlo puesto
                // la escondería detrás del filtro que lo nombró.
                onClearFilter()
                onCreated(id)
            })
            .catch((e) => setError(String(e)))
    }, [query, onCreated, onClearFilter])

    const searching = query.trim().length > 0

    const matchCount = searching ? hits.length : null
    useEffect(() => {
        onMatchCount(matchCount)
    }, [matchCount, onMatchCount])

    // Aristas del grafo, para colgar cada nota de la que la enlaza. Se piden
    // todas juntas y no por nota: el árbol necesita el conjunto para saber
    // quién es raíz, y pedirlas de a una serían N llamadas por dibujo.
    const [edges, setEdges] = useState<vault.NoteGraphEdge[]>([])
    useEffect(() => {
        let cancelled = false
        NotesGraph()
            .then((g) => !cancelled && setEdges(g.edges ?? []))
            .catch(() => !cancelled && setEdges([]))
        return () => {
            cancelled = true
        }
    }, [reloadToken])

    const children = useMemo(() => childrenIndex(edges), [edges])

    // Ramas plegadas, por camino. Se guarda lo PLEGADO y no lo abierto porque
    // el árbol nace desplegado: la estructura es justamente lo que se quiere
    // ver de un vistazo.
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
    const toggleBranch = (path: string) =>
        setCollapsed((prev) => {
            const next = new Set(prev)
            if (next.has(path)) next.delete(path)
            else next.add(path)
            return next
        })

    // Buscando NO se anida: una coincidencia escondida debajo de una nota que
    // no coincide es un resultado que no se ve, justo lo contrario de lo que
    // se pidió al buscar.
    const rowsFor = useCallback(
        (notes: vault.NoteHit[], depth: number): NoteTreeRow[] =>
            searching
                ? notes.map((h) => ({hit: h, depth, path: h.id, children: 0}))
                : buildNoteLinkTree(notes, children, (p) => collapsed.has(p), depth),
        [searching, children, collapsed],
    )

    // Árbol de carpetas del módulo. Se construye con el mismo helper que los
    // otros tres módulos: un árbol propio por scope, nunca mezclado.
    const noteFolders = useMemo(() => folders.filter((f) => f.scope === 'note'), [folders])
    const tree = useMemo(() => buildFolderTree(noteFolders), [noteFolders])
    const flatFolders = useMemo(() => flatten(tree), [tree])
    const [openFolders, setOpenFolders] = useState<Set<string>>(new Set())

    // Notas por carpeta. Las que quedaron en una carpeta borrada caen a la
    // raíz: es un estado entendible, y mejor que esconderlas.
    const byFolder = useMemo(() => {
        const known = new Set(noteFolders.map((f) => f.id))
        const map: Record<string, vault.NoteHit[]> = {}
        for (const h of hits) {
            const k = h.folderId && known.has(h.folderId) ? h.folderId : ''
            ;(map[k] ??= []).push(h)
        }
        return map
    }, [hits, noteFolders])

    // Buscando, las carpetas se abren solas: esconder un resultado detrás de
    // una carpeta plegada es el peor momento para pedir un clic más.
    const foldersOpen = (id: string) => searching || openFolders.has(id)

    const toggleFolder = (id: string) =>
        setOpenFolders((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })

    // Crea una nota YA adentro de la carpeta, en una sola llamada: crear y
    // después mover la dibujaría un instante en la raíz.
    const createNoteIn = (folderId: string) => {
        const title = query.trim() || 'Nota sin título'
        void CreateNoteInFolder(title, folderId)
            .then((id) => {
                onClearFilter()
                setOpenFolders((prev) => new Set([...prev, folderId]))
                onCreated(id)
            })
            .catch((e) => setError(String(e)))
    }

    // Ids de las subcarpetas de una carpeta, para que su tabla pueda contar la
    // rama entera y no solo el primer nivel.
    const descendantsOf = useCallback(
        (id: string): string[] => {
            const out: string[] = []
            const walk = (parent: string) => {
                for (const f of noteFolders) {
                    if (f.parentId === parent) {
                        out.push(f.id)
                        walk(f.id)
                    }
                }
            }
            walk(id)
            return out
        },
        [noteFolders],
    )

    const moveNote = (noteId: string, folderId: string) => {
        void SetNoteFolder(noteId, folderId)
            .then(onChanged)
            .catch((e) => setError(String(e)))
    }

    return (
        <SidebarSection
            title="Notas"
            count={searching ? `${hits.length} ${hits.length === 1 ? 'resultado' : 'resultados'}` : hits.length ? String(hits.length) : null}
            actions={
                <>
                <button
                    onClick={() => {
                        const name = query.trim() || 'Nueva carpeta'
                        onClearFilter()
                        onCreateFolder(name, '')
                    }}
                    title="Crea una carpeta en la raíz. Si hay algo escrito en el buscador, lo usa como nombre."
                    className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="create_new_folder" size={16} />
                </button>
                <button
                    onClick={onOpenGraph}
                    title="Abre el grafo de conocimiento: qué notas hay y cuáles enlazan a cuáles. Las privadas también aparecen — el candado es contra los agentes, no contra vos."
                    className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="hub" size={16} />
                </button>
                <button
                    onClick={createNote}
                    title={
                        searching
                            ? `Crea una nota titulada «${query.trim()}» — el título es lo que la hace enlazable con [[…]]`
                            : 'Crea una nota nueva. Nace VISIBLE para los agentes; el candado de su barra la esconde cuando haga falta.'
                    }
                    className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="note_add" size={16} />
                </button>
                </>
            }
        >
            {/* La caja de búsqueda vive arriba, en el marco de la barra, y es
                la misma para los cuatro módulos. Lo que NO se puede mover
                allá es esto: la sintaxis de búsqueda de las notas
                (tag:, enlaza:, privado:) es propia de este módulo, y un
                signo de pregunta en el buscador global prometería que sirve
                también para conexiones y repositorios, donde no significa
                nada. */}
            <div className="flex items-center justify-end px-2 pb-1">
                <button
                    onClick={() => setShowHelp((v) => !v)}
                    title={showHelp ? 'Ocultar la ayuda de búsqueda' : 'Qué más se puede escribir en el buscador para filtrar notas: etiquetas, frases exactas, enlaces entre notas'}
                    className={`flex items-center gap-1 rounded px-1 text-[10px] ${showHelp ? 'text-primary' : 'text-on-surface-variant hover:text-on-surface'}`}
                >
                    <Icon name="help" size={12} />
                    Sintaxis de búsqueda
                </button>
            </div>
            <div className="px-2">
                {showHelp && (
                    <div className="rounded border border-outline-variant bg-surface-container-low p-1.5 text-[10px] leading-4 text-on-surface-variant">
                        <p>
                            <span className="font-mono text-on-surface">oracle tablespace</span> — las dos palabras,
                            en cualquier orden
                        </p>
                        <p>
                            <span className="font-mono text-on-surface">"plan de contingencia"</span> — frase exacta
                        </p>
                        <p>
                            <span className="font-mono text-on-surface">tag:produccion</span> — por etiqueta del
                            frontmatter
                        </p>
                        <p>
                            <span className="font-mono text-on-surface">enlaza:Runbook SGC</span> — las que apuntan a
                            esa nota
                        </p>
                        <p>
                            <span className="font-mono text-on-surface">privado:no</span> — solo las que un agente
                            puede leer
                        </p>
                    </div>
                )}
            </div>

            {error && <p className="px-2 pb-1 text-[10px] text-error">{error}</p>}

            <div className="min-h-0 flex-1 overflow-y-auto">
                {hits.length === 0 && !loading && (
                    <p className="px-2 py-2 text-[11px] text-on-surface-variant">
                        {searching ? (
                            <>
                                Sin resultados para <span className="text-on-surface">{query}</span>. El botón{' '}
                                <Icon name="note_add" size={11} className="inline align-text-bottom" /> crea una nota con
                                ese título.
                            </>
                        ) : (
                            'Todavía no hay notas. Acá va tu documentación: runbooks, procedimientos, lo que hoy vive en un archivo suelto.'
                        )}
                    </p>
                )}

                {/* Carpetas primero y después las notas sueltas, que es el
                    orden de cualquier explorador de archivos. */}
                {tree.map((node) => (
                    <FolderRow
                        key={node.folder.id}
                        node={node}
                        depth={0}
                        byFolder={byFolder}
                        isOpen={foldersOpen}
                        onToggle={toggleFolder}
                        onCreateFolder={onCreateFolder}
                        onCreateNote={createNoteIn}
                        onOpenFolder={setOpenedFolder}
                        onRenameFolder={setRenamingFolder}
                        onDeleteFolder={onDeleteFolder}
                        renderNotes={(notes, depth) =>
                            rowsFor(notes, depth).map((row) => (
                                <NoteRow
                                    key={row.path}
                                    row={row}
                                    active={activeNoteId === row.hit.id}
                                    collapsed={collapsed.has(row.path)}
                                    onToggleBranch={toggleBranch}
                                    flatFolders={flatFolders}
                                    onOpen={onOpenNote}
                                    onMove={moveNote}
                                    onDelete={setDeleting}
                                />
                            ))
                        }
                    />
                ))}

                {rowsFor(byFolder[''] ?? [], 0).map((row) => (
                    <NoteRow
                        key={row.path}
                        row={row}
                        active={activeNoteId === row.hit.id}
                        collapsed={collapsed.has(row.path)}
                        onToggleBranch={toggleBranch}
                        flatFolders={flatFolders}
                        onOpen={onOpenNote}
                        onMove={moveNote}
                        onDelete={setDeleting}
                    />
                ))}
            </div>

            {deleting && (
                <ConfirmDialog
                    title="Borrar la nota"
                    description={`«${deleting.title || 'Sin título'}» se borra del vault, con sus imágenes. Las notas que la enlazaban van a mostrar el enlace como roto, con la opción de volver a crearla. Esto no se puede deshacer.`}
                    confirmLabel="Borrar"
                    danger
                    onConfirm={() => {
                        void DeleteNote(deleting.id)
                            .then(onChanged)
                            .catch((e) => setError(String(e)))
                    }}
                    onClose={() => setDeleting(null)}
                />
            )}

            {openedFolder && (
                <FolderNotesDialog
                    folder={openedFolder}
                    descendantIds={descendantsOf(openedFolder.id)}
                    activeNoteId={activeNoteId}
                    onOpenNote={onOpenNote}
                    onChanged={onChanged}
                    onClose={() => setOpenedFolder(null)}
                />
            )}

            {renamingFolder && (
                <PromptDialog
                    title="Cambiar el nombre de la carpeta"
                    label="Nombre"
                    initial={renamingFolder.name}
                    confirmLabel="Guardar"
                    onSubmit={(value) => {
                        const id = renamingFolder.id
                        setRenamingFolder(null)
                        if (value.trim()) onRenameFolder(id, value.trim())
                    }}
                    onClose={() => setRenamingFolder(null)}
                />
            )}
        </SidebarSection>
    )
}

// FolderRow es una carpeta y lo que tiene adentro.
function FolderRow({
    node,
    depth,
    byFolder,
    isOpen,
    onToggle,
    onCreateFolder,
    onCreateNote,
    onOpenFolder,
    onRenameFolder,
    onDeleteFolder,
    renderNotes,
}: {
    node: FolderNode
    depth: number
    byFolder: Record<string, vault.NoteHit[]>
    isOpen: (id: string) => boolean
    onToggle: (id: string) => void
    onCreateFolder: (name: string, parentId: string) => void
    onCreateNote: (folderId: string) => void
    onOpenFolder: (folder: vault.Folder) => void
    onRenameFolder: (folder: vault.Folder) => void
    onDeleteFolder: (id: string) => void
    // Recibe TODAS las notas de la carpeta y no una por una: el anidado por
    // enlaces necesita el conjunto para saber cuáles son raíz.
    renderNotes: (notes: vault.NoteHit[], depth: number) => ReactNode
}) {
    const notes = byFolder[node.folder.id] ?? []
    const open = isOpen(node.folder.id)
    // El contador incluye las subcarpetas: una carpeta plegada que dice "0"
    // cuando adentro hay doce notas en subcarpetas miente.
    const total = countIn(node, byFolder)

    return (
        <div>
            {/* Solo el chevron y el nombre. El ícono de carpeta al lado del
                chevron es información repetida —el chevron ya dice que se
                despliega— y en una barra angosta cada ícono de más come ancho
                del nombre, que es lo único que hay que leer. El contador
                aparece al pasar por encima. */}
            <div
                className="group mx-1 flex items-center gap-1 rounded py-[3px] pr-1 text-[12px] hover:bg-surface-variant"
                style={{paddingLeft: `${depth * 12 + 4}px`}}
            >
                <button
                    onClick={() => onToggle(node.folder.id)}
                    title={open ? 'Plegar la carpeta' : `Desplegar la carpeta (${total} ${total === 1 ? 'nota' : 'notas'})`}
                    className="shrink-0 rounded text-on-surface-variant/70 hover:text-on-surface"
                >
                    <Icon name={open ? 'expand_more' : 'chevron_right'} size={13} />
                </button>
                {/* El NOMBRE abre la carpeta en una tabla; la flecha la
                    despliega en el árbol. Es la separación de cualquier
                    explorador de archivos, y es lo que permite revisar una
                    carpeta —fechas, cuántas hay, buscar adentro— sin perder el
                    plegado que sirve para navegar. */}
                <button
                    onClick={() => onOpenFolder(node.folder)}
                    title={`Abre «${node.folder.name}» en una tabla: sus notas con fecha de creación y de última modificación, y un buscador propio. La flecha de la izquierda solo despliega.`}
                    className="flex min-w-0 flex-1 items-center gap-1 text-left"
                >
                    <span className="min-w-0 truncate text-on-surface">{node.folder.name}</span>
                    <span className="shrink-0 text-[10px] text-on-surface-variant/50 group-hover:hidden">{total}</span>
                </button>

                <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                    <button
                        onClick={() => onCreateNote(node.folder.id)}
                        title="Crea una nota adentro de esta carpeta. Si hay algo escrito en el buscador, lo usa como título."
                        className="rounded p-0.5 text-on-surface-variant hover:text-on-surface"
                    >
                        <Icon name="note_add" size={12} />
                    </button>
                    <button
                        onClick={() => onCreateFolder('Nueva carpeta', node.folder.id)}
                        title="Crea una subcarpeta acá adentro"
                        className="rounded p-0.5 text-on-surface-variant hover:text-on-surface"
                    >
                        <Icon name="create_new_folder" size={12} />
                    </button>
                    <button
                        onClick={() => onRenameFolder(node.folder)}
                        title="Renombrar la carpeta"
                        className="rounded p-0.5 text-on-surface-variant hover:text-on-surface"
                    >
                        <Icon name="edit" size={12} />
                    </button>
                    <button
                        onClick={() => onDeleteFolder(node.folder.id)}
                        title="Borra la carpeta. Las notas que tenía NO se borran: quedan en la raíz."
                        className="rounded p-0.5 text-on-surface-variant hover:text-on-error-container"
                    >
                        <Icon name="delete" size={12} />
                    </button>
                </span>
            </div>

            {open && (
                <>
                    {node.children.map((child) => (
                        <FolderRow
                            key={child.folder.id}
                            node={child}
                            depth={depth + 1}
                            byFolder={byFolder}
                            isOpen={isOpen}
                            onToggle={onToggle}
                            onCreateFolder={onCreateFolder}
                            onCreateNote={onCreateNote}
                            onOpenFolder={onOpenFolder}
                            onRenameFolder={onRenameFolder}
                            onDeleteFolder={onDeleteFolder}
                            renderNotes={renderNotes}
                        />
                    ))}
                    {renderNotes(notes, depth + 1)}
                </>
            )}
        </div>
    )
}

function countIn(node: FolderNode, byFolder: Record<string, vault.NoteHit[]>): number {
    let n = (byFolder[node.folder.id] ?? []).length
    for (const c of node.children) n += countIn(c, byFolder)
    return n
}

// NoteRow es una nota en el árbol.
function NoteRow({
    row,
    active,
    collapsed,
    onToggleBranch,
    flatFolders,
    onOpen,
    onMove,
    onDelete,
}: {
    row: NoteTreeRow
    active: boolean
    collapsed: boolean
    onToggleBranch: (path: string) => void
    flatFolders: {folder: vault.Folder; depth: number}[]
    onOpen: (id: string) => void
    onMove: (noteId: string, folderId: string) => void
    onDelete: (hit: vault.NoteHit) => void
}) {
    const {hit, depth} = row
    return (
        // La nota activa se marca con un fondo redondeado, no con una barra al
        // costado: en una lista de treinta títulos la barra se pierde y el
        // fondo se ve de un vistazo. Y sin ícono de documento — todas son
        // documentos, así que el ícono no distingue nada y solo come ancho del
        // título, que es lo único que hay que leer.
        <div
            className={`group mx-1 flex flex-col rounded pr-1 ${
                active ? 'bg-surface-variant' : 'hover:bg-surface-container-high'
            }`}
            style={{paddingLeft: `${depth * 12 + 4}px`}}
        >
            <div className="flex items-center gap-1.5 py-[3px]">
                {/* El chevron solo si de esta nota cuelga algo. Las hojas
                    llevan un hueco del mismo ancho para que los títulos del
                    mismo nivel queden alineados. */}
                {row.children > 0 ? (
                    <button
                        onClick={() => onToggleBranch(row.path)}
                        title={
                            collapsed
                                ? `Mostrar las ${row.children} notas que esta enlaza`
                                : 'Plegar las notas que esta enlaza'
                        }
                        className="shrink-0 rounded text-on-surface-variant/70 hover:text-on-surface"
                    >
                        <Icon name={collapsed ? 'chevron_right' : 'expand_more'} size={13} />
                    </button>
                ) : (
                    <span className="w-[13px] shrink-0" />
                )}
                <button
                    onClick={() => onOpen(hit.id)}
                    title={
                        hit.isPrivate
                            ? `${hit.title} — privada: ningún agente puede leerla`
                            : `${hit.title} — visible para los agentes`
                    }
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                >
                    {/* El candado SÍ se queda: es la única señal de un vistazo
                        de qué puede leer un agente, y solo aparece cuando hay
                        algo que decir. */}
                    {hit.isPrivate && (
                        <Icon name="lock" size={11} className="shrink-0 text-on-surface-variant/60" />
                    )}
                    <span
                        className={`min-w-0 truncate text-[12px] ${
                            active ? 'text-on-surface' : 'text-on-surface/90'
                        } ${hit.matchedTitle ? 'font-medium' : ''}`}
                    >
                        {hit.title || 'Sin título'}
                    </span>
                </button>
                <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                    <MoveToFolderMenu connId={hit.id} flatFolders={flatFolders} onMove={onMove} />
                    <button
                        onClick={() => onDelete(hit)}
                        title="Borra esta nota y sus imágenes. Las notas que la enlazaban van a mostrar el enlace como roto — no se borran en silencio."
                        className="rounded p-0.5 text-on-surface-variant hover:bg-error-container hover:text-on-error-container"
                    >
                        <Icon name="delete" size={12} />
                    </button>
                </span>
            </div>

            {/* El fragmento es lo que evita abrir cinco notas para ver cuál
                era. El resaltado viene marcado con «…» desde el backend y se
                parte acá — nunca se inyecta HTML. */}
            {hit.snippet && (
                <span className="line-clamp-2 pb-1 text-[10px] leading-4 text-on-surface-variant">
                    {hit.snippet.split(/«|»/).map((part, i) =>
                        i % 2 === 1 ? (
                            <mark key={i} className="rounded bg-primary/25 text-on-surface">
                                {part}
                            </mark>
                        ) : (
                            <span key={i}>{part}</span>
                        ),
                    )}
                </span>
            )}
        </div>
    )
}
