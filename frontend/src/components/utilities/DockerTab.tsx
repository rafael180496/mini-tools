import {useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode} from 'react'
import {
    DockerAction,
    DockerBuilds,
    DockerCompose,
    DockerComposeUpFile,
    DockerContainers,
    DockerCounts,
    DockerExportBuildLogs,
    DockerPickComposeFile,
    DockerImages,
    DockerNetworks,
    DockerStartApp,
    DockerStats,
    DockerStatus,
    DockerVolumes,
} from '../../../wailsjs/go/main/App'
import {BrowserOpenURL} from '../../../wailsjs/runtime'
import type {dockerctl} from '../../../wailsjs/go/models'
import ConfirmDialog from '../ConfirmDialog'
import Icon from '../Icon'
import {errorCode, errorText, useT} from '../../i18n'
import {formatBytes} from './format'
import DockerBuildsTable from './docker/DockerBuilds'
import DockerContainersTable, {type ComposeOp, type ContainerOp} from './docker/DockerContainers'
import DockerDetail, {type DetailKind, type DetailTarget} from './docker/DockerLogs'
import DockerResources, {type ResourceKind} from './docker/DockerResources'
import type {DockerSection} from './docker/sections'
import {NoticeBar, type Notice} from './useProcessKiller'

// Utilidad Docker: contenedores, imágenes, volúmenes y redes, con sus logs.
//
// **Cuesta solo mientras se mira.** Igual que las otras utilidades: el
// temporizador vive en un efecto que corre con la pestaña a la vista y la
// ventana visible, y el panel de logs en vivo (el único proceso que queda
// abierto) se termina al cerrarlo. Con la pestaña oculta o cerrada no se
// consulta nada y no hay ningún `docker logs -f` colgado.

const REFRESH_MS = 5000
// Reintento mientras Docker está instalado pero su motor no responde: es lo que
// hace que, tras abrir Docker Desktop, la pantalla se actualice sola.
const PROBE_RETRY_MS = 4000
const INSTALL_URL = 'https://docs.docker.com/get-started/get-docker/'

type Section = DockerSection

interface Confirm {
    title: string
    description: string
    action: string
    run: () => void
}

interface DockerTabProps {
    // La pestaña está a la vista. Oculta sigue montada (para no perder el
    // filtro ni el panel abierto), pero no consulta.
    visible: boolean
    // Qué sección se muestra. La elige el submenú de la barra lateral (como el de
    // Git): la pestaña ya no tiene menú propio, es solo el contenido.
    section: DockerSection
    // Los totales de cada sección, para los contadores de ese submenú. Se piden
    // en cada actualización, y solo mientras la pestaña está a la vista.
    onCounts: (c: dockerctl.Counts) => void
}

