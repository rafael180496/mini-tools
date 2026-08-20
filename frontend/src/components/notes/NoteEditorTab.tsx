import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {EditorState, Compartment} from '@codemirror/state'
import {EditorView, keymap, drawSelection, placeholder} from '@codemirror/view'
import {history, historyKeymap, defaultKeymap} from '@codemirror/commands'
import {
    autocompletion,
    closeBrackets,
    closeBracketsKeymap,
    completionKeymap,
    type CompletionContext,
    type CompletionResult,
} from '@codemirror/autocomplete'
import {
    DeleteNote,
    GetNote,
    NoteBacklinks,
    NoteLinks,
    NoteStatsFor,
    NoteTags,
    SaveNoteImage,
    NoteTitles,
    SetNotePrivacy,
    UpdateNote,
} from '../../../wailsjs/go/main/App'
import {EventsOn} from '../../../wailsjs/runtime'
import {main, vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import ConfirmDialog from '../ConfirmDialog'
import MarkdownPreview from '../MarkdownPreview'
import NoteImage from './NoteImage'
import NoteToolbar, {type NoteAlign} from './NoteToolbar'
import RunbookSqlBlock from './RunbookSqlBlock'
import {useAgentChat} from '../agent/AgentChatHost'
import {loadLanguage} from '../../codemirror/languageRegistry'
import {slashCommandSource} from '../../codemirror/slashCommands'
import {notesEditorExtensions} from '../../codemirror/markdownTheme'
import {notesEnterEscapesMarks} from '../../codemirror/notesKeymap'
import {notesLivePreview} from '../../codemirror/notesLivePreview'
import {notesLint} from '../../codemirror/notesLint'
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
    // Publica el editor de CodeMirror hacia afuera, para que el chat pueda
    // insertar un bloque de código en la nota abierta. Se avisa también al
    // desmontar (con null): un editor destruido al que alguien todavía apunta
    // es un `dispatch` sobre una vista muerta.
    onViewReady?: (view: EditorView | null) => void
    // Avisa que algo cambió, para que la lista del sidebar se refresque. El
    // título viaja para que la pestaña se renombre con la nota — una pestaña
    // que dice "Nota" cuando el documento ya se llama otra cosa obliga a
    // abrirla para saber cuál es.
    onChanged: (title?: string) => void
}

// toStorableImage deja la imagen en un formato que el vault acepta.
//
// **Por qué hace falta.** El vault guarda solo PNG y JPG —por seguridad y por
// tamaño, ver backend/imageopt— pero el portapapeles no siempre da eso: una
// imagen copiada de una página web puede venir en WebP, y un GIF pegado viene
// como GIF. Rechazarlas sería técnicamente correcto y prácticamente molesto:
// quien pega una captura no sabe ni le importa en qué formato la puso el
// sistema.
//
// Entonces, si no es PNG ni JPG, se **redibuja en un lienzo y se exporta como
// PNG**: una conversión hacia PNG con los píxeles exactos que el navegador
// decodificó, no una recompresión con pérdida.
//
// Lo que el navegador no sabe decodificar —un TIFF, por ejemplo— falla acá con
// un mensaje que dice qué pasó, en vez de guardarse como un archivo roto.
async function toStorableImage(file: File): Promise<{dataURL: string; name: string}> {
    const read = (f: Blob) =>
        new Promise<string>((resolve, reject) => {
            const r = new FileReader()
            r.onload = () => resolve(String(r.result ?? ''))
            r.onerror = () => reject(new Error('No se pudo leer la imagen'))
            r.readAsDataURL(f)
        })

    const name = file.name || 'captura'
    if (file.type === 'image/png' || file.type === 'image/jpeg') {
        return {dataURL: await read(file), name}
    }

    const url = URL.createObjectURL(file)
    try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const el = new Image()
            el.onload = () => resolve(el)
            el.onerror = () =>
                reject(
                    new Error(
                        `No se pudo leer una imagen de tipo ${file.type || 'desconocido'}. Las notas guardan PNG y JPG; probá con una captura de pantalla.`,
                    ),
                )
            el.src = url
        })
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('No se pudo convertir la imagen')
        ctx.drawImage(img, 0, 0)
        return {dataURL: canvas.toDataURL('image/png'), name: name.replace(/\.[^.]+$/, '') + '.png'}
    } finally {
        URL.revokeObjectURL(url)
    }
}

