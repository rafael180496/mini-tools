import {useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent} from '@dnd-kit/core'
import {SortableContext, horizontalListSortingStrategy, useSortable, arrayMove} from '@dnd-kit/sortable'
import {CSS} from '@dnd-kit/utilities'
import {vault} from '../../../wailsjs/go/models'
import DbTypeIcon, {dbTypeLabel} from '../DbTypeIcon'
import Icon from '../Icon'

export type TabLanguage = 'sql' | 'redis-cli'

// 'editor' is a plain CodeMirror tab (the only kind that existed before
// the Redis Browser feature). 'redis-browser' is a full-tab key
// list+detail view (see RedisBrowserTab.tsx) — it has no CodeMirror
// content, so most EditorTab fields (content/dirty/language) are unused
// placeholders for that kind, kept only so every tab still fits one array
// of one type instead of a union threaded through EditorTabs/Workspace.
export type TabKind = 'editor' | 'redis-browser'

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
                        <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                        <div
                            style={{position: 'fixed', top: menuPos.top, left: menuPos.left}}
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
                                    {connections.map((c) => (
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
        <div className="flex items-center gap-1 overflow-x-auto border-b border-outline-variant bg-surface-container px-2 pt-1">
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
            <button
                onClick={onNew}
                title="Abre una pestaña nueva en blanco para escribir un query sin guardarlo todavía"
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-on-surface-variant hover:text-on-surface"
            >
                <Icon name="add" size={16} />
                Nueva
            </button>
        </div>
    )
}
