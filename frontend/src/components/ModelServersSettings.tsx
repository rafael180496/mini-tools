import {useCallback, useEffect, useState} from 'react'
import {DeleteModelServer, DetectLocalOllama, ListModelServers, SaveModelServer, TestModelServer} from '../../wailsjs/go/main/App'
import {main} from '../../wailsjs/go/models'
import ConfirmDialog from './ConfirmDialog'
import Icon from './Icon'
import ModelServerForm, {LOCAL_OLLAMA_URL, ProbeResult, type Probe} from './ModelServerForm'
import {HealthDot} from './agent/HealthIndicators'
import {errorText, useT} from '../i18n'
import {MODEL_SERVER_PREFIX, STORED_HEADERS} from '../lib/modelServers'
import {recordProbe, useModelServersHealth, type Health} from '../lib/modelServerHealth'
import {notifyModelServersChanged} from '../lib/appBus'

// Sección "Servidores de modelos" de Configuración → IA.
//
// Un servidor de modelos (Ollama, o cualquiera que hable la API de OpenAI) es
// otro PROVEEDOR de IA, igual que Claude Code o Codex pero sin programa de
// terminal: el backend lo publica en el catálogo de agentes con id `llm:<id>`
// y por eso entra solo al chat, a los selectores y a los botones de un turno.
// Esta pantalla solo administra la lista; no hay nada que "abrir".
//
// El formulario de alta y edición es `ModelServerForm`, compartido con el
// diálogo que abre el selector de proveedor del chat. Las reglas del token y de
// las cabeceras (nunca vuelven; vacío = conservar) viven ahí.

const DISMISS_KEY = 'mini-tools:localOllamaSuggestionDismissed'

function readDismissed(): boolean {
    try {
        return localStorage.getItem(DISMISS_KEY) === '1'
    } catch {
        return false
    }
}

function sameUrl(a: string, b: string): boolean {
    const norm = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase()
    return norm(a) === norm(b)
}

