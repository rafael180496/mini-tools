import {useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactNode} from 'react'
import {
    CreateNote,
    CreateNoteInFolder,
    DeleteNote,
    DuplicateNote,
    ExportNoteMarkdown,
    MergeNotes,
    NotesGraph,
    RenameNote,
    SearchNotesSmart,
    SetNoteFolder,
    SetNotePinned,
    SetNotePrivacy,
} from '../../../wailsjs/go/main/App'
import {vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import SidebarSection from '../sidebar/SidebarSection'
import TreeRow, {TREE_FOLDER_ICON} from '../sidebar/TreeRow'
import {MenuButton, moveToFolderSubmenu, useTreeMenu, type TreeMenuEntry} from '../sidebar/TreeMenu'
import ConfirmDialog from '../ConfirmDialog'
import FolderNotesDialog from './FolderNotesDialog'
import MergeNoteDialog from './MergeNoteDialog'
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
    const [renamingNote, setRenamingNote] = useState<vault.NoteHit | null>(null)
    // Volver visible una nota privada se confirma: es el único gesto de la
    // barra que cambia lo que un agente puede leer.
    const [publishing, setPublishing] = useState<vault.NoteHit | null>(null)
    const [merging, setMerging] = useState<vault.NoteHit | null>(null)
    // Aviso breve de algo que salió bien y no se ve solo (una exportación).
    const [notice, setNotice] = useState('')
    useEffect(() => {
        if (!notice) return
        const t = setTimeout(() => setNotice(''), 4000)
        return () => clearTimeout(t)
    }, [notice])
    const menu = useTreeMenu()

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
    const pinnedHits = useMemo(() => hits.filter((h) => h.pinned), [hits])

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

    const expandAll = () => {
        setOpenFolders(new Set(noteFolders.map((f) => f.id)))
        setCollapsed(new Set())
    }
    const collapseAll = () => setOpenFolders(new Set())

    const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {})

    // Ubicación de una nota como "Carpeta / Subcarpeta / Título": es el «Print
    // file path» de Obsidian. Las notas no son archivos (viven cifradas en el
    // vault), así que la ruta útil es la del árbol.
    const locationOf = (hit: vault.NoteHit) => {
        const byId = new Map(noteFolders.map((f) => [f.id, f]))
        const parts: string[] = []
        let f = hit.folderId ? byId.get(hit.folderId) : undefined
        while (f && parts.length < 50) {
            parts.unshift(f.name)
            f = f.parentId ? byId.get(f.parentId) : undefined
        }
        return [...parts, hit.title || 'Sin título'].join(' / ')
    }

    const noteMenu = (e: ReactMouseEvent, hit: vault.NoteHit) => {
        const title = hit.title || 'Sin título'
        const items: TreeMenuEntry[] = [
            {label: 'Abrir en una pestaña', icon: 'open_in_new', hint: 'clic', onSelect: () => onOpenNote(hit.id)},
            {
                label: hit.pinned ? 'Quitar de fijadas' : 'Fijar arriba',
                icon: hit.pinned ? 'keep_off' : 'keep',
                title: 'Las fijadas aparecen primero en la barra, en su propia sección',
                onSelect: () =>
                    void SetNotePinned(hit.id, !hit.pinned)
                        .then(onChanged)
                        .catch((err) => setError(String(err))),
            },
            'separator',
            {label: 'Cambiar nombre', icon: 'edit', onSelect: () => setRenamingNote(hit)},
            {
                label: 'Duplicar',
                icon: 'content_copy',
                title: 'Copia la nota con sus etiquetas, carpeta, privacidad e imágenes',
                onSelect: () =>
                    void DuplicateNote(hit.id)
                        .then((id) => {
                            onChanged()
                            onCreated(id)
                        })
                        .catch((err) => setError(String(err))),
            },
            {label: 'Mover a…', icon: 'drive_file_move', submenu: moveToFolderSubmenu(flatFolders, hit.folderId ?? '', (f) => moveNote(hit.id, f))},
            {
                label: 'Fundir con otra nota…',
                icon: 'call_merge',
                title: 'Agrega su texto al final de otra nota y la borra',
                onSelect: () => setMerging(hit),
            },
            'separator',
            {label: 'Copiar enlace', icon: 'link', hint: '[[…]]', title: `Copia [[${title}]] para pegarlo en otra nota`, onSelect: () => copy(`[[${title}]]`)},
            {label: 'Copiar título', icon: 'title', onSelect: () => copy(title)},
            {label: 'Copiar ubicación', icon: 'account_tree', title: locationOf(hit), onSelect: () => copy(locationOf(hit))},
            {label: 'Ver en el grafo', icon: 'hub', onSelect: onOpenGraph},
            'separator',
            {
                label: 'Exportar como Markdown…',
                icon: 'download',
                title: 'Guarda un .md con las imágenes incluidas, que se abre en Obsidian o en cualquier editor. Queda en claro en el disco: la nota deja de estar cifrada en ese archivo.',
                onSelect: () =>
                    void ExportNoteMarkdown(hit.id)
                        .then((path) => path && setNotice(`Exportada en ${path}`))
                        .catch((err) => setError(String(err))),
            },
            hit.isPrivate
                ? {label: 'Hacer visible para agentes', icon: 'lock_open', onSelect: () => setPublishing(hit)}
                : {
                      label: 'Hacer privada',
                      icon: 'lock',
                      title: 'Ningún agente (chat, @note, MCP) va a poder leerla',
                      onSelect: () =>
                          void SetNotePrivacy(hit.id, true)
                              .then(onChanged)
                              .catch((err) => setError(String(err))),
                  },
            'separator',
            {label: 'Borrar', icon: 'delete', danger: true, onSelect: () => setDeleting(hit)},
        ]
        menu.openAt(e, items)
    }

    const folderMenu = (e: ReactMouseEvent, node: FolderNode, total: number) => {
        const f = node.folder
        const open = foldersOpen(f.id)
        menu.openAt(e, [
            {label: 'Nota nueva aquí', icon: 'note_add', onSelect: () => createNoteIn(f.id)},
            {
                label: 'Subcarpeta nueva',
                icon: 'create_new_folder',
                onSelect: () => {
                    setOpenFolders((prev) => new Set([...prev, f.id]))
                    onCreateFolder('Nueva carpeta', f.id)
                },
            },
            'separator',
            {label: 'Abrir como tabla', icon: 'table_rows', hint: `${total}`, title: 'Sus notas con fechas y un buscador propio', onSelect: () => setOpenedFolder(f)},
            {label: open ? 'Plegar' : 'Desplegar', icon: open ? 'unfold_less' : 'unfold_more', disabled: searching, onSelect: () => toggleFolder(f.id)},
            'separator',
            {label: 'Cambiar nombre', icon: 'edit', onSelect: () => setRenamingFolder(f)},
            'separator',
            {
                label: 'Borrar carpeta',
                icon: 'delete',
                danger: true,
                title: 'Las notas que tenía NO se borran: quedan en la raíz',
                onSelect: () => onDeleteFolder(f.id),
            },
        ])
    }

    const blankMenu = (e: ReactMouseEvent) =>
        menu.openAt(e, [
            {label: 'Nota nueva', icon: 'note_add', onSelect: createNote},
            {
                label: 'Carpeta nueva',
                icon: 'create_new_folder',
                onSelect: () => onCreateFolder('Nueva carpeta', ''),
            },
            'separator',
            {label: 'Desplegar todo', icon: 'unfold_more', disabled: searching, onSelect: expandAll},
            {label: 'Plegar todo', icon: 'unfold_less', disabled: searching, onSelect: collapseAll},
            'separator',
            {label: 'Grafo de conocimiento', icon: 'hub', onSelect: onOpenGraph},
        ])

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
                    onClick={() => (openFolders.size > 0 ? collapseAll() : expandAll())}
                    disabled={searching || noteFolders.length === 0}
                    title={openFolders.size > 0 ? 'Plegar todas las carpetas' : 'Desplegar todas las carpetas'}
                    className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-40"
                >
                    <Icon name={openFolders.size > 0 ? 'unfold_less' : 'unfold_more'} size={16} />
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
                    className={`flex items-center gap-1 rounded px-1 text-ui-10 ${showHelp ? 'text-primary' : 'text-on-surface-variant hover:text-on-surface'}`}
                >
                    <Icon name="help" size={12} />
                    Sintaxis de búsqueda
                </button>
            </div>
            <div className="px-2">
                {showHelp && (
                    <div className="rounded border border-outline-variant bg-surface-container-low p-1.5 text-ui-10 leading-4 text-on-surface-variant">
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

            {error && <p className="px-2 pb-1 text-ui-10 text-error">{error}</p>}
            {notice && <p className="truncate px-2 pb-1 text-ui-10 text-on-surface-variant" title={notice}>{notice}</p>}

            <div className="min-h-0 flex-1 overflow-y-auto pb-6" onContextMenu={blankMenu}>
                {hits.length === 0 && !loading && (
                    <p className="px-2 py-2 text-ui-11 text-on-surface-variant">
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

                {/* Fijadas arriba de todo, como los marcadores de Obsidian. La
                    nota sigue apareciendo también en su carpeta: fijar es un
                    atajo, no una mudanza. Buscando no se muestran — ahí manda
                    la relevancia. */}
                {!searching && pinnedHits.length > 0 && (
                    <div className="mb-1 border-b border-outline-variant/60 pb-1">
                        <p className="flex items-center gap-1.5 px-3 pb-0.5 pt-1 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/70">
                            <Icon name="keep" size={12} />
                            Fijadas
                        </p>
                        {pinnedHits.map((h) => (
                            <NoteRow
                                key={`pin-${h.id}`}
                                row={{hit: h, depth: 0, path: `pin-${h.id}`, children: 0}}
                                active={activeNoteId === h.id}
                                collapsed={false}
                                onToggleBranch={toggleBranch}
                                onOpen={onOpenNote}
                                onMenu={noteMenu}
                            />
                        ))}
                    </div>
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
                        onOpenFolder={setOpenedFolder}
                        onMenu={folderMenu}
                        renderNotes={(notes, depth) =>
                            rowsFor(notes, depth).map((row) => (
                                <NoteRow
                                    key={row.path}
                                    row={row}
                                    active={activeNoteId === row.hit.id}
                                    collapsed={collapsed.has(row.path)}
                                    onToggleBranch={toggleBranch}
                                    onOpen={onOpenNote}
                                    onMenu={noteMenu}
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
                        onOpen={onOpenNote}
                        onMenu={noteMenu}
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

            {menu.element}

            {renamingNote && (
                <PromptDialog
                    title="Cambiar el nombre de la nota"
                    label="Título"
                    initial={renamingNote.title}
                    confirmLabel="Guardar"
                    description={`Las notas que la enlazan con [[${renamingNote.title}]] no se actualizan solas: van a mostrar el enlace como roto hasta que lo corrijas.`}
                    onSubmit={(value) => {
                        const id = renamingNote.id
                        setRenamingNote(null)
                        if (value.trim() && value.trim() !== renamingNote.title)
                            void RenameNote(id, value.trim())
                                .then(onChanged)
                                .catch((e) => setError(String(e)))
                    }}
                    onClose={() => setRenamingNote(null)}
                />
            )}

            {merging && (
                <MergeNoteDialog
                    source={merging}
                    onMerge={(targetId) =>
                        void MergeNotes(merging.id, targetId)
                            .then(() => {
                                onChanged()
                                onOpenNote(targetId)
                            })
                            .catch((e) => setError(String(e)))
                    }
                    onClose={() => setMerging(null)}
                />
            )}

            {publishing && (
                <ConfirmDialog
                    title="Hacer visible para los agentes"
                    description={`«${publishing.title || 'Sin título'}» va a poder leerse desde el chat, con @note y por el servidor MCP. Si tiene credenciales o datos sensibles, dejala privada.`}
                    confirmLabel="Hacer visible"
                    onConfirm={() => {
                        void SetNotePrivacy(publishing.id, false)
                            .then(onChanged)
                            .catch((e) => setError(String(e)))
                    }}
                    onClose={() => setPublishing(null)}
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
//
// Clic en la fila la despliega, como en cualquier explorador (Obsidian, el de
// archivos del sistema). La vista de tabla —fechas, buscador propio— sigue
// estando, con doble clic o desde el menú contextual.
function FolderRow({
    node,
    depth,
    byFolder,
    isOpen,
    onToggle,
    onOpenFolder,
    onMenu,
    renderNotes,
}: {
    node: FolderNode
    depth: number
    byFolder: Record<string, vault.NoteHit[]>
    isOpen: (id: string) => boolean
    onToggle: (id: string) => void
    onOpenFolder: (folder: vault.Folder) => void
    onMenu: (e: ReactMouseEvent, node: FolderNode, total: number) => void
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
            <TreeRow
                depth={depth}
                icon={open ? 'folder_open' : 'folder'}
                iconClass={TREE_FOLDER_ICON}
                iconFilled={!open}
                label={node.folder.name}
                labelClass="text-on-surface font-medium"
                title={`${node.folder.name} — ${total} ${total === 1 ? 'nota' : 'notas'}. Doble clic: abrirla como tabla. Clic derecho: más opciones.`}
                expanded={open}
                onToggle={() => onToggle(node.folder.id)}
                onClick={() => onToggle(node.folder.id)}
                onDoubleClick={() => onOpenFolder(node.folder)}
                onContextMenu={(e) => onMenu(e, node, total)}
                trailing={<span className="text-ui-10 tabular-nums text-on-surface-variant/50">{total}</span>}
                actions={<MenuButton onOpen={(e) => onMenu(e, node, total)} title="Opciones de la carpeta" />}
            />

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
                            onOpenFolder={onOpenFolder}
                            onMenu={onMenu}
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

// NoteRow es una nota en el árbol. Una nota de la que cuelgan otras (las que
// enlaza) lleva chevron y un ícono distinto: es un "índice", y tiene que
// verse como algo que se despliega antes de apuntarle.
function NoteRow({
    row,
    active,
    collapsed,
    onToggleBranch,
    onOpen,
    onMenu,
}: {
    row: NoteTreeRow
    active: boolean
    collapsed: boolean
    onToggleBranch: (path: string) => void
    onOpen: (id: string) => void
    onMenu: (e: ReactMouseEvent, hit: vault.NoteHit) => void
}) {
    const {hit, depth} = row
    const parent = row.children > 0
    return (
        <TreeRow
            depth={depth}
            icon={parent ? 'library_books' : 'description'}
            iconClass={active ? 'text-primary' : undefined}
            label={hit.title || 'Sin título'}
            labelClass={`${active ? 'text-on-surface' : 'text-on-surface/90'} ${hit.matchedTitle ? 'font-medium' : ''}`}
            title={
                (hit.isPrivate ? `${hit.title} — privada: ningún agente puede leerla` : `${hit.title} — visible para los agentes`) +
                (parent ? `. Enlaza ${row.children} ${row.children === 1 ? 'nota' : 'notas'}.` : '')
            }
            expanded={parent ? !collapsed : undefined}
            onToggle={() => onToggleBranch(row.path)}
            onClick={() => onOpen(hit.id)}
            onContextMenu={(e) => onMenu(e, hit)}
            active={active}
            // El candado se queda a la vista: es la única señal de un vistazo
            // de qué puede leer un agente.
            trailing={
                hit.isPrivate || hit.pinned ? (
                    <>
                        {hit.pinned && <Icon name="keep" size={12} className="text-on-surface-variant/60" />}
                        {hit.isPrivate && <Icon name="lock" size={12} className="text-on-surface-variant/60" />}
                    </>
                ) : undefined
            }
            actions={<MenuButton onOpen={(e) => onMenu(e, hit)} title="Opciones de la nota" />}
            below={
                // El fragmento es lo que evita abrir cinco notas para ver cuál
                // era. El resaltado viene marcado con «…» desde el backend y se
                // parte acá — nunca se inyecta HTML.
                hit.snippet ? (
                    <span className="line-clamp-2 pb-1 pl-[46px] pr-1 text-ui-10 leading-4 text-on-surface-variant">
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
                ) : undefined
            }
        />
    )
}
