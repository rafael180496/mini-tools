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
        <div className="flex items-center gap-1 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900 px-2 pt-1">
            {tabs.map((t) => (
                <div
                    key={t.id}
                    onClick={() => onSelect(t.id)}
                    className={`flex cursor-pointer items-center gap-2 rounded-t px-3 py-1 text-xs ${
                        t.id === activeId ? 'bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100' : 'text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300'
                    }`}
                    title={t.path ?? undefined}
                >
                    <span>
                        {t.title}
                        {t.dirty ? ' •' : ''}
                    </span>
                    <button
                        onClick={(e) => {
                            e.stopPropagation()
                            onClose(t.id)
                        }}
                        className="text-neutral-400 dark:text-neutral-600 hover:text-neutral-700 dark:hover:text-neutral-300"
                    >
                        ×
                    </button>
                </div>
            ))}
            <button onClick={onNew} className="px-2 py-1 text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300">
                + Nueva
            </button>
        </div>
    )
}
