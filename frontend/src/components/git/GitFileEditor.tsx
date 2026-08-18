import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {EditorState, Compartment, type Extension} from '@codemirror/state'
import {EditorView, keymap} from '@codemirror/view'
import {indentWithTab} from '@codemirror/commands'
import {search} from '@codemirror/search'
import {basicSetup} from 'codemirror'
import {editorAppearanceExtension, type EditorAppearance} from '../../codemirror/editorAppearance'
import {GitListWorkTree, GitReadWorkFile, GitWriteWorkFile} from '../../../wailsjs/go/main/App'
import {git} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import ConfirmDialog from '../ConfirmDialog'
import {resolveEditorTheme} from '../../codemirror/themes'
import {LANGUAGE_OPTIONS, languageForPath, languageIfLoaded, languageLabel, loadLanguage, type LanguageId} from '../../codemirror/languageRegistry'
import {frontmatterLint, needsFrontmatter} from '../../codemirror/frontmatterLint'
import MarkdownPreview from '../MarkdownPreview'
import {ancestorsOf, buildFileTree, flatten} from '../../lib/fileTree'
import type {Theme} from '../../hooks/useTheme'

// Editor de archivos del árbol de trabajo, dentro de la pestaña Git.
//
// Por qué no reusa CodeMirrorTabbedEditor (el editor del workspace de base de
// datos): aquel existe para pestañas atadas a una CONEXIÓN — recibe
// `connId`/`dbType`/`schemaMetadata`, ceba el índice de esquema, y reconfigura
// su lenguaje cuando cambia la conexión vinculada. Un archivo del repositorio
// no tiene nada de eso, y lo que sí tiene (resolver el lenguaje por el nombre
// del archivo, cargarlo de forma asíncrona, guardar contra un mtime) aquel no
// tiene. Compartirían la mecánica de "una vista, un EditorState por pestaña" y
// nada más; unificarlos hoy significaría un componente con la unión de ambos
// juegos de props, la mitad inaplicable en cada caso.
//
// La mecánica que sí se copia, deliberadamente, es esa: una sola EditorView
// para todo el panel y un EditorState por archivo abierto, creado la primera
// vez que se lo visita y conservado al cambiar de pestaña. Como EditorState es
// inmutable, cada estado lleva su propio updateListener que reescribe la
// versión vigente en statesRef en CADA update — sin eso, el estado cacheado de
// una pestaña de fondo queda viejo (pierde ediciones o una reconfiguración de
// lenguaje/tema) apenas deja de ser la visible.

// Cuántas coincidencias se dibujan en la lista. ListWorkTree devuelve hasta
// 50.000 rutas y pintarlas todas congela el panel; el filtro es el que hace
// utilizable un repositorio grande, así que se muestra un tope y se dice
// cuántas quedaron afuera en vez de recortar en silencio.
const MAX_VISIBLE_FILES = 400

interface OpenFile {
    path: string
    // savedContent es lo último confirmado en disco: la diferencia contra el
    // contenido vivo del editor es lo que define "sin guardar".
    savedContent: string
    content: string
    modTimeUnix: number
    language: LanguageId
    binary: boolean
    tooLarge: boolean
}

interface GitFileEditorProps {
    repoId: string
    editorThemeId: string
    appTheme: Theme
    appearance: EditorAppearance
    // Archivo que el padre pide abrir al entrar a la vista (el botón "Editar"
    // del diff). Lleva un token además de la ruta porque pedir DOS VECES el
    // mismo archivo tiene que volver a enfocarlo: sin el token, el efecto no
    // se redispararía y el segundo click no haría nada.
    request?: {path: string; token: number} | null
    // Rutas que estaban abiertas la última vez (migración 30). Se leen del
    // disco al restaurar, nunca de una copia guardada del contenido: si un
    // agente tocó el archivo mientras la app estaba cerrada, lo correcto es
    // ver lo que hay ahora.
    initialFiles?: string[]
    onOpenFilesChange?: (paths: string[]) => void
    // Le pasa a la sesión de un agente una pregunta sobre este archivo (o
    // sobre lo que esté seleccionado). Ausente = la acción no se ofrece.
    onAskAgent?: (prompt: string, about: string) => void
    // Estado git de los archivos, para marcarlos en el árbol como en VSCode.
    // Se recibe del padre en vez de pedirlo acá: ya lo tiene, lo refresca con
    // su poll, y dos fuentes del mismo dato se contradicen.
    status?: git.RepoStatus | null
    // Se llama después de cada guardado: el archivo recién modificado tiene
    // que aparecer en Cambios sin esperar al siguiente poll de estado.
    onSaved: () => void
    onClose: () => void
}

