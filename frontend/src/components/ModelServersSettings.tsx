import {useCallback, useEffect, useState} from 'react'
import {DeleteModelServer, DetectLocalOllama, ListModelServers, SaveModelServer, TestModelServer} from '../../wailsjs/go/main/App'
import {main} from '../../wailsjs/go/models'
import ConfirmDialog from './ConfirmDialog'
import Icon from './Icon'
import Select from './Select'
import Toggle from './Toggle'
import {HealthDot} from './agent/HealthIndicators'
import {errorText, useT} from '../i18n'
import type {Dict} from '../i18n'
import {isLoopbackUrl, MODEL_SERVER_PREFIX, STORED_HEADERS} from '../lib/modelServers'
import {recheckHealth, recordProbe, useModelServersHealth, type Health} from '../lib/modelServerHealth'

// Sección "Servidores de modelos" de Configuración → IA.
//
// Un servidor de modelos (Ollama, o cualquiera que hable la API de OpenAI) es
// otro PROVEEDOR de IA, igual que Claude Code o Codex pero sin programa de
// terminal: el backend lo publica en el catálogo de agentes con id `llm:<id>`
// y por eso entra solo al chat, a los selectores y a los botones de un turno.
// Esta pantalla solo administra la lista; no hay nada que "abrir".
//
// **El token nunca vuelve.** El backend devuelve `hasToken` y nada más. Al
// editar, un campo vacío significa "conservar el guardado" (el backend lo
// entiende así) y borrarlo es un gesto aparte ("Quitar token"): un campo vacío
// que borrara el secreto lo perdería quien solo quería cambiar el nombre.
//
// **Las cabeceras adicionales siguen la misma regla, con su propio gesto.** El
// backend devuelve solo los NOMBRES (`headerNames`), nunca los valores. Como no
// hay valores que mostrar, tampoco hay fila que editar: «Reemplazar cabeceras»
// descarta las guardadas y abre un editor en blanco, y solo entonces viaja
// `replaceHeaders = true`. Guardar sin tocarlas las conserva.

const LOCAL_OLLAMA_URL = 'http://localhost:11434'
const DISMISS_KEY = 'mini-tools:localOllamaSuggestionDismissed'
const MODELS_SHOWN = 6

type Kind = 'ollama' | 'openai'

interface HeaderRow {
    key: string
    value: string
}

interface Form {
    id: string
    name: string
    kind: Kind
    baseUrl: string
    token: string
    clearToken: boolean
    hasToken: boolean
    // No verificar el certificado HTTPS (autofirmado). Solo tiene efecto con https.
    insecureTls: boolean
    // Filas del editor de cabeceras; solo se mandan si el editor está activo.
    headers: HeaderRow[]
    // Nombres de las cabeceras ya guardadas (los valores no vuelven).
    storedHeaders: string[]
    replaceHeaders: boolean
    createdAt: number
    updatedAt: number
}

type Probe = {state: 'testing'} | {state: 'done'; probe: main.ModelServerProbe} | {state: 'error'; error: string}

function emptyForm(): Form {
    return {
        id: '',
        name: '',
        kind: 'ollama',
        baseUrl: '',
        token: '',
        clearToken: false,
        hasToken: false,
        insecureTls: false,
        headers: [],
        storedHeaders: [],
        replaceHeaders: false,
        createdAt: 0,
        updatedAt: 0,
    }
}

// Token de nombre de campo HTTP (RFC 9110): sin espacios ni dos puntos.
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/

// Primer problema de la lista de cabeceras, o '' si está bien. Una fila
// totalmente vacía no es un problema: es una fila que se agregó y no se usó, y
// simplemente no viaja.
function headersProblem(rows: HeaderRow[], m: Dict['settings']['modelServers']): string {
    const seen = new Set<string>()
    for (const r of rows) {
        const key = r.key.trim()
        if (key === '' && r.value === '') continue
        if (key === '') return m.headerErrorEmptyName
        if (!HEADER_NAME_RE.test(key)) return m.headerErrorBadName({name: key})
        if (r.value === '') return m.headerErrorEmptyValue({name: key})
        const lower = key.toLowerCase()
        if (seen.has(lower)) return m.headerErrorDuplicate({name: key})
        seen.add(lower)
    }
    return ''
}

function headersRecord(rows: HeaderRow[]): Record<string, string> {
    const out: Record<string, string> = {}
    for (const r of rows) {
        const key = r.key.trim()
        if (key !== '') out[key] = r.value
    }
    return out
}

