import {useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent} from '@dnd-kit/core'
import {SortableContext, horizontalListSortingStrategy, useSortable, arrayMove} from '@dnd-kit/sortable'
import {CSS} from '@dnd-kit/utilities'
import {vault} from '../../../wailsjs/go/models'
import DbTypeIcon, {dbTypeLabel} from '../DbTypeIcon'
import Icon from '../Icon'
import Select from '../Select'
import RecentFilesMenu from './RecentFilesMenu'
import {MIDDLE_CLICK_HINT} from '../../lib/middleClickClose'

export type TabLanguage = 'sql' | 'redis-cli' | 'mongosh'

// 'editor' is a plain CodeMirror tab (the only kind that existed before
// the Redis Browser feature). 'redis-browser' is a full-tab key
// list+detail view (see RedisBrowserTab.tsx) — it has no CodeMirror
// content, so most EditorTab fields (content/dirty/language) are unused
// placeholders for that kind, kept only so every tab still fits one array
// of one type instead of a union threaded through EditorTabs/Workspace.
// 'ssh-terminal' is the same idea for an interactive SSH shell (see
// SshTerminalTab.tsx) — same unused-placeholder-fields treatment.
// 'sftp' is the dual-pane file-transfer explorer (see SftpTab.tsx) — likewise
// a full-tab view with the editor fields unused; connId marks the host it was
// launched from (for the tab strip icon / dedupe), not a bound query engine.
// 'git-repo' is the Git client's three-panel repository view (see
// GitRepoTab.tsx) — same unused-placeholder-fields treatment, but it is the
// one kind bound to a repoId instead of a connId, since a repository is not a
// database connection.
// 'note' es una nota de la base de conocimiento cifrada (ver
// components/notes/): mismo tratamiento de campos sin usar que las anteriores,
// con su propio `noteId` en vez de connId — una nota no es una conexión ni un
// repositorio, y sobrecargar connId la haría aparecer como "sin conexión
// vinculada" en cada búsqueda del workspace.
export type TabKind =
    | 'editor'
    | 'redis-browser'
    | 'mongo-browser'
    | 'ssh-terminal'
    // Terminal del SISTEMA OPERATIVO (la shell de esta máquina), abierta desde
    // el módulo SSH. Es un tipo aparte de 'ssh-terminal' y no una variante suya
    // porque no tiene conexión detrás: lo que la identifica es el intérprete
    // (`shellId`), y confundirlas haría que el resto del workspace la trate
    // como una sesión remota que se puede desconectar.
    | 'local-terminal'
    | 'sftp'
    | 'git-repo'
    | 'remote-file'
    | 'ssh-hybrid'
    | 'note'
    // Una petición HTTP del módulo de colecciones. Tipo propio y no una
    // variante de 'editor' porque no tiene lenguaje ni conexión de base de
    // datos: lo que la identifica es el ítem guardado (`httpItemId`), o nada
    // en absoluto si es una **petición rápida** — una que se manda sin
    // guardarla, y que vive solo mientras la pestaña esté abierta.
    | 'http-request'

// El rótulo de tipo que lleva cada pestaña delante del nombre.
//
// Antes el tipo se decía con un ícono dentro de un círculo, y con nueve
// clases de pestaña eso significaba nueve glifos que hay que aprender: un
// engranaje, una flecha doble y un commit no se distinguen a 12px, y la única
// forma de saber qué era una pestaña era apuntarle con el mouse y esperar el
// tooltip. Tres o cuatro letras se leen de una y no hay nada que aprender.
//
// El color agrupa, no decora: primary para lo que es una consulta, secondary
// para lo que es un servidor remoto, tertiary para lo que es un documento.
// Son tokens semánticos del sistema de diseño, así que siguen el tema claro/
// oscuro sin una segunda definición.
const KIND_BADGE: Record<TabKind, {text: string; className: string; hint: string}> = {
    editor: {text: 'SQL', className: 'text-primary', hint: 'Editor de consultas'},
    'redis-browser': {text: 'REDIS', className: 'text-error', hint: 'Explorador de claves Redis'},
    'mongo-browser': {text: 'MONGO', className: 'text-secondary', hint: 'Explorador de colecciones MongoDB'},
    'ssh-terminal': {text: 'SSH', className: 'text-secondary', hint: 'Terminal remota'},
    'local-terminal': {text: 'LOCAL', className: 'text-primary', hint: 'Terminal de esta máquina'},
    sftp: {text: 'SFTP', className: 'text-secondary', hint: 'Transferencia de archivos entre hosts'},
    'ssh-hybrid': {text: 'SSH+', className: 'text-secondary', hint: 'Terminal remota con explorador de archivos al lado'},
    'remote-file': {text: 'REMOTO', className: 'text-tertiary', hint: 'Archivo de un servidor, editado en vivo'},
    'git-repo': {text: 'GIT', className: 'text-tertiary', hint: 'Repositorio'},
    note: {text: 'NOTA', className: 'text-tertiary', hint: 'Nota de la base de conocimiento'},
    'http-request': {text: 'HTTP', className: 'text-primary', hint: 'Petición HTTP de una colección'},
}

