import {useEffect, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent} from 'react'
import {
    CreateFolder,
    CreateSshSnippet,
    DeleteFolder,
    DeleteSshSnippet,
    GetSettings,
    ListFolders,
    ListSshSnippets,
    MoveFolder,
    MoveSshSnippetToFolder,
    RenameFolder,
    ReorderFolder,
    SetSnippetsPanelWidth,
    UpdateSshSnippet,
} from '../../../wailsjs/go/main/App'
import {vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import ConfirmDialog from '../ConfirmDialog'
import ConnectionRowMenu from '../sidebar/ConnectionRowMenu'
import {flattenForMenu} from '../sidebar/MoveToFolderMenu'
import {buildFolderTree, countConnectionsIn, type FolderNode} from '../../lib/folderTree'
import ShellScriptEditor from './ShellScriptEditor'

interface SshSnippetsPanelProps {
    // Dónde escriben Ejecutar/Pegar. La lista de snippets es GLOBAL (la misma
    // desde cualquier terminal, ver el doc de vault.SshSnippet); lo único
    // atado a la pestaña es a qué sesión se le mandan los bytes.
    //
    // Se recibe como función y no como id de conexión porque el mismo panel lo
    // usan las terminales SSH y las LOCALES del sistema operativo, y cada una
    // escribe por su propio binding. Un snippet no sabe —ni tiene por qué
    // saber— si del otro lado hay un servidor o la máquina de uno.
    write: (data: string) => void
    onClose: () => void
}

// Snippet folders live in their own scope ('ssh-snippet') on the SAME
// `folders` table connections already use (schema_migrations version 14) —
// entirely independent tree from the 'db'/'ssh' connection folders, even if
// a folder happens to share a name, same pattern as SshConnectionTree.tsx's
// own 'ssh' scope.
const SNIPPET_FOLDER_SCOPE = 'ssh-snippet'

// Ancho del panel. 0 en el vault = nunca se arrastró. El tope superior lo
// acota también el ancho de la ventana al arrastrar: un panel que se come la
// terminal deja sin lugar justo lo que el snippet viene a escribir.
const PANEL_WIDTH_DEFAULT = 300
const PANEL_WIDTH_MIN = 240
const PANEL_WIDTH_MAX = 900

// Tipo MIME propio del arrastre: así una carpeta solo acepta snippets y
// carpetas de este panel, y no un archivo o un texto soltado desde afuera.
const DRAG_MIME = 'application/x-mini-tools-snippet-item'

// Qué carpetas quedaron abiertas. A nivel de módulo y no de estado del
// componente: el panel se desmonta al cerrarlo, y volver a abrirlo con todo
// plegado obligaba a recorrer el árbol de nuevo cada vez.
const expandedFoldersMemory = new Set<string>()

// "Run" executes every line (each terminated by \r, matching the byte xterm
// sends for a real Enter keypress — see SshTerminalTab.tsx's term.onData).
// "Paste" inserts the same text but leaves the LAST line uncommitted in the
// shell's prompt, so the user can review/extend it before pressing Enter
// themselves — same distinction Termius' own snippet Run/Paste buttons make.
// Single-line snippets: Run submits it, Paste just types it.
function runSnippet(write: (data: string) => void, script: string) {
    const lines = script.split('\n')
    write(lines.map((l) => l + '\r').join(''))
}

function pasteSnippet(write: (data: string) => void, script: string) {
    const lines = script.split('\n')
    write(lines.map((l, i) => (i < lines.length - 1 ? l + '\r' : l)).join(''))
}

// Ids de una carpeta y de todo lo que cuelga de ella: una carpeta no se puede
// mover adentro de sí misma ni de una de sus hijas.
function subtreeIds(node: FolderNode): Set<string> {
    const ids = new Set<string>([node.folder.id])
    for (const child of node.children) for (const id of subtreeIds(child)) ids.add(id)
    return ids
}

function findNode(nodes: FolderNode[], id: string): FolderNode | null {
    for (const n of nodes) {
        if (n.folder.id === id) return n
        const found = findNode(n.children, id)
        if (found) return found
    }
    return null
}

type DragItem = {kind: 'snippet' | 'folder'; id: string}

export default function SshSnippetsPanel({write, onClose}: SshSnippetsPanelProps) {
    const [snippets, setSnippets] = useState<vault.SshSnippet[]>([])
    const [folders, setFolders] = useState<vault.Folder[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [filter, setFilter] = useState('')

    const [width, setWidth] = useState(PANEL_WIDTH_DEFAULT)
    const resizingRef = useRef(false)

    // null = formulario cerrado, 'new' = creando, un id = editando ese snippet.
    const [editingId, setEditingId] = useState<string | null>(null)
    const [formName, setFormName] = useState('')
    const [formScript, setFormScript] = useState('')
    const [formFolderId, setFormFolderId] = useState('')
    const [saving, setSaving] = useState(false)

    const [deleteTarget, setDeleteTarget] = useState<vault.SshSnippet | null>(null)
    const [deleteFolderTarget, setDeleteFolderTarget] = useState<vault.Folder | null>(null)
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set(expandedFoldersMemory))
    const [creatingFolderParentId, setCreatingFolderParentId] = useState<string | null>(null)
    const [newFolderName, setNewFolderName] = useState('')
    const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)
    const [renameFolderName, setRenameFolderName] = useState('')

    // Destino resaltado mientras se arrastra: un id de carpeta, '' = la raíz,
    // null = ninguno.
    const [dropTarget, setDropTarget] = useState<string | null>(null)
    const dragItemRef = useRef<DragItem | null>(null)

    function load() {
        setLoading(true)
        Promise.all([ListSshSnippets(), ListFolders()])
            .then(([sn, fo]) => {
                setSnippets(sn)
                setFolders(fo.filter((f) => f.scope === SNIPPET_FOLDER_SCOPE))
            })
            .catch((err) => setError(String(err)))
            .finally(() => setLoading(false))
    }

    useEffect(() => {
        load()
        GetSettings()
            .then((s) => {
                if (s.snippetsPanelWidth > 0) setWidth(s.snippetsPanelWidth)
            })
            .catch(() => {
                // Sin settings el panel abre con su ancho por defecto: no es
                // motivo para mostrar un error encima de los snippets.
            })
    }, [])

    useEffect(() => {
        expandedFoldersMemory.clear()
        for (const id of expandedFolders) expandedFoldersMemory.add(id)
    }, [expandedFolders])

    function clampWidth(px: number) {
        const max = Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, window.innerWidth * 0.75))
        return Math.round(Math.min(max, Math.max(PANEL_WIDTH_MIN, px)))
    }

    // El tirador está en el borde IZQUIERDO: el panel se ancla a la derecha de
    // la terminal, así que arrastrar hacia la izquierda es agrandarlo.
    function startResize(e: ReactMouseEvent) {
        e.preventDefault()
        resizingRef.current = true
        const startX = e.clientX
        const startWidth = width
        const prevCursor = document.body.style.cursor
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'

        function onMove(ev: MouseEvent) {
            if (!resizingRef.current) return
            setWidth(clampWidth(startWidth + (startX - ev.clientX)))
        }
        function onUp(ev: MouseEvent) {
            resizingRef.current = false
            document.body.style.cursor = prevCursor
            document.body.style.userSelect = ''
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
            void SetSnippetsPanelWidth(clampWidth(startWidth + (startX - ev.clientX))).catch(() => {})
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
    }

    function resetWidth() {
        setWidth(PANEL_WIDTH_DEFAULT)
        void SetSnippetsPanelWidth(PANEL_WIDTH_DEFAULT).catch(() => {})
    }

    const q = filter.trim().toLowerCase()
    const snippetMatches = (s: vault.SshSnippet) => !q || s.name.toLowerCase().includes(q) || s.script.toLowerCase().includes(q)
    const folderNameMatches = (f: vault.Folder) => !q || f.name.toLowerCase().includes(q)
    const folderTree = buildFolderTree(folders)
    const flatFolders = flattenForMenu(folderTree)

    function folderHasVisibleContent(node: FolderNode): boolean {
        if (creatingFolderParentId === node.folder.id) return true
        if (folderNameMatches(node.folder)) return true
        if (snippets.some((s) => (s.folderId ?? '') === node.folder.id && snippetMatches(s))) return true
        return node.children.some(folderHasVisibleContent)
    }

    function isFolderExpanded(id: string) {
        if (q) return true
        return expandedFolders.has(id)
    }

    const rootSnippets = snippets.filter((s) => !s.folderId && snippetMatches(s))
    const visibleFolderNodes = folderTree.filter((node) => !q || folderHasVisibleContent(node))
    const matchCount = snippets.filter(snippetMatches).length

    function expandFolder(id: string) {
        if (!id) return
        setExpandedFolders((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
    }

    function toggleFolder(id: string) {
        setExpandedFolders((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    function setAllFolders(open: boolean) {
        setExpandedFolders(open ? new Set(folders.map((f) => f.id)) : new Set())
    }

    function startCreateFolder(parentId: string) {
        expandFolder(parentId)
        setCreatingFolderParentId(parentId)
        setNewFolderName('')
    }

    async function commitCreateFolder() {
        const name = newFolderName.trim()
        const parentId = creatingFolderParentId
        setCreatingFolderParentId(null)
        setNewFolderName('')
        if (!name || parentId === null) return
        try {
            const created = await CreateFolder(name, parentId, SNIPPET_FOLDER_SCOPE)
            expandFolder(created.id)
            load()
        } catch (err) {
            setError(String(err))
        }
    }

    function startRenameFolder(f: vault.Folder) {
        setRenamingFolderId(f.id)
        setRenameFolderName(f.name)
    }

    async function commitRenameFolder() {
        const name = renameFolderName.trim()
        const id = renamingFolderId
        setRenamingFolderId(null)
        if (!name || !id) return
        try {
            await RenameFolder(id, name)
            load()
        } catch (err) {
            setError(String(err))
        }
    }

    async function run(action: () => Promise<unknown>) {
        try {
            await action()
            load()
        } catch (err) {
            setError(String(err))
        }
    }

    function moveSnippetToFolder(id: string, folderId: string) {
        expandFolder(folderId)
        void run(() => MoveSshSnippetToFolder(id, folderId))
    }

    function moveFolderTo(id: string, parentId: string) {
        if (id === parentId) return
        const node = findNode(folderTree, id)
        if (node && subtreeIds(node).has(parentId)) return
        expandFolder(parentId)
        void run(() => MoveFolder(id, parentId))
    }

    function startNew(folderId = '') {
        setEditingId('new')
        setFormName('')
        setFormScript('')
        setFormFolderId(folderId)
        expandFolder(folderId)
    }

    function startEdit(s: vault.SshSnippet) {
        setEditingId(s.id)
        setFormName(s.name)
        setFormScript(s.script)
        setFormFolderId(s.folderId ?? '')
    }

    function cancelEdit() {
        setEditingId(null)
        setFormName('')
        setFormScript('')
        setFormFolderId('')
    }

    async function saveForm() {
        if (saving || !formName.trim() || !formScript.trim()) return
        setSaving(true)
        setError('')
        try {
            if (editingId === 'new') {
                const created = await CreateSshSnippet(formName.trim(), formScript)
                if (formFolderId) await MoveSshSnippetToFolder(created.id, formFolderId)
            } else if (editingId) {
                await UpdateSshSnippet(editingId, formName.trim(), formScript)
                const current = snippets.find((s) => s.id === editingId)
                if ((current?.folderId ?? '') !== formFolderId) await MoveSshSnippetToFolder(editingId, formFolderId)
            }
            expandFolder(formFolderId)
            cancelEdit()
            load()
        } catch (err) {
            setError(String(err))
        } finally {
            setSaving(false)
        }
    }

    async function duplicateSnippet(s: vault.SshSnippet) {
        await run(async () => {
            const created = await CreateSshSnippet(`${s.name} (copia)`, s.script)
            if (s.folderId) await MoveSshSnippetToFolder(created.id, s.folderId)
        })
    }

    async function confirmDelete() {
        if (!deleteTarget) return
        const id = deleteTarget.id
        setDeleteTarget(null)
        if (editingId === id) cancelEdit()
        await run(() => DeleteSshSnippet(id))
    }

    // --- Arrastrar y soltar ---------------------------------------------

    function onDragStartItem(e: DragEvent, item: DragItem) {
        dragItemRef.current = item
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData(DRAG_MIME, JSON.stringify(item))
    }

    function onDragEnd() {
        dragItemRef.current = null
        setDropTarget(null)
    }

    // Se valida con el ref y no leyendo dataTransfer: durante dragover el
    // navegador no deja leer los datos, solo los tipos.
    function canDropOn(folderId: string) {
        const item = dragItemRef.current
        if (!item) return false
        if (item.kind === 'snippet') return (snippets.find((s) => s.id === item.id)?.folderId ?? '') !== folderId
        const node = findNode(folderTree, item.id)
        if (!node || subtreeIds(node).has(folderId)) return false
        return (node.folder.parentId ?? '') !== folderId
    }

    function dropHandlers(folderId: string) {
        return {
            onDragOver: (e: DragEvent) => {
                if (!e.dataTransfer.types.includes(DRAG_MIME) || !canDropOn(folderId)) return
                e.preventDefault()
                e.stopPropagation()
                e.dataTransfer.dropEffect = 'move'
                if (dropTarget !== folderId) setDropTarget(folderId)
            },
            onDragLeave: (e: DragEvent) => {
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
                if (dropTarget === folderId) setDropTarget(null)
            },
            onDrop: (e: DragEvent) => {
                const item = dragItemRef.current
                if (!item || !canDropOn(folderId)) return
                e.preventDefault()
                e.stopPropagation()
                setDropTarget(null)
                dragItemRef.current = null
                if (item.kind === 'snippet') moveSnippetToFolder(item.id, folderId)
                else moveFolderTo(item.id, folderId)
            },
        }
    }

    // --- Render ---------------------------------------------------------

    const iconButton = 'shrink-0 rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'

    function renderNewFolderInput() {
        return (
            <div className="mb-1 flex items-center gap-1.5 rounded-md bg-surface-container-high px-1.5 py-1">
                <Icon name="create_new_folder" size={14} className="shrink-0 text-primary" />
                <input
                    autoFocus
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onBlur={() => void commitCreateFolder()}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') void commitCreateFolder()
                        if (e.key === 'Escape') {
                            setCreatingFolderParentId(null)
                            setNewFolderName('')
                        }
                    }}
                    placeholder="Nombre de la carpeta — Enter crea, Esc cancela"
                    className="min-w-0 flex-1 border-none bg-transparent text-xs text-on-surface outline-none placeholder:text-on-surface-variant/60"
                />
            </div>
        )
    }

    function renderSnippetRow(s: vault.SshSnippet) {
        const lines = s.script.split('\n')
        const preview = lines.slice(0, 3)
        const hidden = lines.length - preview.length
        const isEditing = editingId === s.id
        return (
            <div
                key={s.id}
                draggable
                onDragStart={(e) => onDragStartItem(e, {kind: 'snippet', id: s.id})}
                onDragEnd={onDragEnd}
                className={`group mb-1.5 rounded-lg border bg-surface-container-high p-2 transition-colors ${
                    isEditing ? 'border-primary' : 'border-outline-variant hover:border-outline'
                }`}
            >
                <div className="flex items-center gap-1">
                    <Icon name="terminal" size={14} className="shrink-0 text-primary" />
                    <button
                        onDoubleClick={() => startEdit(s)}
                        title={`${s.name} — doble clic para editar. Arrastralo sobre una carpeta para moverlo`}
                        className="min-w-0 flex-1 cursor-grab truncate text-left text-xs font-medium text-on-surface active:cursor-grabbing"
                    >
                        {s.name}
                    </button>
                    <button
                        onClick={() => startEdit(s)}
                        title="Editar este snippet"
                        className="hidden shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 group-hover:block"
                    >
                        <Icon name="edit" size={14} />
                    </button>
                    <ConnectionRowMenu
                        flatFolders={flatFolders}
                        onMoveToFolder={(folderId) => moveSnippetToFolder(s.id, folderId)}
                        items={[
                            {icon: 'edit', label: 'Editar', onSelect: () => startEdit(s)},
                            {icon: 'content_copy', label: 'Duplicar', onSelect: () => void duplicateSnippet(s)},
                            {
                                icon: 'assignment',
                                label: 'Copiar script',
                                title: 'Copia el script al portapapeles, sin escribir nada en la terminal',
                                onSelect: () => void navigator.clipboard.writeText(s.script).catch(() => {}),
                            },
                            {icon: 'delete', label: 'Eliminar', danger: true, onSelect: () => setDeleteTarget(s)},
                        ]}
                    />
                </div>
                <pre
                    onDoubleClick={() => startEdit(s)}
                    className="mt-1 overflow-hidden rounded bg-surface-container-low px-1.5 py-1 font-mono text-ui-11 leading-snug text-on-surface-variant"
                >
                    {preview.map((l, i) => (
                        <div key={i} className="truncate">
                            {l || ' '}
                        </div>
                    ))}
                    {hidden > 0 && (
                        <div className="text-on-surface-variant/60">
                            + {hidden} {hidden === 1 ? 'línea' : 'líneas'} más
                        </div>
                    )}
                </pre>
                <div className="mt-1.5 flex gap-1.5">
                    <button
                        onClick={() => runSnippet(write, s.script)}
                        title="Ejecuta cada línea de este snippet en la terminal, como si las tipearas y presionaras Enter"
                        className="flex items-center gap-1 rounded bg-secondary-container px-2 py-1 text-ui-11 font-medium text-on-secondary-container hover:opacity-90"
                    >
                        <Icon name="play_arrow" size={12} filled />
                        Ejecutar
                    </button>
                    <button
                        onClick={() => pasteSnippet(write, s.script)}
                        title="Escribe este snippet en la terminal sin ejecutarlo — la última línea queda sin confirmar para que la revises antes de Enter"
                        className="flex items-center gap-1 rounded bg-surface-container-highest px-2 py-1 text-ui-11 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="content_paste" size={12} />
                        Pegar
                    </button>
                </div>
            </div>
        )
    }

    function renderFolderNode(node: FolderNode) {
        if (q && !folderHasVisibleContent(node)) return null

        const expanded = isFolderExpanded(node.folder.id)
        const isRenaming = renamingFolderId === node.folder.id
        const ownSnippets = snippets.filter((s) => (s.folderId ?? '') === node.folder.id && snippetMatches(s))
        const isCreatingHere = creatingFolderParentId === node.folder.id
        const total = countConnectionsIn(node, snippets, snippetMatches)
        const isDropTarget = dropTarget === node.folder.id
        const blocked = subtreeIds(node)
        const isEmpty = node.children.length === 0 && ownSnippets.length === 0 && !isCreatingHere

        return (
            <div key={node.folder.id} className="mb-0.5" {...dropHandlers(node.folder.id)}>
                <div
                    draggable={!isRenaming}
                    onDragStart={(e) => onDragStartItem(e, {kind: 'folder', id: node.folder.id})}
                    onDragEnd={onDragEnd}
                    onClick={() => !isRenaming && toggleFolder(node.folder.id)}
                    onDoubleClick={() => startRenameFolder(node.folder)}
                    title={
                        isRenaming
                            ? undefined
                            : `${node.folder.name} — clic para ${expanded ? 'contraer' : 'expandir'}, doble clic para renombrar. Soltá un snippet o una carpeta encima para moverlo acá`
                    }
                    className={`group flex cursor-pointer select-none items-center gap-1 rounded-md py-1 pr-1 pl-0.5 text-xs transition-colors ${
                        isDropTarget
                            ? 'bg-primary-container text-on-primary-container ring-1 ring-primary'
                            : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
                    }`}
                >
                    <Icon name={expanded ? 'expand_more' : 'chevron_right'} size={16} className="shrink-0 opacity-70" />
                    <Icon name={expanded ? 'folder_open' : 'folder'} size={15} className="shrink-0 text-primary/80" filled />
                    {isRenaming ? (
                        <input
                            autoFocus
                            value={renameFolderName}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setRenameFolderName(e.target.value)}
                            onBlur={() => void commitRenameFolder()}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') void commitRenameFolder()
                                if (e.key === 'Escape') setRenamingFolderId(null)
                            }}
                            className="min-w-0 flex-1 rounded border-none bg-surface-container-highest px-1 py-0.5 text-xs text-on-surface outline-none focus:ring-1 focus:ring-primary"
                        />
                    ) : (
                        <>
                            <span className="min-w-0 flex-1 truncate font-medium">{node.folder.name}</span>
                            {/* El contador se esconde al pasar el mouse para
                                dejarle el lugar a los botones, igual que en el
                                árbol de conexiones. */}
                            <span className="shrink-0 font-mono text-ui-10 tabular-nums text-on-surface-variant/50 group-hover:hidden">
                                {total}
                            </span>
                            <div className="flex items-center" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                                <button
                                    onClick={() => startNew(node.folder.id)}
                                    title="Nuevo snippet en esta carpeta"
                                    className="hidden shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 group-hover:block"
                                >
                                    <Icon name="add" size={15} />
                                </button>
                                <ConnectionRowMenu
                                    flatFolders={flatFolders.filter(({folder}) => !blocked.has(folder.id))}
                                    onMoveToFolder={(parentId) => moveFolderTo(node.folder.id, parentId)}
                                    items={[
                                        {icon: 'add', label: 'Nuevo snippet aquí', onSelect: () => startNew(node.folder.id)},
                                        {icon: 'create_new_folder', label: 'Nueva subcarpeta', onSelect: () => startCreateFolder(node.folder.id)},
                                        {icon: 'edit', label: 'Renombrar', onSelect: () => startRenameFolder(node.folder)},
                                        {icon: 'arrow_upward', label: 'Subir', onSelect: () => void run(() => ReorderFolder(node.folder.id, 'up'))},
                                        {icon: 'arrow_downward', label: 'Bajar', onSelect: () => void run(() => ReorderFolder(node.folder.id, 'down'))},
                                        {
                                            icon: 'delete',
                                            label: 'Eliminar carpeta',
                                            title: 'Su contenido se mueve a la carpeta contenedora, nunca se borra',
                                            danger: true,
                                            onSelect: () => setDeleteFolderTarget(node.folder),
                                        },
                                    ]}
                                />
                            </div>
                        </>
                    )}
                </div>
                {expanded && (
                    // La línea guía a la izquierda es lo que deja ver de qué
                    // carpeta es cada snippet cuando el árbol tiene varios niveles.
                    <div className="ml-2.75 border-l border-outline-variant pt-0.5 pl-2">
                        {isCreatingHere && renderNewFolderInput()}
                        {node.children.map((child) => renderFolderNode(child))}
                        {ownSnippets.map((s) => renderSnippetRow(s))}
                        {isEmpty && !q && (
                            <button
                                onClick={() => startNew(node.folder.id)}
                                className="mb-1 flex w-full items-center gap-1 rounded px-1 py-1 text-left text-ui-11 text-on-surface-variant/70 hover:bg-surface-variant hover:text-on-surface"
                            >
                                <Icon name="add" size={13} />
                                Carpeta vacía — crear un snippet acá
                            </button>
                        )}
                    </div>
                )}
            </div>
        )
    }

    function renderForm() {
        const isNew = editingId === 'new'
        const canSave = !saving && !!formName.trim() && !!formScript.trim()
        return (
            <div className="flex flex-col gap-2 border-b border-outline-variant bg-surface-container-low p-2">
                <div className="flex items-center gap-1.5">
                    <Icon name={isNew ? 'add_circle' : 'edit'} size={15} className="text-primary" />
                    <span className="text-xs font-semibold text-on-surface">{isNew ? 'Nuevo snippet' : 'Editar snippet'}</span>
                    <div className="flex-1" />
                    <button onClick={cancelEdit} title="Cerrar sin guardar (Esc)" className={iconButton}>
                        <Icon name="close" size={14} />
                    </button>
                </div>
                <div className="flex gap-1.5">
                    <input
                        autoFocus={isNew}
                        value={formName}
                        onChange={(e) => setFormName(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Escape') cancelEdit()
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void saveForm()
                        }}
                        placeholder="Nombre (ej. Menú principal)"
                        className="min-w-0 flex-1 rounded-lg border border-outline bg-surface px-2 py-1.5 text-xs text-on-surface outline-none focus:border-primary"
                    />
                    <select
                        value={formFolderId}
                        onChange={(e) => setFormFolderId(e.target.value)}
                        title="Carpeta donde se guarda el snippet"
                        className="w-2/5 min-w-0 rounded-lg border border-outline bg-surface px-1.5 py-1.5 text-xs text-on-surface outline-none focus:border-primary"
                    >
                        <option value="">Sin carpeta</option>
                        {flatFolders.map(({folder, depth}) => (
                            <option key={folder.id} value={folder.id}>
                                {'\u00a0'.repeat(depth * 3)}
                                {folder.name}
                            </option>
                        ))}
                    </select>
                </div>
                <ShellScriptEditor
                    key={editingId ?? ''}
                    value={formScript}
                    onChange={setFormScript}
                    onSubmit={() => void saveForm()}
                    onCancel={cancelEdit}
                    autoFocus={!isNew}
                    placeholder={'# Una línea por comando\ncd /export/env/sgc\n./menu_principal.sh'}
                />
                <div className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-ui-10 text-on-surface-variant/70">
                        Tab indenta · Ctrl+Enter guarda · Esc cancela
                    </span>
                    <button onClick={cancelEdit} className="rounded px-2 py-1 text-xs text-on-surface-variant hover:text-on-surface">
                        Cancelar
                    </button>
                    <button
                        onClick={() => void saveForm()}
                        disabled={!canSave}
                        title="Guarda este snippet — queda disponible para cualquier terminal"
                        className="rounded bg-primary px-2.5 py-1 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
                    >
                        {saving ? 'Guardando…' : 'Guardar'}
                    </button>
                </div>
            </div>
        )
    }

    const rootDrop = dropHandlers('')
    const hasContent = rootSnippets.length > 0 || visibleFolderNodes.length > 0

    return (
        <div
            className="relative flex h-full shrink-0 flex-col border-l border-outline-variant bg-surface-container"
            style={{width}}
        >
            {/* Tirador superpuesto sobre el borde, no una columna del flex: una
                columna propia dejaría una franja visible al lado del borde,
                que es justo el píxel que uno intenta agarrar. */}
            <div
                onMouseDown={startResize}
                onDoubleClick={resetWidth}
                title="Arrastrar para cambiar el ancho del panel — queda guardado. Doble clic vuelve al ancho por defecto"
                className="absolute inset-y-0 -left-0.5 z-10 w-1.5 cursor-col-resize hover:bg-primary/30"
            />

            <div className="flex items-center gap-0.5 border-b border-outline-variant px-2 py-1.5">
                <Icon name="data_object" size={16} className="text-on-surface-variant" />
                <span className="ml-1 text-xs font-semibold uppercase tracking-wider text-on-surface-variant">Snippets</span>
                {!loading && <span className="ml-1 font-mono text-ui-10 tabular-nums text-on-surface-variant/50">{snippets.length}</span>}
                <div className="flex-1" />
                {folders.length > 0 && (
                    <>
                        <button onClick={() => setAllFolders(true)} title="Expandir todas las carpetas" className={iconButton}>
                            <Icon name="unfold_more" size={16} />
                        </button>
                        <button onClick={() => setAllFolders(false)} title="Contraer todas las carpetas" className={iconButton}>
                            <Icon name="unfold_less" size={16} />
                        </button>
                    </>
                )}
                <button onClick={() => startCreateFolder('')} title="Crea una carpeta para organizar snippets" className={iconButton}>
                    <Icon name="create_new_folder" size={16} />
                </button>
                <button
                    onClick={() => startNew()}
                    title="Crea un snippet nuevo: un comando o script reutilizable en cualquier terminal abierta, no solo esta"
                    className={iconButton}
                >
                    <Icon name="add" size={16} />
                </button>
                <button
                    onClick={onClose}
                    title="Cierra este panel — los snippets no se pierden, siguen disponibles la próxima vez que lo abras"
                    className={iconButton}
                >
                    <Icon name="close" size={16} />
                </button>
            </div>

            <div className="px-2 pt-2">
                <div className="flex items-center gap-1.5 rounded-lg bg-surface-container-highest px-2 focus-within:ring-1 focus-within:ring-primary">
                    <Icon name="search" size={14} className="shrink-0 text-on-surface-variant/60" />
                    <input
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        onKeyDown={(e) => e.key === 'Escape' && setFilter('')}
                        placeholder="Buscar..."
                        title="Busca por nombre o contenido del snippet, o por nombre de carpeta — una carpeta con una coincidencia se expande automáticamente"
                        className="min-w-0 flex-1 border-none bg-transparent py-1.5 text-xs text-on-surface outline-none placeholder:text-on-surface-variant/60"
                    />
                    {q && (
                        <>
                            <span className="shrink-0 font-mono text-ui-10 tabular-nums text-on-surface-variant/60">{matchCount}</span>
                            <button onClick={() => setFilter('')} title="Limpiar búsqueda (Esc)" className="shrink-0 rounded p-0.5 text-on-surface-variant hover:text-on-surface">
                                <Icon name="close" size={13} />
                            </button>
                        </>
                    )}
                </div>
            </div>

            {error && (
                <div className="mx-2 mt-1.5 flex items-start gap-1 rounded bg-error-container/40 px-2 py-1 text-ui-11 text-error">
                    <span className="min-w-0 flex-1">{error}</span>
                    <button onClick={() => setError('')} title="Descartar" className="shrink-0">
                        <Icon name="close" size={12} />
                    </button>
                </div>
            )}

            {editingId && <div className="mt-2">{renderForm()}</div>}

            <div
                {...rootDrop}
                className={`mt-1 min-h-0 flex-1 overflow-y-auto p-2 ${dropTarget === '' ? 'bg-primary/5 ring-1 ring-inset ring-primary/40' : ''}`}
            >
                {creatingFolderParentId === '' && renderNewFolderInput()}
                {loading && <p className="text-xs text-on-surface-variant">Cargando…</p>}
                {!loading && !hasContent && creatingFolderParentId !== '' && (
                    <div className="flex flex-col items-center gap-2 px-2 py-6 text-center">
                        <Icon name={q ? 'search_off' : 'data_object'} size={28} className="text-on-surface-variant/40" />
                        <p className="text-xs text-on-surface-variant">
                            {q ? `Sin coincidencias para "${filter}".` : 'Sin snippets todavía. Guardá comandos para reutilizarlos en cualquier terminal.'}
                        </p>
                        {!q && !editingId && (
                            <button
                                onClick={() => startNew()}
                                className="flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-xs font-medium text-on-primary hover:opacity-90"
                            >
                                <Icon name="add" size={14} />
                                Nuevo snippet
                            </button>
                        )}
                    </div>
                )}
                {visibleFolderNodes.map((node) => renderFolderNode(node))}
                {rootSnippets.length > 0 && visibleFolderNodes.length > 0 && (
                    <div className="mt-2 mb-1 px-1 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">Sin carpeta</div>
                )}
                {rootSnippets.map((s) => renderSnippetRow(s))}
            </div>

            {deleteTarget && (
                <ConfirmDialog
                    title="Eliminar snippet"
                    description={`"${deleteTarget.name}" se va a borrar permanentemente — no se puede deshacer.`}
                    confirmLabel="Eliminar"
                    danger
                    onConfirm={() => void confirmDelete()}
                    onClose={() => setDeleteTarget(null)}
                />
            )}
            {deleteFolderTarget && (
                <ConfirmDialog
                    title="Eliminar carpeta"
                    description={`Esto elimina la carpeta "${deleteFolderTarget.name}". Los snippets y subcarpetas que tenga adentro se mueven a la carpeta contenedora (o a la raíz) — nunca se borran.`}
                    confirmLabel="Eliminar"
                    danger
                    onConfirm={() => {
                        const id = deleteFolderTarget.id
                        setDeleteFolderTarget(null)
                        void run(() => DeleteFolder(id))
                    }}
                    onClose={() => setDeleteFolderTarget(null)}
                />
            )}
        </div>
    )
}
