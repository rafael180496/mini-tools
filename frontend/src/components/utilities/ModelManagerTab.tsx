import {lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode} from 'react'
import {DeleteModelServer, ListModelServers, ModelServerDeleteModel, ModelServerModels, ModelServerRunning, ModelServerUnload, ReorderModelServers, SaveModelServer, SetModelServerEnabled, TestModelServer} from '../../../wailsjs/go/main/App'
import {main} from '../../../wailsjs/go/models'
import type {llm} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import ResizeHandle from '../ResizeHandle'
import ConfirmDialog from '../ConfirmDialog'
import {ProbeResult, type Probe} from '../ModelServerProbeResult'
import {HealthBadge} from '../agent/HealthIndicators'
import AgentModelServersUsage from '../agent/AgentModelServersUsage'
import Toggle from '../Toggle'
import {errorText, useT} from '../../i18n'
import {useElementWidth} from '../../hooks/useElementWidth'
import {recheckHealth, recordProbe, useModelServerHealth, useModelServersHealth} from '../../lib/modelServerHealth'
import {MODEL_SERVER_PREFIX, providerGroup, providerIcon, providerKind, STORED_HEADERS} from '../../lib/modelServers'
import {CLOUD_PRESETS, LOCAL_PRESETS, presetTexts} from '../../lib/modelServerPresets'
import {notifyModelServersChanged, onModelServersChanged} from '../../lib/appBus'
import {notifyModelsChanged} from '../../lib/modelsChanged'
import {NoticeBar, type Notice} from './useProcessKiller'
import ModelDetailsPanel from './models/ModelDetailsPanel'
import {ModelPullForm, ModelPullList} from './models/ModelPullPanel'
import {canonicalName, formatModelSize, fullDate, hostOf, inFuture, matchesModel, shortDate, sortModels, type SortKey} from './models/modelFormat'
import {useModelPulls} from './models/useModelPulls'
import ModelServersColumn from './models/ModelServersColumn'
import ProviderConfigPanel from './models/ProviderConfigPanel'
import {applyOrder, sortedServers} from './models/providerOrder'
import {
    MODELS_MIN,
    readServersOpen,
    readServersWidth,
    SERVERS_NARROW_BELOW,
    SERVERS_WIDTH_DEFAULT,
    SERVERS_WIDTH_MAX,
    SERVERS_WIDTH_MIN,
    writeServersOpen,
    writeServersWidth,
} from './models/serverLayout'

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

// Qué muestra el diálogo de servidor: un alta, la edición de uno guardado o un
// alta que parte de otro (Duplicar).
// Las tres secciones del proveedor elegido.
type ProviderPanel = 'models' | 'usage' | 'config'