// Para una pestaña de editor el rótulo depende del lenguaje: "SQL" sobre una
// consola de Redis sería directamente falso.
function badgeFor(kind: TabKind, language: TabLanguage) {
    if (kind !== 'editor') return KIND_BADGE[kind]
    if (language === 'redis-cli') return {text: 'REDIS', className: 'text-error', hint: 'Consola de comandos Redis'}
    if (language === 'mongosh') return {text: 'MONGO', className: 'text-secondary', hint: 'Consola mongosh'}
    return KIND_BADGE.editor
}

// RemoteFileRef identifies a file being edited on a server: which browse
// session to reach it through, its path, and the modification time it was
// loaded with — that last one is what makes saving detect somebody else
// having changed the file meanwhile instead of blindly overwriting it.
export interface RemoteFileRef {
    sessionId: string
    path: string
    connName: string
    modTimeUnix: number
}

export interface EditorTab {
    id: string
    title: string
    path: string | null
    content: string
    dirty: boolean
    // Which saved connection this tab runs against — null means unbound
    // (falls back to nothing selected; the toolbar shows "Sin conexión
    // vinculada" and running is disabled until one is picked here). For a
    // 'redis-browser' tab this is always set (the connection it browses)
    // and never changes after creation.
    connId: string | null
    // The CodeMirror language to render. Only freely editable while connId
    // is null — once a connection is bound, Workspace.tsx keeps this in
    // sync with that connection's engine (sql for sqlite/postgres/oracle,
    // redis-cli for redis) rather than trusting a stale manual pick.
    language: TabLanguage
    kind: TabKind
    // Set only for kind === 'remote-file': the server-side file this tab is
    // editing. Its own field rather than reusing `path`, which means a LOCAL
    // filesystem path everywhere else — conflating the two would make Ctrl+S
    // write a remote file to the user's disk.
    remote?: RemoteFileRef
    // Which registered git repository this tab shows — set only for
    // kind === 'git-repo', undefined everywhere else. It gets its own field
    // rather than reusing connId because the two address different registries
    // (vault.git_repos vs vault.connections); overloading connId would make
    // every `connections.find(c => c.id === tab.connId)` in Workspace silently
    // miss and render the tab as "sin conexión vinculada".
    repoId?: string
    // Nota que muestra esta pestaña — solo para kind === 'note'. Su propio
    // campo por el mismo motivo que repoId: direcciona otro registro
    // (vault_notes), no las conexiones.
    noteId?: string
    // Ítem de una colección HTTP — solo para kind === 'http-request'. Su
    // propio campo por el mismo motivo que repoId y noteId: direcciona la
    // tabla http_items, no las conexiones.
    // Sin valor en una petición rápida: esa pestaña no direcciona ningún
    // ítem, y toma uno recién cuando el usuario la guarda en una colección.
    httpItemId?: string
    // Intérprete de una terminal local — solo para kind === 'local-terminal'.
    // Vacío significa "el configurado en Configuración → Terminal".
    shellId?: string
    // Cómo se llama ese intérprete en pantalla ("PowerShell", "zsh"). Se guarda
    // en la pestaña y no se deriva del id porque el backend cae al shell por
    // defecto del sistema cuando el guardado no está instalado, y el rótulo
    // tiene que decir la verdad sobre lo que está corriendo.
    shellLabel?: string
}

interface EditorTabsProps {
    tabs: EditorTab[]
    activeId: string
    connections: vault.ConnectionSummary[]
    onSelect: (id: string) => void
    onClose: (id: string) => void
    onNew: () => void
    onReorder: (tabs: EditorTab[]) => void
    onChangeTabConnection: (tabId: string, connId: string | null) => void
    onChangeTabLanguage: (tabId: string, language: TabLanguage) => void
    // Open/reopen a .sql file — global actions (which file to open doesn't
    // depend on which tab happens to be active), so they live in the tab
    // strip itself next to "+ Nueva" instead of the per-tab toolbar below
    // (where they used to sit, duplicated-looking above every tab).
    onOpenFile: () => void
    onOpenRecentFile: (path: string) => void
    // Ids de las pestañas que están ejecutando algo. Ver `isRunning` arriba.
    runningIds: Set<string>
}

