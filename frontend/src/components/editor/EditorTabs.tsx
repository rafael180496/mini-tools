import {useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent} from '@dnd-kit/core'
import {SortableContext, horizontalListSortingStrategy, useSortable, arrayMove} from '@dnd-kit/sortable'
import {CSS} from '@dnd-kit/utilities'
import {vault} from '../../../wailsjs/go/models'
import DbTypeIcon, {dbTypeLabel} from '../DbTypeIcon'
import Icon from '../Icon'
import RecentFilesMenu from './RecentFilesMenu'

export type TabLanguage = 'sql' | 'redis-cli'

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
export type TabKind = 'editor' | 'redis-browser' | 'ssh-terminal' | 'sftp'

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
}

interface SortableTabProps {
    tab: EditorTab
    isActive: boolean
    connections: vault.ConnectionSummary[]
    onSelect: (id: string) => void
    onClose: (id: string) => void
    onChangeTabConnection: (tabId: string, connId: string | null) => void
    onChangeTabLanguage: (tabId: string, language: TabLanguage) => void
}

// Un solo tab, arrastrable dentro del SortableContext de abajo. distance:5
// en el sensor (ver EditorTabs) evita que un simple click (sin
// desplazamiento) se interprete como intento de drag — así el botón de
// cerrar y el click de selección siguen funcionando igual que antes.
function SortableTab({tab, isActive, connections, onSelect, onClose, onChangeTabConnection, onChangeTabLanguage}: SortableTabProps) {
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
        : `Sin conexión vinculada (lenguaje: ${tab.language === 'redis-cli' ? 'Redis' : 'SQL'}) — click para vincular una conexión o cambiar el lenguaje. La conexión vinculada se muestra arriba, en la barra de herramientas.`
    const isBrowserTab = tab.kind === 'redis-browser'
    const isSshTab = tab.kind === 'ssh-terminal'
    const isSftpTab = tab.kind === 'sftp'

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
            className={`flex max-w-48 cursor-pointer items-center gap-1.5 rounded-t-xs px-3 py-1 text-xs font-mono ${
                isActive ? 'bg-surface text-on-surface' : 'text-on-surface-variant hover:text-on-surface'
            }`}
            title={`${tab.path ?? 'Pestaña sin guardar'} — arrastrar para reordenar`}
        >
            {/* Chip solo-ícono (nunca texto inline acá — mostrar el nombre
                de la conexión en cada pestaña fue lo que empujó la barra a
                un scroll horizontal no deseado). El nombre de la conexión
                vinculada se muestra en la barra de contexto del toolbar
                (Workspace.tsx, "Pestaña vinculada a: X"), que tiene espacio
                de sobra y no compite por ancho con las demás pestañas. */}
            {isBrowserTab ? (
                <span
                    title="Redis Browser — no se puede vincular a otra conexión, abrí uno nuevo para eso"
                    className="flex shrink-0 items-center justify-center rounded-full border border-outline-variant bg-surface-container-highest p-0.5"
                >
                    <DbTypeIcon dbType="redis" size={12} />
                </span>
            ) : isSshTab ? (
                <span
                    title="Terminal SSH — no se puede vincular a otra conexión, abrí una nueva para eso"
                    className="flex shrink-0 items-center justify-center rounded-full border border-outline-variant bg-surface-container-highest p-0.5"
                >
                    <Icon name="terminal" size={12} />
                </span>
            ) : isSftpTab ? (
                <span
                    title="Transferencia SFTP — explorador de archivos entre hosts"
                    className="flex shrink-0 items-center justify-center rounded-full border border-outline-variant bg-surface-container-highest p-0.5"
                >
                    <Icon name="swap_horiz" size={12} />
                </span>
            ) : (
                <button
                    ref={chipRef}
                    onClick={openMenu}
                    onPointerDown={(e) => e.stopPropagation()}
                    title={bindingTitle}
                    className={`flex shrink-0 items-center justify-center rounded-full border p-0.5 ${
                        boundConnection
                            ? 'border-outline-variant bg-surface-container-highest hover:bg-surface-variant'
                            : 'border-dashed border-error/60 hover:bg-error-container/40'
                    }`}
                >
                    {boundConnection ? (
                        <DbTypeIcon dbType={boundConnection.dbType} size={12} />
                    ) : (
                        <Icon name={tab.language === 'redis-cli' ? 'terminal' : 'code'} size={12} className="text-error" />
                    )}
                </button>
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
                            <label className="flex flex-col gap-1 text-[11px] text-on-surface-variant">
                                Conexión
                                <select
                                    value={tab.connId ?? ''}
                                    onChange={(e) => {
                                        onChangeTabConnection(tab.id, e.target.value || null)
                                        setMenuOpen(false)
                                    }}
                                    title="Vincula esta pestaña a una conexión guardada — al ejecutar, corre contra esta conexión sin importar cuál esté seleccionada en el sidebar"
                                    className="rounded border-none bg-surface-container-highest px-2 py-1 text-xs text-on-surface outline-none"
                                >
                                    <option value="">Sin conexión</option>
                                    {/* SSH connections have no query/editor concept at all — their
                                        only interaction mode is the terminal itself (see
                                        openSshTerminal in Workspace.tsx), so they're excluded here
                                        the same way this dropdown has no case for binding to
                                        something with no queryable surface. */}
                                    {connections
                                        .filter((c) => c.dbType !== 'ssh')
                                        .map((c) => (
                                            <option key={c.id} value={c.id}>
                                                {c.name} ({dbTypeLabel(c.dbType)})
                                            </option>
                                        ))}
                                </select>
                            </label>
                            <label className="mt-2 flex flex-col gap-1 text-[11px] text-on-surface-variant">
                                Lenguaje
                                <select
                                    value={tab.language}
                                    disabled={!!tab.connId}
                                    onChange={(e) => {
                                        onChangeTabLanguage(tab.id, e.target.value as TabLanguage)
                                        setMenuOpen(false)
                                    }}
                                    title={
                                        tab.connId
                                            ? 'El lenguaje lo determina la conexión vinculada — desvinculá la pestaña para elegirlo a mano'
                                            : 'Lenguaje del editor para esta pestaña mientras no tenga conexión vinculada'
                                    }
                                    className="rounded border-none bg-surface-container-highest px-2 py-1 text-xs text-on-surface outline-none disabled:opacity-50"
                                >
                                    <option value="sql">SQL</option>
                                    <option value="redis-cli">Redis</option>
                                </select>
                            </label>
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
