import {useEffect, useMemo, useRef, useState} from 'react'
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
    // Selects/deselects a batch at once (the "select everything visible"
    // action). Separate from onToggleSelect so the parent can replace the
    // whole set in one render instead of N.
    onSelectMany?: (keys: string[], selected: boolean) => void
    // Pattern pushed in from outside (the namespace tree clicking a
    // prefix). Changing it re-runs the server-side SCAN — the quick filter
    // could not do this, since the matching keys may not be loaded at all.
    externalPattern?: string
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
    onSelectMany,
    externalPattern,
}: RedisKeyTreeProps) {
    const [keys, setKeys] = useState<db.RedisKeyEntry[]>([])
    const [cursor, setCursor] = useState('')
    const [match, setMatch] = useState('')
    const [typeFilter, setTypeFilter] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')
    const [stats, setStats] = useState<db.RedisStats | null>(null)
    const [statsLoading, setStatsLoading] = useState(false)
    // Quick filter: narrows the keys ALREADY loaded, in the browser, without
    // touching Redis. Kept apart from the pattern box above it on purpose —
    // that one re-runs the SCAN server-side, this one is instant and only
    // ever sees the pages you have pulled. The placeholder says which is
    // which, because confusing them means thinking a key does not exist
    // when it simply was not fetched yet.
    const [quick, setQuick] = useState('')
    // Auto-load the next page when the sentinel at the bottom becomes
    // visible — the "Cargar más" button stays as the fallback and as the
    // signal that there IS more.
    const [autoLoad, setAutoLoad] = useState(true)
    const sentinelRef = useRef<HTMLDivElement>(null)

    const visible = useMemo(() => {
        const q = quick.trim().toLowerCase()
        if (q === '') return keys
        return keys.filter((k) => k.key.toLowerCase().includes(q))
    }, [keys, quick])

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

    // A prefix picked in the namespace tree replaces the pattern and
    // re-scans server-side — the quick filter could not do this, since the
    // matching keys may not be loaded at all.
    useEffect(() => {
        if (externalPattern === undefined) return
        setMatch(externalPattern)
        void loadFirstPage(externalPattern, typeFilter)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [externalPattern])

    // Infinite scroll: pull the next page when the bottom sentinel scrolls
    // into view. Guarded on `loading` so a fast scroll cannot stack
    // requests, and on `cursor` so it stops at the end of the keyspace.
    useEffect(() => {
        if (!autoLoad || !cursor || loading) return
        const node = sentinelRef.current
        if (!node) return
        const observer = new IntersectionObserver((entries) => {
            if (entries[0]?.isIntersecting) void loadMore()
        })
        observer.observe(node)
        return () => observer.disconnect()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoLoad, cursor, loading])

    useEffect(() => {
        setMatch('')
        setTypeFilter('')
        setQuick('')
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
            <div className="mb-1 flex items-center gap-2 px-1 text-ui-11 text-on-surface-variant">
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

            <div className="mb-1 flex items-center gap-1.5 px-1">
                <div className="relative min-w-0 flex-1">
                    <Icon name="filter_alt" size={13} className="pointer-events-none absolute left-1.5 top-1.5 text-on-surface-variant/60" />
                    <input
                        value={quick}
                        onChange={(e) => setQuick(e.target.value)}
                        placeholder="filtrar lo ya cargado"
                        title="Filtra al instante las claves YA cargadas, sin consultar Redis. Para buscar en todo el keyspace usá el patrón de arriba, que vuelve a correr el SCAN en el servidor."
                        className="w-full rounded border border-outline-variant bg-surface-container-low py-0.5 pl-6 pr-5 text-xs text-on-surface outline-none focus:ring-1 focus:ring-primary"
                    />
                    {quick && (
                        <button
                            onClick={() => setQuick('')}
                            title="Limpia el filtro rápido"
                            className="absolute right-1 top-1 text-on-surface-variant hover:text-on-surface"
                        >
                            <Icon name="close" size={12} />
                        </button>
                    )}
                </div>
                {selectable && visible.length > 0 && (
                    <button
                        onClick={() => {
                            const ids = visible.map((k) => k.key)
                            const allSelected = ids.every((id) => selectedKeys?.has(id))
                            onSelectMany?.(ids, !allSelected)
                        }}
                        title="Selecciona (o deselecciona) todas las claves visibles en la lista — solo las cargadas y que pasan el filtro rápido, nunca el keyspace entero"
                        className="shrink-0 rounded px-1.5 py-0.5 text-ui-11 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        Todas
                    </button>
                )}
                <label className="flex shrink-0 items-center gap-1 text-ui-11 text-on-surface-variant" title="Carga la página siguiente sola al llegar al final de la lista. Desactivalo si preferís controlar cada lote a mano.">
                    <input type="checkbox" checked={autoLoad} onChange={(e) => setAutoLoad(e.target.checked)} className="accent-primary" />
                    auto
                </label>
            </div>

            {quick && (
                <p className="px-1 pb-1 text-ui-10 text-on-surface-variant/70">
                    {visible.length} de {keys.length} cargadas coinciden — el filtro rápido no consulta Redis
                </p>
            )}

            {visible.map((k) => {
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
                        <span className="flex-1 truncate">{quick ? highlightMatch(k.key, quick) : k.key}</span>
                        <span className={`shrink-0 flex items-center gap-1 rounded px-1 py-0.5 text-ui-10 uppercase ${style.badgeClass}`}>
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

            <div ref={sentinelRef} aria-hidden className="h-px" />

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

// highlightMatch marks where the quick filter matched, so a long key shows
// WHY it is in the list rather than leaving the user to scan for it.
function highlightMatch(text: string, needle: string) {
    const q = needle.trim()
    if (q === '') return text
    const lower = text.toLowerCase()
    const target = q.toLowerCase()

    const parts: React.ReactNode[] = []
    let from = 0
    let at = lower.indexOf(target)
    while (at >= 0) {
        if (at > from) parts.push(text.slice(from, at))
        parts.push(
            <mark key={at} className="rounded-sm bg-tertiary/30 text-on-surface">
                {text.slice(at, at + q.length)}
            </mark>,
        )
        from = at + q.length
        at = lower.indexOf(target, from)
    }
    if (from < text.length) parts.push(text.slice(from))
    return parts
}