interface SortableTabProps {
    tab: EditorTab
    isActive: boolean
    connections: vault.ConnectionSummary[]
    onSelect: (id: string) => void
    onClose: (id: string) => void
    onChangeTabConnection: (tabId: string, connId: string | null) => void
    onChangeTabLanguage: (tabId: string, language: TabLanguage) => void
    // Esta pestaña tiene algo ejecutándose AHORA. Desde que dos pestañas pueden
    // correr a la vez, es lo único que dice que la que dejaste atrás sigue
    // trabajando —y cuándo terminó—, que es lo que hace usable irse.
    isRunning: boolean
}

// Un solo tab, arrastrable dentro del SortableContext de abajo. distance:5
// en el sensor (ver EditorTabs) evita que un simple click (sin
// desplazamiento) se interprete como intento de drag — así el botón de
// cerrar y el click de selección siguen funcionando igual que antes.
function SortableTab({tab, isActive, connections, onSelect, onClose, onChangeTabConnection, onChangeTabLanguage, isRunning}: SortableTabProps) {
    const {attributes, listeners, setNodeRef, transform, transition, isDragging} = useSortable({id: tab.id})
    const [menuOpen, setMenuOpen] = useState(false)
    const [menuPos, setMenuPos] = useState({top: 0, left: 0})
    const chipRef = useRef<HTMLButtonElement>(null)
    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
    }

    const boundConnection = tab.connId ? connections.find((c) => c.id === tab.connId) : undefined
    const bindingTitle = boundConnection
        ? `Vinculada a "${boundConnection.name}" (${dbTypeLabel(boundConnection.dbType)}) — click para cambiar`
        : `Sin conexión vinculada (lenguaje: ${tab.language === 'redis-cli' ? 'Redis' : tab.language === 'mongosh' ? 'MongoDB' : 'SQL'}) — click para vincular una conexión o cambiar el lenguaje. La conexión vinculada se muestra arriba, en la barra de herramientas.`
    const badge = badgeFor(tab.kind, tab.language)
    // Solo el editor puede cambiar de conexión/lenguaje: el resto de las
    // clases nace atado a lo suyo y no hay menú que ofrecer.
    const isEditorTab = tab.kind === 'editor'

    // Posiciona el menú vía viewport coords + un portal a document.body, no
    // position:absolute dentro de esta fila — la fila de pestañas tiene
    // overflow-x-auto, y por la regla CSS de que fijar UN eje de overflow a
    // algo distinto de "visible" fuerza al OTRO eje a comportarse como
    // "auto" también, un menú absolute-dentro-de-la-fila quedaba clippeado
    // verticalmente (bug real, reportado con captura: el dropdown se veía
    // cortado y no dejaba seleccionar nada).
    function openMenu(e: React.MouseEvent) {
        e.stopPropagation()
        const rect = chipRef.current?.getBoundingClientRect()
        if (rect) setMenuPos({top: rect.bottom + 4, left: rect.left})
        setMenuOpen((v) => !v)
    }

    return (
        <div
            ref={setNodeRef}
            style={style}
            {...attributes}
            {...listeners}
            onClick={() => onSelect(tab.id)}
            // Clic central = cerrar, como en VS Code. Acá no se puede usar
            // `closeOnMiddleClick` con spread: el `onPointerDown` de dnd-kit
            // viene en `listeners` y sobrescribirlo mataría el arrastre para
            // reordenar, así que se encadena a mano.
            onAuxClick={(e) => {
                if (e.button !== 1) return
                e.preventDefault()
                e.stopPropagation()
                onClose(tab.id)
            }}
            onPointerDown={(e) => {
                if (e.button === 1) {
                    // Evita el desplazamiento automático del navegador, que
                    // dejaría la barra de pestañas moviéndose sola después de
                    // cerrar.
                    e.preventDefault()
                    return
                }
                listeners?.onPointerDown?.(e)
            }}
            className={`flex max-w-52 cursor-pointer items-center gap-1.5 rounded-t-xs px-3 py-1 font-mono text-ui-11 ${
                isActive ? 'bg-surface text-on-surface' : 'text-on-surface-variant hover:text-on-surface'
            }`}
            title={`${tab.path ?? 'Pestaña sin guardar'} — arrastrar para reordenar${MIDDLE_CLICK_HINT}`}
        >
            {/* El tipo, delante del nombre. Para una pestaña vinculada a
                una conexión el logo real del motor va antes del rótulo: el
                rótulo dice QUÉ es la pestaña ("SQL") y el logo dice CONTRA
                QUÉ corre (Oracle, Postgres, SQLite…), que son dos preguntas
                distintas y las dos importan cuando hay ocho pestañas
                abiertas. El nombre de la conexión sigue sin entrar acá —
                ponerlo fue lo que empujó la barra a un scroll horizontal no
                deseado— y se muestra en la barra de contexto del toolbar.

                Solo la pestaña de editor abre el menú al clickear el rótulo:
                es la única que puede cambiar de conexión o de lenguaje. En un
                repositorio o una nota no hay nada que elegir, y ofrecer el
                menú igual sería ofrecer una opción que no significa nada. */}
            {isEditorTab ? (
                <button
                    ref={chipRef}
                    onClick={openMenu}
                    onPointerDown={(e) => e.stopPropagation()}
                    title={bindingTitle}
                    className="flex shrink-0 items-center gap-1 rounded px-0.5 hover:bg-surface-variant"
                >
                    {boundConnection && <DbTypeIcon dbType={boundConnection.dbType} size={12} />}
                    <span className={`font-semibold tracking-wide ${boundConnection ? badge.className : 'text-error'}`}>{badge.text}</span>
                </button>
            ) : (
                <span
                    title={`${badge.hint} — no se vincula a una conexión de base de datos, abrí una pestaña nueva para eso`}
                    className="flex shrink-0 items-center gap-1 px-0.5"
                >
                    {boundConnection && <DbTypeIcon dbType={boundConnection.dbType} size={12} />}
                    <span className={`font-semibold tracking-wide ${badge.className}`}>{badge.text}</span>
                </span>
            )}
            {isRunning && (
                <span
                    aria-hidden
                    title="Esta pestaña está ejecutando algo ahora mismo"
                    className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-t-transparent border-secondary"
                />
            )}
            <span className="min-w-0 shrink truncate">
                {tab.title}
                {tab.dirty ? ' •' : ''}
            </span>
            <button
                onClick={(e) => {
                    e.stopPropagation()
                    onClose(tab.id)
                }}
                onPointerDown={(e) => e.stopPropagation()}
                title={tab.dirty ? 'Cerrar pestaña (hay cambios sin guardar)' : 'Cerrar pestaña'}
                className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
            >
                <Icon name="close" size={14} />
            </button>

            {menuOpen &&
                createPortal(
                    <>
                        {/* Backdrop invisible, cierra el menú al clickear afuera —
                            necesario porque, al ser un portal, ya no hay un
                            "afuera de este div" natural que React pueda detectar
                            solo con stopPropagation. */}
                        <div
                            className="fixed inset-0 z-40"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => setMenuOpen(false)}
                        />
                        {/* onPointerDown stopPropagation es OBLIGATORIO acá: un
                            portal de React propaga los eventos por el árbol de
                            React, NO por el DOM, así que sin esto el pointerdown
                            sobre estos <select> sube hasta el <div> de la
                            pestaña (que tiene los listeners de dnd-kit) y arranca
                            un arrastre — la pestaña se "iba en modo movimiento"
                            al elegir una conexión. onClick solo no alcanza porque
                            dnd-kit activa con pointerdown, no con click. */}
                        <div
                            style={{position: 'fixed', top: menuPos.top, left: menuPos.left}}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => e.stopPropagation()}
                            className="z-50 w-56 cursor-default rounded-lg border border-outline-variant bg-surface-container-high p-2 text-on-surface shadow-lg"
                        >
                            {/* SSH connections have no query/editor concept at all — their
                                only interaction mode is the terminal itself (see
                                openSshTerminal in Workspace.tsx), so they're excluded here
                                the same way this dropdown has no case for binding to
                                something with no queryable surface. */}
                            <div className="flex flex-col gap-1 text-ui-11 text-on-surface-variant">
                                Conexión
                                <Select
                                    value={tab.connId ?? ''}
                                    options={[
                                        {value: '', label: 'Sin conexión', separatorAfter: true},
                                        // The engine logo, not just its name: this
                                        // list mixes SQL, Redis and MongoDB
                                        // connections, and the icon is what makes
                                        // the right one findable at a glance —
                                        // same visual the sidebar tree already
                                        // uses for the very same connections.
                                        ...connections
                                            .filter((c) => c.dbType !== 'ssh')
                                            .map((c) => ({
                                                value: c.id,
                                                label: c.name,
                                                hint: dbTypeLabel(c.dbType),
                                                icon: <DbTypeIcon dbType={c.dbType} size={16} />,
                                            })),
                                    ]}
                                    onChange={(v) => {
                                        onChangeTabConnection(tab.id, v || null)
                                        setMenuOpen(false)
                                    }}
                                    size="sm"
                                    ariaLabel="Conexión de la pestaña"
                                    className="w-full"
                                />
                            </div>
                            <div className="mt-2 flex flex-col gap-1 text-ui-11 text-on-surface-variant">
                                Lenguaje
                                <Select
                                    value={tab.language}
                                    disabled={!!tab.connId}
                                    options={[
                                        {value: 'sql', label: 'SQL'},
                                        {value: 'redis-cli', label: 'Redis'},
                                        {value: 'mongosh', label: 'MongoDB'},
                                    ]}
                                    onChange={(v) => {
                                        onChangeTabLanguage(tab.id, v as TabLanguage)
                                        setMenuOpen(false)
                                    }}
                                    size="sm"
                                    ariaLabel="Lenguaje de la pestaña"
                                    className="w-full"
                                />
                            </div>
                        </div>
                    </>,
                    document.body,
                )}
        </div>
    )
}

