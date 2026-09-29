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
import {useT} from '../../i18n'

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
    const t = useT()
    const tn = t.sidebar.notes
    const tf = t.sidebar.folders
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
        const timer = setTimeout(() => setNotice(''), 4000)
        return () => clearTimeout(timer)
    }, [notice])
    const menu = useTreeMenu()

    // Con retardo: cada búsqueda descifra las notas en memoria (ver
    // backend/vault/notesearch.go), así que buscar por pulsación las
    // descifraría todas por cada letra.
    useEffect(() => {
        let cancelled = false
        const timer = setTimeout(() => {
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
            clearTimeout(timer)
        }
    }, [query, reloadToken])

    const createNote = useCallback(() => {
        // El título sale de lo que se venía buscando: quien busca "Runbook
        // SGC", no lo encuentra y aprieta "+", quiere crear justamente esa.
        const title = query.trim() || t.sidebar.notes.untitledNote
        CreateNote(title, '')
            .then((id) => {
                // Limpiar la búsqueda es parte de crear: el texto acaba de
                // convertirse en el título de la nota nueva, y dejarlo puesto
                // la escondería detrás del filtro que lo nombró.
                onClearFilter()
                onCreated(id)
            })
            .catch((e) => setError(String(e)))
    }, [query, onCreated, onClearFilter, t])

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
        const title = query.trim() || tn.untitledNote
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
        return [...parts, hit.title || tn.untitled].join(' / ')
    }

    const noteMenu = (e: ReactMouseEvent, hit: vault.NoteHit) => {
        const title = hit.title || tn.untitled
        const items: TreeMenuEntry[] = [
            {label: tn.openInTab, icon: 'open_in_new', hint: t.sidebar.ssh.click, onSelect: () => onOpenNote(hit.id)},
            {
                label: hit.pinned ? tn.unpin : tn.pin,
                icon: hit.pinned ? 'keep_off' : 'keep',
                title: tn.pinTitle,
                onSelect: () =>
                    void SetNotePinned(hit.id, !hit.pinned)
                        .then(onChanged)
                        .catch((err) => setError(String(err))),
            },
            'separator',
            {label: tf.rename, icon: 'edit', onSelect: () => setRenamingNote(hit)},
            {
                label: tn.duplicate,
                icon: 'content_copy',
                title: tn.duplicateTitle,
                onSelect: () =>
                    void DuplicateNote(hit.id)
                        .then((id) => {
                            onChanged()
                            onCreated(id)
                        })
                        .catch((err) => setError(String(err))),
            },
            {label: tf.moveTo, icon: 'drive_file_move', submenu: moveToFolderSubmenu(flatFolders, hit.folderId ?? '', (f) => moveNote(hit.id, f))},
            {
                label: tn.merge,
                icon: 'call_merge',
                title: tn.mergeTitle,
                onSelect: () => setMerging(hit),
            },
            'separator',
            {label: tn.copyLink, icon: 'link', hint: '[[…]]', title: tn.copyLinkTitle({title}), onSelect: () => copy(`[[${title}]]`)},
            {label: tn.copyTitle, icon: 'title', onSelect: () => copy(title)},
            {label: tn.copyLocation, icon: 'account_tree', title: locationOf(hit), onSelect: () => copy(locationOf(hit))},
            {label: tn.showInGraph, icon: 'hub', onSelect: onOpenGraph},
            'separator',
            {
                label: tn.exportMarkdown,
                icon: 'download',
                title: tn.exportMarkdownTitle,
                onSelect: () =>
                    void ExportNoteMarkdown(hit.id)
                        .then((path) => path && setNotice(tn.exported({path})))
                        .catch((err) => setError(String(err))),
            },
            hit.isPrivate
                ? {label: tn.makeVisible, icon: 'lock_open', onSelect: () => setPublishing(hit)}
                : {
                      label: tn.makePrivate,
                      icon: 'lock',
                      title: tn.makePrivateTitle,
                      onSelect: () =>
                          void SetNotePrivacy(hit.id, true)
                              .then(onChanged)
                              .catch((err) => setError(String(err))),
                  },
            'separator',
            {label: t.common.delete, icon: 'delete', danger: true, onSelect: () => setDeleting(hit)},
        ]
        menu.openAt(e, items)
    }

    const folderMenu = (e: ReactMouseEvent, node: FolderNode, total: number) => {
        const f = node.folder
        const open = foldersOpen(f.id)
        menu.openAt(e, [
            {label: tn.newNoteHere, icon: 'note_add', onSelect: () => createNoteIn(f.id)},
            {
                label: tf.newSubfolder,
                icon: 'create_new_folder',
                onSelect: () => {
                    setOpenFolders((prev) => new Set([...prev, f.id]))
                    onCreateFolder(tn.defaultFolderName, f.id)
                },
            },
            'separator',
            {label: tn.openAsTable, icon: 'table_rows', hint: `${total}`, title: tn.openAsTableTitle, onSelect: () => setOpenedFolder(f)},
            {label: open ? t.common.collapse : t.common.expand, icon: open ? 'unfold_less' : 'unfold_more', disabled: searching, onSelect: () => toggleFolder(f.id)},
            'separator',
            {label: tf.rename, icon: 'edit', onSelect: () => setRenamingFolder(f)},
            'separator',
            {
                label: t.sidebar.git.deleteFolder,
                icon: 'delete',
                danger: true,
                title: tn.deleteFolderTitle,
                onSelect: () => onDeleteFolder(f.id),
            },
        ])
    }

    const blankMenu = (e: ReactMouseEvent) =>
        menu.openAt(e, [
            {label: tn.newNote, icon: 'note_add', onSelect: createNote},
            {
                label: tf.newFolder,
                icon: 'create_new_folder',
                onSelect: () => onCreateFolder(tn.defaultFolderName, ''),
            },
            'separator',
            {label: tf.expandAll, icon: 'unfold_more', disabled: searching, onSelect: expandAll},
            {label: tf.collapseAll, icon: 'unfold_less', disabled: searching, onSelect: collapseAll},
            'separator',
            {label: tn.graph, icon: 'hub', onSelect: onOpenGraph},
        ])

    return (
        <SidebarSection
            title={tn.title}
            count={searching ? tn.resultCount({count: hits.length}) : hits.length ? String(hits.length) : null}
            actions={
                <>
                <button
                    onClick={() => {
                        const name = query.trim() || tn.defaultFolderName
                        onClearFilter()
                        onCreateFolder(name, '')
                    }}
                    title={tn.newFolderTitle}
                    className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="create_new_folder" size={16} />
                </button>
                <button
                    onClick={() => (openFolders.size > 0 ? collapseAll() : expandAll())}
                    disabled={searching || noteFolders.length === 0}
                    title={openFolders.size > 0 ? t.sidebar.ssh.collapseAllTitle : tf.expandAllTitle}
                    className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-40"
                >
                    <Icon name={openFolders.size > 0 ? 'unfold_less' : 'unfold_more'} size={16} />
                </button>
                <button
                    onClick={onOpenGraph}
                    title={tn.graphTitle}
                    className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="hub" size={16} />
                </button>
                <button
                    onClick={createNote}
                    title={
                        searching
                            ? tn.newNoteNamedTitle({title: query.trim()})
                            : tn.newNoteTitle
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
                    title={showHelp ? tn.hideSearchHelp : tn.searchHelpTitle}
                    className={`flex items-center gap-1 rounded px-1 text-ui-10 ${showHelp ? 'text-primary' : 'text-on-surface-variant hover:text-on-surface'}`}
                >
                    <Icon name="help" size={12} />
                    {tn.searchSyntax}
                </button>
            </div>
            <div className="px-2">
                {showHelp && (
                    <div className="rounded border border-outline-variant bg-surface-container-low p-1.5 text-ui-10 leading-4 text-on-surface-variant">
                        {tn.searchHelp.map((row) => (
                            <p key={row.code}>
                                <span className="font-mono text-on-surface">{row.code}</span> — {row.desc}
                            </p>
                        ))}
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
                                {tn.noResults.before}
                                <span className="text-on-surface">{query}</span>
                                {tn.noResults.middle}
                                <Icon name="note_add" size={11} className="inline align-text-bottom" />
                                {tn.noResults.after}
                            </>
                        ) : (
                            tn.empty
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
                            {tn.pinned}
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
                    title={tn.deleteNote}
                    description={tn.deleteNoteDesc({title: deleting.title || tn.untitled})}
                    confirmLabel={t.common.delete}
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
                    title={tn.renameNote}
                    label={tn.titleLabel}
                    initial={renamingNote.title}
                    confirmLabel={t.common.save}
                    description={tn.renameNoteDesc({title: renamingNote.title})}
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
                    title={tn.makeVisibleTitle}
                    description={tn.makeVisibleDesc({title: publishing.title || tn.untitled})}
                    confirmLabel={tn.makeVisibleConfirm}
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
                    title={tf.renameTitle}
                    label={tf.nameLabel}
                    initial={renamingFolder.name}
                    confirmLabel={t.common.save}
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
    const t = useT()
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
                title={t.sidebar.notes.folderTitle({name: node.folder.name, count: total})}
                expanded={open}
                onToggle={() => onToggle(node.folder.id)}
                onClick={() => onToggle(node.folder.id)}
                onDoubleClick={() => onOpenFolder(node.folder)}
                onContextMenu={(e) => onMenu(e, node, total)}
                trailing={<span className="text-ui-10 tabular-nums text-on-surface-variant/50">{total}</span>}
                actions={<MenuButton onOpen={(e) => onMenu(e, node, total)} title={t.sidebar.folders.folderOptions} />}
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
    const t = useT()
    const tn = t.sidebar.notes
    const {hit, depth} = row
    const parent = row.children > 0
    return (
        <TreeRow
            depth={depth}
            icon={parent ? 'library_books' : 'description'}
            iconClass={active ? 'text-primary' : undefined}
            label={hit.title || tn.untitled}
            labelClass={`${active ? 'text-on-surface' : 'text-on-surface/90'} ${hit.matchedTitle ? 'font-medium' : ''}`}
            title={
                tn.noteTitle({title: hit.title, isPrivate: hit.isPrivate, links: parent ? row.children : 0})
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
            actions={<MenuButton onOpen={(e) => onMenu(e, hit)} title={tn.noteOptions} />}
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
