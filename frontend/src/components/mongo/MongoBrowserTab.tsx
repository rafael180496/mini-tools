import {useEffect, useState} from 'react'
import Icon from '../Icon'
import MongoCollectionTree from './MongoCollectionTree'
import MongoDocumentPanel from './MongoDocumentPanel'

interface MongoBrowserTabProps {
    connId: string
    initialDatabase?: string
    initialCollection?: string
    // Bumped when the tab is (re)focused on a specific collection, so the
    // effect re-selects even if db/collection are unchanged (same pattern as
    // RedisBrowserTab's initialKeyToken).
    initialToken?: number
    // Reports the browsed database/collection upward so the workspace's query
    // wizard can start on whatever the user is actually looking at — the
    // sidebar tree already did this, the browser tab's own tree did not.
    onSelectCollection?: (database: string, collection: string) => void
    // Opens the query wizard from here. Without it, the wizard was reachable
    // only from the editor toolbar, which is the one place you are NOT
    // standing on a collection.
    onOpenWizard?: () => void
}

// Full-tab MongoDB browser (opened by double-clicking a collection in the
// sidebar) — two panes like RedisBrowserTab: a collection tree on the left to
// switch collections/databases, and the document viewer/editor on the right.
export default function MongoBrowserTab({
    connId,
    initialDatabase,
    initialCollection,
    initialToken,
    onSelectCollection,
    onOpenWizard,
}: MongoBrowserTabProps) {
    const [selected, setSelected] = useState<{database: string; collection: string} | null>(
        initialDatabase && initialCollection ? {database: initialDatabase, collection: initialCollection} : null,
    )

    useEffect(() => {
        if (initialDatabase && initialCollection) {
            setSelected({database: initialDatabase, collection: initialCollection})
        }
    }, [initialDatabase, initialCollection, initialToken])

    function select(database: string, collection: string) {
        setSelected({database, collection})
        onSelectCollection?.(database, collection)
    }

    return (
        // min-w-0 flex-1, not h-full: this sits inside the workspace's flex
        // ROW, where a child with no width class sizes to its content — which
        // is why the document panel used to render as a narrow column with
        // the rest of the window empty beside it, and why long documents
        // looked cut off. Same shape RedisBrowserTab already uses.
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {onOpenWizard && (
                <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant bg-surface-container px-2 py-1">
                    <span className="min-w-0 truncate font-mono text-xs text-on-surface-variant">
                        {selected ? `${selected.database}.${selected.collection}` : 'sin colección seleccionada'}
                    </span>
                    <button
                        onClick={onOpenWizard}
                        title="Abre el asistente de consulta ya apuntando a esta colección: armá un find() o un pipeline de agregación sin escribir MQL a mano"
                        className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="auto_awesome" size={14} />
                        Asistente de consulta
                    </button>
                </div>
            )}
            <div className="flex min-h-0 flex-1">
                <div className="w-64 shrink-0 overflow-y-auto border-r border-outline-variant py-1">
                    <MongoCollectionTree
                        connId={connId}
                        isActiveTabConnection={false}
                        onSelectDatabase={() => {}}
                        onOpenCollection={select}
                    />
                </div>
                <div className="min-w-0 flex-1">
                    {selected ? (
                        <MongoDocumentPanel connId={connId} database={selected.database} collection={selected.collection} />
                    ) : (
                        <p className="p-3 text-xs text-on-surface-variant">Elegí una colección en el árbol de la izquierda.</p>
                    )}
                </div>
            </div>
        </div>
    )
}
