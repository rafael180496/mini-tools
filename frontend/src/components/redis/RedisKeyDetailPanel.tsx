import {useEffect, useState} from 'react'
import {
    AddRedisSetMember,
    AddRedisZSetMember,
    DeleteRedisHashField,
    DeleteRedisKey,
    GetRedisKeyInfo,
    GetRedisKeyValue,
    PushRedisListValue,
    RemoveRedisListIndex,
    RemoveRedisSetMember,
    RemoveRedisZSetMember,
    SetRedisHashField,
    SetRedisJSONValue,
    SetRedisListIndex,
    SetRedisStringValue,
} from '../../../wailsjs/go/main/App'
import {db} from '../../../wailsjs/go/models'
import {looksBinary} from '../../lib/binaryPreview'
import {tryPrettyPrintJSON} from '../../lib/prettyPrintJSON'
import {formatBytes} from '../../lib/formatBytes'
import {redisTypeStyle} from '../../lib/redisTypeStyle'
import ConfirmDialog from '../ConfirmDialog'
import Icon from '../Icon'

interface RedisKeyDetailPanelProps {
    connId: string
    keyName: string
    // Called after a successful delete of the WHOLE key so RedisBrowserTab
    // can deselect it and drop it from RedisKeyTree's already-loaded list.
    onDeleted: () => void
}

const PAGE_SIZE = 100

// Same locally-shaped accumulator RedisValueInspector.tsx used — NOT
// db.RedisValue itself, since that class also carries a convertValues
// instance method a plain merged object literal wouldn't satisfy
// structurally.
interface ValuePage {
    type: string
    stringVal?: string
    hashPairs?: db.RedisFieldValue[]
    listItems?: string[]
    setMembers?: string[]
    zsetItems?: db.RedisScoredMember[]
    streamEntries?: db.RedisStreamEntry[]
    cursor?: string
}

function ttlLabel(ttlSeconds: number): string {
    if (ttlSeconds === -1) return 'sin expiración'
    if (ttlSeconds === -2) return 'no existe (expiró)'
    return `${ttlSeconds}s`
}

// Renders a scalar value (a string field/member/element from any Redis
// type), unless it looks binary/non-printable — a marshaled object or a
// Sidekiq-style lock value stored as raw bytes renders as a confusing
// "tofu" box (the browser's missing-glyph placeholder) otherwise, since the
// value already went through lossy UTF-8 replacement on the backend (see
// lib/binaryPreview.ts) before it ever reaches this component. Binary
// values are shown read-only even for types that are otherwise editable —
// there's no safe text editor round-trip for bytes that already lost
// information going through UTF-8 replacement.
function renderScalar(raw: string) {
    if (looksBinary(raw)) {
        return <span className="italic text-on-surface-variant">contenido binario / no imprimible ({raw.length} caracteres)</span>
    }
    return <>{raw}</>
}