export default function ModelServersSettings() {
    const t = useT()
    const m = t.settings.modelServers
    const [servers, setServers] = useState<main.ModelServer[] | null>(null)
    const [error, setError] = useState('')
    const [detected, setDetected] = useState(false)
    const [dismissed, setDismissed] = useState(readDismissed)
    // Qué se está editando: un servidor existente, o `null` dentro para uno nuevo.
    const [editor, setEditor] = useState<{server: main.ModelServer | null} | null>(null)
    const [probes, setProbes] = useState<Record<string, Probe>>({})
    const [toDelete, setToDelete] = useState<main.ModelServer | null>(null)

    const reload = useCallback(() => {
        ListModelServers()
            .then((l) => {
                setServers(l ?? [])
                setError('')
            })
            .catch((e) => {
                setServers([])
                setError(errorText(e))
            })
    }, [])

    useEffect(() => {
        reload()
        // Sondear el Ollama local es barato (un GET a localhost) y no bloquea
        // la lista: si no responde, simplemente no hay sugerencia.
        DetectLocalOllama()
            .then(setDetected)
            .catch(() => setDetected(false))
    }, [reload])

    const kindLabel = (k: string) => (k === 'openai' ? m.kindOpenai : m.kindOllama)

    // La sugerencia sobra si ya hay un Ollama apuntando a esa dirección.
    const alreadyLocal = (servers ?? []).some((s) => s.kind === 'ollama' && sameUrl(s.baseUrl, LOCAL_OLLAMA_URL))
    const showSuggestion = detected && !dismissed && !alreadyLocal && servers !== null

    function dismissSuggestion() {
        setDismissed(true)
        try {
            localStorage.setItem(DISMISS_KEY, '1')
        } catch {
            // sin almacenamiento: la sugerencia vuelve la próxima vez, no pasa nada
        }
    }

    async function addLocalOllama() {
        setError('')
        try {
            await SaveModelServer(
                main.ModelServer.createFrom({id: '', name: m.localName, kind: 'ollama', baseUrl: LOCAL_OLLAMA_URL, hasToken: false, insecureTls: false, headerNames: []}),
                '',
                false,
                {},
                false,
            )
            notifyModelServersChanged()
            reload()
        } catch (e) {
            setError(errorText(e))
        }
    }
    function openNew() {
        setEditor({server: null})
        setError('')
    }

    function openEdit(s: main.ModelServer) {
        setEditor({server: s})
        setError('')
    }

    function onSaved(saved: main.ModelServer) {
        // La prueba anterior hablaba de la configuración vieja.
        setProbes((p) => {
            const {[saved.id]: _gone, ...rest} = p
            return rest
        })
        setEditor(null)
        reload()
    }
    async function testSaved(s: main.ModelServer) {
        setProbes((p) => ({...p, [s.id]: {state: 'testing'}}))
        try {
            // serverId + token vacío: el backend usa el token guardado, que
            // esta pantalla nunca tiene.
            // Cabeceras null + serverId: el backend usa las guardadas.
            const probe = await TestModelServer(s.kind, s.baseUrl, '', s.id, s.insecureTls, STORED_HEADERS)
            recordProbe(s.id, probe)
            setProbes((p) => ({...p, [s.id]: {state: 'done', probe}}))
        } catch (e) {
            setProbes((p) => ({...p, [s.id]: {state: 'error', error: errorText(e)}}))
        }
    }
    async function remove(s: main.ModelServer) {
        setError('')
        try {
            await DeleteModelServer(s.id)
            notifyModelServersChanged()
            reload()
        } catch (e) {
            setError(errorText(e))
        }
    }

    // Una lectura de salud de cada servidor al abrir la pantalla (sin sondeo).
    const health = useModelServersHealth(
        (servers ?? []).map((s) => MODEL_SERVER_PREFIX + s.id),
        servers !== null,
    )

    return (
        <section data-model-servers className="flex flex-col gap-2">
            <h3 className="px-1 text-ui-11 font-semibold uppercase tracking-wider text-on-surface-variant">{m.title}</h3>
            <p className="px-1 text-xs text-on-surface-variant">{m.intro}</p>

            {/* Lo primero que se pregunta quien llega acá con un Ollama en otra
                máquina es si tiene que instalar algo. */}
            <p data-no-install className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-on-surface-variant">
                <Icon name="cloud_done" size={16} className="mt-px shrink-0 text-primary" />
                <span>
                    <strong className="font-semibold text-on-surface">{m.noInstallTitle}.</strong> {m.noInstall}
                </span>
            </p>

            {error && <p className="rounded bg-error-container/40 px-2 py-1 text-ui-11 text-error">{error}</p>}

            {showSuggestion && (
                <div className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2">
                    <Icon name="bolt" size={16} className="shrink-0 text-primary" />
                    <p className="min-w-0 flex-1 text-xs text-on-surface">
                        {m.detectedBefore} <span className="font-mono">{LOCAL_OLLAMA_URL}</span>
                    </p>
                    <button
                        type="button"
                        onClick={() => void addLocalOllama()}
                        title={m.detectedAddTitle}
                        className="shrink-0 rounded bg-primary px-2 py-1 text-xs font-medium text-on-primary hover:opacity-90"
                    >
                        {m.detectedAdd}
                    </button>
                    <button
                        type="button"
                        onClick={dismissSuggestion}
                        title={m.detectedDismissTitle}
                        className="shrink-0 rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="close" size={14} />
                    </button>
                </div>
            )}

            {servers === null && <p className="px-1 text-xs text-on-surface-variant/70">{m.loading}</p>}

            {servers !== null && servers.length === 0 && !editor && (
                <p className="rounded-lg border border-dashed border-outline-variant px-3 py-3 text-xs text-on-surface-variant">{m.empty}</p>
            )}

            {(servers ?? []).map((s) => {
                const probe = probes[s.id]
                const editing = editor?.server?.id === s.id
                if (editing) return null
                return (
                    <div key={s.id} className="flex flex-col gap-2 rounded-lg border border-outline-variant bg-surface-container-highest p-3">
                        <div className="flex items-center gap-3">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                                <Icon name={s.isLocal ? 'computer' : 'cloud'} size={18} />
                            </span>
                            <div className="min-w-0 flex-1">
                                <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-on-surface">
                                    <span className="truncate">{s.name}</span>
                                    <span
                                        title={m.kindBadgeTitle({kind: kindLabel(s.kind)})}
                                        className="shrink-0 rounded-full bg-surface-variant px-1.5 text-ui-10 font-normal text-on-surface-variant"
                                    >
                                        {kindLabel(s.kind)}
                                    </span>
                                    {!s.isLocal && (
                                        <span
                                            data-remote-badge
                                            title={m.remoteBadgeTitle}
                                            className="flex shrink-0 items-center gap-1 rounded-full border border-tertiary/40 bg-tertiary/10 px-1.5 text-ui-10 font-normal text-tertiary"
                                        >
                                            <Icon name="cloud" size={11} />
                                            {m.remoteBadge}
                                        </span>
                                    )}
                                    {s.hasToken ? (
                                        <span
                                            title={m.tokenBadgeTitle}
                                            className="flex shrink-0 items-center gap-1 rounded-full bg-secondary/15 px-1.5 text-ui-10 font-normal text-secondary"
                                        >
                                            <Icon name="key" size={11} />
                                            {m.tokenBadge}
                                        </span>
                                    ) : (
                                        <span
                                            title={m.noTokenTitle}
                                            className="shrink-0 rounded-full px-1.5 text-ui-10 font-normal text-on-surface-variant/70"
                                        >
                                            {m.noToken}
                                        </span>
                                    )}
                                    {(s.headerNames ?? []).length > 0 && (
                                        <span
                                            data-headers-badge
                                            title={m.headersBadgeTitle({names: (s.headerNames ?? []).join(', ')})}
                                            className="flex shrink-0 items-center gap-1 rounded-full bg-surface-variant px-1.5 text-ui-10 font-normal text-on-surface-variant"
                                        >
                                            <Icon name="data_array" size={11} />
                                            {m.headersBadge({count: (s.headerNames ?? []).length})}
                                        </span>
                                    )}
                                    {s.insecureTls && (
                                        <span
                                            data-insecure-tls-badge
                                            title={m.insecureTlsBadgeTitle}
                                            className="flex shrink-0 items-center gap-1 rounded-full border border-tertiary/40 bg-tertiary/10 px-1.5 text-ui-10 font-normal text-tertiary"
                                        >
                                            <Icon name="lock_open" size={11} />
                                            {m.insecureTlsBadge}
                                        </span>
                                    )}
                                </span>
                                <span className="block truncate font-mono text-xs text-on-surface-variant" title={s.baseUrl}>
                                    {s.baseUrl}
                                </span>
                                <HealthLine health={health[MODEL_SERVER_PREFIX + s.id]} name={s.name} />
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                                <button
                                    type="button"
                                    data-model-server-test
                                    onClick={() => void testSaved(s)}
                                    disabled={probe?.state === 'testing'}
                                    title={m.testTitle({name: s.name})}
                                    className="flex items-center gap-1 rounded px-2 py-1 text-xs text-primary hover:bg-primary/10 disabled:opacity-50"
                                >
                                    <Icon name="network_check" size={14} />
                                    {probe?.state === 'testing' ? m.testing : m.test}
                                </button>
                                <button
                                    type="button"
                                    data-model-server-edit={s.id}
                                    onClick={() => openEdit(s)}
                                    title={m.editTitle({name: s.name})}
                                    className="rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                                >
                                    <Icon name="edit" size={16} />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setToDelete(s)}
                                    title={m.deleteTitle({name: s.name})}
                                    className="rounded p-1 text-on-surface-variant hover:bg-error-container/40 hover:text-error"
                                >
                                    <Icon name="delete" size={16} />
                                </button>
                            </div>
                        </div>
                        {probe && probe.state !== 'testing' && <ProbeResult probe={probe} />}
                    </div>
                )
            })}

            {editor && (
                <ModelServerForm key={editor.server?.id ?? 'new'} server={editor.server} onSaved={onSaved} onCancel={() => setEditor(null)} />
            )}

            {!editor && (
                <button
                    type="button"
                    data-model-server-add
                    onClick={openNew}
                    title={m.addTitle}
                    className="flex items-center gap-1.5 self-start rounded-lg border border-outline-variant px-3 py-1.5 text-xs text-primary hover:bg-primary/10"
                >
                    <Icon name="add" size={14} />
                    {m.add}
                </button>
            )}

            {toDelete && (
                <ConfirmDialog
                    title={m.deleteConfirmTitle}
                    description={m.deleteConfirm({name: toDelete.name})}
                    confirmLabel={m.deleteConfirmLabel}
                    danger
                    onConfirm={() => void remove(toDelete)}
                    onClose={() => setToDelete(null)}
                />
            )}
        </section>
    )
}

// Estado de salud de un servidor de la lista, en una línea: punto + el mismo
// texto que el del selector del chat. Un error largo se recorta, y el `title`
// lo trae entero.
function HealthLine({health, name}: {health: Health | undefined; name: string}) {
    const t = useT()
    const m = t.settings.modelServers
    if (!health) return null
    const text =
        health.status === 'ok'
            ? m.healthOk({
                  latency: health.latencyMs,
                  ago: t.agent.health.ago({sec: Math.max(0, Math.round((Date.now() - health.checkedAt) / 1000))}),
              })
            : health.status === 'error'
              ? m.healthError({error: health.error})
              : health.status === 'checking'
                ? m.healthChecking
                : m.healthUnknown
    return (
        <span data-health-line={health.status} className="mt-0.5 flex min-w-0 items-center gap-1.5 text-ui-11 text-on-surface-variant">
            <HealthDot health={health} server={name} />
            <span className={`min-w-0 truncate ${health.status === 'error' ? 'text-error' : ''}`} title={text}>
                {text}
            </span>
        </span>
    )
}
