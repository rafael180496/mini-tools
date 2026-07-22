import {useEffect, useState} from 'react'
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
}

// Full-tab MongoDB browser (opened by double-clicking a collection in the
// sidebar) — two panes like RedisBrowserTab: a collection tree on the left to
// switch collections/databases, and the document viewer/editor on the right.
export default function MongoBrowserTab({connId, initialDatabase, initialCollection, initialToken}: MongoBrowserTabProps) {
    const [selected, setSelected] = useState<{database: string; collection: string} | null>(
        initialDatabase && initialCollection ? {database: initialDatabase, collection: initialCollection} : null,
    )

    useEffect(() => {
        if (initialDatabase && initialCollection) {
            setSelected({database: initialDatabase, collection: initialCollection})
        }
    }, [initialDatabase, initialCollection, initialToken])

    return (
        <div className="flex h-full">
            <div className="w-64 shrink-0 overflow-y-auto border-r border-outline-variant py-1">
                <MongoCollectionTree
                    connId={connId}
                    isActiveTabConnection={false}
                    onSelectDatabase={() => {}}
                    onOpenCollection={(database, collection) => setSelected({database, collection})}
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
    )
}
