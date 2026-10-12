import {useRef, useState} from 'react'
import {SaveModelServer, TestModelServer} from '../../wailsjs/go/main/App'
import {main} from '../../wailsjs/go/models'
import Icon from './Icon'
import Select from './Select'
import Toggle from './Toggle'
import OllamaExposeGuide from './OllamaExposeGuide'
import {errorText, useT} from '../i18n'
import type {Dict} from '../i18n'
import {isLoopbackUrl, looksUnreachable, STORED_HEADERS} from '../lib/modelServers'
import {composeUrl, hostPortOf, hostProblem, parseHostPortUrl, presetByKey, PRESETS, validPort, type PresetKey} from '../lib/modelServerPresets'
import {recheckHealth} from '../lib/modelServerHealth'
import {notifyModelServersChanged} from '../lib/appBus'

// Formulario de alta y edición de un servidor de modelos.
//
// Vive aparte de `ModelServersSettings` porque se usa en DOS lugares: la sección
// de Configuración → IA (en línea, dentro de la lista) y el diálogo que abren los
// selectores de proveedor del chat (`ModelServerDialog`). Antes el único camino
// para agregar un Ollama remoto era Configuración, y quien abría el selector del
// chat solo veía los CLIs instalados y concluía que Ollama había que instalarlo.
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
//
// **Guardar no depende de que la prueba salga bien.** Un servidor puede estar
// apagado ahora, o a punto de abrirse a la red; obligar a probar primero sería
// impedir registrar justo el caso que más ayuda necesita. Si la prueba falla, el
// botón pasa a decir «Guardar igual» para que sea una decisión visible.
//
// **Atajos (solo al crear).** Seis tarjetas arriba completan nombre, tipo y
// dirección (`lib/modelServerPresets.ts`). Los que viven en otra máquina piden
// IP y puerto y arman `http://<ip>:<puerto>`; la dirección libre sigue a la
// vista y se sincroniza en los dos sentidos mientras tenga esa forma — si se
// la edita a otra cosa, el atajo se suelta (queda «personalizado»). El nombre se
// autocompleta solo mientras nadie lo escribió. No se recuerda nada entre
// aperturas: el formulario siempre arranca sin atajo elegido.
//
// **La guía de Ollama** (`OllamaExposeGuide`) aparece abierta con el atajo «en
// otra máquina» y plegada ante cualquier Ollama con dirección no local. El
// aviso de prueba fallida ya no repite los pasos: abre la guía.

export const LOCAL_OLLAMA_URL = 'http://localhost:11434'
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


export type Probe = {state: 'testing'} | {state: 'done'; probe: main.ModelServerProbe} | {state: 'error'; error: string}

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


function fromServer(s: main.ModelServer): Form {
    return {
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
    }
}

interface Props {
    // null = servidor nuevo.
    server: main.ModelServer | null
    onSaved: (saved: main.ModelServer) => void
    onCancel: () => void
    // Sin el marco de tarjeta ni el título: dentro de un diálogo que ya los tiene.
    bare?: boolean
    autoFocus?: boolean
}

