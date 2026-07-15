import {useEffect, useState} from 'react'
import {DeleteRedisKey, ExportRedisKeys, ExportResult} from '../../../wailsjs/go/main/App'
import ConfirmDialog from '../ConfirmDialog'
import Icon from '../Icon'
import RedisKeyDetailPanel from './RedisKeyDetailPanel'
import RedisKeyTree from './RedisKeyTree'

interface RedisBrowserTabProps {
    connId: string
    // Pre-selects a key in the detail panel once — set by
    // Workspace.tsx's openRedisKeyDetail (double-click in the sidebar's
    // inline RedisKeyTree). initialKeyToken changes on every such call
    // (even re-picking the same key, or picking a different one while this
    // tab is already active) so the effect below re-fires reliably instead
    // of only on mount.
    initialKey?: string
    initialKeyToken?: number
}

// Full-tab Redis key browser — opened via ConnectionTree's "Abrir en
// pestaña" button on a Redis connection, or by double-clicking a key in
// the sidebar (see Workspace.tsx). Two columns: RedisKeyTree.tsx (already
// has the type filter + pattern search + stats header from the Redis
// redesign) on the left, RedisKeyDetailPanel.tsx (editable value view) on
// the right, plus a bulk selection bar for exporting or deleting several
// keys at once.
export default function RedisBrowserTab({connId, initialKey, initialKeyToken}: RedisBrowserTabProps) {
    const [selectedKey, setSelectedKey] = useState<string | null>(null)
    const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
    const [reloadToken, setReloadToken] = useState(0)
    const [exporting, setExporting] = useState(false)
    const [bulkDeleting, setBulkDeleting] = useState(false)
    const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
    const [statusMessage, setStatusMessage] = useState('')

    useEffect(() => {
        if (initialKey) setSelectedKey(initialKey)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialKeyToken])

    // A different connId (a different browser tab entirely, since each one
    // is pinned to its connId for life) starts fresh — no reason to keep a
    // previous connection's selection/checkboxes around.
    useEffect(() => {
        setSelectedKey(null)
        setSelectedKeys(new Set())
    }, [connId])

    function toggleSelect(key: string) {
        setSelectedKeys((prev) => {
            const next = new Set(prev)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
        })
    }

    async function exportSelected(format: 'csv' | 'json') {
        setExporting(true)
        setStatusMessage('')
        try {
            const entries = await ExportRedisKeys(connId, Array.from(selectedKeys))
            const columns = ['key', 'type', 'ttlSeconds', 'value']
            const rows = entries.map((e) => [
                e.key,
                e.type,
                e.ttlSeconds,
                // CSV cells are flat text — a hash/list/set/zset/stream
                // value gets JSON-stringified there; JSON export keeps the
                // real nested object/array instead (WriteJSON marshals it
                // as-is), same "flatten only where the format forces it"
                // criterion ExportMenu.tsx already uses for query results.
                format === 'csv' && typeof e.value !== 'string' ? JSON.stringify(e.value) : e.value,
            ])
            const dest = await ExportResult(columns, rows, format)
            setStatusMessage(dest ? `Exportado a ${dest}` : '')
        } catch (err) {
            setStatusMessage(`Error: ${String(err)}`)
        } finally {
            setExporting(false)
        }
    }

    async function bulkDelete() {
        setBulkDeleting(true)
        try {
            for (const key of selectedKeys) {
                await DeleteRedisKey(connId, key)
            }
            if (selectedKey && selectedKeys.has(selectedKey)) setSelectedKey(null)
            setSelectedKeys(new Set())
            setReloadToken((n) => n + 1)
        } catch (err) {
            setStatusMessage(`Error: ${String(err)}`)
        } finally {
            setBulkDeleting(false)
        }
    }

    return (
        <div className="flex min-h-0 flex-1 overflow-hidden">
            <div className="flex w-80 shrink-0 flex-col overflow-hidden border-r border-outline-variant">
                {selectedKeys.size > 0 && (
                    <div className="flex flex-wrap items-center gap-2 border-b border-outline-variant bg-surface-container px-2 py-1.5 text-xs">
                        <span className="text-on-surface-variant">{selectedKeys.size} seleccionadas</span>
                        <div className="flex-1" />
                        <button
                            onClick={() => void exportSelected('json')}
                            disabled={exporting}
                            title="Exporta las keys seleccionadas a un archivo .json (type/TTL/valor completo por key)"
                            className="flex items-center gap-1 rounded px-2 py-1 text-on-surface-variant hover:bg-surface-variant disabled:opacity-50"
                        >
                            <Icon name="data_object" size={13} />
                            JSON
                        </button>
                        <button
                            onClick={() => void exportSelected('csv')}
                            disabled={exporting}
                            title="Exporta las keys seleccionadas a un archivo .csv (valores complejos aplanados a texto)"
                            className="flex items-center gap-1 rounded px-2 py-1 text-on-surface-variant hover:bg-surface-variant disabled:opacity-50"
                        >
                            <Icon name="grid_on" size={13} />
                            CSV
                        </button>
                        <button
                            onClick={() => setConfirmBulkDelete(true)}
                            disabled={bulkDeleting}
                            title="Elimina todas las keys seleccionadas — no se puede deshacer"
                            className="flex items-center gap-1 rounded px-2 py-1 text-error hover:bg-error-container disabled:opacity-50"
                        >
                            <Icon name="delete" size={13} />
                            Eliminar
                        </button>
                    </div>
                )}
                {statusMessage && <p className="border-b border-outline-variant px-2 py-1 text-[11px] text-on-surface-variant">{statusMessage}</p>}
                <div className="flex-1 overflow-y-auto">
                    <RedisKeyTree
                        connId={connId}
                        onOpenKey={(key) => setSelectedKey(key)}
                        reloadToken={reloadToken}
                        isActiveTabConnection={false}
                        selectable
                        selectedKeys={selectedKeys}
                        onToggleSelect={toggleSelect}
                    />
                </div>
            </div>
            <div className="min-w-0 flex-1 overflow-hidden">
                {selectedKey ? (
                    <RedisKeyDetailPanel
                        key={selectedKey}
                        connId={connId}
                        keyName={selectedKey}
                        onDeleted={() => {
                            setSelectedKey(null)
                            setReloadToken((n) => n + 1)
                        }}
                    />
                ) : (
                    <p className="p-4 text-sm text-on-surface-variant">Seleccioná una key para ver su valor.</p>
                )}
            </div>

            {confirmBulkDelete && (
                <ConfirmDialog
                    title="Eliminar keys seleccionadas"
                    description={`Esto elimina ${selectedKeys.size} key(s) de Redis de forma permanente. No se puede deshacer.`}
                    confirmLabel={bulkDeleting ? 'Eliminando…' : 'Eliminar'}
                    danger
                    onConfirm={() => void bulkDelete()}
                    onClose={() => setConfirmBulkDelete(false)}
                />
            )}
        </div>
    )
}
