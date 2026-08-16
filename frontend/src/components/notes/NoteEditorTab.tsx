import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {EditorState, Compartment} from '@codemirror/state'
import {EditorView, keymap} from '@codemirror/view'
import {autocompletion, type CompletionContext, type CompletionResult} from '@codemirror/autocomplete'
import {basicSetup} from 'codemirror'
import {
    DeleteNote,
    GetNote,
    NoteBacklinks,
    NoteLinks,
    NoteTitles,
    SetNotePrivacy,
    UpdateNote,
} from '../../../wailsjs/go/main/App'
import {main, vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import ConfirmDialog from '../ConfirmDialog'
import MarkdownPreview from '../MarkdownPreview'
import {loadLanguage} from '../../codemirror/languageRegistry'
import {resolveEditorTheme, type EditorThemeId} from '../../codemirror/themes'
import type {Theme} from '../../hooks/useTheme'

// Una nota abierta: editor Markdown, control de privacidad y el panel de
// enlaces.
//
// **Markdown puro, sin formato propietario.** Una nota exportada a `.md` se
// abre en Obsidian sin pérdida. Guardar un formato de bloques propio dentro de
// una columna cifrada crearía documentación que solo esta app puede leer, y el
// usuario ya tiene una app así para credenciales — no para su documentación.

interface Props {
    noteId: string
    editorThemeId: string
    appTheme: Theme
    // Abrir otra nota (desde un enlace o desde los backlinks).
    onOpenNote: (id: string) => void
    // Crear la nota que un enlace roto nombra.
    onCreateNote: (title: string) => void
    onClosed: () => void
    // Avisa que algo cambió, para que la lista del sidebar se refresque.
    onChanged: () => void
}

export default function NoteEditorTab({
    noteId,
    editorThemeId,
    appTheme,
    onOpenNote,
    onCreateNote,
    onClosed,
    onChanged,
}: Props) {
    const [note, setNote] = useState<vault.Note | null>(null)
    const [title, setTitle] = useState('')
    const [content, setContent] = useState('')
    const [dirty, setDirty] = useState(false)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState('')
    const [preview, setPreview] = useState(false)
    const [links, setLinks] = useState<vault.NoteLink[]>([])
    const [backlinks, setBacklinks] = useState<vault.NoteLink[]>([])
    const [confirmShare, setConfirmShare] = useState(false)
    const [confirmDelete, setConfirmDelete] = useState(false)

    const hostRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)
    const themeComp = useRef(new Compartment())
    const langComp = useRef(new Compartment())
    const contentRef = useRef(content)
    contentRef.current = content
    const titleRef = useRef(title)
    titleRef.current = title

    // --- carga -------------------------------------------------------------

    useEffect(() => {
        let cancelled = false
        GetNote(noteId)
            .then((n) => {
                if (cancelled) return
                setNote(n)
                setTitle(n.title)
                setContent(n.content)
                setDirty(false)
            })
            .catch((e) => !cancelled && setError(String(e)))
        return () => {
            cancelled = true
        }
    }, [noteId])

    const reloadLinks = useCallback(() => {
        NoteLinks(noteId)
            .then((l) => setLinks(l ?? []))
            .catch(() => setLinks([]))
        NoteBacklinks(noteId)
            .then((l) => setBacklinks(l ?? []))
            .catch(() => setBacklinks([]))
    }, [noteId])

    useEffect(reloadLinks, [reloadLinks])

    // --- guardado ----------------------------------------------------------

    const save = useCallback(async () => {
        if (!titleRef.current.trim()) {
            setError('La nota necesita un título: es lo que la hace enlazable con [[…]]')
            return
        }
        setSaving(true)
        setError('')
        try {
            await UpdateNote(noteId, titleRef.current, contentRef.current, note?.frontmatter ?? '')
            setDirty(false)
            reloadLinks()
            onChanged()
        } catch (e) {
            setError(String(e))
        } finally {
            setSaving(false)
        }
    }, [noteId, note?.frontmatter, reloadLinks, onChanged])

    // El atajo de guardar se registra UNA vez al montar el editor, así que no
    // puede cerrarse sobre esta función: quedaría con el estado del primer
    // render. Se llama a través del ref, que siempre apunta a la actual.
    const saveRef = useRef(save)
    saveRef.current = save

    // Guardado automático con retardo. Una nota no es un archivo de código: no
    // hay compilación que romper con un guardado a medias, y perder tres
    // párrafos por no haber apretado Ctrl+S es la peor forma de perder
    // documentación.
    useEffect(() => {
        if (!dirty) return
        const t = setTimeout(() => void save(), 1200)
        return () => clearTimeout(t)
    }, [dirty, title, content, save])

    // --- editor ------------------------------------------------------------

    // Autocompletado de `[[`: los títulos los sirve el backend descifrando en
    // memoria — nunca hay una lista de títulos en claro persistida.
    const wikiLinkSource = useCallback(async (ctx: CompletionContext): Promise<CompletionResult | null> => {
        const before = ctx.state.sliceDoc(Math.max(0, ctx.pos - 200), ctx.pos)
        const open = before.lastIndexOf('[[')
        if (open < 0) return null
        const typed = before.slice(open + 2)
        // Un `[[` ya cerrado no abre el selector, y un salto de línea lo
        // cancela: `[[` suelto en un párrafo anterior no puede seguir
        // completando tres líneas más abajo.
        if (typed.includes(']]') || typed.includes('\n')) return null

        const titles = await NoteTitles().catch(() => [] as main.NoteTitle[])
        const q = typed.toLowerCase()
        const options = titles
            .filter((t) => t.title.toLowerCase().includes(q))
            .slice(0, 20)
            .map((t) => ({
                label: t.title,
                type: 'text',
                detail: t.isPrivate ? 'privada' : 'visible para la IA',
                apply: t.title + ']]',
            }))
        if (options.length === 0) return null
        return {from: ctx.pos - typed.length, options}
    }, [])

    useEffect(() => {
        if (!hostRef.current || viewRef.current) return
        const view = new EditorView({
            parent: hostRef.current,
            state: EditorState.create({
                doc: '',
                extensions: [
                    basicSetup,
                    EditorView.lineWrapping,
                    langComp.current.of([]),
                    themeComp.current.of(resolveEditorTheme(editorThemeId as EditorThemeId, appTheme)),
                    autocompletion({override: [wikiLinkSource]}),
                    keymap.of([
                        {
                            key: 'Mod-s',
                            run: () => {
                                void saveRef.current()
                                return true
                            },
                        },
                    ]),
                    EditorView.updateListener.of((u) => {
                        if (!u.docChanged) return
                        setContent(u.state.doc.toString())
                        setDirty(true)
                    }),
                ],
            }),
        })
        viewRef.current = view
        // Markdown con import() dinámico, nunca estático: los parsers de
        // lenguaje van cada uno a su chunk (regla 6 de technical.md).
        void loadLanguage('markdown').then((ext) => {
            if (ext) view.dispatch({effects: langComp.current.reconfigure(ext)})
        })
        return () => {
            view.destroy()
            viewRef.current = null
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // El documento se repone cuando cambia la nota, no en cada render: pisar
    // el contenido mientras se escribe movería el cursor al principio.
    useEffect(() => {
        const view = viewRef.current
        if (!view || note === null) return
        if (view.state.doc.toString() === content) return
        view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: content}})
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [noteId, note?.id])

    useEffect(() => {
        viewRef.current?.dispatch({
            effects: themeComp.current.reconfigure(resolveEditorTheme(editorThemeId as EditorThemeId, appTheme)),
        })
    }, [editorThemeId, appTheme])

    // --- privacidad --------------------------------------------------------

    const togglePrivacy = useCallback(() => {
        if (!note) return
        // Cerrarla es inmediato; abrirla pide confirmación. La asimetría es a
        // propósito: volver a esconder algo nunca puede salir mal, mostrarlo sí.
        if (!note.isPrivate) {
            void SetNotePrivacy(noteId, true).then(() => {
                setNote({...note, isPrivate: true} as vault.Note)
                onChanged()
            })
            return
        }
        setConfirmShare(true)
    }, [note, noteId, onChanged])

    const brokenLinks = useMemo(() => links.filter((l) => !l.targetId), [links])
    const resolvedLinks = useMemo(() => links.filter((l) => l.targetId), [links])

    if (error && !note) {
        return <p className="p-4 text-xs text-error">{error}</p>
    }

    return (
        <div className="flex h-full min-h-0 flex-col">
            {/* Barra de la nota */}
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-outline-variant bg-surface-container px-2 py-1">
                <input
                    value={title}
                    onChange={(e) => {
                        setTitle(e.target.value)
                        setDirty(true)
                    }}
                    placeholder="Título de la nota"
                    title="El título es lo que otras notas usan para enlazarla con [[…]]. Cambiarlo deja rotos los enlaces que le apuntaban — se ven marcados en la nota que los tiene."
                    className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm font-medium text-on-surface outline-none hover:border-outline-variant focus:border-primary"
                />

                {/* Insignia de privacidad: el control más importante de esta
                    barra, y por eso lleva texto y no solo un ícono. */}
                <button
                    onClick={togglePrivacy}
                    title={
                        note?.isPrivate
                            ? 'PRIVADA: ningún agente puede leer esta nota, ni por el chat ni por el servidor MCP. Sigue apareciendo en tu grafo y en tus búsquedas. Hacé clic para permitir que la lean.'
                            : 'VISIBLE PARA LA IA: los agentes pueden leer el contenido de esta nota si la referenciás o la buscan. Hacé clic para volver a esconderla.'
                    }
                    className={`flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
                        note?.isPrivate
                            ? 'border-outline-variant text-on-surface-variant hover:bg-surface-variant'
                            : 'border-tertiary/50 bg-tertiary/10 text-tertiary'
                    }`}
                >
                    <Icon name={note?.isPrivate ? 'lock' : 'lock_open'} size={12} filled={!note?.isPrivate} />
                    {note?.isPrivate ? 'Privado' : 'Acceso IA permitido'}
                </button>

                <button
                    onClick={() => setPreview((v) => !v)}
                    title={preview ? 'Volver a editar el Markdown' : 'Ver la nota renderizada, con los enlaces navegables'}
                    className={`shrink-0 rounded p-1 ${
                        preview ? 'bg-surface-variant text-on-surface' : 'text-on-surface-variant hover:bg-surface-variant'
                    }`}
                >
                    <Icon name={preview ? 'edit' : 'visibility'} size={15} />
                </button>

                <span className="shrink-0 text-[10px] text-on-surface-variant">
                    {saving ? 'Guardando…' : dirty ? 'Sin guardar' : 'Guardado'}
                </span>

                <button
                    onClick={() => setConfirmDelete(true)}
                    title="Borra esta nota. Los enlaces que le apuntaban desde otras notas quedan visibles como rotos, no se borran en silencio."
                    className="shrink-0 rounded p-1 text-on-surface-variant hover:bg-error-container hover:text-on-error-container"
                >
                    <Icon name="delete" size={15} />
                </button>
            </div>

            {note?.corrupt && (
                <p className="shrink-0 bg-error-container/40 px-2 py-1 text-[11px] text-error">
                    El checksum de esta nota no coincide con su contenido: puede haberse dañado. Se muestra igual para que
                    puedas rescatar lo que quede — al guardarla, el checksum se recalcula.
                </p>
            )}
            {error && note && <p className="shrink-0 px-2 py-1 text-[11px] text-error">{error}</p>}

            <div className="flex min-h-0 flex-1">
                <div className="min-h-0 min-w-0 flex-1 overflow-auto">
                    {/* El editor sigue montado detrás de la vista previa: si se
                        desmontara, se perdería el historial de deshacer cada vez
                        que se mira cómo quedó. */}
                    <div ref={hostRef} className="h-full" style={{display: preview ? 'none' : undefined}} />
                    {preview && (
                        <div className="p-3 text-sm text-on-surface">
                            <MarkdownPreview
                                source={content}
                                onWikiLink={(target) => {
                                    // Se resuelve contra los enlaces YA
                                    // indexados: si el destino existe se abre,
                                    // y si no, se ofrece crearlo con ese
                                    // título — que es como se arma el grafo.
                                    const known = links.find(
                                        (l) => l.title.trim().toLowerCase() === target.trim().toLowerCase(),
                                    )
                                    if (known?.targetId) onOpenNote(known.targetId)
                                    else onCreateNote(target)
                                }}
                            />
                        </div>
                    )}
                </div>

                {/* Panel de enlaces. Los backlinks son la mitad más útil del
                    grafo: los salientes ya se ven escribiendo, los entrantes son
                    los que uno no recuerda haber puesto. */}
                <div className="flex w-56 shrink-0 flex-col gap-2 overflow-y-auto border-l border-outline-variant bg-surface-container-low p-2 text-[11px]">
                    <LinkGroup
                        title="Enlaces salientes"
                        hint="Notas que ESTA menciona con [[…]]"
                        links={resolvedLinks}
                        onOpen={onOpenNote}
                    />

                    {brokenLinks.length > 0 && (
                        <div>
                            <p className="mb-1 flex items-center gap-1 font-medium text-on-surface-variant">
                                <Icon name="link_off" size={12} />
                                Sin crear ({brokenLinks.length})
                            </p>
                            {brokenLinks.map((l) => (
                                <button
                                    key={l.targetHash}
                                    onClick={() => onCreateNote(l.title || '')}
                                    title="Esta nota enlaza algo que todavía no existe. Hacé clic para crearla — así es como se va armando el grafo."
                                    className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-on-surface-variant hover:bg-surface-variant"
                                >
                                    <Icon name="add" size={11} className="shrink-0" />
                                    <span className="min-w-0 truncate italic">{l.title || 'nota sin título'}</span>
                                </button>
                            ))}
                        </div>
                    )}

                    <LinkGroup
                        title="Backlinks"
                        hint="Notas que apuntan a ESTA"
                        links={backlinks}
                        onOpen={onOpenNote}
                    />
                </div>
            </div>

            {confirmShare && (
                <ConfirmDialog
                    title="Permitir que los agentes lean esta nota"
                    description={`El contenido completo de «${title}» va a poder ser leído por Claude Code, Codex o Antigravity cuando la referencies con @note o cuando la busquen. Las credenciales, claves y datos personales que tenga adentro salen con ella. Podés volver a esconderla en cualquier momento.`}
                    confirmLabel="Permitir acceso"
                    onConfirm={() => {
                        void SetNotePrivacy(noteId, false).then(() => {
                            setNote((n) => (n ? ({...n, isPrivate: false} as vault.Note) : n))
                            onChanged()
                        })
                    }}
                    onClose={() => setConfirmShare(false)}
                />
            )}

            {confirmDelete && (
                <ConfirmDialog
                    title="Borrar la nota"
                    description={`«${title}» se borra del vault. Las notas que la enlazaban van a mostrar el enlace como roto, con la opción de volver a crearla. Esto no se puede deshacer.`}
                    confirmLabel="Borrar"
                    danger
                    onConfirm={() => {
                        void DeleteNote(noteId).then(() => {
                            onChanged()
                            onClosed()
                        })
                    }}
                    onClose={() => setConfirmDelete(false)}
                />
            )}
        </div>
    )
}

function LinkGroup({
    title,
    hint,
    links,
    onOpen,
}: {
    title: string
    hint: string
    links: vault.NoteLink[]
    onOpen: (id: string) => void
}) {
    return (
        <div>
            <p className="mb-1 font-medium text-on-surface-variant" title={hint}>
                {title} ({links.length})
            </p>
            {links.length === 0 ? (
                <p className="px-1 text-on-surface-variant/60">Ninguno</p>
            ) : (
                links.map((l) => (
                    <button
                        key={l.targetId + l.targetHash}
                        onClick={() => onOpen(l.targetId)}
                        title={l.isPrivate ? `${l.title} — privada` : l.title}
                        className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-surface-variant"
                    >
                        <Icon
                            name={l.isPrivate ? 'lock' : 'description'}
                            size={11}
                            className="shrink-0 text-on-surface-variant"
                        />
                        <span className="min-w-0 truncate text-on-surface">{l.title || 'Sin título'}</span>
                    </button>
                ))
            )}
        </div>
    )
}