const languageCompartment = new Compartment()
const themeCompartment = new Compartment()

// isNotFound distingue "ese archivo no existe" de cualquier otro fallo.
//
// Se mira el texto porque un error que cruza el binding de Wails llega como
// string, sin el tipo que tenía en Go. Se contemplan las dos formas en que
// puede venir el mensaje del sistema operativo (`os.ReadFile` no está
// traducido y depende del idioma/plataforma) además del envoltorio en
// castellano que agrega backend/git.
function isNotFound(e: unknown): boolean {
    const msg = String(e).toLowerCase()
    return msg.includes('no such file') || msg.includes('cannot find the file') || msg.includes('no existe')
}

// statusColor y statusTitle traducen el código de git a algo legible.
//
// Los colores siguen la convención que ya usa el resto de la app y que
// cualquiera reconoce de otros editores: verde lo nuevo, amarillo lo
// modificado, rojo lo borrado o en conflicto.
function statusColor(code?: string): string {
    switch (code) {
        case 'A':
        case '?':
            return 'text-secondary'
        case 'M':
        case 'R':
            return 'text-tertiary'
        case 'D':
        case 'U':
            return 'text-error'
        default:
            return ''
    }
}

function statusTitle(code?: string): string {
    switch (code) {
        case 'A':
            return 'Agregado'
        case '?':
            return 'Sin rastrear — todavía no está en git'
        case 'M':
            return 'Modificado'
        case 'R':
            return 'Renombrado'
        case 'D':
            return 'Borrado'
        case 'U':
            return 'En conflicto'
        default:
            return code ?? ''
    }
}

// Fuente, cuerpo y demás llegan por prop y viajan en el mismo compartment
// que el tema — ver frontend/src/codemirror/editorAppearance.ts. Antes esto
// era un EditorView.theme fijo, idéntico por copiar y pegar al del editor
// SQL, que es exactamente la forma en que dos editores de la misma app
// terminan viéndose distinto sin que nadie lo haya decidido.

