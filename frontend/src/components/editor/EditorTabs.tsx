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
}

// Tabs hold both files opened from disk and unsaved scratch queries — spec:
// "múltiples tabs: archivos abiertos + queries sueltas sin guardar".
export default function EditorTabs({tabs, activeId, onSelect, onClose, onNew}: EditorTabsProps) {
    return (
        <div className="flex items-center gap-1 border-b border-outline-variant bg-surface-container px-2 pt-1">
            {tabs.map((t) => (
                <div
                    key={t.id}
                    onClick={() => onSelect(t.id)}
                    className={`flex cursor-pointer items-center gap-2 rounded-t-xs px-3 py-1 text-xs font-mono ${
                        t.id === activeId ? 'bg-surface text-on-surface' : 'text-on-surface-variant hover:text-on-surface'
                    }`}
                    title={t.path ?? undefined}
                >
                    <Icon name={t.path ? 'article' : 'code'} size={14} className="opacity-70" />
                    <span>
                        {t.title}
                        {t.dirty ? ' •' : ''}
                    </span>
                    <button
                        onClick={(e) => {
                            e.stopPropagation()
                            onClose(t.id)
                        }}
                        title={t.dirty ? 'Cerrar pestaña (hay cambios sin guardar)' : 'Cerrar pestaña'}
                        className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="close" size={14} />
                    </button>
                </div>
            ))}
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