export default function ModelServerForm({server, onSaved, onCancel, bare, autoFocus}: Props) {
    const t = useT()
    const m = t.settings.modelServers
    const [form, setForm] = useState<Form>(() => (server ? fromServer(server) : emptyForm()))
    const [formProbe, setFormProbe] = useState<Probe | null>(null)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState('')
    // Atajos: solo al crear. `preset` null = nada elegido o dirección personalizada.
    const isNew = server === null
    const [preset, setPreset] = useState<PresetKey | null>(null)
    const [host, setHost] = useState('')
    const [port, setPort] = useState('11434')
    // El nombre se autocompleta mientras nadie lo escribió a mano.
    const [nameTouched, setNameTouched] = useState(false)
    // null = automática (abierta con el atajo «Ollama en otra máquina»).
    const [guideOpen, setGuideOpen] = useState<boolean | null>(null)
    const guideRef = useRef<HTMLDivElement>(null)
    const activePreset = preset ? presetByKey(preset) : null
    const presetText = m.presets

    const placeholderFor = (k: Kind) => (k === 'openai' ? 'http://localhost:1234/v1' : LOCAL_OLLAMA_URL)

    // Nombre sugerido de un atajo; '' si no hay uno que valga todavía.
    function presetName(key: PresetKey, hostValue: string): string {
        const pr = presetByKey(key)
        const h = hostValue.trim()
        if (key === 'ollamaLocal') return m.localName
        if (key === 'openaiOther') return ''
        if (pr.hostPort) return h !== '' && !hostProblem(h) ? presetText.nameWithHost({brand: pr.brand, host: h}) : key === 'vllm' ? pr.brand : ''
        return pr.brand
    }

    function applyPreset(key: PresetKey) {
        const pr = presetByKey(key)
        const nextPort = pr.hostPort ? String(pr.defaultPort) : port
        if (pr.hostPort) setPort(nextPort)
        setPreset(key)
        setGuideOpen(null)
        setFormProbe(null)
        setForm((f) => ({
            ...f,
            kind: pr.kind,
            baseUrl: pr.hostPort ? composeUrl(pr, host, nextPort) : pr.fixedUrl,
            name: nameTouched ? f.name : presetName(key, host),
        }))
    }

    function changeHostPort(nextHost: string, nextPort: string) {
        if (!activePreset || !preset) return
        setHost(nextHost)
        setPort(nextPort)
        setFormProbe(null)
        setForm((f) => ({
            ...f,
            baseUrl: composeUrl(activePreset, nextHost, nextPort),
            name: nameTouched ? f.name : presetName(preset, nextHost),
        }))
    }

    function changeUrl(value: string) {
        setFormProbe(null)
        // Con un atajo de IP y puerto, la dirección sigue sincronizada mientras
        // conserve esa forma; con cualquier otra, el atajo se suelta.
        const parsed = activePreset?.hostPort ? parseHostPortUrl(activePreset, value) : null
        if (parsed) {
            setHost(parsed.host)
            setPort(parsed.port)
            setForm((f) => ({...f, baseUrl: value, name: nameTouched || !preset ? f.name : presetName(preset, parsed.host)}))
            return
        }
        if (preset) {
            // Que la guía no se pliegue sola al soltar el atajo en medio de la edición.
            if (guideOpen === null) setGuideOpen(preset === 'ollamaRemote')
            setPreset(null)
        }
        setForm((f) => ({...f, baseUrl: value}))
    }

    async function save() {
        setSaving(true)
        setError('')
        try {
            // Las cabeceras solo viajan si el usuario las tocó: con unas
            // guardadas, solo tras «Reemplazar cabeceras»; sin ninguna, si
            // escribió alguna fila. Lo demás las conserva en el backend.
            const replaceHeaders = hasStoredHeaders ? form.replaceHeaders : form.headers.some((r) => r.key.trim() !== '')
            const saved = await SaveModelServer(
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
            // La prueba anterior de un servidor editado hablaba de la
            // configuración vieja.
            if (form.id) recheckHealth(form.id)
            notifyModelServersChanged()
            onSaved(saved)
        } catch (e) {
            setError(errorText(e))
        } finally {
            setSaving(false)
        }
    }

    async function testForm() {
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

    // Cabeceras: con unas guardadas hay que pedir «Reemplazar» para ver el
    // editor; un servidor nuevo (o sin cabeceras) lo tiene siempre.
    const hasStoredHeaders = form.id !== '' && form.storedHeaders.length > 0
    const editingHeaders = !hasStoredHeaders || form.replaceHeaders
    const headersError = editingHeaders ? headersProblem(form.headers, m) : ''
    const tlsBlocked = form.baseUrl.trim() !== '' && !isHttps(form.baseUrl)
    // Nada acá depende de `formProbe`: guardar sin probar, o tras una prueba
    // fallida, es válido a propósito (ver el encabezado del archivo).
    const formReady = form.name.trim() !== '' && form.baseUrl.trim() !== '' && headersError === ''

    // Validación de IP/puerto del atajo (no bloquea por sí sola: la dirección
    // queda vacía mientras algo esté mal, y eso ya deshabilita guardar).
    const hostBad = activePreset?.hostPort === true && hostProblem(host)
    const portBad = activePreset?.hostPort === true && port !== '' && !validPort(port)
    // Guía de Ollama: con el atajo «otra máquina», o con cualquier Ollama que no
    // sea local. Usa el host y el puerto del formulario (o de la dirección).
    const fromUrl = hostPortOf(form.baseUrl)
    const guideShown = form.kind === 'ollama' && (preset === 'ollamaRemote' || (form.baseUrl.trim() !== '' && !isLoopbackUrl(form.baseUrl)))
    const guideHost = activePreset?.hostPort && !hostBad ? host : fromUrl.host
    const guidePortRaw = activePreset?.hostPort ? port : fromUrl.port
    const guidePort = validPort(guidePortRaw) ? String(Number(guidePortRaw)) : '11434'
    const guideExpanded = guideOpen ?? preset === 'ollamaRemote'
    const openGuide = () => {
        setGuideOpen(true)
        window.setTimeout(() => guideRef.current?.scrollIntoView({block: 'nearest', behavior: 'smooth'}), 0)
    }

    const probeError =
        formProbe?.state === 'error' ? formProbe.error : formProbe?.state === 'done' && !formProbe.probe.ok ? formProbe.probe.error : null
    const probeFailed = probeError !== null
    const showRemoteHint = probeFailed && form.kind === 'ollama' && !isLoopbackUrl(form.baseUrl) && looksUnreachable(probeError)

    return (
        <div className={bare ? 'flex flex-col gap-3' : 'flex flex-col gap-3 rounded-lg border border-primary/50 bg-surface-container-highest p-3'}>
            {!bare && (
                <p className="flex items-center gap-2 text-sm font-medium text-on-surface">
                    <Icon name={form.id ? 'edit' : 'add_circle'} size={16} className="text-primary" />
                    {form.id ? m.formTitleEdit({name: form.name || '…'}) : m.formTitleNew}
                </p>
            )}

            {isNew && (
                <div data-model-presets className="flex flex-col gap-1.5">
                    <div>
                        <p className="text-xs font-medium text-on-surface">{presetText.title}</p>
                        <p className="text-ui-11 text-on-surface-variant">{presetText.intro}</p>
                    </div>
                    <div role="radiogroup" aria-label={presetText.groupLabel} className="grid grid-cols-2 gap-1.5">
                        {PRESETS.map((pr) => {
                            const selected = preset === pr.key
                            return (
                                <button
                                    key={pr.key}
                                    type="button"
                                    role="radio"
                                    aria-checked={selected}
                                    data-model-preset={pr.key}
                                    onClick={() => applyPreset(pr.key)}
                                    title={presetText[`${pr.key}Title` as const]}
                                    className={`flex min-w-0 items-center gap-2 rounded-md border px-2 py-1.5 text-left ${
                                        selected
                                            ? 'border-primary bg-primary/10'
                                            : 'border-outline-variant bg-surface hover:border-primary/60 hover:bg-surface-variant'
                                    }`}
                                >
                                    <Icon name={pr.icon} size={16} className={selected ? 'shrink-0 text-primary' : 'shrink-0 text-on-surface-variant'} />
                                    <span className="min-w-0">
                                        <span className="block truncate text-xs font-medium text-on-surface">{presetText[pr.key]}</span>
                                        <span className="block truncate font-mono text-ui-10 text-on-surface-variant">{presetText[`${pr.key}Hint` as const]}</span>
                                    </span>
                                </button>
                            )
                        })}
                    </div>

                    {activePreset?.hostPort && (
                        <div data-preset-hostport className="grid grid-cols-[1fr_7rem] gap-3">
                            <label className="flex min-w-0 flex-col gap-1" title={presetText.hostTitle}>
                                <span className="text-xs font-medium text-on-surface">{presetText.hostLabel}</span>
                                <input
                                    data-preset-host
                                    value={host}
                                    onChange={(e) => changeHostPort(e.target.value, port)}
                                    placeholder={presetText.hostPlaceholder}
                                    title={presetText.hostTitle}
                                    spellCheck={false}
                                    autoCapitalize="off"
                                    autoComplete="off"
                                    aria-invalid={hostBad}
                                    className={`w-full rounded-md border bg-surface px-2 py-1 font-mono text-xs text-on-surface outline-none focus:border-primary ${
                                        hostBad ? 'border-error' : 'border-outline-variant'
                                    }`}
                                />
                            </label>
                            <label className="flex min-w-0 flex-col gap-1" title={presetText.portTitle}>
                                <span className="text-xs font-medium text-on-surface">{presetText.portLabel}</span>
                                <input
                                    data-preset-port
                                    value={port}
                                    onChange={(e) => changeHostPort(host, e.target.value.replace(/\D/g, '').slice(0, 5))}
                                    inputMode="numeric"
                                    placeholder={String(activePreset.defaultPort)}
                                    title={presetText.portTitle}
                                    aria-invalid={portBad}
                                    className={`w-full rounded-md border bg-surface px-2 py-1 font-mono text-xs text-on-surface outline-none focus:border-primary ${
                                        portBad ? 'border-error' : 'border-outline-variant'
                                    }`}
                                />
                            </label>
                            {(hostBad || portBad) && (
                                <p className="col-span-2 flex items-center gap-1 text-ui-11 text-error">
                                    <Icon name="error" size={12} className="shrink-0" />
                                    {hostBad ? presetText.hostError : presetText.portError}
                                </p>
                            )}
                        </div>
                    )}
                </div>
            )}

            <div className="grid grid-cols-[1fr_11rem] gap-3">
                <label className="flex min-w-0 flex-col gap-1" title={m.nameTitle}>
                    <span className="text-xs font-medium text-on-surface">{m.name}</span>
                    <input
                        value={form.name}
                        autoFocus={autoFocus}
                        onChange={(e) => {
                            setNameTouched(e.target.value !== '')
                            setForm({...form, name: e.target.value})
                        }}
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
                            if (preset) {
                                if (guideOpen === null) setGuideOpen(preset === 'ollamaRemote')
                                setPreset(null)
                            }
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
                    data-base-url
                    value={form.baseUrl}
                    onChange={(e) => changeUrl(e.target.value)}
                    placeholder={placeholderFor(form.kind)}
                    title={m.baseUrlTitle}
                    spellCheck={false}
                    autoCapitalize="off"
                    className="w-full rounded-md border border-outline-variant bg-surface px-2 py-1 font-mono text-xs text-on-surface outline-none focus:border-primary"
                />
                {activePreset?.hostPort && <span className="text-ui-10 text-on-surface-variant/80">{presetText.urlDerived}</span>}
            </label>

            {form.baseUrl.trim() !== '' && !isLoopbackUrl(form.baseUrl) && (
                <p className="flex items-start gap-1.5 rounded bg-tertiary/10 px-2 py-1.5 text-ui-11 text-on-surface-variant">
                    <Icon name="public" size={14} className="mt-px shrink-0 text-tertiary" />
                    {m.remoteWarning}
                </p>
            )}

            {guideShown && (
                <OllamaExposeGuide ref={guideRef} open={guideExpanded} onToggle={() => setGuideOpen(!guideExpanded)} port={guidePort} host={guideHost} />
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

            {probeFailed && (
                <p data-save-anyway-note className="flex items-start gap-1.5 text-ui-11 text-on-surface-variant">
                    <Icon name="info" size={14} className="mt-px shrink-0" />
                    {m.saveFailedNote}
                </p>
            )}

            {showRemoteHint && <RemoteOllamaHint onOpenGuide={openGuide} />}

            {error && <p className="rounded bg-error-container/40 px-2 py-1 text-ui-11 text-error">{error}</p>}

            {/* En el diálogo, que scrollea cuando el consejo alarga el formulario,
                los botones quedan pegados abajo: «Guardar igual» no puede
                esconderse justo cuando la prueba falló. */}
            <div
                className={`flex items-center justify-end gap-2 ${
                    bare ? 'sticky -bottom-5 -mx-5 -mb-5 border-t border-outline-variant bg-surface-container-high px-5 py-3' : ''
                }`}
            >
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
                    onClick={onCancel}
                    title={m.cancelTitle}
                    className="rounded px-3 py-1 text-xs text-on-surface-variant hover:text-on-surface"
                >
                    {m.cancel}
                </button>
                <button
                    type="button"
                    onClick={() => void save()}
                    disabled={!formReady || saving}
                    title={formReady ? (probeFailed ? m.saveAnywayTitle : m.saveTitle) : m.saveNeedsFields}
                    className={`rounded px-3 py-1 text-xs font-medium hover:opacity-90 disabled:opacity-40 ${
                        probeFailed ? 'border border-primary text-primary' : 'bg-primary text-on-primary'
                    }`}
                >
                    {probeFailed ? m.saveAnyway : m.save}
                </button>
            </div>
        </div>
    )
}

// Resultado de una prueba de conexión, en línea. La lista de modelos se
// recorta: un servidor con cuarenta modelos no tiene que empujar el resto de
// la pantalla, y el conteo ya dice cuántos hay.
export function ProbeResult({probe}: {probe: Exclude<Probe, {state: 'testing'}>}) {
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


// Aviso tras una prueba fallida contra un Ollama «remoto»: por defecto Ollama
// escucha solo en 127.0.0.1 de SU máquina, así que desde otra la conexión se
// rechaza aunque el servicio esté en marcha. Los pasos viven en la guía
// (`OllamaExposeGuide`); acá solo se la abre, para no decir lo mismo dos veces.
function RemoteOllamaHint({onOpenGuide}: {onOpenGuide: () => void}) {
    const t = useT()
    const m = t.settings.modelServers
    return (
        <div data-remote-ollama-hint className="flex flex-col gap-1.5 rounded-md border border-tertiary/40 bg-tertiary/10 px-2.5 py-2 text-ui-11 text-on-surface-variant">
            <p className="flex items-center gap-1.5 font-medium text-on-surface">
                <Icon name="lightbulb" size={14} className="shrink-0 text-tertiary" />
                {m.remoteHintTitle}
            </p>
            <p>{m.remoteHintBody}</p>
            <button
                type="button"
                data-remote-hint-guide
                onClick={onOpenGuide}
                title={m.remoteHintGuideTitle}
                className="flex items-center gap-1 self-start rounded px-2 py-0.5 text-xs text-primary hover:bg-primary/10"
            >
                <Icon name="menu_book" size={13} />
                {m.remoteHintGuide}
            </button>
        </div>
    )
}
