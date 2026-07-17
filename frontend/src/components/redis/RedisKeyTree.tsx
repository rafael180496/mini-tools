import {useEffect, useState} from 'react'
import {GetRedisStats, ListRedisKeys} from '../../../wailsjs/go/main/App'
import {db} from '../../../wailsjs/go/models'
import {setActiveRedisKeys} from '../../codemirror/redisKeysStore'
import {likeToRedisGlob} from '../../lib/likePattern'
import {formatBytes} from '../../lib/formatBytes'
import {redisTypeStyle, REDIS_TYPES} from '../../lib/redisTypeStyle'
import Icon from '../Icon'
import Select from '../Select'

interface RedisKeyTreeProps {
    connId: string
    onOpenKey: (key: string) => void
    // Bumped by Workspace.tsx after a key is deleted from
    // RedisKeyDetailPanel (a different component instance) so this list
    // drops the now-gone key — same reuse of ConnectionTree's existing
    // reloadToken prop it already uses to refresh the connection list.
    reloadToken: number
    // True when this tree's connId is the one the ACTIVE editor tab is
    // bound to — only then does it push its scanned keys into
    // redisKeysStore.ts for the command editor's completion provider.
    // Prevents a connection merely expanded in the sidebar (but not the one
    // the active tab is running against) from leaking its keys into an
    // unrelated tab's suggestions.
    isActiveTabConnection: boolean
    // Bulk-selection mode (checkboxes per row) — opt-in, used only by
    // RedisBrowserTab.tsx for its "N seleccionadas / Exportar / Eliminar"
    // bar. The sidebar's own usage never passes these, leaving it exactly
    // as it was before bulk actions existed.
    selectable?: boolean
    selectedKeys?: ReadonlySet<string>
    onToggleSelect?: (key: string) => void
}

const PAGE_SIZE = 100