export default function DockerTab({visible, section, onCounts}: DockerTabProps) {
    const t = useT()
    const td = t.utilities.docker

    const [status, setStatus] = useState<dockerctl.Status | null>(null)
    const [containers, setContainers] = useState<dockerctl.Container[]>([])
    const [images, setImages] = useState<dockerctl.Image[]>([])
    const [volumes, setVolumes] = useState<dockerctl.Volume[]>([])
    const [networks, setNetworks] = useState<dockerctl.Network[]>([])
    const [builds, setBuilds] = useState<dockerctl.Build[]>([])
    const [stats, setStats] = useState<Record<string, dockerctl.Stat>>({})
    const [loaded, setLoaded] = useState<Set<Section>>(new Set())
    const [loadError, setLoadError] = useState('')
    const [query, setQuery] = useState('')
    const [live, setLive] = useState(true)
    const [detail, setDetail] = useState<{target: DetailTarget; tab: 'logs' | 'inspect'} | null>(null)
    const [confirm, setConfirm] = useState<Confirm | null>(null)
    const [notice, setNotice] = useState<Notice | null>(null)
    const [busy, setBusy] = useState<Set<string>>(new Set())
    // Proyectos de Compose con una operación en curso (`up` puede tardar minutos).
    // '__file' es el «Compose up…» desde un archivo.
    const [composeBusy, setComposeBusy] = useState<Set<string>>(new Set())
    // Ancho del panel de detalle en píxeles (null = el predeterminado) y si está
    // maximizado.
    const [panelW, setPanelW] = useState<number | null>(null)
    const [expanded, setExpanded] = useState(false)
    // Tope de líneas de lo que se exporta (100 a 10000).
    const [exportLines, setExportLines] = useState(10000)
    const rowRef = useRef<HTMLDivElement>(null)

    const inFlight = useRef(false)
    const statsInFlight = useRef(false)
    const running = !!status?.running

    const probe = useCallback(async () => {
        try {
            setStatus(await DockerStatus())
        } catch (e) {
            setNotice({tone: 'error', text: errorText(e)})
        }
    }, [])

    // --- Estado del motor ---------------------------------------------------
    // Se comprueba al ponerse a la vista y, solo mientras Docker está instalado
    // pero apagado, cada PROBE_RETRY_MS. Con el motor andando no se vuelve a
    // preguntar: si se cae, la próxima lectura falla y vuelve a comprobar.
    useEffect(() => {
        if (!visible) return
        if (status === null) {
            void probe()
            return
        }
        if (status.installed && !status.running) {
            const timer = window.setInterval(() => {
                if (!document.hidden) void probe()
            }, PROBE_RETRY_MS)
            return () => window.clearInterval(timer)
        }
    }, [visible, status, probe])

    // --- Datos de la sección ------------------------------------------------
    const load = useCallback(
        async (sec: Section) => {
            if (inFlight.current) return
            inFlight.current = true
            try {
                if (sec === 'containers') {
                    const list = (await DockerContainers()) ?? []
                    setContainers(list)
                    // El consumo se pide aparte: `docker stats` muestrea unos
                    // segundos y la tabla no tiene que esperarlo.
                    if (list.some((c) => c.state === 'running') && !statsInFlight.current) {
                        statsInFlight.current = true
                        DockerStats()
                            .then((s) => setStats(Object.fromEntries((s ?? []).map((x) => [x.id, x]))))
                            .catch(() => {})
                            .finally(() => {
                                statsInFlight.current = false
                            })
                    }
                } else if (sec === 'images') {
                    setImages((await DockerImages()) ?? [])
                } else if (sec === 'volumes') {
                    setVolumes((await DockerVolumes()) ?? [])
                } else if (sec === 'builds') {
                    setBuilds((await DockerBuilds()) ?? [])
                } else {
                    setNetworks((await DockerNetworks()) ?? [])
                }
                setLoaded((cur) => (cur.has(sec) ? cur : new Set(cur).add(sec)))
                setLoadError('')
            } catch (e) {
                // Un Docker sin buildx nuevo no tiene historial de builds: no es
                // un motor caído, así que no se vuelve a comprobar.
                if (errorCode(e) === 'no-buildx') {
                    setLoadError(td.builds.noBuildx)
                    return
                }
                setLoadError(errorText(e))
                // Una lectura fallida suele ser el motor que se cayó: se vuelve
                // a comprobar para que la pantalla lo diga en vez de quedarse
                // con un error genérico.
                void probe()
            } finally {
                inFlight.current = false
            }
        },
        [probe, td],
    )

    // Los contadores del submenú. Una consulta liviana (solo ids), aparte de la
    // lista: el submenú los muestra para TODAS las secciones y la pestaña solo
    // lee la que está a la vista.
    const countsInFlight = useRef(false)
    const refreshCounts = useCallback(() => {
        if (countsInFlight.current) return
        countsInFlight.current = true
        DockerCounts()
            .then(onCounts)
            .catch(() => {})
            .finally(() => {
                countsInFlight.current = false
            })
    }, [onCounts])

    useEffect(() => {
        if (!visible || !running) return
        void load(section)
        refreshCounts()
        if (!live) return
        const timer = window.setInterval(() => {
            if (document.hidden) return
            void load(section)
            refreshCounts()
        }, REFRESH_MS)
        return () => window.clearInterval(timer)
    }, [visible, running, section, live, load, refreshCounts])

    // Cambiar de sección desde la barra: el filtro y el error eran de la
    // anterior, y un texto que sobró dejaría una lista vacía sin explicación.
    useEffect(() => {
        setQuery('')
        setLoadError('')
    }, [section])

    // --- Acciones -----------------------------------------------------------
    async function run(op: string, ids: string[], ok: string) {
        setBusy((cur) => new Set([...cur, ...ids]))
        setNotice(null)
        try {
            await DockerAction(op, ids)
            setNotice({tone: 'ok', text: ok})
            // Eliminar lo que está abierto en el panel lo cierra: quedaría
            // mostrando los logs de algo que ya no existe.
            if (op.endsWith('.remove') && detail && ids.includes(detail.target.id)) setDetail(null)
        } catch (e) {
            setNotice({tone: 'error', text: td.result.failed({error: errorText(e)})})
        } finally {
            setBusy((cur) => {
                const next = new Set(cur)
                ids.forEach((id) => next.delete(id))
                return next
            })
            void load(section)
        }
    }

    function onContainerOp(op: ContainerOp, list: dockerctl.Container[], label: string) {
        if (list.length === 0) return
        const ids = list.map((c) => c.id)
        const go = () => void run(`container.${op}`, ids, td.result[op]({count: list.length}))
        if (op !== 'remove') return go()
        const isProject = list.length > 1
        setConfirm({
            title: isProject ? td.confirm.removeProject : td.confirm.removeContainer,
            description: isProject
                ? td.confirm.removeProjectBody({name: label, count: list.length})
                : td.confirm.removeContainerBody({name: label}),
            action: td.confirm.action,
            run: go,
        })
    }

    function onResourceRemove(kind: ResourceKind, id: string, name: string) {
        const tc = td.confirm
        const [title, description] =
            kind === 'image'
                ? [tc.removeImage, tc.removeImageBody({name})]
                : kind === 'volume'
                  ? [tc.removeVolume, tc.removeVolumeBody({name})]
                  : [tc.removeNetwork, tc.removeNetworkBody({name})]
        setConfirm({
            title,
            description,
            action: tc.action,
            run: () => void run(`${kind}.remove`, [id], td.result.remove({count: 1})),
        })
    }

    function openDetail(kind: DetailKind, id: string, title: string, tab: 'logs' | 'inspect') {
        setDetail({target: {kind, id, title}, tab})
    }

    function closeDetail() {
        setDetail(null)
        setExpanded(false)
    }

    // --- Compose ------------------------------------------------------------
    async function runCompose(op: ComposeOp, project: string) {
        setComposeBusy((cur) => new Set(cur).add(project))
        setNotice(null)
        try {
            await DockerCompose(op, project)
            setNotice({tone: 'ok', text: td.compose.done[op]({name: project})})
        } catch (e) {
            setNotice({tone: 'error', text: td.result.failed({error: errorText(e)})})
        } finally {
            setComposeBusy((cur) => {
                const next = new Set(cur)
                next.delete(project)
                return next
            })
            void load(section)
        }
    }

    function onCompose(op: ComposeOp, project: string) {
        // Bajar el proyecto elimina contenedores y redes: confirma. Los demás
        // se pueden deshacer con otro clic.
        if (op !== 'down') return void runCompose(op, project)
        setConfirm({
            title: td.compose.downConfirm,
            description: td.compose.downBody({name: project}),
            action: td.compose.downAction,
            run: () => void runCompose('down', project),
        })
    }

    // «Compose up…»: elegir un archivo y levantar ese proyecto, que todavía no
    // existe como contenedores.
    async function composeUpFromFile() {
        let path = ''
        try {
            path = await DockerPickComposeFile()
        } catch (e) {
            setNotice({tone: 'error', text: td.result.failed({error: errorText(e)})})
            return
        }
        if (!path) return // se canceló el diálogo
        setComposeBusy((cur) => new Set(cur).add('__file'))
        setNotice(null)
        try {
            await DockerComposeUpFile(path)
            setNotice({tone: 'ok', text: td.compose.upFileDone})
        } catch (e) {
            setNotice({tone: 'error', text: td.result.failed({error: errorText(e)})})
        } finally {
            setComposeBusy((cur) => {
                const next = new Set(cur)
                next.delete('__file')
                return next
            })
            void load(section)
        }
    }

    // --- Builds -------------------------------------------------------------
    async function exportBuild(b: dockerctl.Build) {
        setBusy((cur) => new Set(cur).add(b.ref))
        try {
            const r = await DockerExportBuildLogs(b.ref, b.name, exportLines)
            if (r.path) setNotice({tone: 'ok', text: td.detail.exported({path: r.path, size: formatBytes(r.bytes), lines: r.lines})})
        } catch (e) {
            setNotice({tone: 'error', text: td.detail.exportFailed({error: errorText(e)})})
        } finally {
            setBusy((cur) => {
                const next = new Set(cur)
                next.delete(b.ref)
                return next
            })
        }
    }

    // --- Panel de detalle: ancho ajustable ------------------------------------
    function startResize(e: ReactMouseEvent) {
        const row = rowRef.current
        if (!row) return
        e.preventDefault()
        const rect = row.getBoundingClientRect()
        const move = (ev: MouseEvent) => setPanelW(Math.min(rect.width - 280, Math.max(320, rect.right - ev.clientX)))
        const up = () => {
            window.removeEventListener('mousemove', move)
            window.removeEventListener('mouseup', up)
            document.body.style.userSelect = ''
            document.body.style.cursor = ''
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
        // Mientras se arrastra, no seleccionar texto de las tablas por el camino.
        document.body.style.userSelect = 'none'
        document.body.style.cursor = 'col-resize'
    }

    async function startApp() {
        try {
            await DockerStartApp()
        } catch (e) {
            setNotice({tone: 'error', text: td.notRunning.startFailed({error: errorText(e)})})
        }
    }

    const counts: Record<Section, number | null> = useMemo(
        () => ({
            containers: loaded.has('containers') ? containers.length : null,
            images: loaded.has('images') ? images.length : null,
            volumes: loaded.has('volumes') ? volumes.length : null,
            networks: loaded.has('networks') ? networks.length : null,
            builds: loaded.has('builds') ? builds.length : null,
        }),
        [loaded, containers, images, volumes, networks, builds],
    )

    // --- Pantallas previas a las listas ------------------------------------
    if (status === null) {
        return (
            <div className="flex h-full w-full flex-1 items-center justify-center bg-surface text-xs text-on-surface-variant">
                {td.checking}
            </div>
        )
    }

    if (!status.installed) {
        return (
            <Gate icon="deployed_code" title={td.notInstalled.title} body={td.notInstalled.body}>
                <button
                    onClick={() => BrowserOpenURL(INSTALL_URL)}
                    className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:opacity-90"
                >
                    <Icon name="open_in_new" size={14} />
                    {td.notInstalled.install}
                </button>
                <button
                    onClick={() => void probe()}
                    className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="refresh" size={14} />
                    {td.notInstalled.recheck}
                </button>
            </Gate>
        )
    }

    if (!status.running) {
        return (
            <Gate icon="power_off" title={td.notRunning.title} body={status.launcher ? td.notRunning.body : td.notRunning.noLauncher}>
                {status.launcher && (
                    <button
                        onClick={() => void startApp()}
                        title={td.notRunning.startTitle({app: status.launcher})}
                        className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:opacity-90"
                    >
                        <Icon name="play_arrow" size={14} />
                        {td.notRunning.start({app: status.launcher})}
                    </button>
                )}
                <button
                    onClick={() => void probe()}
                    className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="refresh" size={14} />
                    {td.notRunning.retry}
                </button>
                {status.error && (
                    <details className="mt-2 w-full max-w-xl text-left">
                        <summary className="cursor-pointer text-ui-10 text-on-surface-variant">{td.notRunning.detail}</summary>
                        <pre className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-surface-container-highest p-2 font-mono text-ui-10 text-on-surface-variant">
                            {status.error}
                        </pre>
                    </details>
                )}
                <div className="w-full max-w-xl">
                    <NoticeBar notice={notice} onDismiss={() => setNotice(null)} dismissLabel={td.result.dismiss} />
                </div>
            </Gate>
        )
    }

    // --- Lista --------------------------------------------------------------
    const empty = loaded.has(section) && counts[section] === 0
    // El contenedor del panel de logs, con su estado de ahora: al detenerlo o
    // iniciarlo desde ahí, el botón tiene que cambiar solo.
    const detailContainer = detail?.target.kind === 'container' ? containers.find((c) => c.id === detail.target.id) : undefined

    return (
        <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col bg-surface text-on-surface">
            <div className="flex shrink-0 items-center gap-3 border-b border-outline-variant bg-surface-container-low px-4 py-2">
                <Icon name="deployed_code" size={18} className="shrink-0 text-primary" />
                <span className="text-sm font-semibold">{t.utilities.tools.docker.name}</span>
                {/* La sección que se está viendo: sin menú propio, la pestaña
                    tiene que decir cuál es. */}
                <span className="flex items-center gap-1 text-sm text-on-surface-variant">
                    <Icon name="chevron_right" size={16} />
                    {td.nav[section]}
                </span>
                <span
                    title={td.engineTitle}
                    className="hidden shrink-0 rounded-full bg-surface-container-highest px-2.5 py-0.5 font-mono text-ui-10 text-on-surface-variant sm:inline"
                >
                    {td.engine({context: status.context, version: status.serverVersion || status.version})}
                </span>

                <div className="ml-2 flex min-w-0 max-w-xs flex-1 items-center gap-1.5 rounded-lg bg-surface-container-highest px-2.5 py-1.5 focus-within:ring-1 focus-within:ring-primary">
                    <Icon name="search" size={14} className="shrink-0 text-on-surface-variant/60" />
                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder={td.searchPlaceholder}
                        title={td.searchTitle}
                        className="min-w-0 flex-1 bg-transparent text-xs text-on-surface outline-none placeholder:text-on-surface-variant/60"
                    />
                    {query && (
                        <button onClick={() => setQuery('')} title={td.clearSearch} className="shrink-0 rounded text-on-surface-variant/60 hover:text-on-surface">
                            <Icon name="close" size={14} />
                        </button>
                    )}
                </div>

                <span className="ml-auto flex shrink-0 items-center gap-1">
                    {section === 'containers' && (
                        <button
                            disabled={composeBusy.has('__file')}
                            onClick={() => void composeUpFromFile()}
                            title={composeBusy.has('__file') ? td.compose.working : td.compose.upFileTitle}
                            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-on-surface-variant enabled:hover:bg-surface-variant enabled:hover:text-on-surface disabled:opacity-60"
                        >
                            <Icon name={composeBusy.has('__file') ? 'progress_activity' : 'playlist_add'} size={14} className={composeBusy.has('__file') ? 'animate-spin text-primary' : ''} />
                            {td.compose.upFile}
                        </button>
                    )}
                    <button
                        onClick={() => setLive((v) => !v)}
                        title={live ? td.liveTitle({seconds: REFRESH_MS / 1000}) : td.pausedTitle}
                        aria-pressed={live}
                        className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs ${
                            live ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
                        }`}
                    >
                        <Icon name={live ? 'sensors' : 'pause_circle'} size={14} />
                        {live ? td.live : td.paused}
                    </button>
                    <button
                        onClick={() => void load(section)}
                        title={td.refreshTitle}
                        className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="refresh" size={14} />
                        {td.refresh}
                    </button>
                </span>
            </div>

            <NoticeBar notice={notice} onDismiss={() => setNotice(null)} dismissLabel={td.result.dismiss} />

            <div className="flex min-h-0 flex-1">
                <div ref={rowRef} className="flex min-h-0 min-w-0 flex-1">
                    <div className={`min-h-0 min-w-0 flex-1 overflow-auto ${detail && expanded ? 'hidden' : ''}`}>
                        {loadError && !loaded.has(section) ? (
                            <div className="flex flex-col items-center gap-1 px-6 py-12 text-center">
                                <Icon name="error" size={24} className="text-error" />
                                <p className="text-sm font-medium">{td.loadFailed}</p>
                                <p className="max-w-md text-xs text-on-surface-variant">{loadError}</p>
                            </div>
                        ) : !loaded.has(section) ? (
                            <p className="px-6 py-12 text-center text-xs text-on-surface-variant">{td.loading}</p>
                        ) : empty ? (
                            <p className="px-6 py-12 text-center text-xs text-on-surface-variant">{td.empty[section]}</p>
                        ) : section === 'builds' ? (
                            <DockerBuildsTable
                                builds={builds}
                                query={query}
                                busy={busy}
                                onLogs={(b) => openDetail('build', b.ref, b.name, 'inspect')}
                                onExport={(b) => void exportBuild(b)}
                                exportLines={exportLines}
                                onExportLines={setExportLines}
                            />
                        ) : section === 'containers' ? (
                            <DockerContainersTable
                                containers={containers}
                                stats={stats}
                                query={query}
                                compact={!!detail}
                                busy={busy}
                                composeBusy={composeBusy}
                                onCompose={onCompose}
                                onOp={onContainerOp}
                                onLogs={(c) => openDetail('container', c.id, c.service || c.name, 'logs')}
                                onInspect={(c) => openDetail('container', c.id, c.service || c.name, 'inspect')}
                            />
                        ) : (
                            <DockerResources
                                kind={section === 'images' ? 'image' : section === 'volumes' ? 'volume' : 'network'}
                                images={images}
                                volumes={volumes}
                                networks={networks}
                                query={query}
                                busy={busy}
                                onRemove={onResourceRemove}
                                onInspect={(kind, id, name) => openDetail(kind, id, name, 'inspect')}
                            />
                        )}
                    </div>

                    {detail && (
                        <div
                            className="flex min-h-0 min-w-0 shrink-0 border-l border-outline-variant"
                            style={expanded ? {flex: 1} : {width: panelW ?? '46%', minWidth: 320}}
                        >
                            {/* El tirador de ancho: se arrastra para ensanchar el
                                panel y con doble clic vuelve al ancho original. */}
                            {!expanded && (
                                <div
                                    onMouseDown={startResize}
                                    onDoubleClick={() => setPanelW(null)}
                                    title={td.detail.resize}
                                    className="w-1.5 shrink-0 cursor-col-resize hover:bg-primary/30"
                                />
                            )}
                            <div className="min-h-0 min-w-0 flex-1">
                                <DockerDetail
                                    // Otro contenedor u otra pestaña inicial reinician
                                    // el panel: es otro flujo de logs.
                                    key={`${detail.target.kind}:${detail.target.id}:${detail.tab}`}
                                    target={detail.target}
                                    initialTab={detail.tab}
                                    onClose={closeDetail}
                                    container={detailContainer ? {running: detailContainer.state === 'running', busy: busy.has(detailContainer.id)} : undefined}
                                    onOp={(op) => detailContainer && onContainerOp(op, [detailContainer], detailContainer.service || detailContainer.name)}
                                    expanded={expanded}
                                    onToggleExpand={() => setExpanded((v) => !v)}
                                    onNotice={setNotice}
                                    exportLines={exportLines}
                                    onExportLines={setExportLines}
                                />
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {confirm && (
                <ConfirmDialog
                    title={confirm.title}
                    description={confirm.description}
                    confirmLabel={confirm.action}
                    danger
                    onConfirm={confirm.run}
                    onClose={() => setConfirm(null)}
                />
            )}
        </div>
    )
}

// El estado vacío de las pantallas previas: instalar o arrancar Docker.
function Gate({icon, title, body, children}: {icon: string; title: string; body: string; children: ReactNode}) {
    return (
        <div className="flex h-full w-full flex-1 flex-col items-center justify-center gap-3 bg-surface px-6 py-10 text-center text-on-surface">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-surface-container-highest text-on-surface-variant">
                <Icon name={icon} size={28} />
            </span>
            <div className="flex max-w-md flex-col gap-1">
                <h2 className="text-base font-semibold">{title}</h2>
                <p className="text-xs text-on-surface-variant">{body}</p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">{children}</div>
        </div>
    )
}
