import {useCallback, useEffect, useMemo, useState, type ReactNode} from 'react'
import {CreateNote, DeleteNote, SearchNotesSmart, SetNoteFolder} from '../../../wailsjs/go/main/App'
import {vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import SidebarModule from '../sidebar/SidebarModule'
import MoveToFolderMenu from '../sidebar/MoveToFolderMenu'
import ConfirmDialog from '../ConfirmDialog'
import PromptDialog from '../git/PromptDialog'
import {buildFolderTree, type FolderNode} from '../../lib/folderTree'

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
    moduleCollapsed: boolean
    onToggleModuleCollapsed: () => void
    rail: boolean
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
    moduleCollapsed,
    onToggleModuleCollapsed,
    rail,
    onCreated,
    reloadToken,
    onOpenGraph,
    folders,
    onCreateFolder,
    onRenameFolder,
    onDeleteFolder,
    onChanged,
}: Props) {
    const [query, setQuery] = useState('')
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

    // Con retardo: cada búsqueda descifra las notas en memoria (ver
    // backend/vault/notesearch.go), así que buscar por pulsación las
    // descifraría todas por cada letra.
    useEffect(() => {
        let cancelled = false
        const t = setTimeout(() => {
            setLoading(true)
            SearchNotesSmart(query, 60)
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
                setQuery('')
                onCreated(id)
            })
            .catch((e) => setError(String(e)))
    }, [query, onCreated])

    const searching = query.trim().length > 0

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

    const moveNote = (noteId: string, folderId: string) => {
        void SetNoteFolder(noteId, folderId)
            .then(onChanged)
            .catch((e) => setError(String(e)))
    }

    return (
        <SidebarModule
            title="Notas"
            collapsed={moduleCollapsed}
            onToggleCollapsed={onToggleModuleCollapsed}
            matchCount={searching ? hits.length : null}
            actions={
                <>
                <button
                    onClick={() => {
                        const name = query.trim() || 'Nueva carpeta'
                        setQuery('')
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
            {!rail && (
                <div className="flex flex-col gap-1 px-2 pb-1">
                    <div className="flex items-center gap-1 rounded border border-outline-variant bg-surface px-1.5 py-0.5">
                        <Icon name="search" size={13} className="shrink-0 text-on-surface-variant" />
                        <input
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Buscar en tus notas…"
                            title="Busca en títulos y cuerpos, sin importar tildes ni mayúsculas. Varias palabras: todas tienen que aparecer. Entre comillas: frase exacta."
                            className="min-w-0 flex-1 bg-transparent py-0.5 text-[11px] text-on-surface outline-none placeholder:text-on-surface-variant/60"
                        />
                        {query && (
                            <button
                                onClick={() => setQuery('')}
                                title="Limpia la búsqueda"
                                className="shrink-0 rounded text-on-surface-variant hover:text-on-surface"
                            >
                                <Icon name="close" size={12} />
                            </button>
                        )}
                        <button
                            onClick={() => setShowHelp((v) => !v)}
                            title="Qué más se puede escribir en el buscador"
                            className={`shrink-0 rounded ${showHelp ? 'text-primary' : 'text-on-surface-variant hover:text-on-surface'}`}
                        >
                            <Icon name="help" size={12} />
                        </button>
                    </div>

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
            )}

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
                        onRenameFolder={setRenamingFolder}
                        onDeleteFolder={onDeleteFolder}
                        renderNote={(h, depth) => (
                            <NoteRow
                                key={h.id}
                                hit={h}
                                depth={depth}
                                active={activeNoteId === h.id}
                                flatFolders={flatFolders}
                                onOpen={onOpenNote}
                                onMove={moveNote}
                                onDelete={setDeleting}
                            />
                        )}
                    />
                ))}

                {(byFolder[''] ?? []).map((h) => (
                    <NoteRow
                        key={h.id}
                        hit={h}
                        depth={0}
                        active={activeNoteId === h.id}
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
        </SidebarModule>
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
    onRenameFolder,
    onDeleteFolder,
    renderNote,
}: {
    node: FolderNode
    depth: number
    byFolder: Record<string, vault.NoteHit[]>
    isOpen: (id: string) => boolean
    onToggle: (id: string) => void
    onCreateFolder: (name: string, parentId: string) => void
    onRenameFolder: (folder: vault.Folder) => void
    onDeleteFolder: (id: string) => void
    renderNote: (hit: vault.NoteHit, depth: number) => ReactNode
}) {
    const notes = byFolder[node.folder.id] ?? []
    const open = isOpen(node.folder.id)
    // El contador incluye las subcarpetas: una carpeta plegada que dice "0"
    // cuando adentro hay doce notas en subcarpetas miente.
    const total = countIn(node, byFolder)

    return (
        <div>
            <div
                className="group flex items-center gap-1 py-0.5 pr-2 text-[11px] hover:bg-surface-variant"
                style={{paddingLeft: `${depth * 12 + 8}px`}}
            >
                <button
                    onClick={() => onToggle(node.folder.id)}
                    title={open ? 'Plegar la carpeta' : `Desplegar la carpeta (${total} notas)`}
                    className="flex min-w-0 flex-1 items-center gap-1 text-left"
                >
                    <Icon
                        name={open ? 'expand_more' : 'chevron_right'}
                        size={12}
                        className="shrink-0 text-on-surface-variant"
                    />
                    <Icon
                        name={open ? 'folder_open' : 'folder'}
                        size={13}
                        className="shrink-0 text-on-surface-variant"
                    />
                    <span className="min-w-0 truncate text-on-surface">{node.folder.name}</span>
                    <span className="shrink-0 text-on-surface-variant/60">{total}</span>
                </button>

                <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
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
                            onRenameFolder={onRenameFolder}
                            onDeleteFolder={onDeleteFolder}
                            renderNote={renderNote}
                        />
                    ))}
                    {notes.map((h) => renderNote(h, depth + 1))}
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
    hit,
    depth,
    active,
    flatFolders,
    onOpen,
    onMove,
    onDelete,
}: {
    hit: vault.NoteHit
    depth: number
    active: boolean
    flatFolders: {folder: vault.Folder; depth: number}[]
    onOpen: (id: string) => void
    onMove: (noteId: string, folderId: string) => void
    onDelete: (hit: vault.NoteHit) => void
}) {
    return (
        <div
            className={`group flex flex-col border-l-2 pr-1 ${
                active ? 'border-l-primary bg-surface-variant' : 'border-l-transparent hover:bg-surface-container-high'
            }`}
            style={{paddingLeft: `${depth * 12 + 8}px`}}
        >
            <div className="flex items-center gap-1.5 py-1">
                <button
                    onClick={() => onOpen(hit.id)}
                    title={
                        hit.isPrivate
                            ? `${hit.title} — privada: ningún agente puede leerla`
                            : `${hit.title} — visible para los agentes`
                    }
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                >
                    {/* El candado no es decoración: es la única señal de un
                        vistazo de qué puede leer un agente. */}
                    <Icon
                        name={hit.isPrivate ? 'lock' : 'description'}
                        size={11}
                        className={`shrink-0 ${hit.isPrivate ? 'text-on-surface-variant/60' : 'text-on-surface-variant'}`}
                    />
                    <span
                        className={`min-w-0 truncate text-[11px] ${
                            hit.matchedTitle ? 'font-medium text-on-surface' : 'text-on-surface'
                        }`}
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
                <span className="line-clamp-2 pb-1 pl-[18px] text-[10px] leading-4 text-on-surface-variant">
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