// The Redis Browser tab's detail panel — shows type/TTL/size and a
// type-shaped, paginated rendering of a key's value (see db.GetRedisValue),
// same fetch/pagination logic RedisValueInspector.tsx used, but embeddable
// (no modal chrome) and editable for every type except stream (append-only,
// "editing" has no natural meaning there). Reached from RedisBrowserTab.tsx
// — either by clicking a key in the tab's own list, or by double-clicking a
// key in the sidebar's inline RedisKeyTree (which opens/focuses this tab
// instead of a read-only modal, see Workspace.tsx's openRedisKeyDetail).
//
// TTL correctness: editing a string or JSON value replaces the whole value
// server-side (SET/JSON.SET) — SET without KEEPTTL would silently clear an
// existing expiration, so SetRedisStringValue always preserves it (see
// backend/db/rediskeys.go). Hash/list/set/zset mutations (HSET/SADD/ZADD/
// RPUSH/LSET) never touch TTL to begin with, nothing special needed there.
export default function RedisKeyDetailPanel({connId, keyName, onDeleted}: RedisKeyDetailPanelProps) {
    const [info, setInfo] = useState<db.RedisKeyInfo | null>(null)
    const [value, setValue] = useState<ValuePage | null>(null)
    const [loading, setLoading] = useState(true)
    const [loadingMore, setLoadingMore] = useState(false)
    const [error, setError] = useState('')
    const [confirmDelete, setConfirmDelete] = useState(false)
    const [deleting, setDeleting] = useState(false)
    const [copyHint, setCopyHint] = useState('')
    const [saving, setSaving] = useState(false)

    // string/JSON: whole-value textarea edit.
    const [editingWhole, setEditingWhole] = useState(false)
    const [wholeDraft, setWholeDraft] = useState('')
    const [wholeError, setWholeError] = useState('')

    // hash: per-field inline edit + "add field" row.
    const [editingHashField, setEditingHashField] = useState<string | null>(null)
    const [hashFieldDraft, setHashFieldDraft] = useState('')
    const [newHashField, setNewHashField] = useState('')
    const [newHashValue, setNewHashValue] = useState('')

    // list: per-index inline edit + "push" row.
    const [editingListIndex, setEditingListIndex] = useState<number | null>(null)
    const [listItemDraft, setListItemDraft] = useState('')
    const [newListValue, setNewListValue] = useState('')

    // set: "add member" row (removal has no inline edit, only delete).
    const [newSetMember, setNewSetMember] = useState('')

    // zset: per-member score inline edit + "add member" row.
    const [editingZsetMember, setEditingZsetMember] = useState<string | null>(null)
    const [zsetScoreDraft, setZsetScoreDraft] = useState('')
    const [newZsetMember, setNewZsetMember] = useState('')
    const [newZsetScore, setNewZsetScore] = useState('0')

    async function load() {
        setLoading(true)
        setError('')
        setValue(null)
        setEditingWhole(false)
        setEditingHashField(null)
        setEditingListIndex(null)
        setEditingZsetMember(null)
        try {
            const keyInfo = await GetRedisKeyInfo(connId, keyName)
            setInfo(keyInfo)
            const firstPage = await GetRedisKeyValue(connId, keyName, keyInfo.type, '', 0, PAGE_SIZE)
            setValue(firstPage)
        } catch (err) {
            setError(String(err))
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        let cancelled = false
        void (async () => {
            await load()
            if (cancelled) return
        })()
        return () => {
            cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connId, keyName])

    async function loadMore() {
        if (!info || !value?.cursor) return
        setLoadingMore(true)
        try {
            const useOffset = info.type === 'list' || info.type === 'zset'
            const next = await GetRedisKeyValue(
                connId,
                keyName,
                info.type,
                useOffset ? '' : value.cursor,
                useOffset ? Number(value.cursor) : 0,
                PAGE_SIZE,
            )
            setValue((prev) => ({
                type: next.type,
                stringVal: next.stringVal,
                hashPairs: [...(prev?.hashPairs ?? []), ...(next.hashPairs ?? [])],
                listItems: [...(prev?.listItems ?? []), ...(next.listItems ?? [])],
                setMembers: [...(prev?.setMembers ?? []), ...(next.setMembers ?? [])],
                zsetItems: [...(prev?.zsetItems ?? []), ...(next.zsetItems ?? [])],
                streamEntries: [...(prev?.streamEntries ?? []), ...(next.streamEntries ?? [])],
                cursor: next.cursor,
            }))
        } catch (err) {
            setError(String(err))
        } finally {
            setLoadingMore(false)
        }
    }

    async function copyKey() {
        await navigator.clipboard.writeText(keyName)
        setCopyHint('Copiado')
        setTimeout(() => setCopyHint(''), 1500)
    }

    async function doDelete() {
        setDeleting(true)
        try {
            await DeleteRedisKey(connId, keyName)
            onDeleted()
        } catch (err) {
            setError(String(err))
            setDeleting(false)
        }
    }

    // Wraps any mutating call: shows a busy state, reloads the value fresh
    // from the server on success (simplest way to stay consistent with
    // whatever Redis actually did — e.g. RPUSH's exact new length — rather
    // than hand-patching local state to guess it), surfaces the error
    // in-panel on failure without losing whatever the user was mid-editing.
    // Returns whether fn succeeded — every caller only clears its draft /
    // closes its edit row when this resolves true, so a failed save (shown
    // via `error` above) leaves the user's typed input in place to retry
    // instead of silently discarding it.
    async function mutate(fn: () => Promise<void>): Promise<boolean> {
        setSaving(true)
        setError('')
        try {
            await fn()
            await load()
            return true
        } catch (err) {
            setError(String(err))
            return false
        } finally {
            setSaving(false)
        }
    }

    function startEditWhole() {
        setWholeDraft(value?.stringVal ?? '')
        setWholeError('')
        setEditingWhole(true)
    }

    async function saveWhole() {
        if (!info) return
        if (info.type === 'ReJSON-RL') {
            try {
                JSON.parse(wholeDraft)
            } catch (err) {
                setWholeError(`JSON inválido: ${String(err)}`)
                return
            }
        }
        setWholeError('')
        const ok = await mutate(async () => {
            if (info.type === 'ReJSON-RL') {
                await SetRedisJSONValue(connId, keyName, wholeDraft)
            } else {
                await SetRedisStringValue(connId, keyName, wholeDraft)
            }
        })
        if (ok) setEditingWhole(false)
    }

    return (
        <div className="flex h-full flex-col gap-3 overflow-hidden p-4">
            <div className="flex items-center gap-2">
                <Icon name="key" size={18} className="shrink-0 text-primary" />
                <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" title={keyName}>
                    {keyName}
                </h2>
            </div>

            {loading && <p className="text-xs text-on-surface-variant">Cargando…</p>}
            {error && <p className="text-xs text-error">{error}</p>}

            {info && !loading && (
                <>
                    <div className="flex flex-wrap items-center gap-3 text-xs text-on-surface-variant">
                        {(() => {
                            const style = redisTypeStyle(info.type)
                            return (
                                <span className={`flex items-center gap-1 rounded px-2 py-0.5 ${style.badgeClass}`}>
                                    <Icon name={style.icon} size={12} />
                                    {style.label}
                                </span>
                            )
                        })()}
                        <span title="Tiempo de vida restante — -1 sin expiración, -2 la key ya no existe">TTL: {ttlLabel(info.ttlSeconds)}</span>
                        {!!info.sizeBytes && (
                            <span title="Estimación de MEMORY USAGE — memoria aproximada que ocupa esta key">
                                Tamaño: {formatBytes(info.sizeBytes)}
                            </span>
                        )}
                        {saving && <span className="text-primary">Guardando…</span>}
                        <div className="flex-1" />
                        <button
                            onClick={() => void copyKey()}
                            title="Copia el nombre de esta key al portapapeles"
                            className="flex items-center gap-1 rounded px-2 py-1 hover:bg-surface-variant"
                        >
                            <Icon name="content_copy" size={14} />
                            {copyHint || 'Copiar clave'}
                        </button>
                        <button
                            onClick={() => setConfirmDelete(true)}
                            title="Elimina esta key de Redis — no se puede deshacer"
                            className="flex items-center gap-1 rounded px-2 py-1 text-error hover:bg-error-container"
                        >
                            <Icon name="delete" size={14} />
                            Eliminar
                        </button>
                    </div>

                    <div className="flex-1 overflow-auto rounded-lg border border-outline-variant bg-surface p-2 font-mono text-xs">
                        {(info.type === 'string' || info.type === 'ReJSON-RL') &&
                            (editingWhole ? (
                                <div className="flex h-full flex-col gap-2">
                                    <textarea
                                        value={wholeDraft}
                                        onChange={(e) => setWholeDraft(e.target.value)}
                                        autoFocus
                                        spellCheck={false}
                                        className="min-h-32 flex-1 resize-y rounded border border-outline-variant bg-surface-container-lowest p-2 font-mono text-xs text-on-surface outline-none focus:ring-1 focus:ring-primary"
                                    />
                                    {wholeError && <p className="text-error">{wholeError}</p>}
                                    <div className="flex justify-end gap-2">
                                        <button
                                            onClick={() => setEditingWhole(false)}
                                            className="rounded px-2 py-1 text-on-surface-variant hover:bg-surface-variant"
                                        >
                                            Cancelar
                                        </button>
                                        <button
                                            onClick={() => void saveWhole()}
                                            disabled={saving}
                                            className="rounded bg-primary px-2 py-1 text-on-primary hover:opacity-90 disabled:opacity-50"
                                        >
                                            Guardar
                                        </button>
                                    </div>
                                </div>
                            ) : looksBinary(value?.stringVal ?? '') ? (
                                <p className="italic text-on-surface-variant">
                                    Valor binario o no imprimible — no se puede mostrar ni editar como texto ({(value?.stringVal ?? '').length}{' '}
                                    caracteres). Probablemente un objeto serializado (ej. un lock de Sidekiq/Resque), no un string legible.
                                </p>
                            ) : (
                                <div className="flex h-full flex-col gap-2">
                                    <div className="flex justify-end">
                                        <button
                                            onClick={startEditWhole}
                                            title="Edita el valor completo — preserva el TTL existente"
                                            className="flex items-center gap-1 rounded px-2 py-1 text-primary hover:bg-surface-variant"
                                        >
                                            <Icon name="edit" size={13} />
                                            Editar
                                        </button>
                                    </div>
                                    <pre className="flex-1 whitespace-pre-wrap break-all">{tryPrettyPrintJSON(value?.stringVal ?? '')}</pre>
                                </div>
                            ))}

                        {info.type === 'hash' && (
                            <table className="w-full text-left">
                                <thead>
                                    <tr className="text-on-surface-variant">
                                        <th className="pb-1 pr-2">Field</th>
                                        <th className="pb-1">Value</th>
                                        <th className="w-16 pb-1" />
                                    </tr>
                                </thead>
                                <tbody>
                                    {(value?.hashPairs ?? []).map((p) => (
                                        <tr key={p.field} className="align-top">
                                            <td className="pr-2 text-on-surface-variant">{renderScalar(p.field)}</td>
                                            <td className="break-all">
                                                {editingHashField === p.field ? (
                                                    <div className="flex items-center gap-1">
                                                        <input
                                                            value={hashFieldDraft}
                                                            onChange={(e) => setHashFieldDraft(e.target.value)}
                                                            autoFocus
                                                            className="min-w-0 flex-1 rounded border border-outline-variant bg-surface-container-lowest px-1 py-0.5 text-xs outline-none focus:ring-1 focus:ring-primary"
                                                        />
                                                        <button
                                                            onClick={() =>
                                                                void mutate(async () => {
                                                                    await SetRedisHashField(connId, keyName, p.field, hashFieldDraft)
                                                                }).then((ok) => ok && setEditingHashField(null))
                                                            }
                                                            title="Guardar"
                                                            className="rounded p-0.5 text-primary hover:bg-surface-variant"
                                                        >
                                                            <Icon name="check" size={14} />
                                                        </button>
                                                        <button
                                                            onClick={() => setEditingHashField(null)}
                                                            title="Cancelar"
                                                            className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant"
                                                        >
                                                            <Icon name="close" size={14} />
                                                        </button>
                                                    </div>
                                                ) : (
                                                    renderScalar(p.value)
                                                )}
                                            </td>
                                            <td className="whitespace-nowrap text-right">
                                                {editingHashField !== p.field && (
                                                    <>
                                                        <button
                                                            onClick={() => {
                                                                setEditingHashField(p.field)
                                                                setHashFieldDraft(p.value)
                                                            }}
                                                            title="Editar valor de este field"
                                                            className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-primary"
                                                        >
                                                            <Icon name="edit" size={13} />
                                                        </button>
                                                        <button
                                                            onClick={() =>
                                                                void mutate(async () => {
                                                                    await DeleteRedisHashField(connId, keyName, p.field)
                                                                })
                                                            }
                                                            title="Eliminar este field (HDEL)"
                                                            className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-error"
                                                        >
                                                            <Icon name="delete" size={13} />
                                                        </button>
                                                    </>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                    <tr>
                                        <td className="pr-2 pt-2">
                                            <input
                                                value={newHashField}
                                                onChange={(e) => setNewHashField(e.target.value)}
                                                placeholder="field nuevo"
                                                className="w-full rounded border border-outline-variant bg-surface-container-lowest px-1 py-0.5 text-xs outline-none focus:ring-1 focus:ring-primary"
                                            />
                                        </td>
                                        <td className="pt-2">
                                            <input
                                                value={newHashValue}
                                                onChange={(e) => setNewHashValue(e.target.value)}
                                                placeholder="value"
                                                className="w-full rounded border border-outline-variant bg-surface-container-lowest px-1 py-0.5 text-xs outline-none focus:ring-1 focus:ring-primary"
                                            />
                                        </td>
                                        <td className="pt-2 text-right">
                                            <button
                                                onClick={() =>
                                                    void mutate(async () => {
                                                        await SetRedisHashField(connId, keyName, newHashField, newHashValue)
                                                    }).then((ok) => {
                                                        if (ok) {
                                                            setNewHashField('')
                                                            setNewHashValue('')
                                                        }
                                                    })
                                                }
                                                disabled={!newHashField}
                                                title="Agregar field (HSET)"
                                                className="rounded p-0.5 text-primary hover:bg-surface-variant disabled:opacity-40"
                                            >
                                                <Icon name="add" size={14} />
                                            </button>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        )}

                        {info.type === 'list' && (
                            <table className="w-full text-left">
                                <thead>
                                    <tr className="text-on-surface-variant">
                                        <th className="w-10 pb-1 pr-2">#</th>
                                        <th className="pb-1">Value</th>
                                        <th className="w-16 pb-1" />
                                    </tr>
                                </thead>
                                <tbody>
                                    {(value?.listItems ?? []).map((v, i) => (
                                        <tr key={i} className="align-top">
                                            <td className="pr-2 text-on-surface-variant">{i}</td>
                                            <td className="break-all">
                                                {editingListIndex === i ? (
                                                    <div className="flex items-center gap-1">
                                                        <input
                                                            value={listItemDraft}
                                                            onChange={(e) => setListItemDraft(e.target.value)}
                                                            autoFocus
                                                            className="min-w-0 flex-1 rounded border border-outline-variant bg-surface-container-lowest px-1 py-0.5 text-xs outline-none focus:ring-1 focus:ring-primary"
                                                        />
                                                        <button
                                                            onClick={() =>
                                                                void mutate(async () => {
                                                                    await SetRedisListIndex(connId, keyName, i, listItemDraft)
                                                                }).then((ok) => ok && setEditingListIndex(null))
                                                            }
                                                            title="Guardar"
                                                            className="rounded p-0.5 text-primary hover:bg-surface-variant"
                                                        >
                                                            <Icon name="check" size={14} />
                                                        </button>
                                                        <button
                                                            onClick={() => setEditingListIndex(null)}
                                                            title="Cancelar"
                                                            className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant"
                                                        >
                                                            <Icon name="close" size={14} />
                                                        </button>
                                                    </div>
                                                ) : (
                                                    renderScalar(v)
                                                )}
                                            </td>
                                            <td className="whitespace-nowrap text-right">
                                                {editingListIndex !== i && (
                                                    <>
                                                        <button
                                                            onClick={() => {
                                                                setEditingListIndex(i)
                                                                setListItemDraft(v)
                                                            }}
                                                            title="Editar este elemento (LSET)"
                                                            className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-primary"
                                                        >
                                                            <Icon name="edit" size={13} />
                                                        </button>
                                                        <button
                                                            onClick={() =>
                                                                void mutate(async () => {
                                                                    await RemoveRedisListIndex(connId, keyName, i)
                                                                })
                                                            }
                                                            title="Eliminar este elemento"
                                                            className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-error"
                                                        >
                                                            <Icon name="delete" size={13} />
                                                        </button>
                                                    </>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                    <tr>
                                        <td className="pt-2 text-on-surface-variant">+</td>
                                        <td className="pt-2">
                                            <input
                                                value={newListValue}
                                                onChange={(e) => setNewListValue(e.target.value)}
                                                placeholder="nuevo elemento (se agrega al final)"
                                                className="w-full rounded border border-outline-variant bg-surface-container-lowest px-1 py-0.5 text-xs outline-none focus:ring-1 focus:ring-primary"
                                            />
                                        </td>
                                        <td className="pt-2 text-right">
                                            <button
                                                onClick={() =>
                                                    void mutate(async () => {
                                                        await PushRedisListValue(connId, keyName, newListValue)
                                                    }).then((ok) => ok && setNewListValue(''))
                                                }
                                                disabled={!newListValue}
                                                title="Agregar al final (RPUSH)"
                                                className="rounded p-0.5 text-primary hover:bg-surface-variant disabled:opacity-40"
                                            >
                                                <Icon name="add" size={14} />
                                            </button>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        )}

                        {info.type === 'set' && (
                            <>
                                <ul className="list-none">
                                    {(value?.setMembers ?? []).map((m) => (
                                        <li key={m} className="flex items-center gap-2 break-all py-0.5">
                                            <span className="flex-1">{renderScalar(m)}</span>
                                            <button
                                                onClick={() =>
                                                    void mutate(async () => {
                                                        await RemoveRedisSetMember(connId, keyName, m)
                                                    })
                                                }
                                                title="Eliminar este member (SREM)"
                                                className="shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-error"
                                            >
                                                <Icon name="delete" size={13} />
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                                <div className="mt-2 flex items-center gap-1">
                                    <input
                                        value={newSetMember}
                                        onChange={(e) => setNewSetMember(e.target.value)}
                                        placeholder="member nuevo"
                                        className="min-w-0 flex-1 rounded border border-outline-variant bg-surface-container-lowest px-1 py-0.5 text-xs outline-none focus:ring-1 focus:ring-primary"
                                    />
                                    <button
                                        onClick={() =>
                                            void mutate(async () => {
                                                await AddRedisSetMember(connId, keyName, newSetMember)
                                            }).then((ok) => ok && setNewSetMember(''))
                                        }
                                        disabled={!newSetMember}
                                        title="Agregar member (SADD)"
                                        className="rounded p-0.5 text-primary hover:bg-surface-variant disabled:opacity-40"
                                    >
                                        <Icon name="add" size={14} />
                                    </button>
                                </div>
                            </>
                        )}

                        {info.type === 'zset' && (
                            <table className="w-full text-left">
                                <thead>
                                    <tr className="text-on-surface-variant">
                                        <th className="pb-1 pr-2">Member</th>
                                        <th className="pb-1">Score</th>
                                        <th className="w-16 pb-1" />
                                    </tr>
                                </thead>
                                <tbody>
                                    {(value?.zsetItems ?? []).map((z) => (
                                        <tr key={z.member} className="align-top">
                                            <td className="break-all pr-2">{renderScalar(z.member)}</td>
                                            <td className="text-on-surface-variant">
                                                {editingZsetMember === z.member ? (
                                                    <div className="flex items-center gap-1">
                                                        <input
                                                            value={zsetScoreDraft}
                                                            onChange={(e) => setZsetScoreDraft(e.target.value)}
                                                            type="number"
                                                            autoFocus
                                                            className="w-20 rounded border border-outline-variant bg-surface-container-lowest px-1 py-0.5 text-xs outline-none focus:ring-1 focus:ring-primary"
                                                        />
                                                        <button
                                                            onClick={() =>
                                                                void mutate(async () => {
                                                                    await AddRedisZSetMember(connId, keyName, z.member, Number(zsetScoreDraft) || 0)
                                                                }).then((ok) => ok && setEditingZsetMember(null))
                                                            }
                                                            title="Guardar"
                                                            className="rounded p-0.5 text-primary hover:bg-surface-variant"
                                                        >
                                                            <Icon name="check" size={14} />
                                                        </button>
                                                        <button
                                                            onClick={() => setEditingZsetMember(null)}
                                                            title="Cancelar"
                                                            className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant"
                                                        >
                                                            <Icon name="close" size={14} />
                                                        </button>
                                                    </div>
                                                ) : (
                                                    z.score
                                                )}
                                            </td>
                                            <td className="whitespace-nowrap text-right">
                                                {editingZsetMember !== z.member && (
                                                    <>
                                                        <button
                                                            onClick={() => {
                                                                setEditingZsetMember(z.member)
                                                                setZsetScoreDraft(String(z.score))
                                                            }}
                                                            title="Editar score (ZADD)"
                                                            className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-primary"
                                                        >
                                                            <Icon name="edit" size={13} />
                                                        </button>
                                                        <button
                                                            onClick={() =>
                                                                void mutate(async () => {
                                                                    await RemoveRedisZSetMember(connId, keyName, z.member)
                                                                })
                                                            }
                                                            title="Eliminar este member (ZREM)"
                                                            className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-error"
                                                        >
                                                            <Icon name="delete" size={13} />
                                                        </button>
                                                    </>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                    <tr>
                                        <td className="pr-2 pt-2">
                                            <input
                                                value={newZsetMember}
                                                onChange={(e) => setNewZsetMember(e.target.value)}
                                                placeholder="member nuevo"
                                                className="w-full rounded border border-outline-variant bg-surface-container-lowest px-1 py-0.5 text-xs outline-none focus:ring-1 focus:ring-primary"
                                            />
                                        </td>
                                        <td className="pt-2">
                                            <input
                                                value={newZsetScore}
                                                onChange={(e) => setNewZsetScore(e.target.value)}
                                                type="number"
                                                className="w-20 rounded border border-outline-variant bg-surface-container-lowest px-1 py-0.5 text-xs outline-none focus:ring-1 focus:ring-primary"
                                            />
                                        </td>
                                        <td className="pt-2 text-right">
                                            <button
                                                onClick={() =>
                                                    void mutate(async () => {
                                                        await AddRedisZSetMember(connId, keyName, newZsetMember, Number(newZsetScore) || 0)
                                                    }).then((ok) => {
                                                        if (ok) {
                                                            setNewZsetMember('')
                                                            setNewZsetScore('0')
                                                        }
                                                    })
                                                }
                                                disabled={!newZsetMember}
                                                title="Agregar member (ZADD)"
                                                className="rounded p-0.5 text-primary hover:bg-surface-variant disabled:opacity-40"
                                            >
                                                <Icon name="add" size={14} />
                                            </button>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        )}

                        {info.type === 'stream' && (
                            <table className="w-full text-left">
                                <thead>
                                    <tr className="text-on-surface-variant">
                                        <th className="pb-1 pr-2">ID</th>
                                        <th className="pb-1">Fields</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {(value?.streamEntries ?? []).map((entry) => (
                                        <tr key={entry.id} className="align-top">
                                            <td className="pr-2 text-on-surface-variant">{entry.id}</td>
                                            <td className="break-all">
                                                {Object.entries(entry.fields ?? {}).map(([k, v], i, arr) => (
                                                    <span key={k}>
                                                        {k}={renderScalar(v)}
                                                        {i < arr.length - 1 ? ', ' : ''}
                                                    </span>
                                                ))}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>

                    {value?.cursor && (
                        <button
                            onClick={() => void loadMore()}
                            disabled={loadingMore}
                            title="Carga la siguiente página de este valor — nunca se trae todo de una sola vez"
                            className="w-full rounded px-2 py-1 text-center text-xs text-primary hover:bg-surface-variant disabled:opacity-50"
                        >
                            {loadingMore ? 'Cargando…' : 'Cargar más'}
                        </button>
                    )}
                </>
            )}

            {confirmDelete && (
                <ConfirmDialog
                    title="Eliminar key"
                    description={`Esto elimina "${keyName}" de Redis de forma permanente. No se puede deshacer.`}
                    confirmLabel={deleting ? 'Eliminando…' : 'Eliminar'}
                    danger
                    onConfirm={() => void doDelete()}
                    onClose={() => setConfirmDelete(false)}
                />
            )}
        </div>
    )
}
