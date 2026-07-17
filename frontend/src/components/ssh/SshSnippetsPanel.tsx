import {useEffect, useState} from 'react'
import {
    CreateFolder,
    CreateSshSnippet,
    DeleteFolder,
    DeleteSshSnippet,
    ListFolders,
    ListSshSnippets,
    MoveSshSnippetToFolder,
    RenameFolder,
    ReorderFolder,
    UpdateSshSnippet,
    WriteSSHTerminal,
} from '../../../wailsjs/go/main/App'
import {vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import ConfirmDialog from '../ConfirmDialog'
import MoveToFolderMenu, {flattenForMenu} from '../sidebar/MoveToFolderMenu'
import {buildFolderTree, type FolderNode} from '../../lib/folderTree'

interface SshSnippetsPanelProps {
    // Which live terminal session Ejecutar/Pegar write into — the panel
    // itself is global (same snippet list from any SSH tab, see
    // vault.SshSnippet's doc comment), only the target of Run/Paste is tab-
    // scoped.
    connId: string
    onClose: () => void
}

// Snippet folders live in their own scope ('ssh-snippet') on the SAME
// `folders` table connections already use (schema_migrations version 14) —
// entirely independent tree from the 'db'/'ssh' connection folders, even if
// a folder happens to share a name, same pattern as SshConnectionTree.tsx's
// own 'ssh' scope.
const SNIPPET_FOLDER_SCOPE = 'ssh-snippet'

// "Run" executes every line (each terminated by \r, matching the byte xterm
// sends for a real Enter keypress — see SshTerminalTab.tsx's term.onData).
// "Paste" inserts the same text but leaves the LAST line uncommitted in the
// shell's prompt, so the user can review/extend it before pressing Enter
// themselves — same distinction Termius' own snippet Run/Paste buttons make.
// Single-line snippets: Run submits it, Paste just types it.
function runSnippet(connId: string, script: string) {
    const lines = script.split('\n')
    void WriteSSHTerminal(connId, lines.map((l) => l + '\r').join(''))
}

function pasteSnippet(connId: string, script: string) {
    const lines = script.split('\n')
    void WriteSSHTerminal(connId, lines.map((l, i) => (i < lines.length - 1 ? l + '\r' : l)).join(''))
}

export default function SshSnippetsPanel({connId, onClose}: SshSnippetsPanelProps) {
    const [snippets, setSnippets] = useState<vault.SshSnippet[]>([])
    const [folders, setFolders] = useState<vault.Folder[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [filter, setFilter] = useState('')

    // null = panel closed, 'new' = creating, an id = editing that snippet.
    const [editingId, setEditingId] = useState<string | null>(null)
    const [formName, setFormName] = useState('')
    const [formScript, setFormScript] = useState('')
    const [saving, setSaving] = useState(false)

    const [deleteTarget, setDeleteTarget] = useState<vault.SshSnippet | null>(null)
    const [deleteFolderTarget, setDeleteFolderTarget] = useState<vault.Folder | null>(null)
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
    const [creatingFolderParentId, setCreatingFolderParentId] = useState<string | null>(null)
    const [newFolderName, setNewFolderName] = useState('')
    const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)
    const [renameFolderName, setRenameFolderName] = useState('')

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
    }, [])

    const q = filter.trim().toLowerCase()
    const snippetMatches = (s: vault.SshSnippet) => !q || s.name.toLowerCase().includes(q) || s.script.toLowerCase().includes(q)
    const folderNameMatches = (f: vault.Folder) => !q || f.name.toLowerCase().includes(q)
    const folderTree = buildFolderTree(folders)
    const flatFoldersForMenu = flattenForMenu(folderTree)

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

    function toggleFolder(id: string) {
        setExpandedFolders((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    function startCreateFolder(parentId: string) {
        setExpandedFolders((prev) => (parentId ? new Set(prev).add(parentId) : prev))
        setCreatingFolderParentId(parentId)
        setNewFolderName('')
    }

    async function commitCreateFolder() {
        const name = newFolderName.trim()
        setCreatingFolderParentId(null)
        if (!name || creatingFolderParentId === null) {
            setNewFolderName('')
            return
        }
        try {
            await CreateFolder(name, creatingFolderParentId, SNIPPET_FOLDER_SCOPE)
            load()
        } catch (err) {
            setError(String(err))
        } finally {
            setNewFolderName('')
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

    async function reorderFolder(id: string, direction: 'up' | 'down') {
        try {
            await ReorderFolder(id, direction)
            load()
        } catch (err) {
            setError(String(err))
        }
    }

    async function deleteFolder(id: string) {
        try {
            await DeleteFolder(id)
            load()
        } catch (err) {
            setError(String(err))
        }
    }

    async function moveSnippetToFolder(id: string, folderId: string) {
        try {
            await MoveSshSnippetToFolder(id, folderId)
            load()
        } catch (err) {
            setError(String(err))
        }
    }

    function startNew() {
        setEditingId('new')
        setFormName('')
        setFormScript('')
    }

    function startEdit(s: vault.SshSnippet) {
        setEditingId(s.id)
        setFormName(s.name)
        setFormScript(s.script)
    }

    function cancelEdit() {
        setEditingId(null)
        setFormName('')
        setFormScript('')
    }

    async function saveForm() {
        if (!formName.trim() || !formScript.trim()) return
        setSaving(true)
        setError('')
        try {
            if (editingId === 'new') {
                await CreateSshSnippet(formName.trim(), formScript)
            } else if (editingId) {
                await UpdateSshSnippet(editingId, formName.trim(), formScript)
            }
            cancelEdit()
            load()
        } catch (err) {
            setError(String(err))
        } finally {
            setSaving(false)
        }
    }

    async function confirmDelete() {
        if (!deleteTarget) return
        try {
            await DeleteSshSnippet(deleteTarget.id)
            load()
        } catch (err) {
            setError(String(err))
        } finally {
            setDeleteTarget(null)
        }
    }

    const inputClass =
        'rounded-lg border border-outline bg-surface px-2 py-1.5 text-xs text-on-surface outline-none focus:border-primary'

    function renderNewFolderInput() {
        return (
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
                placeholder="Nombre de la carpeta..."
                className="mb-1 w-full rounded border-none bg-surface-container-highest px-2 py-1 text-xs text-on-surface outline-none placeholder:text-on-surface-variant/60 focus:ring-1 focus:ring-primary"
            />
        )
    }

    function renderSnippetRow(s: vault.SshSnippet, depth: number) {
        return (
            <div key={s.id} style={{marginLeft: depth * 12}} className="group mb-1.5 rounded-lg border border-outline-variant bg-surface-container-high p-2">
                <div className="flex items-center gap-1">
                    <Icon name="data_object" size={13} className="shrink-0 text-primary" />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-on-surface">{s.name}</span>
                    <button
                        onClick={() => startEdit(s)}
                        title="Editar este snippet"
                        className="rounded p-0.5 text-on-surface-variant/60 opacity-0 hover:bg-surface-variant hover:text-on-surface group-hover:opacity-100"
                    >
                        <Icon name="edit" size={13} />
                    </button>
                    <MoveToFolderMenu connId={s.id} flatFolders={flatFoldersForMenu} onMove={moveSnippetToFolder} />
                    <button
                        onClick={() => setDeleteTarget(s)}
                        title="Eliminar este snippet permanentemente"
                        className="rounded p-0.5 text-on-surface-variant/60 opacity-0 hover:bg-surface-variant hover:text-error group-hover:opacity-100"
                    >
                        <Icon name="delete" size={13} />
                    </button>
                </div>
                <pre className="mt-1 truncate font-mono text-[11px] text-on-surface-variant">
                    {s.script.split('\n')[0]}
                    {s.script.includes('\n') ? ' …' : ''}
                </pre>
                <div className="mt-1.5 flex gap-1.5">
                    <button
                        onClick={() => runSnippet(connId, s.script)}
                        title="Ejecuta cada línea de este snippet en la terminal, como si las tipearas y presionaras Enter"
                        className="flex items-center gap-1 rounded bg-secondary-container px-2 py-1 text-[11px] font-medium text-on-secondary-container hover:opacity-90"
                    >
                        <Icon name="play_arrow" size={12} filled />
                        Ejecutar
                    </button>
                    <button
                        onClick={() => pasteSnippet(connId, s.script)}
                        title="Escribe este snippet en la terminal sin ejecutarlo — la última línea queda sin confirmar para que la revises antes de Enter"
                        className="flex items-center gap-1 rounded bg-surface-container-highest px-2 py-1 text-[11px] text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="content_paste" size={12} />
                        Pegar
                    </button>
                </div>
            </div>
        )
    }

    function renderFolderNode(node: FolderNode, depth: number) {
        if (q && !folderHasVisibleContent(node)) return null

        const expanded = isFolderExpanded(node.folder.id)
        const isRenaming = renamingFolderId === node.folder.id
        const ownSnippets = snippets.filter((s) => (s.folderId ?? '') === node.folder.id && snippetMatches(s))
        const isCreatingHere = creatingFolderParentId === node.folder.id

        return (
            <div key={node.folder.id} className="mb-0.5" style={{marginLeft: depth * 12}}>
                <div className="group/folder flex items-center gap-1 rounded py-1 pr-1 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface">
                    <button
                        onClick={() => toggleFolder(node.folder.id)}
                        title={expanded ? 'Contraer carpeta' : 'Expandir carpeta'}
                        className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100"
                    >
                        <Icon name={expanded ? 'expand_more' : 'chevron_right'} size={16} />
                    </button>
                    <Icon name={expanded ? 'folder_open' : 'folder'} size={14} className="shrink-0 opacity-70" />
                    {isRenaming ? (
                        <input
                            autoFocus
                            value={renameFolderName}
                            onChange={(e) => setRenameFolderName(e.target.value)}
                            onBlur={() => void commitRenameFolder()}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') void commitRenameFolder()
                                if (e.key === 'Escape') setRenamingFolderId(null)
                            }}
                            className="min-w-0 flex-1 rounded border-none bg-surface-container-highest px-1 py-0.5 text-xs text-on-surface outline-none"
                        />
                    ) : (
                        <span className="min-w-0 flex-1 truncate font-medium">{node.folder.name}</span>
                    )}
                    {!isRenaming && (
                        <>
                            <button
                                onClick={() => startCreateFolder(node.folder.id)}
                                title="Nueva subcarpeta"
                                className="hidden shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 group-hover/folder:block"
                            >
                                <Icon name="create_new_folder" size={13} />
                            </button>
                            <button
                                onClick={() => void reorderFolder(node.folder.id, 'up')}
                                title="Mover arriba"
                                className="hidden shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 group-hover/folder:block"
                            >
                                <Icon name="arrow_upward" size={12} />
                            </button>
                            <button
                                onClick={() => void reorderFolder(node.folder.id, 'down')}
                                title="Mover abajo"
                                className="hidden shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 group-hover/folder:block"
                            >
                                <Icon name="arrow_downward" size={12} />
                            </button>
                            <button
                                onClick={() => startRenameFolder(node.folder)}
                                title="Renombrar carpeta"
                                className="hidden shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 group-hover/folder:block"
                            >
                                <Icon name="edit" size={12} />
                            </button>
                            <button
                                onClick={() => setDeleteFolderTarget(node.folder)}
                                title="Eliminar carpeta — su contenido se mueve a la carpeta contenedora, nunca se borra"
                                className="hidden shrink-0 rounded p-0.5 opacity-70 hover:text-error hover:opacity-100 group-hover/folder:block"
                            >
                                <Icon name="delete" size={12} />
                            </button>
                        </>
                    )}
                </div>
                {expanded && (
                    <div>
                        {isCreatingHere && <div style={{marginLeft: 18}}>{renderNewFolderInput()}</div>}
                        {node.children.map((child) => renderFolderNode(child, depth + 1))}
                        {ownSnippets.map((s) => renderSnippetRow(s, depth + 1))}
                    </div>
                )}
            </div>
        )
    }

    return (
        <div className="flex h-full w-72 shrink-0 flex-col border-l border-outline-variant bg-surface-container">
            <div className="flex items-center gap-1.5 border-b border-outline-variant px-2 py-1.5">
                <Icon name="data_object" size={16} className="text-on-surface-variant" />
                <span className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">Snippets</span>
                <div className="flex-1" />
                <button
                    onClick={() => startCreateFolder('')}
                    title="Crea una carpeta para organizar snippets"
                    className="rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="create_new_folder" size={16} />
                </button>
                <button
                    onClick={startNew}
                    title="Crea un snippet nuevo: un comando o script reutilizable en cualquier sesión SSH abierta, no solo esta"
                    className="rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="add" size={16} />
                </button>
                <button
                    onClick={onClose}
                    title="Cierra este panel — los snippets no se pierden, siguen disponibles la próxima vez que lo abras"
                    className="rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="close" size={16} />
                </button>
            </div>

            <div className="px-2 pt-2">
                <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Buscar..."
                    title="Busca por nombre o contenido del snippet, o por nombre de carpeta — una carpeta con una coincidencia se expande automáticamente"
                    className="w-full rounded-lg border-none bg-surface-container-highest px-3 py-1.5 text-xs text-on-surface outline-none placeholder:text-on-surface-variant/60 focus:ring-1 focus:ring-primary"
                />
            </div>
            {creatingFolderParentId === '' && <div className="px-2 pt-1.5">{renderNewFolderInput()}</div>}

            {error && <p className="px-2 pt-1 text-[11px] text-error">{error}</p>}

            {editingId && (
                <div className="flex flex-col gap-1.5 border-b border-outline-variant p-2">
                    <input
                        value={formName}
                        onChange={(e) => setFormName(e.target.value)}
                        placeholder="Nombre (ej. Menu)"
                        className={inputClass}
                    />
                    <textarea
                        value={formScript}
                        onChange={(e) => setFormScript(e.target.value)}
                        placeholder={'Comando(s) — una línea por comando\ncd /export/env/sgc\n./menu_principal.sh'}
                        rows={4}
                        title="Cada línea se ejecuta como un comando separado al usar Ejecutar"
                        className={`${inputClass} font-mono`}
                    />
                    <div className="flex justify-end gap-1.5">
                        <button
                            onClick={cancelEdit}
                            title="Descarta este snippet sin guardar"
                            className="rounded px-2 py-1 text-xs text-on-surface-variant hover:text-on-surface"
                        >
                            Cancelar
                        </button>
                        <button
                            onClick={() => void saveForm()}
                            disabled={saving || !formName.trim() || !formScript.trim()}
                            title="Guarda este snippet — queda disponible para cualquier conexión SSH"
                            className="rounded bg-primary px-2 py-1 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
                        >
                            Guardar
                        </button>
                    </div>
                </div>
            )}

            <div className="mt-1 min-h-0 flex-1 overflow-y-auto p-2">
                {loading && <p className="text-xs text-on-surface-variant">Cargando…</p>}
                {!loading && rootSnippets.length === 0 && visibleFolderNodes.length === 0 && !editingId && (
                    <p className="text-xs text-on-surface-variant">
                        {q
                            ? `Sin coincidencias para "${filter}".`
                            : 'Sin snippets todavía. Creá uno con el botón + para reutilizar comandos en cualquier sesión SSH.'}
                    </p>
                )}
                {visibleFolderNodes.map((node) => renderFolderNode(node, 0))}
                {rootSnippets.map((s) => renderSnippetRow(s, 0))}
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
                    onConfirm={() => void deleteFolder(deleteFolderTarget.id)}
                    onClose={() => setDeleteFolderTarget(null)}
                />
            )}
        </div>
    )
}
