import {lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {ListModelServers, ModelServerDeleteModel, ModelServerModels, ModelServerRunning, ModelServerUnload} from '../../../wailsjs/go/main/App'
import type {llm, main} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import Select, {type SelectOption} from '../Select'
import ConfirmDialog from '../ConfirmDialog'
import {HealthBadge, ProviderIconWithHealth} from '../agent/HealthIndicators'
import {errorText, useT} from '../../i18n'
import {recheckHealth, useModelServerHealth, useModelServersHealth} from '../../lib/modelServerHealth'
import {MODEL_SERVER_PREFIX} from '../../lib/modelServers'
import {notifyModelsChanged} from '../../lib/modelsChanged'
import {NoticeBar, type Notice} from './useProcessKiller'
import ModelDetailsPanel from './models/ModelDetailsPanel'
import {ModelPullForm, ModelPullList} from './models/ModelPullPanel'
import {canonicalName, formatModelSize, fullDate, hostOf, inFuture, matchesModel, shortDate, sortModels, type SortKey} from './models/modelFormat'
import {useModelPulls} from './models/useModelPulls'

// Modelos: administrar los modelos de un servidor (Ollama, local o remoto).
//
// Ver, descargar y borrar los modelos sin abrir una terminal en la máquina del
// servidor. Todo pasa por los bindings ModelServer* del backend, que usan el
// token, las cabeceras y la preferencia de TLS del servidor guardado: un Ollama
// detrás de un proxy con X-Api-Key se administra igual que uno local.
//
// **Qué se puede hacer depende del tipo.** Ollama expone listar, descargar,
// borrar y descargar de memoria. Un servidor compatible con OpenAI (LM Studio,
// vLLM, llama.cpp) solo sabe listar: la pestaña lo muestra en solo lectura y lo
// dice, en vez de ofrecer botones que van a fallar.
//
// **Las descargas viven en el backend.** Cerrar la pestaña no las corta; ver
// models/useModelPulls.

const ModelServerDialog = lazy(() => import('../ModelServerDialog'))

// Cada cuánto se relee qué modelos están cargados mientras la pestaña se ve.
// Es una consulta chica (/api/ps) y el dato envejece rápido: un modelo se
// libera solo a los 5 minutos de inactividad.
const RUNNING_REFRESH_MS = 15_000

const LAST_SERVER_KEY = 'mini-tools:modelManager:server'
const ADD_SERVER = '__add__'

function loadLastServer(): string {
    try {
        return localStorage.getItem(LAST_SERVER_KEY) ?? ''
    } catch {
        return ''
    }
}

function saveLastServer(id: string) {
    try {
        localStorage.setItem(LAST_SERVER_KEY, id)
    } catch {
        // sin almacenamiento: se vuelve a elegir la próxima vez
    }
}

interface Props {
    // La pestaña está a la vista. Una pestaña oculta sigue montada, pero no
    // consulta ni sondea.
    visible: boolean
}

export default function ModelManagerTab({visible}: Props) {
    const t = useT()
    const L = t.models

    const [servers, setServers] = useState<main.ModelServer[] | null>(null)
    const [serverId, setServerId] = useState(loadLastServer)
    const [models, setModels] = useState<llm.ManagedModel[] | null>(null)
    const [running, setRunning] = useState<llm.RunningModel[]>([])
    const [loading, setLoading] = useState(false)
    const [loadError, setLoadError] = useState('')
    const [query, setQuery] = useState('')
    const [sort, setSort] = useState<{key: SortKey; dir: 'asc' | 'desc'}>({key: 'name', dir: 'asc'})
    const [detail, setDetail] = useState<string | null>(null)
    const [busy, setBusy] = useState<Set<string>>(new Set())
    const [notice, setNotice] = useState<Notice | null>(null)
    const [confirm, setConfirm] = useState<llm.ManagedModel | null>(null)
    const [adding, setAdding] = useState(false)
    // El reloj de los «se libera en…»: se renueva con cada lectura de /api/ps.
    const [now, setNow] = useState(() => Date.now())

    const server = useMemo(() => servers?.find((s) => s.id === serverId) ?? null, [servers, serverId])
    const canManage = server?.kind === 'ollama'
    const loadSeq = useRef(0)

    // --- Servidores ------------------------------------------------------------

    const loadServers = useCallback(async (select?: string) => {
        try {
            const list = (await ListModelServers()) ?? []
            setServers(list)
            setServerId((cur) => {
                const wanted = select ?? cur
                const next = list.some((s) => s.id === wanted) ? wanted : (list[0]?.id ?? '')
                saveLastServer(next)
                return next
            })
        } catch (e) {
            setServers([])
            setLoadError(errorText(e))
        }
    }, [])

    useEffect(() => {
        if (visible) void loadServers()
    }, [visible, loadServers])

    const agentIds = useMemo(() => (servers ?? []).map((s) => MODEL_SERVER_PREFIX + s.id), [servers])
    const healthById = useModelServersHealth(agentIds, visible)
    const current = useModelServerHealth(serverId ? MODEL_SERVER_PREFIX + serverId : '', visible)

    // --- Modelos -----------------------------------------------------------------

    const load = useCallback(
        async (id: string) => {
            if (!id) return
            const seq = ++loadSeq.current
            setLoading(true)
            setLoadError('')
            try {
                const list = (await ModelServerModels(id)) ?? []
                if (seq !== loadSeq.current) return
                setModels(list)
                const run = (await ModelServerRunning(id).catch(() => [])) ?? []
                if (seq !== loadSeq.current) return
                setRunning(run)
                setNow(Date.now())
            } catch (e) {
                if (seq !== loadSeq.current) return
                setModels(null)
                setRunning([])
                setLoadError(errorText(e))
            } finally {
                if (seq === loadSeq.current) setLoading(false)
            }
        },
        [],
    )

    // Cambiar de servidor descarta lo del anterior: mostrar sus modelos bajo el
    // nombre del nuevo, aunque sea un instante, es mentir.
    useEffect(() => {
        setModels(null)
        setRunning([])
        setDetail(null)
        setLoadError('')
        setNotice(null)
    }, [serverId])

    // Lee al ponerse a la vista (la lista pudo quedar vieja mientras estaba
    // oculta) y al cambiar de servidor, sin tirar el detalle ni el aviso abiertos.
    useEffect(() => {
        if (visible && serverId) void load(serverId)
    }, [serverId, visible, load])

    // Los modelos cargados cambian solos (se liberan por inactividad, o los carga
    // un chat): se relee solo esa lista, con la ventana a la vista.
    useEffect(() => {
        if (!visible || !serverId || !canManage || models === null) return
        const timer = window.setInterval(() => {
            if (document.hidden) return
            ModelServerRunning(serverId)
                .then((r) => {
                    setRunning(r ?? [])
                    setNow(Date.now())
                })
                .catch(() => {})
        }, RUNNING_REFRESH_MS)
        return () => window.clearInterval(timer)
    }, [visible, serverId, canManage, models])

    // Aviso al resto de la app de que los modelos del servidor cambiaron: el
    // chat relee su selector, y el estado de salud (que guarda la lista) se
    // vuelve a pedir saltándose la caché.
    const announceChange = useCallback((id: string) => {
        recheckHealth(id)
        notifyModelsChanged(id)
    }, [])

    // --- Descargas ---------------------------------------------------------------

    const {pulls, start, cancel, dismiss} = useModelPulls(visible, (p) => {
        if (p.error || p.cancelled) return
        announceChange(p.serverId)
        if (p.serverId === serverId) void load(serverId)
    })

    // --- Acciones ----------------------------------------------------------------

    const markBusy = (name: string, on: boolean) =>
        setBusy((s) => {
            const next = new Set(s)
            if (on) next.add(name)
            else next.delete(name)
            return next
        })

    async function unload(m: llm.ManagedModel) {
        markBusy(m.name, true)
        try {
            await ModelServerUnload(serverId, m.name)
            setNotice({tone: 'ok', text: L.unloaded({name: m.name})})
            setRunning((await ModelServerRunning(serverId).catch(() => [])) ?? [])
            setNow(Date.now())
        } catch (e) {
            setNotice({tone: 'error', text: L.unloadFailed({name: m.name, error: errorText(e)})})
        } finally {
            markBusy(m.name, false)
        }
    }

    async function remove(m: llm.ManagedModel) {
        markBusy(m.name, true)
        try {
            await ModelServerDeleteModel(serverId, m.name)
            setNotice({tone: 'ok', text: L.deleted({name: m.name})})
            if (detail === m.name) setDetail(null)
            announceChange(serverId)
            await load(serverId)
        } catch (e) {
            setNotice({tone: 'error', text: L.deleteFailed({name: m.name, error: errorText(e)})})
        } finally {
            markBusy(m.name, false)
        }
    }

    // --- Derivados -----------------------------------------------------------------

    const runningByName = useMemo(() => new Map(running.map((r) => [canonicalName(r.name), r])), [running])

    const visibleModels = useMemo(() => {
        const q = query.trim().toLowerCase()
        return sortModels((models ?? []).filter((m) => matchesModel(m, q)), sort.key, sort.dir)
    }, [models, query, sort])

    // Una columna que ningún modelo llena no se dibuja: un servidor compatible
    // con OpenAI solo informa el nombre, y cinco columnas de «—» no dicen nada.
    const has = useMemo(() => {
        const all = models ?? []
        return {
            family: all.some((m) => !!m.family),
            params: all.some((m) => !!m.parameterSize),
            quant: all.some((m) => !!m.quantizationLevel),
            size: all.some((m) => m.size > 0),
            modified: all.some((m) => !!m.modifiedAt),
        }
    }, [models])

    const totalSize = useMemo(() => (models ?? []).reduce((n, m) => n + m.size, 0), [models])
    const detailModel = detail ? (models ?? []).find((m) => m.name === detail) : undefined

    const serverOptions: SelectOption[] = useMemo(() => {
        const list = (servers ?? []).map<SelectOption>((s, i, all) => ({
            value: s.id,
            label: s.name,
            hint: hostOf(s.baseUrl),
            icon: <ProviderIconWithHealth icon={s.isLocal ? 'computer' : 'dns'} health={healthById[MODEL_SERVER_PREFIX + s.id] ?? null} server={s.name} />,
            // «Agregar servidor…» no es un servidor más: va separado de la lista.
            separatorAfter: i === all.length - 1,
        }))
        return [...list, {value: ADD_SERVER, label: L.addServer, title: L.addServerTitle, icon: <Icon name="add_circle" size={14} />}]
    }, [servers, healthById, L])

    function toggleSort(key: SortKey) {
        setSort((s) => (s.key === key ? {key, dir: s.dir === 'asc' ? 'desc' : 'asc'} : {key, dir: key === 'name' ? 'asc' : 'desc'}))
    }

    function sortHead(key: SortKey, label: string, extra = '') {
        const active = sort.key === key
        return (
            <th scope="col" aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={`truncate px-3 py-2 font-semibold ${extra}`}>
                <button
                    type="button"
                    onClick={() => toggleSort(key)}
                    title={L.sortBy({column: label})}
                    className={`flex items-center gap-0.5 uppercase tracking-wider hover:text-on-surface ${active ? 'text-on-surface' : ''}`}
                >
                    {label}
                    <Icon name={active ? (sort.dir === 'asc' ? 'arrow_upward' : 'arrow_downward') : 'swap_vert'} size={12} className={active ? '' : 'opacity-40'} />
                </button>
            </th>
        )
    }

    // --- Pantallas previas a la lista --------------------------------------------

    if (servers === null) {
        return <div className="flex h-full w-full flex-1 items-center justify-center bg-surface text-xs text-on-surface-variant">{L.loading}</div>
    }

    const addDialog = adding && (
        <Suspense fallback={null}>
            <ModelServerDialog
                onClose={() => setAdding(false)}
                onSaved={(saved) => {
                    setAdding(false)
                    void loadServers(saved.id)
                }}
            />
        </Suspense>
    )

    if (servers.length === 0) {
        return (
            <div className="flex h-full w-full flex-1 flex-col items-center justify-center gap-3 bg-surface px-6 py-10 text-center text-on-surface">
                <span className="flex h-14 w-14 items-center justify-center rounded-full bg-surface-container-highest text-on-surface-variant">
                    <Icon name="model_training" size={28} />
                </span>
                <div className="flex max-w-md flex-col gap-1">
                    <h2 className="text-base font-semibold">{L.noServer.title}</h2>
                    <p className="text-xs text-on-surface-variant">{L.noServer.body}</p>
                </div>
                <button
                    type="button"
                    onClick={() => setAdding(true)}
                    title={L.noServer.addTitle}
                    className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:opacity-90"
                >
                    <Icon name="add_circle" size={14} />
                    {L.noServer.add}
                </button>
                {addDialog}
            </div>
        )
    }

    // --- Pantalla principal ----------------------------------------------------------

    const kindLabel = server?.kind === 'ollama' ? L.kindOllama : L.kindOpenai
    const host = server ? hostOf(server.baseUrl) : ''
    const emptyList = models !== null && models.length === 0
    const filteredOut = models !== null && models.length > 0 && visibleModels.length === 0

    return (
        <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col bg-surface text-on-surface">
            <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-outline-variant bg-surface-container-low px-4 py-2">
                <Icon name="model_training" size={18} className="shrink-0 text-primary" />
                <span className="text-sm font-semibold">{L.title}</span>

                <Select
                    value={serverId}
                    options={serverOptions}
                    onChange={(v) => (v === ADD_SERVER ? setAdding(true) : setServerId(v))}
                    size="sm"
                    ariaLabel={L.serverLabel}
                    title={L.serverTitle}
                    className="w-56"
                    menuMinWidth={260}
                />

                {server && (
                    <span className="flex min-w-0 items-center gap-1.5">
                        <span title={L.kindTitle({kind: kindLabel})} className="shrink-0 rounded-full bg-surface-container-highest px-2 py-0.5 text-ui-10 text-on-surface-variant">
                            {kindLabel}
                        </span>
                        <span
                            title={server.isLocal ? L.localTitle : L.remoteTitle({host})}
                            className={`shrink-0 rounded-full px-2 py-0.5 text-ui-10 ${server.isLocal ? 'bg-secondary/15 text-secondary' : 'bg-tertiary/15 text-tertiary'}`}
                        >
                            {server.isLocal ? L.local : L.remote}
                        </span>
                        {current && <HealthBadge health={current.health} server={server.name} />}
                    </span>
                )}

                <div className="flex min-w-40 max-w-xs flex-1 items-center gap-1.5 rounded-lg bg-surface-container-highest px-2.5 py-1.5 focus-within:ring-1 focus-within:ring-primary">
                    <Icon name="search" size={14} className="shrink-0 text-on-surface-variant/60" />
                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder={L.searchPlaceholder}
                        aria-label={L.searchPlaceholder}
                        title={L.searchTitle}
                        className="min-w-0 flex-1 bg-transparent text-xs text-on-surface outline-none placeholder:text-on-surface-variant/60"
                    />
                    {query && (
                        <button type="button" onClick={() => setQuery('')} title={L.clearSearch} aria-label={L.clearSearch} className="shrink-0 rounded text-on-surface-variant/60 hover:text-on-surface">
                            <Icon name="close" size={14} />
                        </button>
                    )}
                </div>

                <button
                    type="button"
                    onClick={() => {
                        current?.refresh()
                        void load(serverId)
                    }}
                    disabled={loading}
                    title={L.refreshTitle}
                    className="ml-auto flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-on-surface-variant enabled:hover:bg-surface-variant enabled:hover:text-on-surface disabled:opacity-60"
                >
                    <Icon name="refresh" size={14} className={loading ? 'animate-spin' : ''} />
                    {L.refresh}
                </button>
            </div>

            {server && canManage && <ModelPullForm server={server} onStart={async (name) => void (await start(server.id, name))} />}
            {server && !canManage && (
                <div role="note" className="flex shrink-0 items-start gap-2 border-b border-outline-variant bg-primary/10 px-4 py-2 text-xs text-on-surface-variant">
                    <Icon name="lock" size={14} className="mt-px shrink-0 text-primary" />
                    <span className="min-w-0">
                        <span className="font-medium text-on-surface">{L.readOnly.title}. </span>
                        {L.readOnly.body({kind: L.kindOpenai})}
                    </span>
                </div>
            )}

            <ModelPullList pulls={pulls} servers={servers} onCancel={cancel} onDismiss={dismiss} />
            <NoticeBar notice={notice} onDismiss={() => setNotice(null)} dismissLabel={L.dismiss} />

            <div className="@container relative flex min-h-0 flex-1">
                <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                    {loadError ? (
                        <div className="flex flex-col items-center gap-1.5 px-6 py-12 text-center">
                            <Icon name="error" size={24} className="text-error" />
                            <p className="text-sm font-medium">{L.loadFailed}</p>
                            <p className="max-w-md break-words text-xs text-on-surface-variant">{loadError}</p>
                            <p className="max-w-md text-xs text-on-surface-variant">{L.loadFailedHint}</p>
                            <button
                                type="button"
                                onClick={() => void load(serverId)}
                                title={L.retryTitle}
                                className="mt-1 flex items-center gap-1.5 rounded-lg border border-outline-variant px-3 py-1.5 text-xs hover:bg-surface-variant"
                            >
                                <Icon name="refresh" size={14} />
                                {L.retry}
                            </button>
                        </div>
                    ) : models === null ? (
                        <p className="px-6 py-12 text-center text-xs text-on-surface-variant">{L.loading}</p>
                    ) : emptyList ? (
                        <p className="px-6 py-12 text-center text-xs text-on-surface-variant">{canManage ? L.empty : L.emptyReadOnly}</p>
                    ) : (
                        <>
                            <p className="shrink-0 px-4 py-1.5 text-ui-11 text-on-surface-variant" aria-live="polite">
                                {query.trim() ? L.summaryFiltered({shown: visibleModels.length, total: models.length}) : L.summary({count: models.length, size: totalSize > 0 ? formatModelSize(totalSize) : ''})}
                            </p>
                            {filteredOut ? (
                                <p className="px-6 py-12 text-center text-xs text-on-surface-variant">{L.noMatch({query: query.trim()})}</p>
                            ) : (
                                <div className="min-h-0 flex-1 overflow-auto">
                                    <table className="w-full table-fixed border-collapse text-xs">
                                        <thead className="sticky top-0 z-[1] bg-surface-container-low text-left text-ui-10 text-on-surface-variant">
                                            <tr className="border-b border-outline-variant">
                                                {sortHead('name', L.columns.name)}
                                                {has.family && (
                                                    <th scope="col" className="hidden w-28 truncate px-3 py-2 font-semibold uppercase tracking-wider @3xl:table-cell">
                                                        {L.columns.family}
                                                    </th>
                                                )}
                                                {has.params && (
                                                    <th scope="col" className="hidden w-28 truncate px-3 py-2 font-semibold uppercase tracking-wider @xl:table-cell">
                                                        {L.columns.params}
                                                    </th>
                                                )}
                                                {has.quant && (
                                                    <th scope="col" className="hidden w-32 truncate px-3 py-2 font-semibold uppercase tracking-wider @5xl:table-cell">
                                                        {L.columns.quant}
                                                    </th>
                                                )}
                                                {has.size && sortHead('size', L.columns.size, 'w-24')}
                                                {has.modified && sortHead('modified', L.columns.modified, 'hidden w-36 @2xl:table-cell')}
                                                {canManage && <th scope="col" className="w-24" />}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {visibleModels.map((m) => {
                                                const run = runningByName.get(canonicalName(m.name))
                                                const working = busy.has(m.name)
                                                const selected = detail === m.name
                                                const expires = run ? inFuture(run.expiresAt, now) : ''
                                                return (
                                                    <tr
                                                        key={m.name}
                                                        data-model={m.name}
                                                        aria-selected={selected}
                                                        className={`border-b border-outline-variant/30 hover:bg-surface-container-low ${selected ? 'bg-primary/10' : ''}`}
                                                    >
                                                        <td className="px-3 py-2">
                                                            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                                                                <span className="min-w-0 truncate font-mono font-medium" title={m.name}>
                                                                    {m.name}
                                                                </span>
                                                                {run && (
                                                                    <span
                                                                        title={L.loadedTitle({
                                                                            name: m.name,
                                                                            total: formatModelSize(run.size),
                                                                            vram: run.sizeVram > 0 ? formatModelSize(run.sizeVram) : '',
                                                                            expires,
                                                                        })}
                                                                        className="flex shrink-0 items-center gap-1 rounded-full bg-secondary/15 px-2 py-0.5 text-ui-10 text-secondary"
                                                                    >
                                                                        <Icon name="memory" size={11} />
                                                                        {L.loaded}
                                                                        {run.sizeVram > 0 && <span className="font-mono">· {formatModelSize(run.sizeVram)}</span>}
                                                                        {expires && <span className="hidden @lg:inline">· {expires}</span>}
                                                                    </span>
                                                                )}
                                                            </div>
                                                        </td>
                                                        {has.family && <td className="hidden truncate px-3 py-2 text-on-surface-variant @3xl:table-cell">{m.family || L.unknown}</td>}
                                                        {has.params && <td className="hidden truncate px-3 py-2 font-mono @xl:table-cell">{m.parameterSize || L.unknown}</td>}
                                                        {has.quant && <td className="hidden truncate px-3 py-2 font-mono text-on-surface-variant @5xl:table-cell">{m.quantizationLevel || L.unknown}</td>}
                                                        {has.size && <td className="px-3 py-2 font-mono">{m.size > 0 ? formatModelSize(m.size) : L.unknown}</td>}
                                                        {has.modified && (
                                                            <td className="hidden truncate px-3 py-2 text-on-surface-variant @2xl:table-cell" title={m.modifiedAt ? L.modifiedTitle({date: fullDate(m.modifiedAt)}) : undefined}>
                                                                {m.modifiedAt ? shortDate(m.modifiedAt) : L.unknown}
                                                            </td>
                                                        )}
                                                        {canManage && (
                                                            <td className="px-2 py-1">
                                                                <span className="flex items-center justify-end gap-0.5">
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => setDetail(selected ? null : m.name)}
                                                                        title={L.actions.detailsTitle({name: m.name})}
                                                                        aria-label={L.actions.details}
                                                                        aria-pressed={selected}
                                                                        className={`flex h-7 w-7 items-center justify-center rounded-lg hover:bg-surface-variant hover:text-on-surface ${selected ? 'text-primary' : 'text-on-surface-variant'}`}
                                                                    >
                                                                        <Icon name="info" size={16} />
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        disabled={!run || working}
                                                                        onClick={() => void unload(m)}
                                                                        title={working ? L.actions.unloading : run ? L.actions.unloadTitle({name: m.name}) : L.actions.unloadIdleTitle}
                                                                        aria-label={L.actions.unload}
                                                                        className="flex h-7 w-7 items-center justify-center rounded-lg text-on-surface-variant enabled:hover:bg-surface-variant enabled:hover:text-on-surface disabled:opacity-30"
                                                                    >
                                                                        <Icon name="eject" size={16} />
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        disabled={working}
                                                                        onClick={() => setConfirm(m)}
                                                                        title={working ? L.actions.deleting : L.actions.deleteTitle({name: m.name})}
                                                                        aria-label={L.actions.delete}
                                                                        className="flex h-7 w-7 items-center justify-center rounded-lg text-error enabled:hover:bg-error-container/50 disabled:opacity-30"
                                                                    >
                                                                        <Icon name="delete" size={16} />
                                                                    </button>
                                                                </span>
                                                            </td>
                                                        )}
                                                    </tr>
                                                )
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </>
                    )}
                </div>

                {server && detailModel && canManage && (
                    // En un panel ancho el detalle va al costado; en uno angosto
                    // tapa la lista (un tercer panel de 20 px no sirve para nada).
                    <div className="absolute inset-0 z-[2] min-h-0 border-l border-outline-variant @3xl:static @3xl:inset-auto @3xl:w-[26rem] @3xl:shrink-0">
                        <ModelDetailsPanel key={`${server.id}:${detailModel.name}`} serverId={server.id} model={detailModel} onClose={() => setDetail(null)} />
                    </div>
                )}
            </div>

            {confirm && server && (
                <ConfirmDialog
                    title={L.deleteConfirm.title}
                    description={L.deleteConfirm.body({
                        name: confirm.name,
                        server: server.name,
                        size: confirm.size > 0 ? formatModelSize(confirm.size) : '',
                        remote: !server.isLocal,
                        host,
                    })}
                    confirmLabel={L.deleteConfirm.action}
                    danger
                    onConfirm={() => void remove(confirm)}
                    onClose={() => setConfirm(null)}
                />
            )}
            {addDialog}
        </div>
    )
}