// normalizeTitle replica NormalizeTitle del backend (minúsculas, espacios
// colapsados). Tiene que dar lo mismo, o un enlace que el backend resuelve acá
// se ofrecería crear de nuevo.
function normalizeTitle(t: string): string {
    return t.trim().toLowerCase().replace(/\s+/g, ' ')
}

export default function NoteEditorTab({
    noteId,
    editorThemeId,
    appTheme,
    onOpenNote,
    onCreateNote,
    onClosed,
    onViewReady,
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
    // Un agente reescribió ESTA nota mientras estaba abierta y hay cambios sin
    // guardar. No se recarga sola: pisar lo que la persona está escribiendo es
    // peor que mostrarle texto viejo. Se avisa y ella decide.
    const [externalChange, setExternalChange] = useState(false)
    const [confirmShare, setConfirmShare] = useState(false)
    const [confirmDelete, setConfirmDelete] = useState(false)
    // Números de la barra de estado: cuántas notas la enlazan y cuánto tiene
    // escrito. Se cuentan en el backend, donde el contenido ya está descifrado.
    const [stats, setStats] = useState<main.NoteStats | null>(null)
    // Alineación del documento. Vive en el frontmatter de la nota —un metadato
    // más— y no en el Markdown: ver NoteAlign.
    const [align, setAlign] = useState<NoteAlign>('left')
    const chat = useAgentChat()

    const hostRef = useRef<HTMLDivElement>(null)
    const fileInputRef = useRef<HTMLInputElement>(null)
    const viewRef = useRef<EditorView | null>(null)
    const langComp = useRef(new Compartment())
    const contentRef = useRef(content)
    contentRef.current = content
    const titleRef = useRef(title)
    titleRef.current = title
    // Lo lee el manejador del evento de "cambió por fuera", que se registra una
    // sola vez por nota: una copia capturada ahí se quedaría en el `false` del
    // montaje y recargaría encima de lo que se está escribiendo.
    const dirtyRef = useRef(dirty)
    dirtyRef.current = dirty

    // --- carga -------------------------------------------------------------

    useEffect(() => {
        let cancelled = false
        GetNote(noteId)
            .then((n) => {
                if (cancelled) return
                setNote(n)
                setTitle(n.title)
                setContent(n.content)
                setAlign(parseAlign(n.frontmatter))
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

    // La privacidad puede cambiar desde otra vista (el grafo, otro panel). La
    // insignia de esta barra tiene que seguirla: mostrar "Acceso IA permitido"
    // sobre una nota que ya está escondida es exactamente el error que un
    // control de privacidad no puede cometer.
    useEffect(
        () =>
            EventsOn('note:privacy', (payload: {id: string; isPrivate: boolean}) => {
                if (payload?.id !== noteId) return
                setNote((n) => (n ? ({...n, isPrivate: payload.isPrivate} as vault.Note) : n))
            }),
        [noteId],
    )

    // Una nota puede cambiar por fuera de esta pestaña: hoy, porque un agente la
    // reescribió por MCP. Sin esto el editor seguiría mostrando el texto viejo
    // y su autoguardado terminaría pisando lo que el agente acaba de escribir.
    //
    // Sin cambios sin guardar se recarga sola —no hay nada que perder—; con
    // cambios propios se avisa y decide la persona.
    const reloadFromDisk = useCallback(() => {
        GetNote(noteId)
            .then((n) => {
                setNote(n)
                setTitle(n.title)
                setContent(n.content)
                setAlign(parseAlign(n.frontmatter))
                setDirty(false)
                setExternalChange(false)
            })
            .catch((e) => setError(String(e)))
    }, [noteId])

    useEffect(
        () =>
            EventsOn('note:changed', (payload: {id: string; title: string}) => {
                if (payload?.id !== noteId) return
                if (dirtyRef.current) {
                    setExternalChange(true)
                    return
                }
                reloadFromDisk()
            }),
        [noteId, reloadFromDisk],
    )

    // Los números se recalculan al guardar, no en cada tecla: contar palabras
    // por pulsación sería un viaje al backend por letra.
    useEffect(() => {
        NoteStatsFor(noteId)
            .then(setStats)
            .catch(() => setStats(null))
    }, [noteId, dirty])

    // --- guardado ----------------------------------------------------------

    const save = useCallback(async () => {
        if (!titleRef.current.trim()) {
            setError('La nota necesita un título: es lo que la hace enlazable con [[…]]')
            return
        }
        setSaving(true)
        setError('')
        try {
            await UpdateNote(noteId, titleRef.current, contentRef.current, withAlign(note?.frontmatter ?? '', alignRef.current))
            setDirty(false)
            reloadLinks()
            onChanged(titleRef.current)
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
    // El linter se registra una sola vez con el editor, así que la acción de
    // "crear la nota" no puede cerrarse sobre el prop del primer render.
    const onCreateNoteRef = useRef(onCreateNote)
    onCreateNoteRef.current = onCreateNote
    const onOpenNoteRef = useRef(onOpenNote)
    onOpenNoteRef.current = onOpenNote
    const onViewReadyRef = useRef(onViewReady)
    onViewReadyRef.current = onViewReady
    // Mismo motivo que saveRef: el manejador se registra una sola vez con el
    // editor y no puede quedarse con la versión del primer render. Se declara
    // vacío y se llena más abajo, donde la función ya existe.
    const imageTransferRef = useRef<(d: DataTransfer | null) => boolean>(() => false)
    const alignRef = useRef<NoteAlign>('left')
    alignRef.current = align

    // Guardado automático con retardo. Una nota no es un archivo de código: no
    // hay compilación que romper con un guardado a medias, y perder tres
    // párrafos por no haber apretado Ctrl+S es la peor forma de perder
    // documentación.
    useEffect(() => {
        if (!dirty) return
        const t = setTimeout(() => void save(), 1200)
        return () => clearTimeout(t)
    }, [dirty, title, content, save])

    // openWikiTarget resuelve un `[[enlace]]` recién clickeado.
    //
    // **Contra los títulos de verdad y no contra la lista de enlaces ya
    // indexada**: los enlaces se indexan al GUARDAR, así que uno recién escrito
    // todavía no está en esa lista y el clic no habría hecho nada — justo el
    // caso en el que uno acaba de enlazar algo y quiere ir a verlo. Si el
    // destino no existe se ofrece crearlo, que es como se arma el grafo.
    const openWikiTarget = useCallback(async (target: string) => {
        const wanted = normalizeTitle(target)
        if (!wanted) return
        const titles = await NoteTitles().catch(() => [] as main.NoteTitle[])
        const hit = titles.find((t) => normalizeTitle(t.title) === wanted)
        if (hit) onOpenNoteRef.current(hit.id)
        else onCreateNoteRef.current(target.trim())
    }, [])
    const openWikiRef = useRef(openWikiTarget)
    openWikiRef.current = openWikiTarget

    // --- editor ------------------------------------------------------------

    // Autocompletado de etiquetas. Mismo principio que el de SQL: no se
    // inventan sugerencias, se ofrecen **las que ya existen en tus notas**.
    // Escribir `#prod` y que aparezca `#produccion` porque ya la usaste en
    // otras cuatro notas es lo que evita terminar con `#produccion`, `#prod` y
    // `#PROD` como tres etiquetas distintas para lo mismo.
    const tagSource = useCallback(async (ctx: CompletionContext): Promise<CompletionResult | null> => {
        const before = ctx.state.sliceDoc(ctx.state.doc.lineAt(ctx.pos).from, ctx.pos)
        const m = /(?:^|\s)(#[\p{L}\d_/-]*)$/u.exec(before)
        if (!m) return null
        // `# ` con espacio es un encabezado, no una etiqueta.
        if (m[1] === '#' && /^\s*#+\s/.test(before)) return null

        const typed = m[1].slice(1).toLowerCase()
        const tags = await NoteTags().catch(() => [] as vault.NoteTag[])
        const options = tags
            .filter((t) => t.tag.slice(1).toLowerCase().includes(typed))
            .slice(0, 15)
            .map((t) => ({
                label: t.tag,
                type: 'keyword',
                detail: `${t.count} ${t.count === 1 ? 'nota' : 'notas'}`,
                apply: t.tag + ' ',
            }))
        if (options.length === 0) return null
        return {from: ctx.pos - m[1].length, options}
    }, [])

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
                    // **Sin `basicSetup`**, y no es una simplificación: ese
                    // preajuste trae números de línea, gutter de plegado y —lo
                    // que rompía el autocompletado— su PROPIA instancia de
                    // `autocompletion()`. Dos instancias no se suman: la de
                    // abajo quedaba ignorada, así que ni `[[` ni `/` abrían
                    // nada. Además, un documento no tiene líneas numeradas: el
                    // gutter solo le daba aspecto de archivo de código.
                    history(),
                    drawSelection(),
                    closeBrackets(),
                    EditorView.lineWrapping,
                    placeholder('Escribí en Markdown. «[[» enlaza otra nota, «/» inserta un bloque.'),
                    langComp.current.of([]),
                    // Tipografía de documento: encabezados con peso real,
                    // ancho de lectura acotado, sin gutter. Ver markdownTheme.
                    ...notesEditorExtensions(),
                    // Vista en vivo: esconde las marcas de Markdown y muestra
                    // las imágenes, salvo en la línea donde está el cursor.
                    // El texto guardado no cambia — son decoraciones.
                    notesLivePreview((title) => void openWikiRef.current(title)),
                    // Dos fuentes de autocompletado: `[[` para enlazar notas y
                    // `/` para insertar bloques. Cada una decide sola si
                    // aplica, y la primera que contesta gana.
                    autocompletion({override: [wikiLinkSource, slashCommandSource, tagSource], icons: false}),
                    // Revisión del texto: enlaces a notas que no existen,
                    // encabezados sin espacio, bloques sin cerrar. Cada aviso
                    // trae su corrección aplicable — ver notesLint.
                    notesLint((title) => onCreateNoteRef.current(title)),
                    // Enter con el cursor pegado a una marca de cierre salta
                    // por encima en vez de partir el par — ver notesKeymap.
                    notesEnterEscapesMarks(),
                    keymap.of([
                        ...closeBracketsKeymap,
                        ...completionKeymap,
                        ...historyKeymap,
                        ...defaultKeymap,
                        {
                            key: 'Mod-s',
                            run: () => {
                                void saveRef.current()
                                return true
                            },
                        },
                    ]),
                    // Captura pegada (⌘⇧4 en macOS, Impr Pant en Windows) o
                    // imagen arrastrada al editor. Va acá y no en el div de
                    // afuera por el orden de los manejadores — ver
                    // imageFromTransfer.
                    EditorView.domEventHandlers({
                        paste: (event) => imageTransferRef.current(event.clipboardData),
                        drop: (event) => {
                            const handled = imageTransferRef.current(event.dataTransfer)
                            if (handled) event.preventDefault()
                            return handled
                        },
                    }),
                    EditorView.updateListener.of((u) => {
                        if (!u.docChanged) return
                        setContent(u.state.doc.toString())
                        setDirty(true)
                    }),
                ],
            }),
        })
        viewRef.current = view
        onViewReadyRef.current?.(view)
        // Markdown con import() dinámico, nunca estático: los parsers de
        // lenguaje van cada uno a su chunk (regla 6 de technical.md).
        void loadLanguage('markdown').then((ext) => {
            if (ext) view.dispatch({effects: langComp.current.reconfigure(ext)})
        })
        return () => {
            onViewReadyRef.current?.(null)
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

    // --- imágenes ----------------------------------------------------------

    // Guarda una imagen en el vault (cifrada) e inserta su referencia. `nota:ID`
    // es un esquema propio, no una ruta: el archivo no existe en el disco —
    // está adentro del vault, cifrado como el resto de la nota.
    const insertImage = useCallback(
        (dataURL: string, name: string) => {
            SaveNoteImage(noteId, dataURL)
                .then((assetId) => {
                    const view = viewRef.current
                    if (!view) return
                    const at = view.state.selection.main.head
                    const md = `\n![${name || 'imagen'}](nota:${assetId})\n`
                    view.dispatch({changes: {from: at, insert: md}, selection: {anchor: at + md.length}})
                    view.focus()
                    setDirty(true)
                })
                .catch((e) => setError(String(e)))
        },
        [noteId],
    )

    // Pegar o arrastrar una imagen.
    //
    // **El manejador se registra DENTRO de CodeMirror**, no solo en el div que
    // lo contiene. El editor tiene su propio manejador de `paste` sobre su
    // elemento editable y corre primero: un `onPaste` en un ancestro se entera
    // tarde y, con una captura de pantalla —que en el portapapeles no trae
    // texto—, el pegado terminaba sin hacer nada. Desde `domEventHandlers` se
    // intercepta antes y se devuelve `true` para que el editor no siga.
    const imageFromTransfer = useCallback(
        (data: DataTransfer | null): boolean => {
            const file = Array.from(data?.items ?? [])
                .find((i) => i.type.startsWith('image/'))
                ?.getAsFile()
            if (!file) return false

            void toStorableImage(file)
                .then(({dataURL, name}) => insertImage(dataURL, name))
                .catch((e) => setError(String(e)))
            return true
        },
        [insertImage],
    )

    imageTransferRef.current = imageFromTransfer

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
        // `flex-1 w-full min-w-0`: el contenedor de la pestaña es una FILA, así
        // que el eje principal es el ancho — sin pedir crecer, este bloque se
        // encogía al ancho de su contenido y dejaba media ventana vacía. Fue un
        // bug real: la nota se veía apretada contra el borde izquierdo.
        <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
            {/* Barra de la nota */}
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-outline-variant bg-surface-container px-2 py-1">
                <Icon name="description" size={14} className="shrink-0 text-on-surface-variant" />
                <span className="min-w-0 flex-1 truncate text-[11px] text-on-surface-variant" title={title}>
                    {title || 'Sin título'}
                </span>

                {/* Insignia de privacidad: el control más importante de esta
                    barra, y por eso lleva texto y no solo un ícono. */}
                <button
                    onClick={togglePrivacy}
                    title={
                        note?.isPrivate
                            ? 'PRIVADA: ningún agente puede leer esta nota, ni por el chat ni por el servidor MCP. Sigue apareciendo en tu grafo y en tus búsquedas. Hacé clic para volver a compartirla.'
                            : 'VISIBLE PARA LA IA (el estado por defecto): los agentes pueden leer el contenido de esta nota si la referenciás o la buscan. Hacé clic para esconderla.'
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

                {/* Chat de IA sobre ESTA nota. Es el mismo componente que el
                    resto de la app (components/agent/): se abre con la nota
                    como contexto de trabajo y con `@note:"…"` ya escrito, así
                    que el agente arranca con el documento adelante en vez de
                    pidiéndolo. Si la nota está marcada como privada, el
                    backend intercepta la referencia y lo dice — el botón no se
                    esconde, porque preguntar SOBRE una nota privada sin
                    mandarle el contenido sigue siendo válido. */}
                <button
                    onClick={() =>
                        chat.open({
                            context: {kind: 'note', id: noteId, label: title},
                            prompt: note?.isPrivate
                                ? ''
                                : `@note:"${title}" `,
                        })
                    }
                    disabled={!chat.hasAgent}
                    title={
                        !chat.hasAgent
                            ? 'No hay ningún CLI agéntico instalado. mini-tools usa Claude Code, Codex o Antigravity.'
                            : note?.isPrivate
                              ? 'Abre el chat con esta nota como contexto. Como está marcada como PRIVADA, su contenido no se le manda: podés preguntar igual, pero el agente no la lee.'
                              : 'Abre el chat con el contenido de esta nota ya referenciado, para preguntar sobre ella, ampliarla o revisar un procedimiento.'
                    }
                    className="shrink-0 rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-40"
                >
                    <Icon name="forum" size={15} />
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

            {!preview && (
                <NoteToolbar
                    view={viewRef.current}
                    align={align}
                    onAlign={(a) => {
                        setAlign(a)
                        setDirty(true)
                    }}
                    onPickImage={() => fileInputRef.current?.click()}
                    onToggleFold={() => {
                        const view = viewRef.current
                        if (!view) return
                        const at = view.state.selection.main.head
                        const md = '\n<details>\n<summary>Ver detalle</summary>\n\n\n\n</details>\n'
                        view.dispatch({changes: {from: at, insert: md}, selection: {anchor: at + 32}})
                        view.focus()
                    }}
                />
            )}

            {/* Un agente reescribió esta nota mientras se editaba. No se recarga
                sola porque hay cambios sin guardar: se ofrecen las dos salidas
                y ninguna se toma por el usuario. */}
            {externalChange && (
                <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-outline-variant bg-tertiary/10 px-3 py-1.5 text-[11px] text-on-surface">
                    <Icon name="smart_toy" size={14} className="shrink-0 text-tertiary" />
                    <span className="min-w-0 flex-1">
                        Un agente reescribió esta nota mientras la editabas. Tus cambios sin guardar siguen acá.
                    </span>
                    <button
                        onClick={reloadFromDisk}
                        title="Descarta lo que escribiste sin guardar y muestra la versión que dejó el agente"
                        className="shrink-0 rounded border border-outline-variant px-2 py-0.5 text-on-surface-variant hover:text-on-surface"
                    >
                        Ver la del agente
                    </button>
                    <button
                        onClick={() => setExternalChange(false)}
                        title="Sigue editando lo tuyo. Al guardar, tu versión reemplaza a la del agente — y la nota pasa a ser tuya: no la va a poder volver a cambiar."
                        className="shrink-0 rounded border border-outline-variant px-2 py-0.5 text-on-surface-variant hover:text-on-surface"
                    >
                        Seguir con lo mío
                    </button>
                </div>
            )}

            {/* Elegir una imagen del disco. Input oculto y no un diálogo nativo
                del backend: el archivo hay que leerlo igual para cifrarlo, así
                que pedirle la ruta al sistema no ahorraría ningún paso. */}
            <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg"
                className="hidden"
                onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) {
                        void toStorableImage(file)
                            .then(({dataURL, name}) => insertImage(dataURL, name))
                            .catch((err) => setError(String(err)))
                    }
                    // Se limpia para poder elegir el MISMO archivo dos veces.
                    e.target.value = ''
                }}
            />

            <div
                className="flex min-h-0 flex-1"
                onPaste={(e) => {
                    if (imageFromTransfer(e.clipboardData)) e.preventDefault()
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                    if (imageFromTransfer(e.dataTransfer)) e.preventDefault()
                }}
            >
                <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
                    {/* El título vive DENTRO del documento y en grande, no
                        como un campo de la barra: en una nota el título es la
                        primera línea de lo que estás escribiendo, no un
                        metadato de un formulario. */}
                    {/* Dos niveles a propósito. `mx-auto` en un hijo directo de
                        un contenedor flex-columna **desactiva el estirado** —
                        los márgenes automáticos absorben el espacio libre y el
                        bloque se encoge al ancho de su contenido, que era por
                        qué el título aparecía flotando en el medio de la
                        pantalla. El envoltorio ocupa el ancho completo y la
                        columna de lectura se centra adentro. */}
                    <div className="w-full shrink-0">
                    {/* Alineado a la IZQUIERDA, no centrado. Centrar una
                        columna de lectura funciona en una app de lectura a
                        pantalla completa; acá el editor convive con la barra
                        lateral y con el panel de enlaces, así que centrar
                        dejaba un hueco muerto a la izquierda y el texto
                        arrancaba en el medio de la nada. Con el ancho máximo se
                        conserva lo que importa —que la línea no cruce un
                        monitor entero— y el espacio sobrante queda de un solo
                        lado, que se lee como margen y no como error. */}
                    <div className="max-w-[52rem] pl-10 pr-8 pt-8">
                        <input
                            value={title}
                            onChange={(e) => {
                                setTitle(e.target.value)
                                setDirty(true)
                            }}
                            placeholder="Sin título"
                            title="El título es lo que otras notas usan para enlazarla con [[…]]. Cambiarlo deja rotos los enlaces que le apuntaban — se ven marcados en la nota que los tiene."
                            style={{textAlign: align}}
                            className="w-full border-none bg-transparent text-3xl font-bold leading-tight text-on-surface outline-none placeholder:text-on-surface-variant/40"
                        />
                        {note?.frontmatter?.trim() && (
                            <div className="mt-2 flex flex-wrap gap-1">
                                {note.frontmatter
                                    .split(/[,\n]/)
                                    .map((tag) => tag.trim())
                                    .filter((tag) => tag && !tag.startsWith('align:'))
                                    .map((tag) => (
                                        <span
                                            key={tag}
                                            className="rounded-full bg-primary/12 px-2 py-0.5 text-[11px] text-primary"
                                        >
                                            #{tag.replace(/^#/, '')}
                                        </span>
                                    ))}
                            </div>
                        )}
                    </div>
                    </div>

                    {/* El editor sigue montado detrás de la vista previa: si se
                        desmontara, se perdería el historial de deshacer cada vez
                        que se mira cómo quedó. */}
                    {/* El editor va debajo del título, sin su propio relleno
                        superior: el aire ya lo pone el bloque del título. */}
                    <div
                        ref={hostRef}
                        className="min-h-0 w-full flex-1"
                        style={{display: preview ? 'none' : undefined, textAlign: align}}
                    />
                    {preview && (
                        <div className="w-full">
                        <div style={{textAlign: align}} className="max-w-[52rem] pb-24 pl-10 pr-8 pt-4 text-[15px] leading-7 text-on-surface [&_h1]:mb-3 [&_h1]:mt-6 [&_h1]:text-3xl [&_h1]:font-bold [&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-2xl [&_h2]:font-bold [&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-lg [&_h3]:font-semibold [&_li]:my-1 [&_p]:my-3 [&_pre]:my-3 [&_ul]:my-3">
                            <MarkdownPreview
                                source={content}
                                // Cada renglón escrito es un renglón leído. En
                                // una nota el editor ES el documento: juntar
                                // dos líneas al leerlas contradice lo que se
                                // acaba de ver al escribirlas. Mismo default
                                // que Obsidian.
                                softBreaks
                                renderCodeBlock={({lang, code, key}) => {
                                    // ```sql connection="Prod" ─► bloque
                                    // ejecutable. Sin el atributo es un bloque
                                    // de código normal: un ejemplo de SQL en
                                    // una nota no tiene por qué traer un botón
                                    // que lo corra contra algo.
                                    const m = /^sql\s+connection\s*=\s*"([^"]+)"/i.exec(lang)
                                    if (!m) return null
                                    return <RunbookSqlBlock key={key} connectionName={m[1]} sql={code} />
                                }}
                                // El mismo resolvedor que el editor: un enlace
                                // se comporta igual escribiendo que leyendo.
                                onWikiLink={(target) => void openWikiTarget(target)}
                                // Las imágenes de una nota viven CIFRADAS en el
                                // vault (`nota:ID`): hay que descifrarlas para
                                // mostrarlas. Una imagen con URL externa se
                                // deja como texto — la app no sale a internet.
                                renderImage={({alt, src, key}) => {
                                    const m = /^nota:([a-f0-9]+)$/.exec(src)
                                    return m ? <NoteImage key={key} assetId={m[1]} alt={alt} /> : null
                                }}
                            />
                        </div>
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

            {/* Barra de estado: los dos números que dicen si la nota está
                conectada al resto y cuánto tiene escrito. Van abajo y en
                chico, como en cualquier editor de documentos. */}
            <div className="flex shrink-0 items-center gap-3 border-t border-outline-variant px-3 py-0.5 text-[10px] text-on-surface-variant">
                <span
                    title="Cuántas notas apuntan a esta con [[…]]. Cero significa que está aislada del resto de tu base de conocimiento."
                    className="flex items-center gap-1"
                >
                    <Icon name="link" size={11} />
                    {stats?.backlinks ?? 0} {stats?.backlinks === 1 ? 'backlink' : 'backlinks'}
                </span>
                <span title="Palabras del cuerpo de la nota" className="flex items-center gap-1">
                    <Icon name="menu_book" size={11} />
                    {(stats?.words ?? 0).toLocaleString('es')} palabras
                </span>
                <span
                    title="Líneas y caracteres. El editor de notas no muestra números de línea al costado —un documento no tiene líneas que referenciar— pero el número sigue estando acá cuando hace falta."
                    className="flex items-center gap-1"
                >
                    <Icon name="format_list_numbered" size={11} />
                    {content.split('\n').length.toLocaleString('es')} líneas ·{' '}
                    {(stats?.chars ?? 0).toLocaleString('es')} caracteres
                </span>
                <span className="ml-auto">{saving ? 'Guardando…' : dirty ? 'Sin guardar' : 'Guardado'}</span>
            </div>

            {confirmShare && (
                <ConfirmDialog
                    title="Volver a compartir esta nota con los agentes"
                    description={`El contenido completo de «${title}» va a poder ser leído por Claude Code, Codex o Antigravity cuando la referencies con @note o cuando la busquen. Las credenciales, claves y datos personales que tenga adentro salen con ella. Podés volver a esconderla en cualquier momento.`}
                    confirmLabel="Compartir"
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

// parseAlign / withAlign guardan la alineación dentro del frontmatter cifrado.
//
// Como una línea `align:justify` y no como una columna nueva: es una
// preferencia de presentación de UNA nota, y agregar una columna al esquema
// por eso obligaría a una migración por cada ajuste visual que se agregue
// después. El frontmatter ya es el lugar de los metadatos.
function parseAlign(frontmatter: string): NoteAlign {
    const m = /(?:^|[,\n])\s*align:\s*(left|center|right|justify)/.exec(frontmatter || '')
    return (m?.[1] as NoteAlign) ?? 'left'
}

function withAlign(frontmatter: string, align: NoteAlign): string {
    const rest = (frontmatter || '')
        .split(/[,\n]/)
        .map((p) => p.trim())
        .filter((p) => p && !p.startsWith('align:'))
    // 'left' es el valor por defecto: no se escribe, para no ensuciar el
    // frontmatter de todas las notas con un dato que no dice nada.
    if (align !== 'left') rest.push(`align:${align}`)
    return rest.join('\n')
}
