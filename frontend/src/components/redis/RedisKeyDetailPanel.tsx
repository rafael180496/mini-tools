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
import RedisTTLControl from './RedisTTLControl'
import RedisValueTable, {
    HASH_COLUMNS, LIST_COLUMNS, SET_COLUMNS, ZSET_COLUMNS, STREAM_COLUMNS,
    hashRows, listRows, setRows, zsetRows, streamRows,
} from './RedisValueTable'
import {formatError, formatValue, REDIS_FORMATS, type RedisFormat} from '../../lib/redisFormat'
import RedisStagingBar from './RedisStagingBar'
import RedisValueDrawer from './RedisValueDrawer'
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

    // How to render values. Redis stores bytes: the same key can hold a JSON
    // document, a marshaled object or a lock token that is not text at all,
    // so one rendering cannot serve them. 'auto' picks per value; the rest
    // are the override for when it guesses wrong.
    const [format, setFormat] = useState<RedisFormat>('auto')

    // Staged edits and deletions, keyed by row id (hash field, list index,
    // set/zset member). NOTHING here has been written to Redis: the whole
    // point is that a mistyped value is a Discard away instead of gone.
    // Redis has no undo and the UI holds no transaction open, so the buffer
    // is the only safety net there is.
    const [pendingEdits, setPendingEdits] = useState<Record<string, string>>({})
    const [pendingDeletes, setPendingDeletes] = useState<string[]>([])
    const [applying, setApplying] = useState(false)
    const [drawer, setDrawer] = useState<{rowId: string; value: string; readOnly: boolean} | null>(null)

    function stageEdit(rowId: string, value: string) {
        setPendingEdits((prev) => ({...prev, [rowId]: value}))
    }

    function revertEdit(rowId: string) {
        setPendingEdits((prev) => {
            const next = {...prev}
            delete next[rowId]
            return next
        })
    }

    function toggleDelete(rowId: string) {
        setPendingDeletes((prev) => (prev.includes(rowId) ? prev.filter((id) => id !== rowId) : [...prev, rowId]))
        // A row on its way out has no use for a pending edit.
        revertEdit(rowId)
    }

    // Adding an element writes immediately and then reloads, which would
    // wipe the staged buffer along with it. Rather than silently losing that
    // work, the add row is blocked while anything is pending.
    const hasStaged = Object.keys(pendingEdits).length > 0 || pendingDeletes.length > 0
    const stagedBlockTitle = 'Guardá o descartá los cambios pendientes antes de agregar: agregar recarga la clave y perdería lo que tenés sin aplicar.'

    function discardStaged() {
        setPendingEdits({})
        setPendingDeletes([])
    }

    // applyStaged writes the buffer to Redis, one command per change —
    // Redis has no multi-key transaction the UI is holding open, so this is
    // a sequence, not an atomic apply. Ordering matters in two ways and
    // both are load-bearing:
    //
    //  1. Edits run BEFORE deletes. For a list, an edit addresses a
    //     position (LSET index), and deleting first would shift every
    //     position after it — the edit would then land on the wrong element.
    //  2. List deletes run from the HIGHEST index down. Removing index 2
    //     shifts 3 into 2, so deleting ascending removes the wrong elements
    //     from the second one onward. Descending leaves the not-yet-deleted
    //     indices untouched.
    //
    // The other types key by name (hash field, set/zset member), where
    // neither concern applies.
    async function applyStaged() {
        if (!info) return
        setApplying(true)
        setError('')
        try {
            for (const [rowId, value] of Object.entries(pendingEdits)) {
                switch (info.type) {
                    case 'hash':
                        await SetRedisHashField(connId, keyName, rowId, value)
                        break
                    case 'list':
                        await SetRedisListIndex(connId, keyName, Number(rowId), value)
                        break
                    case 'zset':
                        await AddRedisZSetMember(connId, keyName, rowId, Number(value) || 0)
                        break
                }
            }

            const deletions =
                info.type === 'list'
                    ? [...pendingDeletes].sort((a, b) => Number(b) - Number(a))
                    : pendingDeletes

            for (const rowId of deletions) {
                switch (info.type) {
                    case 'hash':
                        await DeleteRedisHashField(connId, keyName, rowId)
                        break
                    case 'list':
                        await RemoveRedisListIndex(connId, keyName, Number(rowId))
                        break
                    case 'set':
                        await RemoveRedisSetMember(connId, keyName, rowId)
                        break
                    case 'zset':
                        await RemoveRedisZSetMember(connId, keyName, rowId)
                        break
                }
            }

            discardStaged()
            await load()
        } catch (e) {
            // The buffer is deliberately NOT cleared on failure: some
            // commands may have gone through and some not, and dropping the
            // rest would hide what is still unapplied.
            setError(`No se pudieron aplicar todos los cambios: ${e}`)
        } finally {
            setApplying(false)
        }
    }

    // Shared staging props for the value tables. `editable` is the column a
    // cell edit changes — a set has none, since its member IS its identity.
    function stagingProps(editableColumn?: string) {
        return {
            editableColumn,
            pendingEdits,
            pendingDeletes,
            onEdit: editableColumn ? stageEdit : undefined,
            onRevertEdit: editableColumn ? revertEdit : undefined,
            onToggleDelete: toggleDelete,
        }
    }

    // string/JSON: whole-value textarea edit.
    const [editingWhole, setEditingWhole] = useState(false)
    const [wholeDraft, setWholeDraft] = useState('')
    const [wholeError, setWholeError] = useState('')

    // hash: per-field inline edit + "add field" row.
    const [newHashField, setNewHashField] = useState('')
    const [newHashValue, setNewHashValue] = useState('')

    // list: per-index inline edit + "push" row.
    const [newListValue, setNewListValue] = useState('')

    // set: "add member" row (removal has no inline edit, only delete).
    const [newSetMember, setNewSetMember] = useState('')

    // zset: "add member" row.
    const [newZsetMember, setNewZsetMember] = useState('')
    const [newZsetScore, setNewZsetScore] = useState('0')

    async function load() {
        setLoading(true)
        setError('')
        setValue(null)
        setEditingWhole(false)
        // Reloading the key means the staged buffer no longer describes what
        // is on screen — a pending edit on hash field "x" is meaningless once
        // the values were re-read. Dropping it beats applying it blind.
        setPendingEdits({})
        setPendingDeletes([])
        setDrawer(null)
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
                        <RedisTTLControl
                            connId={connId}
                            keyName={keyName}
                            ttlSeconds={info.ttlSeconds}
                            onChanged={() => void load()}
                            onError={setError}
                        />
                        <label className="flex items-center gap-1" title="Cómo interpretar el contenido de los valores">
                            Formato
                            <select
                                value={format}
                                onChange={(e) => setFormat(e.target.value as RedisFormat)}
                                className="rounded border border-outline-variant bg-surface-container-low px-1 py-0.5 text-xs text-on-surface"
                            >
                                {REDIS_FORMATS.map((f) => (
                                    <option key={f.value} value={f.value} title={f.hint}>
                                        {f.label}
                                    </option>
                                ))}
                            </select>
                        </label>
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

                    <RedisStagingBar
                        editCount={Object.keys(pendingEdits).length}
                        deleteCount={pendingDeletes.length}
                        saving={applying}
                        onSave={() => void applyStaged()}
                        onDiscard={discardStaged}
                    />

                    <div className="relative flex-1 overflow-auto rounded-lg border border-outline-variant bg-surface p-2 font-mono text-xs">
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
                                    {formatError(value?.stringVal ?? '', format) && (
                                        <p className="text-ui-11 text-tertiary">{formatError(value?.stringVal ?? '', format)}</p>
                                    )}
                                    <pre className="flex-1 whitespace-pre-wrap break-all">{formatValue(value?.stringVal ?? '', format)}</pre>
                                </div>
                            ))}

                        {info.type === 'hash' && (
                            <>
                                <RedisValueTable
                                    columns={HASH_COLUMNS}
                                    rows={hashRows(value?.hashPairs ?? [])}
                                    format={format}
                                    emptyLabel="Este hash no tiene campos."
                                    {...stagingProps('value')}
                                    onExpand={(rowId, v) => setDrawer({rowId, value: v, readOnly: false})}
                                    rowActions={(row) => (
                                        <DeleteToggle
                                            staged={pendingDeletes.includes(row.id)}
                                            onToggle={() => toggleDelete(row.id)}
                                            label="campo (HDEL)"
                                        />
                                    )}
                                />
                                <AddRow
                                    inputs={[
                                        {value: newHashField, onChange: setNewHashField, placeholder: 'campo nuevo'},
                                        {value: newHashValue, onChange: setNewHashValue, placeholder: 'valor'},
                                    ]}
                                    disabled={!newHashField || hasStaged}
                                    title={hasStaged ? stagedBlockTitle : "Agrega un campo al hash (HSET)"}
                                    onAdd={() =>
                                        void mutate(async () => {
                                            await SetRedisHashField(connId, keyName, newHashField, newHashValue)
                                        }).then((ok) => {
                                            if (ok) {
                                                setNewHashField('')
                                                setNewHashValue('')
                                            }
                                        })
                                    }
                                />
                            </>
                        )}

                        {info.type === 'list' && (
                            <>
                                <RedisValueTable
                                    columns={LIST_COLUMNS}
                                    rows={listRows(value?.listItems ?? [], 0)}
                                    format={format}
                                    emptyLabel="Esta lista está vacía."
                                    {...stagingProps('value')}
                                    onExpand={(rowId, v) => setDrawer({rowId, value: v, readOnly: false})}
                                    rowActions={(row) => (
                                        <DeleteToggle
                                            staged={pendingDeletes.includes(row.id)}
                                            onToggle={() => toggleDelete(row.id)}
                                            label="elemento de la lista"
                                        />
                                    )}
                                />
                                <AddRow
                                    inputs={[{value: newListValue, onChange: setNewListValue, placeholder: 'nuevo elemento (se agrega al final)'}]}
                                    disabled={!newListValue || hasStaged}
                                    title={hasStaged ? stagedBlockTitle : "Agrega el elemento al final de la lista (RPUSH)"}
                                    onAdd={() =>
                                        void mutate(async () => {
                                            await PushRedisListValue(connId, keyName, newListValue)
                                        }).then((ok) => ok && setNewListValue(''))
                                    }
                                />
                            </>
                        )}

                        {info.type === 'set' && (
                            <>
                                <RedisValueTable
                                    columns={SET_COLUMNS}
                                    rows={setRows(value?.setMembers ?? [])}
                                    format={format}
                                    emptyLabel="Este conjunto está vacío."
                                    {...stagingProps()}
                                    onExpand={(rowId, v) => setDrawer({rowId, value: v, readOnly: true})}
                                    rowActions={(row) => (
                                        <DeleteToggle
                                            staged={pendingDeletes.includes(row.id)}
                                            onToggle={() => toggleDelete(row.id)}
                                            label="miembro del conjunto (SREM)"
                                        />
                                    )}
                                />
                                <AddRow
                                    inputs={[{value: newSetMember, onChange: setNewSetMember, placeholder: 'miembro nuevo'}]}
                                    disabled={!newSetMember || hasStaged}
                                    title={hasStaged ? stagedBlockTitle : "Agrega un miembro al conjunto (SADD)"}
                                    onAdd={() =>
                                        void mutate(async () => {
                                            await AddRedisSetMember(connId, keyName, newSetMember)
                                        }).then((ok) => ok && setNewSetMember(''))
                                    }
                                />
                            </>
                        )}

                        {info.type === 'zset' && (
                            <>
                                <RedisValueTable
                                    columns={ZSET_COLUMNS}
                                    rows={zsetRows(value?.zsetItems ?? [])}
                                    format={format}
                                    emptyLabel="Este sorted set está vacío."
                                    {...stagingProps('score')}
                                    rowActions={(row) => (
                                        <DeleteToggle
                                            staged={pendingDeletes.includes(row.id)}
                                            onToggle={() => toggleDelete(row.id)}
                                            label="miembro del sorted set (ZREM)"
                                        />
                                    )}
                                />
                                <AddRow
                                    inputs={[
                                        {value: newZsetMember, onChange: setNewZsetMember, placeholder: 'miembro nuevo'},
                                        {value: newZsetScore, onChange: setNewZsetScore, placeholder: 'score', numeric: true},
                                    ]}
                                    disabled={!newZsetMember || hasStaged}
                                    title={hasStaged ? stagedBlockTitle : "Agrega un miembro con su score (ZADD)"}
                                    onAdd={() =>
                                        void mutate(async () => {
                                            await AddRedisZSetMember(connId, keyName, newZsetMember, Number(newZsetScore) || 0)
                                        }).then((ok) => {
                                            if (ok) {
                                                setNewZsetMember('')
                                                setNewZsetScore('0')
                                            }
                                        })
                                    }
                                />
                            </>
                        )}

                        {info.type === 'stream' && (
                            <RedisValueTable
                                columns={STREAM_COLUMNS}
                                rows={streamRows(value?.streamEntries ?? [])}
                                format={format}
                                emptyLabel="Este stream no tiene entradas."
                            />
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

                        {drawer && (
                            <RedisValueDrawer
                                title={`${keyName} · ${drawer.rowId}`}
                                value={drawer.value}
                                readOnly={drawer.readOnly}
                                onSave={(v) => {
                                    stageEdit(drawer.rowId, v)
                                    setDrawer(null)
                                }}
                                onClose={() => setDrawer(null)}
                            />
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

// DeleteToggle marks a row for removal instead of removing it. The write
// happens when the staging bar is saved, which is what makes a mis-click
// recoverable — Redis has no undo.
function DeleteToggle({staged, onToggle, label}: {staged: boolean; onToggle: () => void; label: string}) {
    return (
        <button
            onClick={onToggle}
            title={staged ? `Cancela la baja pendiente de este ${label}` : `Marca este ${label} para eliminar. Se borra recién al guardar los cambios.`}
            className={`rounded p-0.5 ${staged ? 'text-error' : 'text-on-surface-variant hover:bg-surface-variant hover:text-error'}`}
        >
            <Icon name={staged ? 'undo' : 'delete'} size={13} />
        </button>
    )
}

// AddRow is the "add an element" strip under each table.
function AddRow({
    inputs,
    onAdd,
    disabled,
    title,
}: {
    inputs: {value: string; onChange: (v: string) => void; placeholder: string; numeric?: boolean}[]
    onAdd: () => void
    disabled: boolean
    title: string
}) {
    return (
        <div className="mt-2 flex items-center gap-1.5">
            <Icon name="add" size={14} className="shrink-0 text-on-surface-variant" />
            {inputs.map((input, i) => (
                <input
                    key={i}
                    value={input.value}
                    onChange={(e) => input.onChange(e.target.value)}
                    type={input.numeric ? 'number' : 'text'}
                    placeholder={input.placeholder}
                    className={`min-w-0 rounded border border-outline-variant bg-surface-container-lowest px-1.5 py-0.5 font-mono text-xs text-on-surface outline-none focus:ring-1 focus:ring-primary ${
                        input.numeric ? 'w-24 shrink-0' : 'flex-1'
                    }`}
                />
            ))}
            <button
                onClick={onAdd}
                disabled={disabled}
                title={title}
                className="shrink-0 rounded bg-primary px-2 py-0.5 text-ui-11 text-on-primary disabled:opacity-40"
            >
                Agregar
            </button>
        </div>
    )
}