// Tabs hold both files opened from disk and unsaved scratch queries — spec:
// "múltiples tabs: archivos abiertos + queries sueltas sin guardar".
// Reordenables por drag-and-drop (@dnd-kit) — antes el orden era estático,
// el único orden posible era el de apertura, sin forma de mover una
// pestaña vieja (ej. la última) al principio.
export default function EditorTabs({
    tabs,
    activeId,
    connections,
    onSelect,
    onClose,
    onNew,
    onReorder,
    onChangeTabConnection,
    onChangeTabLanguage,
    onOpenFile,
    onOpenRecentFile,
    runningIds,
}: EditorTabsProps) {
    const sensors = useSensors(useSensor(PointerSensor, {activationConstraint: {distance: 5}}))

    function handleDragEnd(event: DragEndEvent) {
        const {active, over} = event
        if (!over || active.id === over.id) return
        const oldIndex = tabs.findIndex((t) => t.id === active.id)
        const newIndex = tabs.findIndex((t) => t.id === over.id)
        if (oldIndex === -1 || newIndex === -1) return
        onReorder(arrayMove(tabs, oldIndex, newIndex))
    }

    return (
        <div className="flex items-center border-b border-outline-variant bg-surface-container px-2 pt-1">
            {/* Scrollable region: only the tabs themselves. Kept separate
                from the actions cluster below (shrink-0, never scrolls) so
                Nueva/Abrir/Recientes stay reachable no matter how many tabs
                are open, instead of potentially sliding out of view along
                with the tab list. */}
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                    <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
                        {tabs.map((t) => (
                            <SortableTab
                                key={t.id}
                                tab={t}
                                isActive={t.id === activeId}
                                connections={connections}
                                onSelect={onSelect}
                                onClose={onClose}
                                onChangeTabConnection={onChangeTabConnection}
                                onChangeTabLanguage={onChangeTabLanguage}
                                isRunning={runningIds.has(t.id)}
                            />
                        ))}
                    </SortableContext>
                </DndContext>
            </div>

            {/* "+ Nueva" stays right against the tab strip (no divider), same
                spot it always had — it's the highest-frequency action here,
                so it belongs closer to the tabs than Abrir/Recientes. */}
            <button
                onClick={onNew}
                title="Abre una pestaña nueva en blanco para escribir un query sin guardarlo todavía"
                className="ml-1 flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-on-surface-variant hover:text-on-surface"
            >
                <Icon name="add" size={16} />
                Nueva
            </button>

            {/* Global file actions — which file to open next doesn't depend
                on the active tab, so these live here once instead of
                duplicated-looking above every tab in the per-tab toolbar
                below. */}
            <div className="ml-1 flex shrink-0 items-center gap-0.5 border-l border-outline-variant pl-1">
                <button
                    onClick={onOpenFile}
                    title="Abre un archivo .sql desde tu disco en una nueva pestaña del editor"
                    className="flex items-center gap-1 rounded px-2 py-1 text-xs text-on-surface-variant hover:text-on-surface"
                >
                    <Icon name="folder_open" size={16} />
                    Abrir
                </button>
                <RecentFilesMenu onOpen={onOpenRecentFile} />
            </div>
        </div>
    )
}
