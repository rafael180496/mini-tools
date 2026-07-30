import {useEffect, useState} from 'react'
import {DeleteRedisKeys, ExportRedisKeys, ExportResult} from '../../../wailsjs/go/main/App'
import ConfirmDialog from '../ConfirmDialog'
import Icon from '../Icon'
import RedisKeyDetailPanel from './RedisKeyDetailPanel'
import RedisKeyTree from './RedisKeyTree'
import RedisPrefixTree from './RedisPrefixTree'
import RedisMetricsPanel from './RedisMetricsPanel'
import RedisLiveMonitor from './RedisLiveMonitor'
import RedisLuaPanel from './RedisLuaPanel'

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
    // Pattern chosen in the namespace tree, pushed down to the key list.
    const [prefixPattern, setPrefixPattern] = useState('')
    // The health dashboard replaces the value panel rather than sitting
    // beside it: both want the full right-hand width, and nobody reads a
    // key's value and the server's memory pressure at the same moment.
    const [showMetrics, setShowMetrics] = useState(false)
    const [showMonitor, setShowMonitor] = useState(false)
    const [showLua, setShowLua] = useState(false)

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
        setPrefixPattern('')
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

    function selectMany(keys: string[], selected: boolean) {
        setSelectedKeys((prev) => {
            const next = new Set(prev)
            for (const k of keys) {
                if (selected) next.add(k)
                else next.delete(k)
            }
            return next
        })
    }

    // One batched call instead of a round trip per key: deleting 500 keys
    // used to be 500 sequential IPC hops, each waiting for the previous.
    // The backend chunks them, and falls back to one-at-a-time on a cluster
    // where a single DEL cannot span slots.
    async function bulkDelete() {
        setBulkDeleting(true)
        try {
            const deleted = await DeleteRedisKeys(connId, Array.from(selectedKeys))
            if (selectedKey && selectedKeys.has(selectedKey)) setSelectedKey(null)
            setSelectedKeys(new Set())
            setReloadToken((n) => n + 1)
            setStatusMessage(`${deleted} clave(s) eliminada(s)`)
        } catch (err) {
            // The error text carries how many were already deleted — a
            // partial destructive operation is unusable without that.
            setStatusMessage(`Error: ${String(err)}`)
            setReloadToken((n) => n + 1)
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
                <div className="flex items-center gap-1 border-b border-outline-variant px-2 py-1">
                    <button
                        onClick={() => {
                            setShowMetrics((v) => !v)
                            setShowMonitor(false)
                            setShowLua(false)
                        }}
                        title="Muestra el estado del servidor: memoria contra su límite, aciertos de caché, clientes conectados, operaciones por segundo y CPU — lo que hoy hay que ir a mirar con redis-cli INFO"
                        className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs ${
                            showMetrics ? 'bg-primary/15 text-primary' : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
                        }`}
                    >
                        <Icon name="monitoring" size={14} />
                        Estado del servidor
                    </button>
                    <button
                        onClick={() => {
                            setShowMonitor((v) => !v)
                            setShowMetrics(false)
                            setShowLua(false)
                        }}
                        title="Escucha canales de Pub/Sub o consume un stream en vivo, sin salir a una terminal aparte. Usa una conexión dedicada mientras esté activo."
                        className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs ${
                            showMonitor ? 'bg-primary/15 text-primary' : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
                        }`}
                    >
                        <Icon name="sensors" size={14} />
                        Monitor en vivo
                    </button>
                    <button
                        onClick={() => {
                            setShowLua((v) => !v)
                            setShowMetrics(false)
                            setShowMonitor(false)
                        }}
                        title="Escribí y probá un script Lua, validándolo antes de mandarlo. Un script de Redis es atómico: mientras corre, el servidor no atiende a nadie más."
                        className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs ${
                            showLua ? 'bg-primary/15 text-primary' : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
                        }`}
                    >
                        <Icon name="code" size={14} />
                        Script Lua
                    </button>
                </div>
                <RedisPrefixTree connId={connId} onSelectPrefix={setPrefixPattern} activePattern={prefixPattern} />
                <div className="flex-1 overflow-y-auto">
                    <RedisKeyTree
                        connId={connId}
                        onOpenKey={(key) => setSelectedKey(key)}
                        reloadToken={reloadToken}
                        isActiveTabConnection={false}
                        selectable
                        selectedKeys={selectedKeys}
                        onToggleSelect={toggleSelect}
                        onSelectMany={selectMany}
                        externalPattern={prefixPattern || undefined}
                    />
                </div>
            </div>
            <div className="min-w-0 flex-1 overflow-hidden">
                {showMetrics ? (
                    <RedisMetricsPanel connId={connId} onClose={() => setShowMetrics(false)} />
                ) : showLua ? (
                    <RedisLuaPanel connId={connId} onClose={() => setShowLua(false)} />
                ) : showMonitor ? (
                    // Keyed by connId so switching connections tears the
                    // subscription down instead of leaving it bound to the
                    // previous one.
                    <RedisLiveMonitor key={connId} connId={connId} onClose={() => setShowMonitor(false)} />
                ) : selectedKey ? (
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
