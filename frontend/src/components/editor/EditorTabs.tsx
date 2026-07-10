import {DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent} from '@dnd-kit/core'
import {SortableContext, horizontalListSortingStrategy, useSortable, arrayMove} from '@dnd-kit/sortable'
import {CSS} from '@dnd-kit/utilities'
import Icon from '../Icon'

export interface EditorTab {
    id: string
    title: string
    path: string | null
    content: string
    dirty: boolean
}

interface EditorTabsProps {
    tabs: EditorTab[]
    activeId: string
    onSelect: (id: string) => void
    onClose: (id: string) => void
    onNew: () => void
    onReorder: (tabs: EditorTab[]) => void
}

interface SortableTabProps {
    tab: EditorTab
    isActive: boolean
    onSelect: (id: string) => void
    onClose: (id: string) => void
}

// Un solo tab, arrastrable dentro del SortableContext de abajo. distance:5
// en el sensor (ver EditorTabs) evita que un simple click (sin
// desplazamiento) se interprete como intento de drag — así el botón de
// cerrar y el click de selección siguen funcionando igual que antes.
function SortableTab({tab, isActive, onSelect, onClose}: SortableTabProps) {
    const {attributes, listeners, setNodeRef, transform, transition, isDragging} = useSortable({id: tab.id})
    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
    }

    return (
        <div
            ref={setNodeRef}
            style={style}
            {...attributes}
            {...listeners}
            onClick={() => onSelect(tab.id)}
            className={`flex cursor-pointer items-center gap-2 rounded-t-xs px-3 py-1 text-xs font-mono ${
                isActive ? 'bg-surface text-on-surface' : 'text-on-surface-variant hover:text-on-surface'
            }`}
            title={`${tab.path ?? 'Pestaña sin guardar'} — arrastrar para reordenar`}
        >
            <Icon name={tab.path ? 'article' : 'code'} size={14} className="opacity-70" />
            <span>
                {tab.title}
                {tab.dirty ? ' •' : ''}
            </span>
            <button
                onClick={(e) => {
                    e.stopPropagation()
                    onClose(tab.id)
                }}
                title={tab.dirty ? 'Cerrar pestaña (hay cambios sin guardar)' : 'Cerrar pestaña'}
                className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
            >
                <Icon name="close" size={14} />
            </button>
        </div>
    )
}

// Tabs hold both files opened from disk and unsaved scratch queries — spec:
// "múltiples tabs: archivos abiertos + queries sueltas sin guardar".
// Reordenables por drag-and-drop (@dnd-kit) — antes el orden era estático,
// el único orden posible era el de apertura, sin forma de mover una
// pestaña vieja (ej. la última) al principio.
export default function EditorTabs({tabs, activeId, onSelect, onClose, onNew, onReorder}: EditorTabsProps) {
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
                        <SortableTab key={t.id} tab={t} isActive={t.id === activeId} onSelect={onSelect} onClose={onClose} />
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