// Sidebar replacement for ConnectionTree's table list, rendered instead of
// it when the expanded connection's dbType is 'redis' (see
// ConnectionTree.tsx). Browses the keyspace via SCAN — never KEYS *, see
// .claude/rules/technical.md's performance rule — paginated with the
// opaque cursor backend/db/rediskeys.go returns. Self-contained: calls
// ListRedisKeys directly, same "components call wailsjs/go/main/App
// directly, no service wrapper" pattern ConnectionTree.tsx already uses for
// ListConnections (see .claude/rules/conventions.md's frontend deviation
// note).
export default function RedisKeyTree({
    connId,
    onOpenKey,
    reloadToken,
    isActiveTabConnection,
    selectable,
    selectedKeys,
    onToggleSelect,
}: RedisKeyTreeProps) {
    const [keys, setKeys] = useState<db.RedisKeyEntry[]>([])
    const [cursor, setCursor] = useState('')
    const [match, setMatch] = useState('')
    const [typeFilter, setTypeFilter] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')
    const [stats, setStats] = useState<db.RedisStats | null>(null)
    const [statsLoading, setStatsLoading] = useState(false)

    async function loadFirstPage(pattern: string, type: string) {
        setLoading(true)
        setError('')
        try {
            const page = await ListRedisKeys(connId, '', likeToRedisGlob(pattern), type, PAGE_SIZE)
            setKeys(page.keys ?? [])
            setCursor(page.cursor ?? '')
        } catch (err) {
            setError(String(err))
        } finally {
            setLoading(false)
        }
    }

    async function loadMore() {
        setLoading(true)
        setError('')
        try {
            const page = await ListRedisKeys(connId, cursor, likeToRedisGlob(match), typeFilter, PAGE_SIZE)
            setKeys((prev) => [...prev, ...(page.keys ?? [])])
            setCursor(page.cursor ?? '')
        } catch (err) {
            setError(String(err))
        } finally {
            setLoading(false)
        }
    }

    // Manual only — never polled/auto-refreshed, same "no sondear de más"
    // discipline the rest of this app already follows for Redis.
    async function loadStats() {
        setStatsLoading(true)
        try {
            setStats(await GetRedisStats(connId))
        } catch {
            setStats(null)
        } finally {
            setStatsLoading(false)
        }
    }

    useEffect(() => {
        setMatch('')
        setTypeFilter('')
        void loadFirstPage('', '')
        void loadStats()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connId, reloadToken])

    function changeTypeFilter(type: string) {
        setTypeFilter(type)
        void loadFirstPage(match, type)
    }

    // Feed the command editor's key-suggestion completion (redisLanguage.ts)
    // — only while this tree's connection is the one the active tab is
    // actually bound to, see the prop doc comment above.
    useEffect(() => {
        if (isActiveTabConnection) setActiveRedisKeys(keys.map((k) => k.key))
    }, [keys, isActiveTabConnection])

    return (
        <div className="pb-1 pl-2 pr-2">
            <div className="mb-1 flex items-center gap-2 px-1 text-[11px] text-on-surface-variant">
                {statsLoading ? (
                    <span>Cargando stats…</span>
                ) : stats ? (
                    <>
                        <span title="Total de keys en la base lógica de esta conexión (DBSIZE)">{stats.totalKeys.toLocaleString()} keys</span>
                        <span title="Memoria usada por TODO el servidor Redis (INFO memory) — no es por-base, Redis no la trackea así">
                            {formatBytes(stats.usedMemoryBytes)}
                        </span>
                    </>
                ) : (
                    <span>Sin stats</span>
                )}
                <div className="flex-1" />
                <button
                    onClick={() => void loadStats()}
                    title="Actualiza el conteo de keys y la memoria usada"
                    className="rounded p-0.5 opacity-70 hover:opacity-100"
                >
                    <Icon name="refresh" size={13} className={statsLoading ? 'animate-spin' : ''} />
                </button>
            </div>

            <div className="mb-1 flex items-center gap-1">
                <Select
                    value={typeFilter}
                    options={[
                        {value: '', label: 'Todos los tipos'},
                        ...REDIS_TYPES.map((t) => ({value: t, label: redisTypeStyle(t).label})),
                    ]}
                    onChange={changeTypeFilter}
                    size="sm"
                    title="Filtra las keys por tipo — usa el propio filtro TYPE de SCAN, del lado del servidor"
                    ariaLabel="Filtrar por tipo"
                    className="shrink-0"
                />
                <input
                    value={match}
                    onChange={(e) => setMatch(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') void loadFirstPage(match, typeFilter)
                    }}
                    placeholder="Buscar (ej. user:1, o user:* / user:%)"
                    title='Filtra las keys — texto simple busca "contiene", o usá un patrón explícito con * ? (glob de SCAN) o % _ (estilo SQL LIKE, ej. "user:%") — Enter para buscar'
                    className="w-full min-w-0 rounded border-none bg-surface-container-highest px-2 py-1 text-xs text-on-surface outline-none placeholder:text-on-surface-variant/60 focus:ring-1 focus:ring-primary"
                />
                <button
                    onClick={() => void loadFirstPage(match, typeFilter)}
                    title="Busca keys que matcheen el patrón"
                    className="shrink-0 rounded p-1 text-on-surface-variant hover:bg-surface-variant"
                >
                    <Icon name="search" size={14} />
                </button>
            </div>

            {error && <p className="px-1 py-1 text-xs text-error">{error}</p>}

            {keys.length === 0 && !loading && !error && <p className="px-1 py-1 text-xs text-on-surface-variant/60">Sin keys.</p>}

            {keys.map((k) => {
                const style = redisTypeStyle(k.type)
                return (
                    <div
                        key={k.key}
                        onClick={() => (selectable ? onOpenKey(k.key) : undefined)}
                        onDoubleClick={() => onOpenKey(k.key)}
                        title={
                            selectable
                                ? `Click: ver el valor de "${k.key}" (tipo ${k.type})`
                                : `Doble click: inspeccionar el valor de "${k.key}" (tipo ${k.type})`
                        }
                        className="flex items-center gap-2 rounded px-2 py-1 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        {selectable && (
                            <span
                                role="checkbox"
                                aria-checked={selectedKeys?.has(k.key) ?? false}
                                onClick={(e) => {
                                    e.stopPropagation()
                                    onToggleSelect?.(k.key)
                                }}
                                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                                    selectedKeys?.has(k.key) ? 'border-primary bg-primary text-on-primary' : 'border-outline'
                                }`}
                            >
                                {(selectedKeys?.has(k.key) ?? false) && <Icon name="check" size={12} />}
                            </span>
                        )}
                        <Icon name="key" size={14} className="shrink-0 opacity-60" />
                        <span className="flex-1 truncate">{k.key}</span>
                        <span className={`shrink-0 flex items-center gap-1 rounded px-1 py-0.5 text-[10px] uppercase ${style.badgeClass}`}>
                            <Icon name={style.icon} size={10} />
                            {style.label}
                        </span>
                    </div>
                )
            })}

            {loading && (
                <div className="flex items-center gap-2 px-2 py-2 text-xs text-on-surface-variant">
                    <span aria-hidden className="h-3 w-3 animate-spin rounded-full border-2 border-t-transparent border-primary" />
                    Cargando…
                </div>
            )}

            {!loading && cursor && (
                <button
                    onClick={() => void loadMore()}
                    title="Carga la siguiente página de keys (SCAN paginado — nunca trae todo el keyspace de una sola vez)"
                    className="mt-1 w-full rounded px-2 py-1 text-center text-xs text-primary hover:bg-surface-variant"
                >
                    Cargar más
                </button>
            )}
        </div>
    )
}