type ServerDialogState = {mode: 'add'} | {mode: 'edit'; server: main.ModelServer} | {mode: 'duplicate'; server: main.ModelServer}

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
    const P = L.providers
    const presetText = t.settings.modelServers.presets

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
    // Diálogo de alta / edición / duplicado y confirmación de borrado de un servidor.
    const [panel, setPanel] = useState<ProviderPanel>('models')
    const [dialog, setDialog] = useState<ServerDialogState | null>(null)
    const [deleting, setDeleting] = useState<main.ModelServer | null>(null)
    // Última prueba de conexión por servidor (con el token guardado).
    const [probes, setProbes] = useState<Record<string, Probe>>({})
    // Avisos de la administración de SERVIDORES (guardado, borrado): aparte de
    // `notice`, que se limpia al cambiar de servidor y el borrado del elegido lo
    // cambia justo antes de que el aviso se pueda leer.
    const [serverNotice, setServerNotice] = useState<Notice | null>(null)
    // Disposición: columna abierta y su ancho (se recuerdan), y el cajón de las
    // pestañas angostas.
    const [serversOpen, setServersOpen] = useState(readServersOpen)
    const [serversWidth, setServersWidth] = useState(readServersWidth)
    const [drawerOpen, setDrawerOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement>(null)
    const rootWidth = useElementWidth(rootRef)
    // 0 = todavía sin medir: no se asume angosto.
    const narrow = rootWidth > 0 && rootWidth < SERVERS_NARROW_BELOW
    const inlineServers = serversOpen && !narrow
    // La columna nunca le deja a la tabla menos de MODELS_MIN.
    const serversMax = rootWidth > 0 ? Math.max(SERVERS_WIDTH_MIN, Math.min(SERVERS_WIDTH_MAX, rootWidth - MODELS_MIN)) : SERVERS_WIDTH_MAX
    const serversShown = Math.min(serversMax, Math.max(SERVERS_WIDTH_MIN, serversWidth))
    // El reloj de los «se libera en…»: se renueva con cada lectura de /api/ps.
    const [now, setNow] = useState(() => Date.now())

    const server = useMemo(() => servers?.find((s) => s.id === serverId) ?? null, [servers, serverId])
    const canManage = server?.kind === 'ollama'
    const loadSeq = useRef(0)

    // --- Servidores ------------------------------------------------------------

    const loadServers = useCallback(async (select?: string) => {
        try {
            const list = (await ListModelServers()) ?? []
            setServers(sortedServers(list))
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

    // La lista cambió desde otro lugar (Configuración → IA, el selector del chat).
    useEffect(() => onModelServersChanged(() => void loadServers()), [loadServers])

    // Elegir un servidor lo recuerda: la próxima vez la pestaña abre en él.
    const selectServer = useCallback((id: string) => {
        setServerId(id)
        saveLastServer(id)
        setDrawerOpen(false)
    }, [])

    // El cajón solo existe en una pestaña angosta; Esc lo cierra.
    useEffect(() => {
        if (!narrow) setDrawerOpen(false)
    }, [narrow])
    useEffect(() => {
        if (!drawerOpen || !visible) return
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setDrawerOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [drawerOpen, visible])

    // Un proveedor apagado no se sondea: no tiene por qué recibir tráfico (y una
    // API alojada, menos) de algo que no se está usando.
    const agentIds = useMemo(() => (servers ?? []).filter((s) => s.enabled).map((s) => MODEL_SERVER_PREFIX + s.id), [servers])
    const healthById = useModelServersHealth(agentIds, visible)
    const current = useModelServerHealth(serverId && server?.enabled ? MODEL_SERVER_PREFIX + serverId : '', visible)

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

    // Cuántos modelos tiene cada servidor, para la lista: la lectura real si es el
    // elegido (y ya cargó), y si no la de la última comprobación de salud. Sin
    // dato, el servidor no muestra conteo — un «0 modelos» inventado se lee como
    // «está vacío».
    const modelCounts = useMemo(() => {
        const out: Record<string, number> = {}
        for (const s of servers ?? []) {
            const n = healthById[MODEL_SERVER_PREFIX + s.id]?.modelCount
            if (typeof n === 'number') out[s.id] = n
        }
        if (serverId && models !== null) out[serverId] = models.length
        return out
    }, [servers, healthById, serverId, models])

    const testing = useMemo(() => new Set(Object.entries(probes).flatMap(([id, p]) => (p.state === 'testing' ? [id] : []))), [probes])

    // --- Administración de servidores ---------------------------------------------

    // Aviso al resto de la app: Configuración, los selectores del chat y esta
    // lista releen los servidores, y quien tenga abierta la lista de modelos de
    // ESTE servidor la relee (cambió la dirección, o dejó de existir).
    function announceServers(id: string) {
        notifyModelServersChanged()
        notifyModelsChanged(id)
    }

    function dropProbe(id: string) {
        setProbes((p) => {
            const {[id]: _gone, ...rest} = p
            return rest
        })
    }

    function onDialogSaved(saved: main.ModelServer) {
        setDialog(null)
        // La prueba anterior hablaba de la configuración vieja.
        dropProbe(saved.id)
        setServerNotice({tone: 'ok', text: L.servers.saved({name: saved.name})})
        // El formulario ya avisó que la lista de servidores cambió
        // (notifyModelServersChanged); falta decir que los modelos de ESTE servidor
        // pueden ser otros (cambió la dirección, el token o los TLS).
        notifyModelsChanged(saved.id)
        selectServer(saved.id)
        void loadServers(saved.id)
        // Editar el servidor que ya estaba elegido no cambia `serverId`, así que
        // los modelos (que pudieron cambiar con la dirección) se releen a mano.
        if (saved.id === serverId) void load(saved.id)
    }

    async function testServer(s: main.ModelServer) {
        selectServer(s.id)
        setProbes((p) => ({...p, [s.id]: {state: 'testing'}}))
        try {
            // serverId + token vacío + cabeceras null: el backend usa el token y
            // las cabeceras guardados, que esta pantalla nunca tiene.
            const probe = await TestModelServer(s.kind, s.baseUrl, '', s.id, s.insecureTls, STORED_HEADERS)
            recordProbe(s.id, probe)
            setProbes((p) => ({...p, [s.id]: {state: 'done', probe}}))
        } catch (e) {
            setProbes((p) => ({...p, [s.id]: {state: 'error', error: errorText(e)}}))
        }
    }

    async function deleteServer(s: main.ModelServer) {
        const list = servers ?? []
        const at = list.findIndex((x) => x.id === s.id)
        // Si era el elegido pasa a ser el siguiente de la lista (o el anterior,
        // si era el último).
        const next = list[at + 1] ?? list[at - 1]
        try {
            await DeleteModelServer(s.id)
        } catch (e) {
            setServerNotice({tone: 'error', text: L.servers.deleteFailed({name: s.name, error: errorText(e)})})
            return
        }
        dropProbe(s.id)
        setServerNotice({tone: 'ok', text: L.servers.deleted({name: s.name})})
        announceServers(s.id)
        if (s.id === serverId) {
            setServerId(next?.id ?? '')
            saveLastServer(next?.id ?? '')
        }
        await loadServers()
    }

    // Encender o apagar un proveedor. Se pinta ya (el interruptor que tarda en
    // responder se lee como roto) y se confirma contra el backend; si falla se
    // vuelve a leer la lista, que es la verdad.
    async function toggleEnabled(s: main.ModelServer, enabled: boolean) {
        setServers((prev) => prev && prev.map((x) => (x.id === s.id ? ({...x, enabled} as main.ModelServer) : x)))
        try {
            await SetModelServerEnabled(s.id, enabled)
            setServerNotice({tone: 'ok', text: enabled ? P.enabledNotice({name: s.name}) : P.disabledNotice({name: s.name})})
            // Los selectores de IA (chat, botones) releen el catálogo de agentes.
            notifyModelServersChanged()
            if (enabled) recheckHealth(s.id)
        } catch (e) {
            setServerNotice({tone: 'error', text: P.toggleFailed({name: s.name, error: errorText(e)})})
            void loadServers()
        }
    }

    // Orden nuevo de TODOS los proveedores (ver models/providerOrder).
    async function reorder(ids: string[]) {
        setServers((prev) => (prev ? applyOrder(prev, ids) : prev))
        try {
            await ReorderModelServers(ids)
            notifyModelServersChanged()
        } catch (e) {
            setServerNotice({tone: 'error', text: P.reorderFailed({error: errorText(e)})})
            void loadServers()
        }
    }

    // Guarda solo el modelo por defecto del proveedor elegido: el resto de la
    // configuración viaja tal cual, y el token y las cabeceras no (vacío / sin
    // reemplazar = el backend conserva los guardados).
    async function saveDefaultModel(model: string): Promise<boolean> {
        if (!server) return false
        try {
            const saved = await SaveModelServer(main.ModelServer.createFrom({...server, defaultModel: model}), '', false, {}, false)
            setServers((prev) => prev && prev.map((x) => (x.id === saved.id ? saved : x)))
            setServerNotice({tone: 'ok', text: model ? P.config.modelSaved({name: server.name, model}) : P.config.modelCleared({name: server.name})})
            notifyModelServersChanged()
            return true
        } catch (e) {
            setServerNotice({tone: 'error', text: P.config.modelFailed({error: errorText(e)})})
            return false
        }
    }

    function toggleServers() {
        if (narrow) {
            setDrawerOpen((v) => !v)
            return
        }
        const next = !serversOpen
        setServersOpen(next)
        writeServersOpen(next)
    }

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


    // --- Diálogos de servidor -----------------------------------------------------

    const dialogEl = dialog && (
        <Suspense fallback={null}>
            <ModelServerDialog
                server={dialog.mode === 'edit' ? dialog.server : undefined}
                template={dialog.mode === 'duplicate' ? dialog.server : undefined}
                onClose={() => setDialog(null)}
                onSaved={onDialogSaved}
            />
        </Suspense>
    )

    // La raíz se dibuja SIEMPRE, también mientras carga o sin servidores: el
    // ancho se mide sobre ella con un ResizeObserver que se engancha una sola
    // vez, al montar. Si la raíz apareciera recién con la lista, nunca se mediría.
    const root = (children: ReactNode) => (
        <div
            ref={rootRef}
            data-models-root
            data-layout={narrow ? 'narrow' : 'wide'}
            className="relative flex h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden bg-surface text-on-surface"
            role="region"
            aria-label={t.utilities.tools.modelManager.name}
        >
            {children}
            {dialogEl}
        </div>
    )

    // --- Pantallas previas a la lista --------------------------------------------

    if (servers === null) {
        return root(<div className="flex h-full w-full flex-1 items-center justify-center bg-surface text-xs text-on-surface-variant">{L.loading}</div>)
    }

    if (servers.length === 0) {
        return root(
            <div className="@container flex h-full w-full flex-1 flex-col items-center justify-center gap-4 overflow-y-auto bg-surface px-6 py-10 text-center text-on-surface">
                <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-surface-container-highest text-on-surface-variant">
                    <Icon name="model_training" size={28} />
                </span>
                <div className="flex max-w-lg flex-col gap-1">
                    <h2 className="text-base font-semibold">{L.noServer.title}</h2>
                    <p className="text-xs text-on-surface-variant">{L.noServer.body}</p>
                </div>
                {loadError && <p className="max-w-lg break-words rounded bg-error-container/40 px-2 py-1 text-ui-11 text-error">{loadError}</p>}
                <button
                    type="button"
                    data-model-server-add
                    onClick={() => setDialog({mode: 'add'})}
                    title={L.noServer.addTitle}
                    className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                    <Icon name="add_circle" size={14} />
                    {L.noServer.add}
                </button>
                <div data-model-presets-hint className="flex w-full max-w-lg flex-col gap-2 rounded-lg border border-outline-variant bg-surface-container-low p-3 text-left">
                    <div>
                        <p className="text-xs font-medium">{L.noServer.presetsTitle}</p>
                        <p className="text-ui-11 text-on-surface-variant">{L.noServer.presetsBody}</p>
                    </div>
                    {([['cloud', CLOUD_PRESETS], ['local', LOCAL_PRESETS]] as const).map(([group, list]) => (
                        <div key={group} className="flex flex-col gap-1">
                            <p className="text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant">{group === 'cloud' ? presetText.groupCloud : presetText.groupLocal}</p>
                            <ul className="grid grid-cols-1 gap-1.5 @md:grid-cols-2">
                                {list.map((pr) => {
                                    const txt = presetTexts(presetText, pr)
                                    return (
                                        <li key={pr.key} title={L.noServer.presetsItemTitle({name: txt.name, hint: txt.hint})} className="flex min-w-0 items-center gap-2 rounded-md bg-surface px-2 py-1.5">
                                            <Icon name={pr.icon} size={16} className="shrink-0 text-primary" />
                                            <span className="min-w-0">
                                                <span className="block truncate text-xs font-medium">{txt.name}</span>
                                                <span className="block truncate font-mono text-ui-10 text-on-surface-variant">{txt.hint}</span>
                                            </span>
                                        </li>
                                    )
                                })}
                            </ul>
                        </div>
                    ))}
                </div>
            </div>,
        )
    }

    // --- Pantalla principal ----------------------------------------------------------

    const kind = server ? providerKind(server.kind) : 'ollama'
    const group = server ? providerGroup(server) : 'local'
    const kindLabel = P.kindShort[kind]
    const host = server ? hostOf(server.baseUrl) : ''
    const emptyList = models !== null && models.length === 0
    const filteredOut = models !== null && models.length > 0 && visibleModels.length === 0
    const probe = server ? probes[server.id] : undefined
    const shownNow = narrow ? drawerOpen : serversOpen
    const SV = L.servers

    const column = (
        <ModelServersColumn
            servers={servers}
            healthById={healthById}
            modelCounts={modelCounts}
            selectedId={serverId}
            testing={testing}
            onSelect={selectServer}
            onAdd={() => setDialog({mode: 'add'})}
            onEdit={(s) => setDialog({mode: 'edit', server: s})}
            onTest={(s) => void testServer(s)}
            onDuplicate={(s) => setDialog({mode: 'duplicate', server: s})}
            onDelete={setDeleting}
            onToggleEnabled={(s, v) => void toggleEnabled(s, v)}
            onReorder={(ids) => void reorder(ids)}
        />
    )
    // El tirador de la columna; el cajón tiene su propio tope (no depende de lo
    // que le quedaría a la tabla, que ahí queda tapada de todos modos).
    const handleFor = (shown: number, max: number) => (
        <ResizeHandle
            value={shown}
            min={SERVERS_WIDTH_MIN}
            max={max}
            defaultValue={SERVERS_WIDTH_DEFAULT}
            onChange={setServersWidth}
            onCommit={writeServersWidth}
            label={SV.resizeLabel}
            title={SV.resizeTitle}
            valueText={(px) => SV.resizeValue({px})}
        />
    )
    const drawerMax = Math.max(SERVERS_WIDTH_MIN, Math.min(SERVERS_WIDTH_MAX, rootWidth - 48))
    const drawerShown = Math.min(drawerMax, Math.max(SERVERS_WIDTH_MIN, serversWidth))

    return root(
        <>
            {inlineServers && (
                <aside data-models-servers className="relative flex shrink-0 flex-col border-r border-outline-variant" style={{width: serversShown}}>
                    {column}
                    {handleFor(serversShown, serversMax)}
                </aside>
            )}

            {/* Cajón: en una pestaña angosta la lista se abre SOBRE la tabla, con un
                velo que la cierra al tocarlo. */}
            {narrow && drawerOpen && (
                <div data-models-drawer className="absolute inset-0 z-30 flex">
                    <aside
                        className="relative flex h-full shrink-0 flex-col border-r border-outline-variant bg-surface-container-low shadow-xl"
                        style={{width: drawerShown}}
                    >
                        {column}
                        {handleFor(drawerShown, drawerMax)}
                    </aside>
                    <button type="button" onClick={() => setDrawerOpen(false)} title={SV.closeDrawerTitle} aria-label={SV.closeDrawer} className="min-w-0 flex-1 cursor-default bg-black/40" />
                </div>
            )}

            <section className="@container flex h-full min-h-0 min-w-0 flex-1 flex-col bg-surface" aria-label={SV.selectedLabel}>
                <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-outline-variant bg-surface-container-low px-3 py-2">
                    <button
                        type="button"
                        data-servers-toggle
                        onClick={toggleServers}
                        title={narrow ? SV.drawerTitle : serversOpen ? SV.hideColumnTitle : SV.showColumnTitle}
                        aria-label={shownNow ? SV.hideColumn : SV.showColumn}
                        aria-pressed={shownNow}
                        className={`shrink-0 rounded-md p-1.5 hover:bg-surface-variant focus-visible:outline-2 focus-visible:outline-primary ${
                            shownNow ? 'bg-surface-variant text-on-surface' : 'text-on-surface-variant hover:text-on-surface'
                        }`}
                    >
                        <Icon name="view_sidebar" size={16} filled={shownNow} />
                    </button>

                    {server && (
                        <>
                            <span className="flex min-w-0 items-center gap-2">
                                <Icon name={providerIcon(server)} size={18} className="shrink-0 text-primary" />
                                <span data-selected-server className="min-w-0 truncate text-sm font-semibold" title={server.name}>
                                    {server.name}
                                </span>
                            </span>
                            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                                <span title={P.kindTitles[kind]} className="shrink-0 rounded-full bg-surface-container-highest px-2 py-0.5 text-ui-10 text-on-surface-variant">
                                    {kindLabel}
                                </span>
                                <span
                                    title={P.groupTitles[group]}
                                    className={`shrink-0 rounded-full px-2 py-0.5 text-ui-10 ${group === 'local' ? 'bg-secondary/15 text-secondary' : 'bg-tertiary/15 text-tertiary'}`}
                                >
                                    {P.groups[group]}
                                </span>
                                {!server.enabled && (
                                    <span title={P.disabledRowTitle({name: server.name})} className="shrink-0 rounded-full border border-outline-variant px-2 py-0.5 text-ui-10 text-on-surface-variant">
                                        {P.disabled}
                                    </span>
                                )}
                                {current && <HealthBadge health={current.health} server={server.name} />}
                            </span>
                        </>
                    )}

                    {server && (
                        <div className="ml-auto flex shrink-0 items-center gap-2">
                            <label className="flex items-center gap-2 text-xs text-on-surface-variant" title={server.enabled ? P.switchOnTitle({name: server.name}) : P.switchOffTitle({name: server.name})}>
                                <span className="hidden @3xl:inline">{server.enabled ? P.active : P.inactive}</span>
                                <Toggle
                                    size="sm"
                                    checked={server.enabled}
                                    onChange={(v) => void toggleEnabled(server, v)}
                                    ariaLabel={P.switchLabel({name: server.name})}
                                    title={server.enabled ? P.switchOnTitle({name: server.name}) : P.switchOffTitle({name: server.name})}
                                />
                            </label>
                            <button
                                type="button"
                                data-server-action="test"
                                onClick={() => void testServer(server)}
                                disabled={probe?.state === 'testing'}
                                title={SV.actions.testTitle({name: server.name})}
                                aria-label={probe?.state === 'testing' ? SV.actions.testing : SV.actions.test}
                                className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-on-surface-variant focus-visible:outline-2 focus-visible:outline-primary enabled:hover:bg-surface-variant enabled:hover:text-on-surface disabled:opacity-50"
                            >
                                <Icon name="network_check" size={15} className={probe?.state === 'testing' ? 'animate-spin' : ''} />
                                <span className="hidden @5xl:inline">{probe?.state === 'testing' ? SV.actions.testing : SV.actions.test}</span>
                            </button>
                        </div>
                    )}
                </div>

                {server && (
                    <div role="tablist" aria-label={P.tabsLabel} className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-outline-variant bg-surface-container-low px-3">
                        {(
                            [
                                ['models', P.tabs.models, 'model_training'],
                                ['usage', P.tabs.usage, 'monitoring'],
                                ['config', P.tabs.config, 'tune'],
                            ] as const
                        ).map(([key, label, icon]) => (
                            <button
                                key={key}
                                type="button"
                                role="tab"
                                id={`provider-tab-${key}`}
                                data-provider-tab={key}
                                aria-selected={panel === key}
                                aria-controls="provider-panel"
                                onClick={() => setPanel(key)}
                                title={P.tabs[`${key}Title` as const]({name: server.name})}
                                className={`-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-xs focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary ${
                                    panel === key ? 'border-primary font-medium text-on-surface' : 'border-transparent text-on-surface-variant hover:text-on-surface'
                                }`}
                            >
                                <Icon name={icon} size={14} />
                                {label}
                                {key === 'models' && models !== null && <span className="rounded-full bg-surface-container-highest px-1.5 text-ui-10 font-normal text-on-surface-variant">{models.length}</span>}
                            </button>
                        ))}
                    </div>
                )}

                <NoticeBar notice={serverNotice} onDismiss={() => setServerNotice(null)} dismissLabel={L.dismiss} />
                <NoticeBar notice={notice} onDismiss={() => setNotice(null)} dismissLabel={L.dismiss} />

                {server && !server.enabled && (
                    <div data-provider-disabled-note role="note" className="flex shrink-0 items-start gap-2 border-b border-outline-variant bg-surface-container-highest px-4 py-2 text-xs text-on-surface-variant">
                        <Icon name="toggle_off" size={15} className="mt-px shrink-0" />
                        <span className="min-w-0 flex-1">
                            <span className="font-medium text-on-surface">{P.disabledBannerTitle}. </span>
                            {P.disabledBanner}
                        </span>
                        <button
                            type="button"
                            onClick={() => void toggleEnabled(server, true)}
                            title={P.switchOffTitle({name: server.name})}
                            className="shrink-0 rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-on-primary hover:opacity-90"
                        >
                            {P.enable}
                        </button>
                    </div>
                )}

                <div id="provider-panel" role="tabpanel" aria-labelledby={`provider-tab-${panel}`} className="flex min-h-0 flex-1 flex-col">
                {panel === 'models' && (
                <>
                <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-outline-variant px-3 py-1.5">
                    {server && (
                        <span className="min-w-0 max-w-full truncate font-mono text-ui-11 text-on-surface-variant" title={server.baseUrl}>
                            {server.baseUrl}
                        </span>
                    )}

                    <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2">
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
                            className="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-on-surface-variant enabled:hover:bg-surface-variant enabled:hover:text-on-surface disabled:opacity-60"
                        >
                            <Icon name="refresh" size={14} className={loading ? 'animate-spin' : ''} />
                            {L.refresh}
                        </button>
                    </div>
                </div>

                {probe && probe.state !== 'testing' && (
                    <div data-server-probe className="flex shrink-0 items-start gap-2 border-b border-outline-variant px-3 py-1.5">
                        <div className="min-w-0 flex-1">
                            <ProbeResult probe={probe} />
                        </div>
                        <button
                            type="button"
                            onClick={() => dropProbe(server?.id ?? '')}
                            title={SV.probeDismissTitle}
                            aria-label={SV.probeDismiss}
                            className="shrink-0 rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                        >
                            <Icon name="close" size={14} />
                        </button>
                    </div>
                )}

                {server && canManage && <ModelPullForm server={server} onStart={async (name) => void (await start(server.id, name))} />}
                {server && !canManage && (
                    <div role="note" className="flex shrink-0 items-start gap-2 border-b border-outline-variant bg-primary/10 px-4 py-2 text-xs text-on-surface-variant">
                        <Icon name="lock" size={14} className="mt-px shrink-0 text-primary" />
                        <span className="min-w-0">
                            <span className="font-medium text-on-surface">{L.readOnly.title}. </span>
                            {group === 'cloud' ? P.readOnlyCloud({brand: kindLabel}) : L.readOnly.body({kind: P.kindLong[kind]})}
                        </span>
                    </div>
                )}

                <ModelPullList pulls={pulls} servers={servers} onCancel={cancel} onDismiss={dismiss} />


            <div className="@container relative flex min-h-0 flex-1">
                {/* Las columnas de la tabla se muestran según el ancho de ESTE panel y no
                    el de toda la fila: con el detalle abierto (o la columna de servidores
                    ancha) la tabla tiene bastante menos de lo que mide la pestaña. */}
                <div className="@container relative flex min-h-0 min-w-0 flex-1 flex-col">
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


                </>
                )}

                {panel === 'usage' && server && (
                    <div data-provider-usage className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-ui-11">
                        <div className="mx-auto max-w-2xl">
                            <AgentModelServersUsage server={server} />
                        </div>
                    </div>
                )}

                {panel === 'config' && server && (
                    <ProviderConfigPanel
                        server={server}
                        health={current?.health}
                        probe={probe}
                        modelNames={(models ?? []).map((m) => m.name)}
                        onEdit={() => setDialog({mode: 'edit', server})}
                        onTest={() => void testServer(server)}
                        onDuplicate={() => setDialog({mode: 'duplicate', server})}
                        onDelete={() => setDeleting(server)}
                        onToggleEnabled={(v) => void toggleEnabled(server, v)}
                        onDefaultModel={saveDefaultModel}
                    />
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
                {deleting && (
                    <ConfirmDialog
                        title={SV.deleteConfirm.title}
                        description={SV.deleteConfirm.body({name: deleting.name, host: hostOf(deleting.baseUrl)})}
                        confirmLabel={SV.deleteConfirm.action}
                        danger
                        onConfirm={() => void deleteServer(deleting)}
                        onClose={() => setDeleting(null)}
                    >
                        <ul data-server-delete-effects className="flex list-disc flex-col gap-1.5 pl-4 text-xs text-on-surface-variant marker:text-on-surface-variant/60">
                            <li>{providerGroup(deleting) === 'cloud' ? P.deleteCloudNote({host: hostOf(deleting.baseUrl)}) : SV.deleteConfirm.disk({host: hostOf(deleting.baseUrl), remote: !deleting.isLocal})}</li>
                            <li>{SV.deleteConfirm.chats}</li>
                            <li>{SV.deleteConfirm.readd}</li>
                        </ul>
                    </ConfirmDialog>
                )}
            </section>
        </>,
    )
}