export default function GitFileEditor({
    repoId,
    editorThemeId,
    appTheme,
    appearance,
    request,
    initialFiles,
    onOpenFilesChange,
    onAskAgent,
    status,
    onSaved,
    onClose,
}: GitFileEditorProps) {
    const [tree, setTree] = useState<git.WorkTree | null>(null)
    const [treeError, setTreeError] = useState('')
    const [filter, setFilter] = useState('')
    const [files, setFiles] = useState<OpenFile[]>([])
    const [activePath, setActivePath] = useState<string | null>(null)
    const [error, setError] = useState('')
    const [saving, setSaving] = useState(false)
    // Guardado que chocó con un cambio externo, a la espera de que el usuario
    // decida pisarlo.
    const [conflict, setConflict] = useState<string | null>(null)
    // Cómo se ve un Markdown: el código, el documento formateado, o los dos.
    //
    // Son tres modos y no un interruptor porque son tres tareas distintas:
    // escribir (código), revisar cómo queda (vista), y corregir mirando el
    // resultado (dividido). Un toggle obliga a elegir entre las dos primeras
    // sin poder tener la tercera. Es preferencia del panel y no del archivo:
    // quien escribe documentación la quiere igual para todos sus .md.
    const [mdView, setMdView] = useState<'code' | 'split' | 'preview'>('code')
    // Carpetas abiertas del árbol. Empieza vacío: en un repositorio de miles
    // de archivos, expandir todo de entrada es la misma lista plana ilegible
    // que esto vino a reemplazar.
    const [expanded, setExpanded] = useState<Set<string>>(new Set())

    const containerRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)
    const statesRef = useRef<Map<string, EditorState>>(new Map())
    // activePath vigente para los callbacks asíncronos (la carga de un
    // lenguaje), que se cierran sobre el valor del render en el que arrancaron
    // y no pueden reconfigurar la vista si la pestaña ya cambió.
    const activePathRef = useRef<string | null>(null)
    activePathRef.current = activePath
    // El keymap de Cmd+S se registra una sola vez al crear cada EditorState,
    // así que no puede capturar el `files` de ese render — pasa por un ref que
    // siempre apunta al guardado vigente.
    const saveActiveRef = useRef<() => void>(() => {})

    const active = files.find((f) => f.path === activePath) ?? null
    const dirtyPaths = useMemo(() => new Set(files.filter((f) => f.content !== f.savedContent).map((f) => f.path)), [files])

    // --- Árbol de archivos --------------------------------------------------

    const reloadTree = useCallback(() => {
        GitListWorkTree(repoId)
            .then((t) => {
                setTree(t)
                setTreeError('')
            })
            .catch((e) => setTreeError(String(e)))
    }, [repoId])

    useEffect(() => {
        reloadTree()
    }, [reloadTree])

    const fileTree = useMemo(() => buildFileTree(tree?.files ?? []), [tree])

    // Estado por ruta y, además, propagado a las CARPETAS: si un cambio queda
    // escondido dentro de un directorio plegado, el árbol no sirve para lo que
    // uno lo mira en un repositorio con trabajo a medias. Es lo mismo que hace
    // VSCode marcando la carpeta que contiene algo modificado.
    const fileStatus = useMemo(() => {
        const byPath = new Map<string, string>()
        // Cuántos archivos cambiados hay dentro de cada carpeta. Solo con el
        // color, una carpeta marcada obliga a abrirla para saber si adentro
        // hay un archivo o veinte — que es la pregunta que uno se hace al
        // mirar el árbol en un repo con trabajo a medias.
        const dirs = new Map<string, number>()
        for (const f of status?.files ?? []) {
            // El código de git son dos letras (índice y árbol de trabajo); se
            // muestra la que no sea un espacio, priorizando el working tree,
            // que es lo que la persona acaba de tocar.
            const code = (f.workStatus || f.indexStatus || '').trim()
            if (!code) continue
            byPath.set(f.path, code)
            for (const dir of ancestorsOf(f.path)) dirs.set(dir, (dirs.get(dir) ?? 0) + 1)
        }
        return {byPath, dirs}
    }, [status])

    // Buscando se muestran RESULTADOS planos, no el árbol: cuando uno filtra
    // ya sabe qué busca y quiere verlo, no navegar hasta él. Es el mismo
    // comportamiento de cualquier explorador de archivos.
    const searchResults = useMemo(() => {
        const q = filter.trim().toLowerCase()
        if (!q) return null
        const all = tree?.files ?? []
        const matched = all.filter((p) => p.toLowerCase().includes(q))
        return {rows: matched.slice(0, MAX_VISIBLE_FILES), total: matched.length}
    }, [tree, filter])

    const rows = useMemo(() => (searchResults ? [] : flatten(fileTree, expanded)), [searchResults, fileTree, expanded])

    const toggleDir = useCallback((path: string) => {
        setExpanded((prev) => {
            const next = new Set(prev)
            if (next.has(path)) next.delete(path)
            else next.add(path)
            return next
        })
    }, [])

    // Abrir un archivo desde afuera (el botón Editar del diff, el panel de
    // agentes) abre además sus carpetas: si no, el árbol no muestra dónde
    // quedó parado y la pestaña aparece sin contexto.
    const revealInTree = useCallback((path: string) => {
        setExpanded((prev) => {
            const next = new Set(prev)
            for (const dir of ancestorsOf(path)) next.add(dir)
            return next
        })
    }, [])

    // --- Abrir / cerrar -----------------------------------------------------

    const openFile = useCallback(
        async (path: string) => {
            setError('')
            if (files.some((f) => f.path === path)) {
                setActivePath(path)
                return
            }
            let opened: OpenFile
            try {
                const f = await GitReadWorkFile(repoId, path)
                opened = {
                    path,
                    savedContent: f.content,
                    content: f.content,
                    modTimeUnix: f.modTimeUnix,
                    language: languageForPath(path),
                    binary: f.binary,
                    tooLarge: f.tooLarge,
                }
            } catch (e) {
                // Un archivo que no existe se abre como uno NUEVO y vacío, no
                // como un error. Es lo que hace accionable al panel de
                // agentes: ahí se ofrece crear el AGENTS.md o el GEMINI.md que
                // al repositorio le falta, y eso solo sirve si al hacer click
                // se puede empezar a escribirlo. modTimeUnix 0 es "no había
                // nada abajo", así que el primer guardado no dispara el
                // diálogo de conflicto contra un archivo inexistente.
                if (!isNotFound(e)) {
                    setError(String(e))
                    return
                }
                opened = {
                    path,
                    savedContent: '',
                    content: '',
                    modTimeUnix: 0,
                    language: languageForPath(path),
                    binary: false,
                    tooLarge: false,
                }
            }
            setFiles((prev) => (prev.some((p) => p.path === path) ? prev : [...prev, opened]))
            setActivePath(path)
        },
        [repoId, files],
    )

    const closeFile = useCallback(
        (path: string) => {
            statesRef.current.delete(path)
            // Los dos setState van uno al lado del otro y no anidados: encadenar
            // un setActivePath DENTRO del updater de setFiles lo convierte en un
            // reducer con efecto, y React lo invoca dos veces en StrictMode.
            setFiles((prev) => prev.filter((f) => f.path !== path))
            setActivePath((current) => {
                if (current !== path) return current
                const rest = files.filter((f) => f.path !== path)
                return rest[rest.length - 1]?.path ?? null
            })
        },
        [files],
    )

    // openFile vigente, para los efectos que no deben depender de él: se
    // recrea con cada cambio de `files` y ponerlo en las dependencias haría
    // que reabran archivos en cada tecleo.
    const openFileRef = useRef(openFile)
    openFileRef.current = openFile

    // Restaurar las pestañas de la sesión anterior (migración 30). Corre una
    // sola vez: `initialFiles` cambia de identidad en cada render del padre y
    // depender de él reabriría lo que el usuario acaba de cerrar.
    const restoredRef = useRef(false)
    useEffect(() => {
        if (restoredRef.current || !initialFiles?.length) return
        restoredRef.current = true
        void (async () => {
            for (const path of initialFiles) {
                await openFileRef.current(path)
            }
        })()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialFiles])

    // Avisar al padre qué quedó abierto, para que lo persista. Se manda la
    // lista de rutas y nunca el contenido: al reabrir hay que leer el archivo
    // como está en el disco.
    useEffect(() => {
        onOpenFilesChange?.(files.map((f) => f.path))
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [files.map((f) => f.path).join('\n')])

    // Apertura pedida desde afuera (el botón "Editar" del diff). Depende solo
    // del token: incluir openFile en las dependencias lo redispararía en cada
    // cambio de `files`, reabriendo el archivo mientras se lo edita.
    useEffect(() => {
        if (request?.path) {
            revealInTree(request.path)
            void openFileRef.current(request.path)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [request?.token])

    // --- Guardar ------------------------------------------------------------

    const save = useCallback(
        async (path: string, force: boolean) => {
            const file = files.find((f) => f.path === path)
            if (!file || file.binary || file.tooLarge) return
            setSaving(true)
            setError('')
            try {
                const newModTime = await GitWriteWorkFile(repoId, path, file.content, force ? 0 : file.modTimeUnix)
                setFiles((prev) =>
                    prev.map((f) => (f.path === path ? {...f, savedContent: f.content, modTimeUnix: newModTime} : f)),
                )
                setConflict(null)
                // El árbol también se recarga: guardar un archivo nuevo lo
                // convierte en uno que git ya conoce.
                reloadTree()
                onSaved()
            } catch (e) {
                const msg = String(e)
                // El backend distingue este caso con un error propio
                // (git.ErrWorkFileChanged) justamente para poder ofrecer
                // "guardar igual" en vez de fallar sin salida.
                if (msg.includes('cambió en el disco')) setConflict(path)
                else setError(msg)
            } finally {
                setSaving(false)
            }
        },
        [repoId, files, onSaved, reloadTree],
    )

    saveActiveRef.current = () => {
        if (activePath) void save(activePath, false)
    }

    // --- CodeMirror ---------------------------------------------------------

    const createState = useCallback(
        (file: OpenFile, theme: Extension): EditorState =>
            EditorState.create({
                doc: file.content,
                extensions: [
                    basicSetup,
                    search(),
                    keymap.of([
                        indentWithTab,
                        {
                            key: 'Mod-s',
                            // preventDefault vía `true`: sin esto el webview se
                            // queda con Cmd+S y ofrece "guardar la página".
                            run: () => {
                                saveActiveRef.current()
                                return true
                            },
                        },
                    ]),
                    // Arranca con lo que ya esté cargado y se reconfigura
                    // cuando el import() del lenguaje resuelve. Empezar vacío
                    // es lo que evita que el chunk de cada lenguaje entre al
                    // bundle inicial.
                    languageCompartment.of(languageIfLoaded(file.language) ?? []),
                    // Solo para los archivos cuyo frontmatter decide si el CLI
                    // los carga. Un README no lleva y marcarlo sería ruido.
                    ...(needsFrontmatter(file.path) ? [frontmatterLint()] : []),
                    themeCompartment.of(theme),
                    EditorView.updateListener.of((update) => {
                        statesRef.current.set(file.path, update.state)
                        if (update.docChanged) {
                            const text = update.state.doc.toString()
                            setFiles((prev) => prev.map((f) => (f.path === file.path ? {...f, content: text} : f)))
                        }
                    }),
                ],
            }),
        [],
    )

    // Montaje único de la vista compartida.
    useEffect(() => {
        if (!containerRef.current) return
        const view = new EditorView({parent: containerRef.current, state: EditorState.create({extensions: [basicSetup, ...editorAppearanceExtension(appearance)]})})
        viewRef.current = view
        return () => {
            view.destroy()
            statesRef.current.clear()
            viewRef.current = null
        }
    }, [])

    // Cambiar de pestaña: crear el estado en la primera visita y conservarlo.
    useEffect(() => {
        const view = viewRef.current
        if (!view || !active) return
        let state = statesRef.current.get(active.path)
        if (!state) {
            state = createState(active, [resolveEditorTheme(editorThemeId, appTheme), ...editorAppearanceExtension(appearance)])
            statesRef.current.set(active.path, state)
        }
        view.setState(state)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activePath])

    // Cargar el lenguaje del archivo activo y reconfigurarlo cuando llegue.
    const activeLanguage = active?.language
    useEffect(() => {
        if (!activeLanguage || !activePath) return
        let cancelled = false
        void loadLanguage(activeLanguage).then((ext) => {
            if (cancelled || !ext) return
            const view = viewRef.current
            // La pestaña pudo cambiar mientras el chunk viajaba: reconfigurar
            // la vista entonces le pondría a un archivo el lenguaje de otro.
            if (view && statesRef.current.has(activePath) && activePath === activePathRef.current) {
                view.dispatch({effects: languageCompartment.reconfigure(ext)})
            } else {
                const stored = statesRef.current.get(activePath)
                if (stored) {
                    statesRef.current.set(activePath, stored.update({effects: languageCompartment.reconfigure(ext)}).state)
                }
            }
        })
        return () => {
            cancelled = true
        }
    }, [activeLanguage, activePath])

    // El tema es de la app entera, así que se reconfiguran TODOS los estados y
    // no solo el visible — si no, una pestaña a la que se vuelve después
    // aparece con el tema viejo.
    useEffect(() => {
        const view = viewRef.current
        if (!view) return
        const themeExt: Extension = [resolveEditorTheme(editorThemeId, appTheme), ...editorAppearanceExtension(appearance)]
        for (const [path, state] of statesRef.current) {
            statesRef.current.set(path, state.update({effects: themeCompartment.reconfigure(themeExt)}).state)
        }
        if (activePath) {
            const state = statesRef.current.get(activePath)
            if (state) view.setState(state)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editorThemeId, appTheme, appearance])

    // Cambio manual de lenguaje desde el selector de la barra.
    const setLanguage = useCallback(
        (path: string, id: LanguageId) => {
            setFiles((prev) => prev.map((f) => (f.path === path ? {...f, language: id} : f)))
            void loadLanguage(id).then((ext) => {
                const view = viewRef.current
                if (view && path === activePathRef.current) {
                    view.dispatch({effects: languageCompartment.reconfigure(ext ?? [])})
                }
            })
        },
        [],
    )

    // --- Render -------------------------------------------------------------

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-3 py-1.5 text-xs">
                <Icon name="edit_document" size={15} className="shrink-0 text-primary" />
                <span className="font-semibold text-on-surface">Archivos</span>
                {tree && <span className="text-on-surface-variant">{tree.files.length}</span>}
                {saving && <span className="text-on-surface-variant">Guardando…</span>}
                <button
                    onClick={reloadTree}
                    title="Vuelve a listar los archivos del repositorio — útil después de que un agente o un checkout cree archivos nuevos"
                    className="ml-auto shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="refresh" size={15} />
                </button>
                <button onClick={onClose} title="Cierra el editor de archivos" className="shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface">
                    <Icon name="close" size={16} />
                </button>
            </div>

            {error && <p className="shrink-0 border-b border-outline-variant px-3 py-1 text-xs text-error">{error}</p>}

            <div className="flex min-h-0 flex-1">
                {/* Lista de archivos */}
                {/* El árbol tiene ancho fijo y el editor se lleva el resto:
                    en modo agente el panel de la conversación se come parte de
                    la pantalla, y un árbol proporcional se volvería ilegible
                    justo cuando más se lo usa. */}
                <div className="flex w-56 shrink-0 flex-col border-r border-outline-variant">
                    <div className="shrink-0 border-b border-outline-variant p-1">
                        <div className="flex items-center gap-1 rounded bg-surface-container px-1.5 py-1 focus-within:ring-1 focus-within:ring-primary">
                            <Icon name="search" size={13} className="shrink-0 text-on-surface-variant" />
                            <input
                                value={filter}
                                onChange={(e) => setFilter(e.target.value)}
                                placeholder="Filtrar archivos"
                                title="Filtra por cualquier parte de la ruta"
                                className="min-w-0 flex-1 bg-transparent text-xs text-on-surface outline-none placeholder:text-on-surface-variant/60"
                            />
                        </div>
                    </div>

                    <div className="min-h-0 flex-1 overflow-y-auto">
                        {treeError && <p className="p-3 text-xs text-error">{treeError}</p>}
                        {!treeError && !searchResults && rows.length === 0 && (
                            <p className="p-3 text-xs text-on-surface-variant">No hay archivos editables en este repositorio.</p>
                        )}
                        {searchResults && searchResults.rows.length === 0 && (
                            <p className="p-3 text-xs text-on-surface-variant">Ningún archivo coincide con el filtro.</p>
                        )}

                        {/* Buscando: resultados planos con la ruta, porque lo
                            que importa es encontrarlo, no ubicarlo. */}
                        {searchResults?.rows.map((path) => (
                            <button
                                key={path}
                                onClick={() => void openFile(path)}
                                title={path}
                                className={`flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs ${
                                    path === activePath ? 'bg-primary/15 text-primary' : 'text-on-surface hover:bg-surface-container-high'
                                }`}
                            >
                                <Icon name="description" size={12} className="shrink-0 text-on-surface-variant" />
                                <span className="shrink-0">{path.split('/').pop()}</span>
                                <span className="min-w-0 flex-1 truncate text-[10px] text-on-surface-variant/70">{path}</span>
                                {dirtyPaths.has(path) && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
                            </button>
                        ))}

                        {/* Navegando: el árbol. La sangría es la que dice
                            dónde está uno parado — con rutas planas había que
                            leer cada fila entera para saberlo. */}
                        {!searchResults &&
                            rows.map(({node, depth}) => (
                                <button
                                    key={node.path}
                                    onClick={() => (node.dir ? toggleDir(node.path) : void openFile(node.path))}
                                    title={node.path}
                                    style={{paddingLeft: 6 + depth * 12}}
                                    className={`flex w-full items-center gap-1 py-0.5 pr-2 text-left text-xs ${
                                        node.path === activePath
                                            ? 'bg-primary/15 text-primary'
                                            : 'text-on-surface hover:bg-surface-container-high'
                                    }`}
                                >
                                    {node.dir ? (
                                        <>
                                            <Icon
                                                name={expanded.has(node.path) ? 'expand_more' : 'chevron_right'}
                                                size={13}
                                                className="shrink-0 text-on-surface-variant"
                                            />
                                            <Icon
                                                name={expanded.has(node.path) ? 'folder_open' : 'folder'}
                                                size={13}
                                                className="shrink-0 text-primary/70"
                                            />
                                        </>
                                    ) : (
                                        // El hueco del chevron mantiene alineados los
                                        // nombres de archivos y carpetas del mismo
                                        // nivel; sin él la sangría se lee torcida.
                                        <>
                                            <span className="w-[13px] shrink-0" />
                                            <Icon name="description" size={13} className="shrink-0 text-on-surface-variant" />
                                        </>
                                    )}
                                    <span
                                        className={`min-w-0 flex-1 truncate ${
                                            node.dir
                                                ? fileStatus.dirs.has(node.path)
                                                    ? 'text-on-surface'
                                                    : ''
                                                : statusColor(fileStatus.byPath.get(node.path))
                                        }`}
                                    >
                                        {node.name}
                                    </span>
                                    {/* En una carpeta, cuántos cambios tiene
                                        adentro; en un archivo, qué le pasó. */}
                                    {node.dir && fileStatus.dirs.has(node.path) && (
                                        <span
                                            title={`${fileStatus.dirs.get(node.path)} archivo(s) con cambios acá adentro`}
                                            className="shrink-0 rounded-full bg-tertiary/20 px-1 font-mono text-[10px] text-tertiary"
                                        >
                                            {fileStatus.dirs.get(node.path)}
                                        </span>
                                    )}
                                    {/* La letra de git, como en VSCode: M
                                        modificado, A agregado, ? sin rastrear.
                                        Dice QUÉ le pasó al archivo, que el
                                        color solo insinúa. */}
                                    {!node.dir && fileStatus.byPath.get(node.path) && (
                                        <span
                                            title={statusTitle(fileStatus.byPath.get(node.path))}
                                            className={`shrink-0 font-mono text-[10px] ${statusColor(fileStatus.byPath.get(node.path))}`}
                                        >
                                            {fileStatus.byPath.get(node.path)}
                                        </span>
                                    )}
                                    {!node.dir && dirtyPaths.has(node.path) && (
                                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" title="Sin guardar en el disco" />
                                    )}
                                </button>
                            ))}

                        {searchResults && searchResults.total > searchResults.rows.length && (
                            <p className="p-2 text-center text-[11px] text-on-surface-variant">
                                {searchResults.total - searchResults.rows.length} archivos más. Refiná el filtro para verlos.
                            </p>
                        )}
                        {tree?.truncated && (
                            <p className="p-2 text-center text-[11px] text-on-surface-variant">
                                El repositorio supera el tope del listado; puede faltar algún archivo.
                            </p>
                        )}
                    </div>
                </div>

                {/* Pestañas + editor */}
                <div className="flex min-w-0 flex-1 flex-col">
                    {files.length > 0 && (
                        <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-outline-variant px-1 py-1">
                            {files.map((f) => {
                                const dirty = dirtyPaths.has(f.path)
                                return (
                                    <span
                                        key={f.path}
                                        className={`flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-xs ${
                                            f.path === activePath ? 'bg-primary/15 text-primary' : 'text-on-surface-variant hover:bg-surface-container-high'
                                        }`}
                                    >
                                        <button onClick={() => setActivePath(f.path)} title={f.path} className="max-w-40 truncate">
                                            {f.path.split('/').pop()}
                                            {dirty && ' •'}
                                        </button>
                                        <button
                                            onClick={() => closeFile(f.path)}
                                            title={dirty ? 'Cerrar (los cambios sin guardar se pierden)' : 'Cerrar'}
                                            className="rounded hover:text-on-surface"
                                        >
                                            <Icon name="close" size={12} />
                                        </button>
                                    </span>
                                )
                            })}
                        </div>
                    )}

                    {active && (
                        <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-2 py-1 text-[11px] text-on-surface-variant">
                            <span className="min-w-0 flex-1 truncate" title={active.path}>
                                {active.path}
                            </span>
                            <select
                                value={active.language}
                                onChange={(e) => setLanguage(active.path, e.target.value as LanguageId)}
                                title={`Resaltado de sintaxis. Se eligió ${languageLabel(active.language)} por el nombre del archivo; cambialo si este archivo es otra cosa.`}
                                className="shrink-0 rounded border border-outline-variant bg-surface px-1 py-0.5 text-[11px] text-on-surface outline-none focus:border-primary"
                            >
                                {LANGUAGE_OPTIONS.map((o) => (
                                    <option key={o.id} value={o.id}>
                                        {o.label}
                                    </option>
                                ))}
                            </select>
                            {active.language === 'markdown' && (
                                <span className="flex shrink-0 items-center gap-0.5 rounded border border-outline-variant p-0.5">
                                    {(
                                        [
                                            ['code', 'code', 'Editar el texto'],
                                            ['split', 'vertical_split', 'El texto y el resultado, lado a lado'],
                                            ['preview', 'visibility', 'Solo el documento formateado'],
                                        ] as const
                                    ).map(([id, icon, title]) => (
                                        <button
                                            key={id}
                                            onClick={() => setMdView(id)}
                                            title={title}
                                            className={`rounded px-1 py-0.5 ${
                                                mdView === id
                                                    ? 'bg-primary/15 text-primary'
                                                    : 'text-on-surface-variant hover:bg-surface-container-high'
                                            }`}
                                        >
                                            <Icon name={icon} size={12} />
                                        </button>
                                    ))}
                                </span>
                            )}
                            {onAskAgent && (
                                <button
                                    onClick={() => {
                                        const view = viewRef.current
                                        const sel = view?.state.selection.main
                                        // Con selección se manda el rango de
                                        // líneas y no el texto: el agente ya
                                        // tiene el archivo, y pegar cien
                                        // líneas gasta contexto y rompe el
                                        // pegado de la terminal.
                                        let about = active.path
                                        if (view && sel && !sel.empty) {
                                            const from = view.state.doc.lineAt(sel.from).number
                                            const to = view.state.doc.lineAt(sel.to).number
                                            about = `${active.path}:${from}${to > from ? `-${to}` : ''}`
                                        }
                                        onAskAgent(`Mirá ${about} en este repositorio y `, about)
                                    }}
                                    title="Le pasa este archivo (o las líneas seleccionadas) a una sesión de agente y deja el prompt escrito para que lo completes. No lo envía solo: enviar es un gesto tuyo, igual que en el historial de la terminal."
                                    className="flex shrink-0 items-center gap-1 rounded border border-outline-variant px-1.5 py-0.5 text-[11px] text-on-surface hover:bg-surface-container-high"
                                >
                                    <Icon name="smart_toy" size={12} />
                                    Preguntar
                                </button>
                            )}
                            <button
                                onClick={() => void save(active.path, false)}
                                disabled={saving || !dirtyPaths.has(active.path) || active.binary || active.tooLarge}
                                title="Guarda el archivo en el disco (Cmd/Ctrl+S). Si cambió abajo mientras lo editabas, se avisa antes de pisarlo."
                                className="shrink-0 rounded bg-primary px-2 py-0.5 text-[11px] text-on-primary disabled:opacity-40"
                            >
                                Guardar
                            </button>
                        </div>
                    )}

                    <div className="min-h-0 flex-1">
                        {!active && (
                            <p className="p-4 text-center text-xs text-on-surface-variant">
                                Elegí un archivo de la lista para abrirlo y editarlo.
                            </p>
                        )}
                        {active?.binary && (
                            <p className="p-4 text-center text-xs text-on-surface-variant">
                                Este archivo es binario y no se puede editar como texto.
                            </p>
                        )}
                        {active?.tooLarge && (
                            <p className="p-4 text-center text-xs text-on-surface-variant">
                                Este archivo supera el tamaño máximo editable (4 MiB).
                            </p>
                        )}
                        {/* El contenedor se mantiene montado siempre: destruirlo
                            y recrearlo por cada cambio de pestaña tiraría los
                            EditorState que este panel justamente conserva. Por
                            eso la vista previa se pone AL LADO y no en lugar
                            del editor. */}
                        <div className={`flex h-full w-full ${active && !active.binary && !active.tooLarge ? '' : 'hidden'}`}>
                            {/* El contenedor del editor NUNCA se desmonta, ni
                                siquiera en modo vista: se oculta. Desmontarlo
                                tiraría el EditorState de la pestaña —con su
                                cursor, su scroll y su historial de deshacer—
                                por el solo hecho de haber mirado el resultado. */}
                            <div
                                ref={containerRef}
                                className={`h-full min-w-0 flex-1 ${
                                    active?.language === 'markdown' && mdView === 'preview' ? 'hidden' : ''
                                }`}
                            />
                            {active?.language === 'markdown' && mdView !== 'code' && (
                                <div
                                    className={`min-w-0 flex-1 ${mdView === 'split' ? 'border-l border-outline-variant' : ''}`}
                                >
                                    {/* Se renderiza el contenido VIVO del
                                        editor, no el guardado: sirve mientras
                                        se escribe. */}
                                    <MarkdownPreview source={active.content} />
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {conflict && (
                <ConfirmDialog
                    title="El archivo cambió en el disco"
                    description={`"${conflict}" fue modificado por fuera del editor desde que lo abriste — puede haber sido un agente, un checkout u otro programa. Si guardás igual, ese cambio se pierde.`}
                    confirmLabel="Guardar igual"
                    danger
                    onConfirm={() => void save(conflict, true)}
                    onClose={() => setConflict(null)}
                />
            )}
        </div>
    )
}
