import {useCallback, useEffect, useState} from 'react'
import {DetectLocalOllama, ListModelServers, SaveModelServer} from '../../wailsjs/go/main/App'
import {main} from '../../wailsjs/go/models'
import Icon from './Icon'
import ModelServerForm, {LOCAL_OLLAMA_URL} from './ModelServerForm'
import {HealthDot} from './agent/HealthIndicators'
import {errorText, useT} from '../i18n'
import {MODEL_SERVER_PREFIX, providerGroup, providerIcon, providerKind} from '../lib/modelServers'
import {useModelServersHealth, type Health} from '../lib/modelServerHealth'
import {notifyModelServersChanged, onModelServersChanged, requestOpenUtility} from '../lib/appBus'

// Sección "Proveedores de IA" de Configuración → IA: un RESUMEN.
//
// Un proveedor (un servidor propio —Ollama, LM Studio, vLLM…— o una API alojada
// —OpenRouter, OpenAI, Anthropic…—) es otro agente de IA, igual que Claude Code
// o Codex pero sin programa de terminal: el backend lo publica en el catálogo de
// agentes con id `llm:<id>` y por eso entra solo al chat, a los selectores y a
// los botones de un turno.
//
// La administración de verdad —activar, ordenar, probar, duplicar, eliminar, ver
// modelos y consumo— vive en Utilidades → Proveedores de IA; acá queda lo que
// hace falta para saber qué hay y llegar ahí: los conteos por grupo, una fila
// compacta por proveedor y el botón de agregar (que sigue siendo el mismo
// formulario, `ModelServerForm`, compartido con el selector del chat). Las
// reglas de la API key y de las cabeceras (nunca vuelven; vacío = conservar)
// viven en ese formulario.

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
    const P = t.models.providers
    const [servers, setServers] = useState<main.ModelServer[] | null>(null)
    const [error, setError] = useState('')
    const [detected, setDetected] = useState(false)
    const [dismissed, setDismissed] = useState(readDismissed)
    // Qué se está editando: un proveedor existente, o `null` dentro para uno nuevo.
    const [editor, setEditor] = useState<{server: main.ModelServer | null} | null>(null)

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

    // La lista cambia desde Utilidades (activar, ordenar, borrar) con esta
    // pantalla abierta debajo: se relee.
    useEffect(() => onModelServersChanged(reload), [reload])

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
                main.ModelServer.createFrom({id: '', name: m.localName, kind: 'ollama', baseUrl: LOCAL_OLLAMA_URL, hasToken: false, insecureTls: false, enabled: true, defaultModel: '', headerNames: []}),
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

    function onSaved() {
        setEditor(null)
        reload()
    }

    // Una lectura de salud de cada proveedor activo al abrir la pantalla (sin sondeo).
    const health = useModelServersHealth(
        (servers ?? []).filter((s) => s.enabled).map((s) => MODEL_SERVER_PREFIX + s.id),
        servers !== null,
    )

    const list = servers ?? []
    const counts = {
        local: list.filter((s) => providerGroup(s) === 'local').length,
        remote: list.filter((s) => providerGroup(s) === 'remote').length,
        cloud: list.filter((s) => providerGroup(s) === 'cloud').length,
    }
    const off = list.filter((s) => !s.enabled).length

    return (
        <section data-model-servers className="flex flex-col gap-2">
            <h3 className="px-1 text-ui-11 font-semibold uppercase tracking-wider text-on-surface-variant">{m.title}</h3>
            <p className="px-1 text-xs text-on-surface-variant">{m.intro}</p>

            <button
                type="button"
                data-manage-in-utilities
                onClick={() => requestOpenUtility('modelManager')}
                title={t.models.servers.settingsLinkTitle}
                className="flex items-center gap-1.5 self-start rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
                <Icon name="open_in_new" size={14} />
                {t.models.servers.settingsLink}
            </button>

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

            {servers !== null && list.length === 0 && !editor && (
                <p className="rounded-lg border border-dashed border-outline-variant px-3 py-3 text-xs text-on-surface-variant">{m.empty}</p>
            )}

            {list.length > 0 && (
                <>
                    <p data-providers-summary className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-on-surface-variant">
                        {(['local', 'remote', 'cloud'] as const).map((g) => (
                            <span key={g} title={P.groupTitles[g]} className="flex items-center gap-1">
                                <Icon name={g === 'local' ? 'computer' : g === 'remote' ? 'lan' : 'cloud'} size={13} />
                                {m.summaryGroup({group: P.groups[g], n: counts[g]})}
                            </span>
                        ))}
                        {off > 0 && <span title={P.disabledBanner}>{m.summaryOff({n: off})}</span>}
                    </p>
                    <ul className="flex flex-col divide-y divide-outline-variant/50 overflow-hidden rounded-lg border border-outline-variant bg-surface-container-highest">
                        {list.map((s) => {
                            if (editor?.server?.id === s.id) return null
                            const group = providerGroup(s)
                            return (
                                <li key={s.id} data-provider-summary-row={s.id} className={`flex items-center gap-2.5 px-3 py-2 ${s.enabled ? '' : 'opacity-60'}`}>
                                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary" title={P.kindTitles[providerKind(s.kind)]}>
                                        <Icon name={providerIcon(s)} size={15} />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-medium text-on-surface">
                                            <span className="truncate">{s.name}</span>
                                            <span className={`shrink-0 rounded-full px-1.5 text-ui-10 font-normal ${group === 'local' ? 'bg-secondary/15 text-secondary' : 'bg-tertiary/15 text-tertiary'}`} title={P.groupTitles[group]}>
                                                {P.groups[group]}
                                            </span>
                                            <span className="shrink-0 rounded-full bg-surface-variant px-1.5 text-ui-10 font-normal text-on-surface-variant">{P.kindShort[providerKind(s.kind)]}</span>
                                            {!s.enabled && <span className="shrink-0 text-ui-10 font-normal text-on-surface-variant">{P.disabled}</span>}
                                        </span>
                                        {s.enabled && <HealthLine health={health[MODEL_SERVER_PREFIX + s.id]} name={s.name} />}
                                    </span>
                                    <button
                                        type="button"
                                        data-model-server-edit={s.id}
                                        onClick={() => {
                                            setEditor({server: s})
                                            setError('')
                                        }}
                                        title={m.editTitle({name: s.name})}
                                        aria-label={m.edit}
                                        className="shrink-0 rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                                    >
                                        <Icon name="edit" size={15} />
                                    </button>
                                </li>
                            )
                        })}
                    </ul>
                </>
            )}

            {editor && <ModelServerForm key={editor.server?.id ?? 'new'} server={editor.server} onSaved={onSaved} onCancel={() => setEditor(null)} />}

            {!editor && (
                <button
                    type="button"
                    data-model-server-add
                    onClick={() => {
                        setEditor({server: null})
                        setError('')
                    }}
                    title={m.addTitle}
                    className="flex items-center gap-1.5 self-start rounded-lg border border-outline-variant px-3 py-1.5 text-xs text-primary hover:bg-primary/10"
                >
                    <Icon name="add" size={14} />
                    {m.add}
                </button>
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