const isHttps = (url: string) => /^https:\/\//i.test(url.trim())

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
    const [form, setForm] = useState<Form | null>(null)
    const [saving, setSaving] = useState(false)
    const [probes, setProbes] = useState<Record<string, Probe>>({})
    const [formProbe, setFormProbe] = useState<Probe | null>(null)
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
    const placeholderFor = (k: Kind) => (k === 'openai' ? 'http://localhost:1234/v1' : LOCAL_OLLAMA_URL)

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
            reload()
        } catch (e) {
            setError(errorText(e))
        }
    }

    function openNew() {
        setForm(emptyForm())
        setFormProbe(null)
        setError('')
    }

    function openEdit(s: main.ModelServer) {
        setForm({
            id: s.id,
            name: s.name,
            kind: s.kind === 'openai' ? 'openai' : 'ollama',
            baseUrl: s.baseUrl,
            token: '',
            clearToken: false,
            hasToken: s.hasToken,
            insecureTls: s.insecureTls,
            headers: [],
            storedHeaders: s.headerNames ?? [],
            replaceHeaders: false,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
        })
        setFormProbe(null)
        setError('')
    }

    async function save() {
        if (!form) return
        setSaving(true)
        setError('')
        try {
            // Las cabeceras solo viajan si el usuario las tocó: con unas
            // guardadas, solo tras «Reemplazar cabeceras»; sin ninguna, si
            // escribió alguna fila. Lo demás las conserva en el backend.
            const replaceHeaders = hasStoredHeaders ? form.replaceHeaders : form.headers.some((r) => r.key.trim() !== '')
            await SaveModelServer(
                main.ModelServer.createFrom({
                    id: form.id,
                    name: form.name.trim(),
                    kind: form.kind,
                    baseUrl: form.baseUrl.trim(),
                    hasToken: form.hasToken,
                    // Con http no hay certificado que aceptar: no se guarda un
                    // «sí» que no significa nada y se activaría solo si algún
                    // día la dirección pasa a https.
                    insecureTls: form.insecureTls && isHttps(form.baseUrl),
                    headerNames: form.storedHeaders,
                    createdAt: form.createdAt,
                    updatedAt: form.updatedAt,
                }),
                form.token.trim(),
                form.clearToken,
                replaceHeaders ? headersRecord(form.headers) : {},
                replaceHeaders,
            )
            if (form.id) {
                // La prueba anterior hablaba de la configuración vieja.
                const id = form.id
                recheckHealth(id)
                setProbes((p) => {
                    const {[id]: _gone, ...rest} = p
                    return rest
                })
            }
            setForm(null)
            setFormProbe(null)
            reload()
        } catch (e) {
            setError(errorText(e))
        } finally {
            setSaving(false)
        }
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

    async function testForm() {
        if (!form) return
        setFormProbe({state: 'testing'})
        try {
            // Cabeceras: las del editor si se están reemplazando (o el servidor es
            // nuevo); si no, null y el backend usa las guardadas del serverId.
            const headers = editingHeaders ? headersRecord(form.headers) : STORED_HEADERS
            const probe = await TestModelServer(
                form.kind,
                form.baseUrl.trim(),
                form.clearToken ? '' : form.token.trim(),
                form.clearToken ? '' : form.id,
                form.insecureTls && isHttps(form.baseUrl),
                headers,
            )
            setFormProbe({state: 'done', probe})
        } catch (e) {
            setFormProbe({state: 'error', error: errorText(e)})
        }
    }

    async function remove(s: main.ModelServer) {
        setError('')
        try {
            await DeleteModelServer(s.id)
            reload()
        } catch (e) {
            setError(errorText(e))
        }
    }

    // Cabeceras: con unas guardadas hay que pedir «Reemplazar» para ver el
    // editor; un servidor nuevo (o sin cabeceras) lo tiene siempre.
    const hasStoredHeaders = form !== null && form.id !== '' && form.storedHeaders.length > 0
    const editingHeaders = form !== null && (!hasStoredHeaders || form.replaceHeaders)
    const headersError = form !== null && editingHeaders ? headersProblem(form.headers, m) : ''
    const tlsBlocked = form !== null && form.baseUrl.trim() !== '' && !isHttps(form.baseUrl)
    const formReady = form !== null && form.name.trim() !== '' && form.baseUrl.trim() !== '' && headersError === ''

    // Una lectura de salud de cada servidor al abrir la pantalla (sin sondeo).
    const health = useModelServersHealth(
        (servers ?? []).map((s) => MODEL_SERVER_PREFIX + s.id),
        servers !== null,
    )

    return (
        <section data-model-servers className="flex flex-col gap-2">
            <h3 className="px-1 text-ui-11 font-semibold uppercase tracking-wider text-on-surface-variant">{m.title}</h3>
            <p className="px-1 text-xs text-on-surface-variant">{m.intro}</p>

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

            {servers !== null && servers.length === 0 && !form && (
                <p className="rounded-lg border border-dashed border-outline-variant px-3 py-3 text-xs text-on-surface-variant">{m.empty}</p>
            )}

            {(servers ?? []).map((s) => {
                const probe = probes[s.id]
                const editing = form?.id === s.id
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

            {form && (
                <div className="flex flex-col gap-3 rounded-lg border border-primary/50 bg-surface-container-highest p-3">
                    <p className="flex items-center gap-2 text-sm font-medium text-on-surface">
                        <Icon name={form.id ? 'edit' : 'add_circle'} size={16} className="text-primary" />
                        {form.id ? m.formTitleEdit({name: form.name || '…'}) : m.formTitleNew}
                    </p>

                    <div className="grid grid-cols-[1fr_11rem] gap-3">
                        <label className="flex min-w-0 flex-col gap-1" title={m.nameTitle}>
                            <span className="text-xs font-medium text-on-surface">{m.name}</span>
                            <input
                                value={form.name}
                                onChange={(e) => setForm({...form, name: e.target.value})}
                                placeholder={m.namePlaceholder}
                                title={m.nameTitle}
                                className="w-full rounded-md border border-outline-variant bg-surface px-2 py-1 text-xs text-on-surface outline-none focus:border-primary"
                            />
                        </label>
                        <div className="flex min-w-0 flex-col gap-1">
                            <span className="text-xs font-medium text-on-surface">{m.kind}</span>
                            <Select
                                value={form.kind}
                                onChange={(v) => {
                                    setForm({...form, kind: v === 'openai' ? 'openai' : 'ollama'})
                                    setFormProbe(null)
                                }}
                                size="sm"
                                ariaLabel={m.kind}
                                title={m.kindTitle}
                                options={[
                                    {value: 'ollama', label: m.kindOllama},
                                    {value: 'openai', label: m.kindOpenai},
                                ]}
                            />
                        </div>
                    </div>

                    <label className="flex flex-col gap-1" title={m.baseUrlTitle}>
                        <span className="text-xs font-medium text-on-surface">{m.baseUrl}</span>
                        <input
                            value={form.baseUrl}
                            onChange={(e) => {
                                setForm({...form, baseUrl: e.target.value})
                                setFormProbe(null)
                            }}
                            placeholder={placeholderFor(form.kind)}
                            title={m.baseUrlTitle}
                            spellCheck={false}
                            autoCapitalize="off"
                            className="w-full rounded-md border border-outline-variant bg-surface px-2 py-1 font-mono text-xs text-on-surface outline-none focus:border-primary"
                        />
                    </label>

                    {form.baseUrl.trim() !== '' && !isLoopbackUrl(form.baseUrl) && (
                        <p className="flex items-start gap-1.5 rounded bg-tertiary/10 px-2 py-1.5 text-ui-11 text-on-surface-variant">
                            <Icon name="public" size={14} className="mt-px shrink-0 text-tertiary" />
                            {m.remoteWarning}
                        </p>
                    )}

                    <div className="flex flex-col gap-1">
                        <span className="flex items-center gap-2 text-xs font-medium text-on-surface">
                            <span title={m.tokenTitle}>
                                {m.token} <span className="font-normal text-on-surface-variant">{m.optional}</span>
                            </span>
                            {form.hasToken && (
                                <button
                                    type="button"
                                    onClick={() => setForm({...form, clearToken: !form.clearToken, token: ''})}
                                    title={form.clearToken ? m.keepTokenTitle : m.removeTokenTitle}
                                    className={`ml-auto rounded px-2 py-0.5 text-xs font-normal ${
                                        form.clearToken
                                            ? 'text-primary hover:bg-primary/10'
                                            : 'text-error hover:bg-error-container/40'
                                    }`}
                                >
                                    {form.clearToken ? m.keepToken : m.removeToken}
                                </button>
                            )}
                        </span>
                        <input
                            type="password"
                            value={form.token}
                            onChange={(e) => {
                                setForm({...form, token: e.target.value})
                                setFormProbe(null)
                            }}
                            disabled={form.clearToken}
                            placeholder={form.clearToken ? m.tokenClearedPlaceholder : form.hasToken ? m.tokenKeepPlaceholder : ''}
                            title={m.tokenTitle}
                            autoComplete="off"
                            className="w-full rounded-md border border-outline-variant bg-surface px-2 py-1 font-mono text-xs text-on-surface outline-none focus:border-primary disabled:opacity-50"
                        />
                    </div>

                    <div data-headers-editor className="flex flex-col gap-1.5">
                        <span className="flex items-center gap-2 text-xs font-medium text-on-surface">
                            <span title={m.headersHint}>
                                {m.headersTitle} <span className="font-normal text-on-surface-variant">{m.optional}</span>
                            </span>
                            {hasStoredHeaders && (
                                <button
                                    type="button"
                                    data-headers-replace-toggle
                                    onClick={() => {
                                        setForm({...form, replaceHeaders: !form.replaceHeaders, headers: []})
                                        setFormProbe(null)
                                    }}
                                    title={form.replaceHeaders ? m.headersKeepTitle : m.headersReplaceTitle}
                                    className={`ml-auto rounded px-2 py-0.5 text-xs font-normal ${
                                        form.replaceHeaders ? 'text-primary hover:bg-primary/10' : 'text-error hover:bg-error-container/40'
                                    }`}
                                >
                                    {form.replaceHeaders ? m.headersKeep : m.headersReplace}
                                </button>
                            )}
                        </span>

                        {hasStoredHeaders && !form.replaceHeaders && (
                            <div className="flex flex-col gap-1 rounded-md border border-outline-variant bg-surface px-2 py-1.5">
                                <p className="text-ui-11 text-on-surface-variant">{m.headersStored({count: form.storedHeaders.length})}</p>
                                <div className="flex flex-wrap gap-1">
                                    {form.storedHeaders.map((name) => (
                                        <span key={name} className="rounded bg-surface-variant px-1.5 py-0.5 font-mono text-ui-10 text-on-surface">
                                            {name}
                                        </span>
                                    ))}
                                </div>
                                <p className="text-ui-10 text-on-surface-variant/70">{m.headersStoredValues}</p>
                            </div>
                        )}

                        {editingHeaders && (
                            <>
                                {hasStoredHeaders && <p className="text-ui-11 text-tertiary">{m.headersReplaceNote}</p>}
                                {form.headers.length === 0 && !hasStoredHeaders && (
                                    <p className="text-ui-11 text-on-surface-variant/70">{m.headersNone}</p>
                                )}
                                {form.headers.map((row, i) => (
                                    <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2" data-header-row>
                                        <input
                                            value={row.key}
                                            onChange={(e) => {
                                                setForm({...form, headers: form.headers.map((r, j) => (j === i ? {...r, key: e.target.value} : r))})
                                                setFormProbe(null)
                                            }}
                                            placeholder={m.headerNamePlaceholder}
                                            title={m.headerNameTitle}
                                            aria-label={m.headerName}
                                            spellCheck={false}
                                            autoCapitalize="off"
                                            autoComplete="off"
                                            className="w-full min-w-0 rounded-md border border-outline-variant bg-surface px-2 py-1 font-mono text-xs text-on-surface outline-none focus:border-primary"
                                        />
                                        <input
                                            type="password"
                                            value={row.value}
                                            onChange={(e) => {
                                                setForm({...form, headers: form.headers.map((r, j) => (j === i ? {...r, value: e.target.value} : r))})
                                                setFormProbe(null)
                                            }}
                                            placeholder={m.headerValuePlaceholder}
                                            title={m.headerValueTitle}
                                            aria-label={m.headerValue}
                                            autoComplete="off"
                                            className="w-full min-w-0 rounded-md border border-outline-variant bg-surface px-2 py-1 font-mono text-xs text-on-surface outline-none focus:border-primary"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setForm({...form, headers: form.headers.filter((_, j) => j !== i)})
                                                setFormProbe(null)
                                            }}
                                            title={m.headerRemoveTitle}
                                            aria-label={m.headerRemoveTitle}
                                            className="rounded p-1 text-on-surface-variant hover:bg-error-container/40 hover:text-error"
                                        >
                                            <Icon name="close" size={14} />
                                        </button>
                                    </div>
                                ))}
                                {headersError && (
                                    <p className="flex items-center gap-1 text-ui-11 text-error">
                                        <Icon name="error" size={12} className="shrink-0" />
                                        {headersError}
                                    </p>
                                )}
                                <button
                                    type="button"
                                    data-header-add
                                    onClick={() => setForm({...form, headers: [...form.headers, {key: '', value: ''}]})}
                                    title={m.headerAddTitle}
                                    className="flex items-center gap-1 self-start rounded px-2 py-0.5 text-xs text-primary hover:bg-primary/10"
                                >
                                    <Icon name="add" size={13} />
                                    {m.headerAdd}
                                </button>
                            </>
                        )}
                    </div>

                    <div data-insecure-tls className="flex items-start gap-3 rounded-md border border-outline-variant bg-surface px-2.5 py-2">
                        <div className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5 text-xs font-medium text-on-surface" title={tlsBlocked ? m.insecureTlsOnlyHttps : m.insecureTlsTitle}>
                                <Icon name="lock_open" size={13} className={form.insecureTls && !tlsBlocked ? 'text-tertiary' : 'text-on-surface-variant'} />
                                {m.insecureTls}
                            </span>
                            <p className={`mt-0.5 text-ui-11 ${tlsBlocked ? 'text-on-surface-variant/70' : form.insecureTls ? 'text-tertiary' : 'text-on-surface-variant'}`}>
                                {tlsBlocked ? m.insecureTlsOnlyHttps : m.insecureTlsDescription}
                            </p>
                        </div>
                        <Toggle
                            size="sm"
                            checked={form.insecureTls && !tlsBlocked}
                            disabled={tlsBlocked}
                            onChange={(v) => {
                                setForm({...form, insecureTls: v})
                                setFormProbe(null)
                            }}
                            title={tlsBlocked ? m.insecureTlsOnlyHttps : m.insecureTlsTitle}
                            ariaLabel={m.insecureTls}
                        />
                    </div>

                    {formProbe && formProbe.state !== 'testing' && <ProbeResult probe={formProbe} />}

                    <div className="flex items-center justify-end gap-2">
                        <button
                            type="button"
                            onClick={() => void testForm()}
                            disabled={form.baseUrl.trim() === '' || formProbe?.state === 'testing'}
                            title={form.baseUrl.trim() === '' ? m.formTestNeedsUrl : m.formTestTitle}
                            className="mr-auto flex items-center gap-1 rounded px-2 py-1 text-xs text-primary hover:bg-primary/10 disabled:opacity-40"
                        >
                            <Icon name="network_check" size={14} />
                            {formProbe?.state === 'testing' ? m.testing : m.formTest}
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                setForm(null)
                                setFormProbe(null)
                            }}
                            title={m.cancelTitle}
                            className="rounded px-3 py-1 text-xs text-on-surface-variant hover:text-on-surface"
                        >
                            {m.cancel}
                        </button>
                        <button
                            type="button"
                            onClick={() => void save()}
                            disabled={!formReady || saving}
                            title={formReady ? m.saveTitle : m.saveNeedsFields}
                            className="rounded bg-primary px-3 py-1 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-40"
                        >
                            {m.save}
                        </button>
                    </div>
                </div>
            )}

            {!form && (
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

// Resultado de una prueba de conexión, en línea. La lista de modelos se
// recorta: un servidor con cuarenta modelos no tiene que empujar el resto de
// la pantalla, y el conteo ya dice cuántos hay.
function ProbeResult({probe}: {probe: Exclude<Probe, {state: 'testing'}>}) {
    const t = useT()
    const m = t.settings.modelServers
    if (probe.state === 'error' || (probe.state === 'done' && !probe.probe.ok)) {
        const error = probe.state === 'error' ? probe.error : probe.probe.error
        return (
            <p className="flex items-start gap-1.5 rounded bg-error-container/40 px-2 py-1.5 text-ui-11 text-error">
                <Icon name="error" size={14} className="mt-px shrink-0" />
                <span className="min-w-0 break-words">{m.testFail({error})}</span>
            </p>
        )
    }
    if (probe.state !== 'done') return null
    const models = probe.probe.models ?? []
    return (
        <div className="flex flex-col gap-0.5 rounded bg-secondary/10 px-2 py-1.5 text-ui-11">
            <p className="flex items-center gap-1.5 text-secondary">
                <Icon name="check_circle" size={14} className="shrink-0" />
                {m.testOk({version: probe.probe.version, models: models.length})}
                {probe.probe.latencyMs > 0 && m.testOkLatency({ms: probe.probe.latencyMs})}
            </p>
            {models.length > 0 && (
                <p className="break-words font-mono text-ui-10 text-on-surface-variant">
                    {m.testOkModels({list: models.slice(0, MODELS_SHOWN).join(', ') + (models.length > MODELS_SHOWN ? ', …' : '')})}
                </p>
            )}
        </div>
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
