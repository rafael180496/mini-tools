import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {
    AgentHTTPChatContext,
    HttpActiveEnvironment,
    HttpAuthPreview,
    HttpBuildRequest,
    HttpCancel,
    HttpClearHistory,
    HttpDefaultSettings,
    HttpFormatBody,
    HttpImportCurl,
    HttpListCollections,
    HttpGetItem,
    HttpHistory,
    HttpListEnvironments,
    HttpPickFile,
    HttpResolvePreview,
    HttpSaveResponseExample,
    HttpSaveResponseToFile,
    HttpSaveItem,
    HttpSend,
    HttpSetActiveEnvironment,
} from '../../../wailsjs/go/main/App'
import {httpclient, vault} from '../../../wailsjs/go/models'
import type {LanguageId} from '../../codemirror/languageRegistry'
import type {EditorAppearance} from '../../codemirror/editorAppearance'
import type {Theme} from '../../hooks/useTheme'
import Icon from '../Icon'
import Select from '../Select'
import CodePane from './CodePane'
import KeyValueTable from './KeyValueTable'
import FormDataTable from './FormDataTable'
import AuthPanel from './AuthPanel'
import ComputedTable from './ComputedTable'
import CodeSnippetPanel from './CodeSnippetPanel'
import AiPanel, {AI_ACTIONS, type AiAction} from './AiPanel'
import {useAgentChat} from '../agent/AgentChatHost'
import type {ChatContextBlock} from '../agent/AgentChat'
import {HTTP_METHODS, humanSize, methodColor, parseComputed, parseRows, pathVarsFromURL, rich, serializeRows, statusColor, type HttpComputed} from './httpShared'
import {formatDateTime, useT} from '../../i18n'

// Una petición HTTP abierta: barra de método/URL arriba, editor abajo y
// panel de respuesta al pie.
//
// # Guardado
//
// Explícito, con Ctrl+S y con botón, y NO automático. En un editor de notas
// el autoguardado es correcto porque no hay nada que "probar"; acá el flujo
// real es tocar la URL, mandar, tocar otra vez, mandar — y persistir cada
// pulsación llenaría el vault de escrituras cifradas para estados que nadie
// quiso conservar. Se avisa con el punto de "sin guardar" en el título.
//
// # Enviar sin guardar
//
// Se puede mandar una petición con cambios sin guardar: lo que se envía es
// lo que está en pantalla, no lo último persistido. Al revés sería la
// trampa clásica —"lo cambié y sigue haciendo lo mismo"—, y probar antes de
// decidir si vale la pena guardar es exactamente para lo que sirve el módulo.

interface HttpRequestTabProps {
    // Ítem guardado que edita la pestaña, o null si es una **petición
    // rápida**: una que se manda sin guardarla en ninguna colección. Existe
    // porque la mitad del uso real de un cliente HTTP es de un solo tiro
    // —probar un endpoint que alguien pasó por chat, reproducir un error una
    // vez— y obligar a crear y nombrar una colección para eso convierte treinta
    // segundos de trabajo en una carpeta que nadie va a volver a abrir.
    itemId: string | null
    // Método y URL con los que nace una petición rápida abierta desde el
    // historial. Se consume al montar: después la pestaña es dueña de su
    // estado, y volver a aplicarlo pisaría lo que el usuario editó.
    seed?: {method: string; url: string}
    editorThemeId: string
    appTheme: Theme
    appearance: EditorAppearance
    // Avisa que el nombre o el método cambiaron, para que el árbol y el
    // título de la pestaña se actualicen.
    onChanged: () => void
    // Avisa que una petición rápida se guardó y ahora es un ítem de verdad,
    // para que la pestaña deje de ser rápida y pase a apuntar a él.
    onSaved?: (item: vault.HTTPItem) => void
    // Avisa que se mandó una petición, para que el panel de historial de la
    // barra lateral no quede viejo. Es su propio aviso y no `onChanged`
    // porque ese recarga el árbol entero de colecciones, y mandar una
    // petición no cambia ninguna.
    onSent?: () => void
    active: boolean
}

type EditorSection = 'params' | 'auth' | 'headers' | 'body' | 'scripts' | 'docs' | 'settings'
type ResponseSection = 'body' | 'headers' | 'history'

const RAW_LANGS: {id: string; label: string; lang: LanguageId}[] = [
    {id: 'json', label: 'JSON', lang: 'json'},
    {id: 'xml', label: 'XML', lang: 'xml'},
    {id: 'html', label: 'HTML', lang: 'html'},
    // El rótulo de «text» es texto de la interfaz: se resuelve al dibujar.
    {id: 'text', label: '', lang: 'plaintext'},
]

export default function HttpRequestTab({itemId, seed, editorThemeId, appTheme, appearance, onChanged, onSaved, onSent, active}: HttpRequestTabProps) {
    // Una petición rápida no tiene ítem, así que tampoco tiene colección de la
    // que heredar: ni variables, ni autenticación, ni carpeta. Lo que se ve en
    // pantalla es todo lo que se manda.
    const t = useT()
    const scratch = itemId === null
    const [item, setItem] = useState<vault.HTTPItem | null>(null)
    const [method, setMethod] = useState(seed?.method || 'GET')
    const [url, setUrl] = useState(seed?.url ?? '')
    const [params, setParams] = useState<httpclient.KeyValue[]>([])
    const [pathVars, setPathVars] = useState<httpclient.KeyValue[]>([])
    const [headers, setHeaders] = useState<httpclient.KeyValue[]>([])
    const [body, setBody] = useState<httpclient.Body>(new httpclient.Body({mode: 'none', raw: '', rawLang: 'json'}))
    // La autenticación de ESTA petición. "inherit" —el default— significa
    // que manda la carpeta o la colección; authPreview dice cuál ganó.
    const [auth, setAuth] = useState<httpclient.Auth>(new httpclient.Auth({type: 'inherit'}))
    // Scripts al estilo Postman. Se guardan y se exportan desde ya; que se
    // EJECUTEN depende de una decisión de tamaño de binario pendiente, y la
    // pestaña lo dice en vez de dejar creer que corren.
    const [preRequest, setPreRequest] = useState('')
    const [testScript, setTestScript] = useState('')
    // Variables calculadas: la firma declarativa que reemplaza a los scripts.
    const [computed, setComputed] = useState<HttpComputed[]>([])
    const [computedErrors, setComputedErrors] = useState<string[]>([])
    // Documentación de la petición, en Markdown. Es lo que viaja a la nota de
    // la colección al publicarla, y también donde queda el `description` de una
    // colección importada de Postman.
    const [docs, setDocs] = useState('')
    const [showCode, setShowCode] = useState(false)
    // Acción de IA abierta en el panel lateral, y si el menú está desplegado.
    const [aiAction, setAiAction] = useState<AiAction | null>(null)
    const [aiMenu, setAiMenu] = useState(false)
    const chat = useAgentChat()

    // Abre el chat con esta petición —y su respuesta, si ya la hay— adjunta.
    // El contexto lo arma Go con la misma redacción que los pedidos de una
    // tirada: lo que se ve en la ficha es exactamente lo que sale, sin
    // credenciales. `extra` suma lo que ya contestó un análisis.
    async function askInChat(extra: ChatContextBlock[] = []) {
        try {
            const text = await AgentHTTPChatContext(
                itemId ?? '',
                request,
                result?.response ?? new httpclient.Response({status: 0}),
                result?.error ?? '',
            )
            chat.open({
                attachments: [
                    {
                        label: result ? t.http.request.chatWithResponse : t.http.request.chatNoResponse,
                        text,
                        language: 'markdown',
                        icon: 'http',
                    },
                    ...extra,
                ],
            })
        } catch (err) {
            // Sin el contexto de la petición igual se abre con lo que haya:
            // perder también la respuesta del análisis sería peor.
            console.error(err)
            chat.open({attachments: extra})
        }
    }
    // Diálogo de "guardar en una colección" de una petición rápida: la lista
    // de colecciones, cuál se eligió y con qué nombre.
    const [saveTo, setSaveTo] = useState<{collections: vault.HTTPCollection[]; collectionId: string; name: string} | null>(null)
    const [authPreview, setAuthPreview] = useState<{type: string; executable: boolean; needsToken: boolean} | null>(null)
    const [settings, setSettings] = useState<httpclient.Settings | null>(null)

    // Aviso de que un pegado se convirtió en una petición entera. Dura unos
    // segundos: pegar un cURL y ver cambiar cinco campos de golpe necesita
    // una línea que diga qué pasó, pero no un cartel que haya que cerrar.
    const [pasteNote, setPasteNote] = useState('')
    const [dirty, setDirty] = useState(false)
    const [section, setSection] = useState<EditorSection>('params')
    const [respSection, setRespSection] = useState<ResponseSection>('body')
    const [pretty, setPretty] = useState(true)

    const [sending, setSending] = useState(false)
    const [result, setResult] = useState<{response: httpclient.Response | null; error: string; sentUrl: string} | null>(null)
    const [history, setHistory] = useState<vault.HTTPHistoryEntry[]>([])
    const [error, setError] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)

    // Entornos: la lista y cuál está activo. El activo es global (una
    // preferencia de sesión), así que cambiarlo desde una pestaña lo cambia
    // para todas — que es lo que se espera de "estoy trabajando contra dev".
    const [envs, setEnvs] = useState<vault.HTTPEnvironment[]>([])
    const [activeEnv, setActiveEnv] = useState('')
    // Variables que la petición usa y ningún nivel define. Se calcula del
    // lado de Go, que es el que conoce la cadena de precedencia.
    const [missing, setMissing] = useState<string[]>([])

    // Id de ejecución para poder cancelar. Se renueva por envío: cancelar el
    // anterior no puede matar al siguiente.
    const execRef = useRef(0)
    // Identificador propio de ESTA pestaña. Con el id del ítem alcanzaba
    // mientras toda petición estuviera guardada, pero dos peticiones rápidas
    // no tienen ítem: las dos generaban `http-rapida-1` y cancelar en una
    // cancelaba la de la otra.
    const tabRef = useRef(Math.random().toString(36).slice(2, 8))
    const [execId, setExecId] = useState('')

    // --- carga ---------------------------------------------------------------

    useEffect(() => {
        let alive = true
        void (async () => {
            try {
                if (itemId === null) {
                    // Los settings se piden igual: el valor de "verificar TLS"
                    // tiene una sola definición y vive en Go. Una petición
                    // rápida que arranque con la verificación apagada porque
                    // nadie le pasó settings sería justamente el error que
                    // DefaultSettings existe para evitar.
                    const defaults = await HttpDefaultSettings()
                    if (!alive) return
                    setSettings(defaults)
                    // "heredar" no significa nada sin colección: acá el
                    // desplegable arranca en "ninguna".
                    setAuth(new httpclient.Auth({type: 'none'}))
                    setDirty(false)
                    return
                }
                const it = await HttpGetItem(itemId)
                if (!alive || !it) return
                setItem(it)
                setMethod(it.method || 'GET')
                setUrl(it.url ?? '')
                setParams(parseRows(it.params))
                setHeaders(parseRows(it.headers))
                setPathVars(parseRows(it.pathVars))
                setBody(it.body ? new httpclient.Body(JSON.parse(it.body)) : new httpclient.Body({mode: 'none', raw: '', rawLang: 'json'}))
                setAuth(it.auth ? new httpclient.Auth(JSON.parse(it.auth)) : new httpclient.Auth({type: 'inherit'}))
                setDocs(it.docs ?? '')
                setPreRequest(it.preRequest ?? '')
                setTestScript(it.testScript ?? '')
                setComputed(parseComputed(it.computed))
                // Los settings salen del backend por HttpBuildRequest, que ya
                // rellena los defaults: así el valor de "verificar TLS" tiene
                // una sola definición y vive en Go.
                const built = await HttpBuildRequest(itemId)
                if (alive && built) setSettings(built.settings)
                setDirty(false)
            } catch (e) {
                if (alive) setError(String(e))
            }
        })()
        return () => {
            alive = false
        }
    }, [itemId])

    const reloadHistory = useCallback(async () => {
        try {
            // Con itemId null se lee el cajón compartido de las peticiones
            // rápidas, que es lo que hace que "¿qué acabo de mandar?" tenga
            // respuesta aunque no se haya guardado nada.
            setHistory((await HttpHistory(itemId ?? '')) ?? [])
        } catch {
            /* el historial es accesorio: su fallo no puede romper la pestaña */
        }
    }, [itemId])

    useEffect(() => {
        void reloadHistory()
    }, [reloadHistory])

    const reloadEnvs = useCallback(async () => {
        try {
            const [list, active] = await Promise.all([HttpListEnvironments(), HttpActiveEnvironment()])
            setEnvs(list ?? [])
            setActiveEnv(active ?? '')
        } catch {
            /* sin entornos se sigue trabajando: las {{llaves}} quedan sin resolver */
        }
    }, [])

    useEffect(() => {
        void reloadEnvs()
    }, [reloadEnvs])

    // Qué autenticación se va a usar de verdad. Con herencia, "qué credencial
    // estoy mandando" deja de ser obvio —la respuesta puede estar dos niveles
    // más arriba—, y mostrarla es la diferencia entre entender un 401 y
    // adivinarlo.
    useEffect(() => {
        void HttpAuthPreview(itemId ?? '', auth)
            .then((p) => setAuthPreview(p ? {type: p.type, executable: p.executable, needsToken: p.needsToken} : null))
            .catch(() => setAuthPreview(null))
    }, [itemId, auth, activeEnv])

    // Qué variables faltan, recalculado cuando cambia algo que participa.
    // Con un pequeño retardo: se dispara al tipear la URL y no vale una
    // llamada por tecla.
    useEffect(() => {
        if (!settings) return
        const timer = window.setTimeout(() => {
            void HttpResolvePreview(itemId ?? '', request)
                .then((r) => {
                    setMissing(r?.missing ?? [])
                    setComputedErrors(r?.computedErrors ?? [])
                })
                .catch(() => setMissing([]))
        }, 250)
        return () => window.clearTimeout(timer)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [itemId, url, params, pathVars, headers, body, activeEnv, settings])

    // Las variables de ruta se derivan de la URL y conservan lo ya escrito.
    useEffect(() => {
        setPathVars((prev) => {
            const next = pathVarsFromURL(url, prev)
            const same = next.length === prev.length && next.every((n, i) => prev[i]?.key === n.key && prev[i]?.value === n.value)
            return same ? prev : next
        })
    }, [url])

    function touch<T>(setter: (v: T) => void) {
        return (v: T) => {
            setter(v)
            setDirty(true)
        }
    }

    // Vuelca una petición que vino de afuera —un cURL pegado en la barra de
    // URL, o lo que devuelve el panel de IA— sobre los campos de la pestaña.
    // Una sola función para los dos caminos: cuando eran dos, agregar un campo
    // a la petición lo dejaba a medias en uno de ellos.
    function applyImported(req: httpclient.Request, note: string) {
        setMethod(req.method || 'GET')
        setUrl(req.url ?? '')
        setParams(req.params ?? [])
        setPathVars(req.pathVars ?? [])
        setHeaders(req.headers ?? [])
        setBody(new httpclient.Body(req.body ?? {mode: 'none'}))
        if (req.auth && req.auth.type && req.auth.type !== 'none') setAuth(new httpclient.Auth(req.auth))
        setDirty(true)
        setError(null)
        if (note) {
            setPasteNote(note)
            setTimeout(() => setPasteNote(''), 4000)
        }
    }

    // --- guardar -------------------------------------------------------------

    const openSaveDialog = useCallback(async () => {
        try {
            const cols = (await HttpListCollections()) ?? []
            setSaveTo({
                collections: cols,
                collectionId: cols[0]?.id ?? '',
                // Un nombre propuesto a partir de la URL: el último tramo de
                // la ruta es lo que uno reconocería en el árbol.
                name: nameFromURL(url) || t.http.request.defaultName,
            })
        } catch (e) {
            setError(String(e))
        }
    }, [url, t])

    // Lo que se persiste, igual para una petición guardada y para una rápida
    // que recién se está guardando.
    const payload = useCallback(
        (base: Partial<vault.HTTPItem>) =>
            new vault.HTTPItem({
                ...base,
                method,
                url,
                params: serializeRows(params),
                pathVars: serializeRows(pathVars),
                headers: serializeRows(headers),
                body: body.mode === 'none' && !body.raw ? '' : JSON.stringify(body),
                auth: auth.type === 'inherit' ? '' : JSON.stringify(auth),
                preRequest,
                testScript,
                docs,
                computed: computed.length === 0 ? '' : JSON.stringify(computed),
                settings: settings ? JSON.stringify(settings) : '',
            }),
        [method, url, params, pathVars, headers, body, auth, docs, preRequest, testScript, computed, settings],
    )

    // Guardar una petición rápida en una colección: deja de ser rápida y pasa
    // a ser un ítem con nombre, con su historial y su herencia.
    const saveInto = useCallback(
        async (collectionId: string, name: string) => {
            setSaving(true)
            setError(null)
            try {
                const created = await HttpSaveItem(payload({collectionId, kind: 'request', name}))
                if (created) {
                    setItem(created)
                    onSaved?.(created)
                }
                setDirty(false)
                setSaveTo(null)
                onChanged()
            } catch (e) {
                setError(String(e))
            } finally {
                setSaving(false)
            }
        },
        [payload, onSaved, onChanged],
    )

    const save = useCallback(async () => {
        if (!item) {
            // Una petición rápida no tiene dónde guardarse todavía: Ctrl+S
            // abre el diálogo que pregunta en qué colección.
            if (scratch) void openSaveDialog()
            return
        }
        setSaving(true)
        setError(null)
        try {
            const updated = await HttpSaveItem(payload(item))
            if (updated) setItem(updated)
            setDirty(false)
            onChanged()
        } catch (e) {
            setError(String(e))
        } finally {
            setSaving(false)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [item, scratch, payload, onChanged])

    // Ctrl/Cmd+S, solo mientras esta pestaña es la visible: sin esa guarda,
    // todas las pestañas montadas responderían al mismo atajo.
    useEffect(() => {
        if (!active) return
        function onKey(e: KeyboardEvent) {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                e.preventDefault()
                void save()
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [active, save])

    // --- enviar ---------------------------------------------------------------

    const request = useMemo(
        () =>
            new httpclient.Request({
                method,
                url,
                params,
                pathVars,
                headers,
                body,
                auth,
                settings: settings ?? undefined,
            }),
        [method, url, params, pathVars, headers, body, auth, settings],
    )

    async function send() {
        if (!url.trim()) {
            setError(t.http.request.urlRequired)
            return
        }
        const generation = ++execRef.current
        const id = `http-${itemId ?? 'rapida'}-${tabRef.current}-${generation}`
        setExecId(id)
        setSending(true)
        setError(null)
        setResult(null)
        try {
            const out = await HttpSend(id, itemId ?? '', request)
            // Guarda anti-zombi, el mismo patrón que la sugerencia en gris:
            // el botón se convierte en «Cancelar» mientras manda, pero Enter
            // en la URL no, así que dos Enter seguidos dejan dos envíos en el
            // aire. Sin esto gana el que conteste último —no el último que se
            // mandó— y la pantalla muestra la respuesta de la petición vieja.
            if (generation !== execRef.current) return
            setResult({response: out?.response ?? null, error: out?.error ?? '', sentUrl: out?.sentUrl ?? ''})
            setMissing(out?.missing ?? [])
            setComputedErrors(out?.computedErrors ?? [])
            setRespSection('body')
            void reloadHistory()
            onSent?.()
        } catch (e) {
            if (generation === execRef.current) setError(String(e))
        } finally {
            if (generation === execRef.current) {
                setSending(false)
                setExecId('')
            }
        }
    }

    async function formatBody() {
        if (body.mode !== 'raw' || !body.raw) return
        try {
            const out = await HttpFormatBody(body.rawLang ?? 'json', body.raw)
            if (out !== body.raw) {
                setBody(new httpclient.Body({...body, raw: out}))
                setDirty(true)
            }
        } catch (e) {
            setError(String(e))
        }
    }

    const responseLang: LanguageId = useMemo(() => {
        const lang = result?.response?.lang ?? 'text'
        return (RAW_LANGS.find((l) => l.id === lang)?.lang ?? 'plaintext') as LanguageId
    }, [result])

    const responseText = useMemo(() => {
        const resp = result?.response
        if (!resp) return ''
        if (resp.isBinary) return ''
        return resp.body
    }, [result])

    const [prettyText, setPrettyText] = useState('')
    useEffect(() => {
        const resp = result?.response
        if (!resp || resp.isBinary || !pretty) {
            setPrettyText('')
            return
        }
        let alive = true
        void HttpFormatBody(resp.lang, resp.body)
            .then((out) => {
                if (alive) setPrettyText(out)
            })
            .catch(() => {})
        return () => {
            alive = false
        }
    }, [result, pretty])

    if (!item && !scratch) {
        return <div className="flex flex-1 items-center justify-center text-ui-11 text-on-surface-variant">{t.http.request.loading}</div>
    }

    // Comparaciones que usa el JSX de abajo, con nombre: se leen mejor que
    // una cadena de `===` en cada bloque.
    const onSection = (id: EditorSection) => section === id
    const onResp = (id: ResponseSection) => respSection === id
    const bodyIs = (mode: string) => body.mode === mode
    const inheritsAuth = auth.type === 'inherit'

    const rawLang = (RAW_LANGS.find((l) => l.id === (body.rawLang ?? 'json'))?.lang ?? 'plaintext') as LanguageId
    const canFormat = body.mode === 'raw' && (body.rawLang === 'json' || body.rawLang === 'xml')

    return (
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-surface">
            {/* Barra de método + URL + enviar */}
            <div className="flex shrink-0 items-center gap-1.5 border-b border-outline-variant px-2 py-1.5">
                {/* El selector temado de la app y no un <select> nativo: el
                    nativo abre el menú del sistema operativo, que ignora el
                    tema, la tipografía y el tamaño de letra elegidos —una caja
                    blanca en una app oscura— y encima no puede pintar cada
                    método de su color, que es justamente cómo se leen acá, en
                    el árbol y en el historial. */}
                <Select
                    value={method}
                    options={HTTP_METHODS.map((m) => ({value: m, label: m, tone: `${methodColor(m)} font-semibold`}))}
                    onChange={(v) => touch(setMethod)(v)}
                    size="sm"
                    ariaLabel={t.http.request.methodAria}
                    title={t.http.request.methodTitle}
                    className="w-28 shrink-0 font-mono"
                />

                <input
                    value={url}
                    onChange={(e) => touch(setUrl)(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') void send()
                    }}
                    onPaste={(e) => {
                        // Pegar un «Copy as cURL» en la barra de URL importa
                        // el comando entero en vez de dejar cien caracteres de
                        // shell adentro de un campo de URL, que es lo único
                        // que podía pasar antes. El resto de los pegados
                        // siguen siendo texto: solo se intercepta lo que
                        // empieza con `curl`.
                        const text = e.clipboardData.getData('text')
                        if (!/^\s*\$?\s*curl[\s\n]/i.test(text)) return
                        e.preventDefault()
                        void HttpImportCurl(text)
                            .then((req) => req && applyImported(req, t.http.request.curlImported))
                            .catch((err) => setError(String(err)))
                    }}
                    placeholder={t.http.request.urlPlaceholder}
                    title={t.http.request.urlTitle}
                    className="min-w-0 flex-1 rounded bg-surface-container px-2 py-1 font-mono text-ui-11 text-on-surface outline-none focus:ring-1 focus:ring-primary"
                />

                {sending ? (
                    <button
                        onClick={() => void HttpCancel(execId)}
                        title={t.http.request.cancelTitle}
                        className="shrink-0 rounded bg-error px-3 py-1 text-ui-11 text-on-error hover:opacity-90"
                    >
                        {t.common.cancel}
                    </button>
                ) : (
                    <button
                        onClick={() => void send()}
                        // Sin settings cargados no se manda: son los que dicen
                        // si hay que verificar el certificado del servidor, y
                        // mandar antes de saberlo dejaba esa decisión en manos
                        // del valor por defecto de un booleano.
                        disabled={!settings}
                        title={settings ? t.http.request.sendTitle : t.http.request.waitingSettings}
                        data-http-send
                        className="shrink-0 rounded bg-primary px-3 py-1 text-ui-11 font-medium text-on-primary hover:opacity-90 disabled:opacity-40"
                    >
                        {t.http.request.send}
                    </button>
                )}

                <Select
                    value={activeEnv}
                    options={[
                        // "Sin entorno" no es un entorno más: es no usar
                        // ninguno, y por eso va separado de la lista real.
                        {value: '', label: t.http.request.noEnv, separatorAfter: envs.length > 0},
                        ...envs.map((e) => ({value: e.id, label: e.name, icon: <Icon name="lan" size={14} />})),
                    ]}
                    onChange={(id) => {
                        setActiveEnv(id)
                        void HttpSetActiveEnvironment(id).catch(() => {})
                    }}
                    size="sm"
                    ariaLabel={t.http.request.envAria}
                    title={t.http.request.envTitle}
                    className="w-36 shrink-0"
                />

                <div className="relative shrink-0">
                    <button
                        onClick={() => setAiMenu((v) => !v)}
                        title={t.http.request.aiTitle}
                        className={`rounded p-1 hover:bg-surface-variant ${aiMenu || aiAction ? 'text-primary' : 'text-on-surface-variant hover:text-on-surface'}`}
                    >
                        <Icon name="auto_awesome" size={16} />
                    </button>
                    {aiMenu && (
                        <>
                            <div className="fixed inset-0 z-40" onClick={() => setAiMenu(false)} />
                            <div className="absolute right-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-lg border border-outline-variant bg-surface-container shadow-xl">
                                {chat.isAvailable && chat.hasAgent && (
                                    <button
                                        onClick={() => {
                                            setAiMenu(false)
                                            void askInChat()
                                        }}
                                        className="flex w-full items-start gap-2 border-b border-outline-variant px-3 py-2 text-left hover:bg-surface-variant"
                                    >
                                        <Icon name="forum" size={14} className="mt-0.5 text-primary" />
                                        <span className="min-w-0 flex-1">
                                            <span className="block text-ui-11 font-medium text-on-surface">{t.http.request.askChat}</span>
                                            <span className="block text-ui-10 leading-relaxed text-on-surface-variant/70">
                                                {t.http.request.askChatHint}
                                            </span>
                                        </span>
                                    </button>
                                )}
                                {AI_ACTIONS.map((a) => {
                                    // Sin respuesta todavía no hay nada que explicar ni que
                                    // diagnosticar: se deshabilita y se dice por qué, en vez de
                                    // dejar que el agente conteste sobre la nada.
                                    const blocked = a.needsResponse && !result
                                    const text = t.http.ai.actions[a.id]
                                    return (
                                        <button
                                            key={a.id}
                                            onClick={() => {
                                                setAiMenu(false)
                                                setAiAction(a.id)
                                            }}
                                            disabled={blocked}
                                            title={blocked ? t.http.request.needsResponse : text.hint}
                                            className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-surface-variant disabled:opacity-40 disabled:hover:bg-transparent"
                                        >
                                            <Icon name={a.icon} size={14} className="mt-0.5 text-on-surface-variant" />
                                            <span className="min-w-0 flex-1">
                                                <span className="block text-ui-11 text-on-surface">{text.label}</span>
                                                <span className="block text-ui-10 leading-relaxed text-on-surface-variant/70">{text.hint}</span>
                                            </span>
                                        </button>
                                    )
                                })}
                            </div>
                        </>
                    )}
                </div>

                <button
                    onClick={() => setShowCode(true)}
                    title={t.http.request.codeTitle}
                    className="shrink-0 rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="code" size={16} />
                </button>

                <button
                    onClick={() => void (scratch && !item ? openSaveDialog() : save())}
                    disabled={saving || (!scratch && !dirty)}
                    title={scratch && !item ? t.http.request.saveScratchTitle : dirty ? t.http.request.saveTitle : t.http.request.noChanges}
                    className="shrink-0 rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-30"
                >
                    <Icon name={scratch && !item ? 'bookmark_add' : 'save'} size={16} />
                </button>
            </div>

            {scratch && !item && (
                <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant bg-surface-container-lowest px-2 py-1 text-ui-11 text-on-surface-variant">
                    <Icon name="bolt" size={14} className="text-tertiary" />
                    <span className="flex-1 leading-relaxed">
                        {t.http.request.scratchNote}
                    </span>
                    <button
                        onClick={() => void openSaveDialog()}
                        title={t.http.request.saveIntoTitle}
                        className="shrink-0 rounded border border-outline-variant px-2 py-0.5 hover:bg-surface-variant"
                    >
                        {t.http.request.saveInto}
                    </button>
                </div>
            )}

            {saveTo && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={() => setSaveTo(null)}>
                    <div
                        className="w-96 max-w-full rounded-lg border border-outline-variant bg-surface-container p-4 shadow-xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <p className="mb-3 text-sm font-medium text-on-surface">{t.http.request.saveDialogTitle}</p>
                        {saveTo.collections.length === 0 ? (
                            <p className="text-ui-11 leading-relaxed text-on-surface-variant">
                                {t.http.request.noCollections}
                            </p>
                        ) : (
                            <>
                                <label className="mb-1 block text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">{t.http.request.collection}</label>
                                <Select
                                    value={saveTo.collectionId}
                                    options={saveTo.collections.map((c) => ({value: c.id, label: c.name, icon: <Icon name="folder" size={14} />}))}
                                    onChange={(v) => setSaveTo({...saveTo, collectionId: v})}
                                    size="sm"
                                    ariaLabel={t.http.request.collectionAria}
                                    title={t.http.request.collectionTitle}
                                    className="mb-3 w-full"
                                />
                                <label className="mb-1 block text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">{t.http.request.name}</label>
                                <input
                                    autoFocus
                                    value={saveTo.name}
                                    onChange={(e) => setSaveTo({...saveTo, name: e.target.value})}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && saveTo.name.trim()) void saveInto(saveTo.collectionId, saveTo.name.trim())
                                    }}
                                    className="w-full rounded border border-outline-variant bg-surface-container-lowest px-2 py-1 text-ui-11 text-on-surface outline-none"
                                />
                            </>
                        )}
                        <div className="mt-4 flex justify-end gap-2">
                            <button onClick={() => setSaveTo(null)} className="rounded px-3 py-1 text-xs text-on-surface-variant hover:bg-surface-variant">
                                {t.common.cancel}
                            </button>
                            <button
                                onClick={() => void saveInto(saveTo.collectionId, saveTo.name.trim())}
                                disabled={saving || !saveTo.collectionId || !saveTo.name.trim()}
                                className="rounded bg-primary px-3 py-1 text-xs text-on-primary hover:opacity-90 disabled:opacity-40"
                            >
                                {t.common.save}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {authPreview && !authPreview.executable && (
                <div
                    className="flex shrink-0 items-start gap-2 border-b border-outline-variant px-2 py-1 text-ui-11 text-tertiary"
                    title={t.http.request.authNotSignedTitle}
                >
                    <Icon name="warning" size={14} className="mt-0.5 shrink-0" />
                    <span>{rich(t.http.request.authNotSigned({type: authPreview.type}))}</span>
                </div>
            )}

            {showCode && (
                <CodeSnippetPanel
                    itemId={itemId ?? ''}
                    request={request}
                    editorThemeId={editorThemeId}
                    appTheme={appTheme}
                    appearance={appearance}
                    onClose={() => setShowCode(false)}
                />
            )}

            {computedErrors.length > 0 && (
                <div
                    className="flex shrink-0 items-start gap-2 border-b border-outline-variant bg-error-container px-2 py-1 text-ui-11 text-on-error-container"
                    title={t.http.request.computedErrorsTitle}
                >
                    <Icon name="functions" size={14} className="mt-0.5 shrink-0" />
                    <span className="min-w-0 flex-1 break-words">{computedErrors.join(' · ')}</span>
                </div>
            )}

            {missing.length > 0 && (
                <div
                    className="flex shrink-0 items-start gap-2 border-b border-outline-variant px-2 py-1 text-ui-11 text-tertiary"
                    title={t.http.request.missingTitle}
                >
                    <Icon name="warning" size={14} className="mt-0.5 shrink-0" />
                    <span className="min-w-0 flex-1 break-words">
                        {rich(t.http.request.missing({list: missing.map((m) => `{{${m}}}`).join('  ')}))}
                    </span>
                </div>
            )}

            {pasteNote && (
                <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant bg-surface-container px-2 py-1 text-ui-10 text-on-surface-variant">
                    <Icon name="content_paste" size={13} className="shrink-0 text-secondary" />
                    <span className="min-w-0 flex-1 break-words">{pasteNote}</span>
                </div>
            )}

            {error && (
                <div className="flex shrink-0 items-start gap-2 border-b border-outline-variant bg-error-container px-2 py-1 text-ui-11 text-on-error-container">
                    <Icon name="error" size={14} className="mt-0.5 shrink-0" />
                    <span className="min-w-0 flex-1 break-words">{error}</span>
                    <button onClick={() => setError(null)} title={t.http.request.dismissError} className="shrink-0 rounded p-0.5 hover:bg-error/20">
                        <Icon name="close" size={12} />
                    </button>
                </div>
            )}

            {/* Editor de la petición */}
            <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex shrink-0 items-center gap-0.5 border-b border-outline-variant px-2">
                    {(
                        [
                            ['params', t.http.request.tabs.params, params.filter((p) => p.enabled && p.key).length + pathVars.length],
                            ['auth', t.http.request.tabs.auth, authPreview && authPreview.type !== 'none' ? 1 : 0],
                            ['headers', t.http.request.tabs.headers, headers.filter((h) => h.enabled && h.key).length],
                            ['body', t.http.request.tabs.body, bodyCount(body)],
                            ['scripts', t.http.request.tabs.scripts, computed.filter((c) => c.enabled && c.name).length + (preRequest ? 1 : 0) + (testScript ? 1 : 0)],
                            ['docs', t.http.request.tabs.docs, docs.trim() ? 1 : 0],
                            ['settings', t.http.request.tabs.settings, 0],
                        ] as [EditorSection, string, number][]
                    ).map(([id, label, count]) => (
                        <button
                            key={id}
                            onClick={() => setSection(id)}
                            title={t.http.request.viewSection({label})}
                            data-http-section={id}
                            className={`relative px-2.5 py-1.5 text-ui-11 ${
                                section === id ? 'text-on-surface' : 'text-on-surface-variant hover:text-on-surface'
                            }`}
                        >
                            {label}
                            {count > 0 && <span className="ml-1 font-mono text-ui-9 tabular-nums opacity-60">{count}</span>}
                            {section === id && <span className="absolute inset-x-1 -bottom-px h-0.5 rounded bg-primary" />}
                        </button>
                    ))}
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto">
                    {onSection('params') && (
                        <>
                            <p className="px-2 pt-2 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">{t.http.request.queryParams}</p>
                            <KeyValueTable rows={params} onChange={touch(setParams)} />
                            <p className="px-2 pt-3 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">{t.http.request.pathVariables}</p>
                            <KeyValueTable
                                rows={pathVars}
                                onChange={touch(setPathVars)}
                                lockKeys
                                emptyHint={t.http.request.pathVarsEmpty}
                            />
                        </>
                    )}

                    {onSection('auth') && (
                        <>
                            {authPreview && inheritsAuth && (
                                <p className="px-3 pt-2 text-ui-10 leading-relaxed text-on-surface-variant/70">
                                    {authPreview.type === 'none'
                                        ? t.http.request.authNone
                                        : t.http.request.authInherited({type: authPreview.type, executable: authPreview.executable})}
                                </p>
                            )}
                            <AuthPanel
                                auth={auth}
                                onChange={touch(setAuth)}
                                onTokenObtained={(updated) => {
                                    // Un token recién obtenido se guarda solo: si no,
                                    // se pierde al cerrar la pestaña y hay que volver
                                    // a pasar por el navegador.
                                    setAuth(updated)
                                    setDirty(true)
                                }}
                            />
                        </>
                    )}

                    {onSection('headers') && <KeyValueTable rows={headers} onChange={touch(setHeaders)} />}

                    {onSection('body') && (
                        <div className="flex h-full min-h-0 flex-col">
                            <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-2 py-1.5">
                                {BODY_MODES.map((m) => (
                                    <label key={m.id} className="flex items-center gap-1 text-ui-11 text-on-surface-variant" title={t.http.request.bodyModes[m.id]}>
                                        <input
                                            type="radio"
                                            checked={body.mode === m.id}
                                            onChange={() => touch(setBody)(new httpclient.Body({...body, mode: m.id}))}
                                            className="accent-primary"
                                        />
                                        {m.name}
                                    </label>
                                ))}
                                {/* form-data, x-www-form-urlencoded, binary y GraphQL entran
                                    en la fase 3 del plan; no se muestran como opciones
                                    apagadas porque una opción que no hace nada es peor que
                                    una que todavía no está. */}
                                {bodyIs('raw') && (
                                    <>
                                        <Select
                                            value={body.rawLang ?? 'json'}
                                            options={RAW_LANGS.map((l) => ({value: l.id, label: l.id === 'text' ? t.http.request.text : l.label}))}
                                            onChange={(v) => touch(setBody)(new httpclient.Body({...body, rawLang: v}))}
                                            size="sm"
                                            variant="ghost"
                                            ariaLabel={t.http.request.bodyFormatAria}
                                            title={t.http.request.bodyFormatTitle}
                                            className="w-24"
                                        />
                                        <button
                                            onClick={() => void formatBody()}
                                            disabled={!canFormat || !body.raw}
                                            title={canFormat ? t.http.request.formatTitle : t.http.request.formatOnlyJsonXml}
                                            className="rounded px-1.5 py-0.5 text-ui-11 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-30"
                                        >
                                            {t.http.request.format}
                                        </button>
                                    </>
                                )}
                            </div>
                            {bodyIs('raw') && (
                                <div className="min-h-0 flex-1 border-t border-outline-variant">
                                    <CodePane
                                        value={body.raw ?? ''}
                                        onChange={(v) => touch(setBody)(new httpclient.Body({...body, raw: v}))}
                                        language={rawLang}
                                        editorThemeId={editorThemeId}
                                        appTheme={appTheme}
                                        appearance={appearance}
                                        placeholder={t.http.request.rawPlaceholder}
                                    />
                                </div>
                            )}

                            {bodyIs('formdata') && (
                                <div className="min-h-0 flex-1 overflow-y-auto border-t border-outline-variant">
                                    <FormDataTable
                                        rows={body.formData ?? []}
                                        onChange={(rows) => touch(setBody)(new httpclient.Body({...body, formData: rows}))}
                                    />
                                    <p className="px-2 py-2 text-ui-10 leading-relaxed text-on-surface-variant/70">
                                        {rich(t.http.request.formDataNote)}
                                    </p>
                                </div>
                            )}

                            {bodyIs('urlencoded') && (
                                <div className="min-h-0 flex-1 overflow-y-auto border-t border-outline-variant">
                                    <KeyValueTable
                                        rows={body.urlEncoded ?? []}
                                        onChange={(rows) => touch(setBody)(new httpclient.Body({...body, urlEncoded: rows}))}
                                    />
                                </div>
                            )}

                            {bodyIs('binary') && (
                                <div className="min-h-0 flex-1 border-t border-outline-variant p-3">
                                    <button
                                        onClick={() =>
                                            void HttpPickFile(t.http.request.pickBodyFileDialog)
                                                .then((path) => {
                                                    if (path) touch(setBody)(new httpclient.Body({...body, binaryPath: path}))
                                                })
                                                .catch(() => {})
                                        }
                                        title={t.http.request.binaryTitle}
                                        className="flex items-center gap-1.5 rounded bg-surface-container px-2 py-1 text-ui-11 text-on-surface hover:bg-surface-variant"
                                    >
                                        <Icon name="attach_file" size={13} />
                                        {body.binaryPath ? fileBaseName(body.binaryPath) : t.http.request.pickFile}
                                    </button>
                                    {body.binaryPath && <p className="mt-2 break-all font-mono text-ui-10 text-on-surface-variant/60">{body.binaryPath}</p>}
                                </div>
                            )}

                            {bodyIs('graphql') && (
                                <div className="flex min-h-0 flex-1 flex-col border-t border-outline-variant">
                                    <p className="shrink-0 px-2 pt-1 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">{t.http.request.graphqlQuery}</p>
                                    <div className="min-h-0 flex-1">
                                        <CodePane
                                            value={body.graphqlQuery ?? ''}
                                            onChange={(v) => touch(setBody)(new httpclient.Body({...body, graphqlQuery: v}))}
                                            language="plaintext"
                                            editorThemeId={editorThemeId}
                                            appTheme={appTheme}
                                            appearance={appearance}
                                            placeholder={t.http.request.graphqlQueryPlaceholder}
                                        />
                                    </div>
                                    <p className="shrink-0 border-t border-outline-variant px-2 pt-1 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">
                                        {t.http.request.graphqlVariables}
                                    </p>
                                    <div className="h-24 shrink-0">
                                        <CodePane
                                            value={body.graphqlVariables ?? ''}
                                            onChange={(v) => touch(setBody)(new httpclient.Body({...body, graphqlVariables: v}))}
                                            language="json"
                                            editorThemeId={editorThemeId}
                                            appTheme={appTheme}
                                            appearance={appearance}
                                            placeholder={t.http.request.graphqlVariablesPlaceholder}
                                        />
                                    </div>
                                </div>
                            )}

                            {bodyIs('none') && (
                                <p className="px-3 py-4 text-ui-11 text-on-surface-variant/70">{t.http.request.noBody}</p>
                            )}
                        </div>
                    )}

                    {onSection('scripts') && (
                        <div className="flex h-full min-h-0 flex-col">
                            <p className="shrink-0 px-2 pt-2 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">
                                {t.http.request.computedTitle}
                            </p>
                            <div className="shrink-0">
                                <ComputedTable rows={computed} onChange={touch(setComputed)} problems={computedErrors} />
                            </div>

                            <p className="shrink-0 border-t border-outline-variant bg-surface-container-lowest px-3 py-2 text-ui-10 leading-relaxed text-tertiary">
                                {rich(t.http.request.scriptsNote)}
                            </p>
                            <p className="shrink-0 px-2 pt-1 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">
                                {t.http.request.preRequest}
                            </p>
                            <div className="min-h-0 flex-1">
                                <CodePane
                                    value={preRequest}
                                    onChange={(v) => touch(setPreRequest)(v)}
                                    language="javascript"
                                    editorThemeId={editorThemeId}
                                    appTheme={appTheme}
                                    appearance={appearance}
                                    placeholder={t.http.request.preRequestPlaceholder}
                                />
                            </div>
                            <p className="shrink-0 border-t border-outline-variant px-2 pt-1 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">
                                {t.http.request.tests}
                            </p>
                            <div className="h-32 shrink-0">
                                <CodePane
                                    value={testScript}
                                    onChange={(v) => touch(setTestScript)(v)}
                                    language="javascript"
                                    editorThemeId={editorThemeId}
                                    appTheme={appTheme}
                                    appearance={appearance}
                                    placeholder={t.http.request.testsPlaceholder}
                                />
                            </div>
                        </div>
                    )}

                    {onSection('docs') && (
                        <div className="flex h-full min-h-0 flex-col">
                            <p className="shrink-0 px-3 pt-2 text-ui-10 leading-relaxed text-on-surface-variant/70">
                                {rich(t.http.request.docsNote)}
                            </p>
                            <textarea
                                value={docs}
                                onChange={(e) => {
                                    setDocs(e.target.value)
                                    setDirty(true)
                                }}
                                placeholder={t.http.request.docsPlaceholder}
                                spellCheck={false}
                                className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-ui-11 leading-relaxed text-on-surface outline-none placeholder:text-on-surface-variant/40"
                            />
                        </div>
                    )}

                    {onSection('settings') && settings && (
                        <div className="divide-y divide-outline-variant/50 px-2 text-ui-11">
                            <SettingRow
                                label={t.http.request.settings.verifyTls}
                                hint={t.http.request.settings.verifyTlsHint}
                                checked={settings.verifyTls}
                                onChange={(v) => touch(setSettings)(new httpclient.Settings({...settings, verifyTls: v}))}
                                danger={!settings.verifyTls}
                            />
                            <SettingRow
                                label={t.http.request.settings.followRedirects}
                                hint={t.http.request.settings.followRedirectsHint}
                                checked={settings.followRedirects}
                                onChange={(v) => touch(setSettings)(new httpclient.Settings({...settings, followRedirects: v}))}
                            />
                            <SettingRow
                                label={t.http.request.settings.keepMethod}
                                hint={t.http.request.settings.keepMethodHint}
                                checked={settings.keepMethodOnRedirect}
                                onChange={(v) => touch(setSettings)(new httpclient.Settings({...settings, keepMethodOnRedirect: v}))}
                                disabled={!settings.followRedirects}
                            />
                            <SettingRow
                                label={t.http.request.settings.keepAuth}
                                hint={t.http.request.settings.keepAuthHint}
                                checked={settings.keepAuthOnRedirect}
                                onChange={(v) => touch(setSettings)(new httpclient.Settings({...settings, keepAuthOnRedirect: v}))}
                                disabled={!settings.followRedirects}
                                danger={settings.keepAuthOnRedirect}
                            />
                            <SettingRow
                                label={t.http.request.settings.removeReferer}
                                hint={t.http.request.settings.removeRefererHint}
                                checked={settings.removeRefererOnRedirect}
                                onChange={(v) => touch(setSettings)(new httpclient.Settings({...settings, removeRefererOnRedirect: v}))}
                                disabled={!settings.followRedirects}
                            />
                            <div className="flex items-center gap-3 py-2">
                                <div className="min-w-0 flex-1">
                                    <p className="text-on-surface">{t.http.request.settings.httpVersion}</p>
                                    <p className="text-ui-10 leading-relaxed text-on-surface-variant/70">
                                        {t.http.request.settings.httpVersionHint}
                                    </p>
                                </div>
                                <Select
                                    value={settings.httpVersion}
                                    options={[
                                        {value: 'auto', label: t.http.request.settings.auto},
                                        ...['1.1', '2'].map((v) => ({value: v, label: `HTTP/${v}`})),
                                    ]}
                                    onChange={(v) => touch(setSettings)(new httpclient.Settings({...settings, httpVersion: v}))}
                                    size="sm"
                                    ariaLabel={t.http.request.settings.httpVersion}
                                    title={t.http.request.settings.httpVersionTitle}
                                    className="w-32 shrink-0"
                                />
                            </div>
                            <div className="flex items-center gap-3 py-2">
                                <div className="min-w-0 flex-1">
                                    <p className="text-on-surface">{t.http.request.settings.timeout}</p>
                                    <p className="text-ui-10 leading-relaxed text-on-surface-variant/70">
                                        {t.http.request.settings.timeoutHint}
                                    </p>
                                </div>
                                <input
                                    type="number"
                                    min={1}
                                    value={Math.round(settings.timeoutMs / 1000)}
                                    onChange={(e) =>
                                        touch(setSettings)(new httpclient.Settings({...settings, timeoutMs: Math.max(1, Number(e.target.value) || 1) * 1000}))
                                    }
                                    title={t.http.request.settings.timeoutTitle}
                                    className="w-20 shrink-0 rounded bg-surface-container px-1.5 py-0.5 text-right font-mono text-ui-11 text-on-surface outline-none focus:ring-1 focus:ring-primary"
                                />
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Respuesta */}
            <div className="flex min-h-0 shrink-0 flex-col border-t border-outline-variant" style={{height: '45%'}}>
                <div className="flex shrink-0 flex-wrap items-center gap-2 px-2 py-1">
                    <span className="text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">{t.http.request.response}</span>
                    {result?.response && (
                        <>
                            <span className={`font-mono text-ui-11 font-semibold ${statusColor(result.response.status)}`}>
                                {result.response.status} {result.response.statusText}
                            </span>
                            <span className="font-mono text-ui-11 text-on-surface-variant">{t.http.request.ms(result.response.durationMs)}</span>
                            <span className="font-mono text-ui-11 text-on-surface-variant">{humanSize(result.response.sizeBytes)}</span>
                            {result.response.redirects > 0 && (
                                <span
                                    className="text-ui-10 text-tertiary"
                                    title={t.http.request.redirectsTitle({n: result.response.redirects, url: result.response.finalUrl})}
                                >
                                    {t.http.request.redirects(result.response.redirects)}
                                </span>
                            )}
                            {result.response.truncated && (
                                <span
                                    className="text-ui-10 text-tertiary"
                                    title={t.http.request.truncatedTitle}
                                >
                                    {t.http.request.truncated}
                                </span>
                            )}
                        </>
                    )}
                    {sending && <span className="text-ui-11 text-on-surface-variant">{t.http.request.sending}</span>}

                    <div className="ml-auto flex items-center gap-0.5">
                        {(
                            [
                                ['body', t.http.request.respTabs.body],
                                ['headers', t.http.request.respTabs.headers],
                                ['history', t.http.request.respTabs.history],
                            ] as [ResponseSection, string][]
                        ).map(([id, label]) => (
                            <button
                                key={id}
                                onClick={() => setRespSection(id)}
                                title={id === 'history' ? t.http.request.historyTitle : t.http.request.viewResponse({label: label.toLowerCase()})}
                                className={`rounded px-2 py-0.5 text-ui-11 ${
                                    respSection === id ? 'bg-surface-variant text-on-surface' : 'text-on-surface-variant hover:text-on-surface'
                                }`}
                            >
                                {label}
                            </button>
                        ))}
                        {onResp('body') && result?.response && (
                            <button
                                onClick={() =>
                                    void HttpSaveResponseToFile(
                                        result.response?.spillPath ?? '',
                                        result.response?.bodyBase64 ?? '',
                                        result.response?.body ?? '',
                                        result.response?.filename ?? '',
                                    ).catch((e) => setError(String(e)))
                                }
                                title={result.response.truncated ? t.http.request.saveFullTitle : t.http.request.saveBodyTitle}
                                className="rounded px-2 py-0.5 text-ui-11 text-on-surface-variant hover:text-on-surface"
                            >
                                {t.http.request.saveFile}
                            </button>
                        )}
                        {onResp('body') && result?.response && item && (
                            <button
                                onClick={() =>
                                    void HttpSaveResponseExample(item.id, request, result.response as httpclient.Response)
                                        .then(async () => {
                                            // La documentación se reescribió del
                                            // lado de Go: hay que releerla, o el
                                            // próximo guardado desde acá pisaría
                                            // el ejemplo con lo que había antes.
                                            const fresh = await HttpGetItem(item.id)
                                            if (fresh) {
                                                setItem(fresh)
                                                setDocs(fresh.docs ?? '')
                                                setSection('docs')
                                            }
                                        })
                                        .catch((e) => setError(String(e)))
                                }
                                title={t.http.request.saveExampleTitle}
                                className="rounded px-2 py-0.5 text-ui-11 text-on-surface-variant hover:text-on-surface"
                            >
                                {t.http.request.saveExample}
                            </button>
                        )}
                        {onResp('body') && result?.response && !result.response.isBinary && (
                            <button
                                onClick={() => setPretty((v) => !v)}
                                title={pretty ? t.http.request.rawTitle : t.http.request.prettyTitle}
                                className="rounded px-2 py-0.5 text-ui-11 text-on-surface-variant hover:text-on-surface"
                            >
                                {pretty ? t.http.request.raw : t.http.request.pretty}
                            </button>
                        )}
                    </div>
                </div>

                {result?.sentUrl && (
                    <p className="shrink-0 truncate px-2 pb-1 font-mono text-ui-10 text-on-surface-variant/60" title={result.sentUrl}>
                        {result.sentUrl}
                    </p>
                )}

                <div className="min-h-0 flex-1 overflow-auto border-t border-outline-variant">
                    {!result && !sending && (
                        <p className="px-3 py-6 text-center text-ui-11 text-on-surface-variant/60">
                            {t.http.request.notSent}
                        </p>
                    )}

                    {result?.error && (
                        <div className="px-3 py-3 text-ui-11 leading-relaxed text-error">
                            <p className="font-medium">{t.http.request.failed}</p>
                            <p className="mt-1 break-words text-on-surface-variant">{result.error}</p>
                        </div>
                    )}

                    {onResp('body') && result?.response && (
                        result.response.isBinary ? (
                            <div className="px-3 py-3">
                                <p className="text-ui-11 leading-relaxed text-on-surface-variant">
                                    {t.http.request.binary({type: result.response.contentType || t.http.request.unknownType, size: humanSize(result.response.sizeBytes)})}
                                </p>
                                {/* Vista previa solo de imágenes: es el único tipo que el
                                    webview dibuja desde base64 sin ayuda, y prometer una
                                    previsualización de PDF que a veces no aparece sería
                                    peor que no ofrecerla. */}
                                {result.response.contentType.startsWith('image/') && result.response.bodyBase64 && (
                                    <img
                                        src={`data:${result.response.contentType};base64,${result.response.bodyBase64}`}
                                        alt={t.http.request.previewAlt}
                                        className="mt-2 max-h-64 max-w-full rounded border border-outline-variant object-contain"
                                    />
                                )}
                            </div>
                        ) : (
                            <CodePane
                                value={pretty && prettyText ? prettyText : responseText}
                                language={responseLang}
                                readOnly
                                editorThemeId={editorThemeId}
                                appTheme={appTheme}
                                appearance={appearance}
                            />
                        )
                    )}

                    {onResp('headers') && result?.response && (
                        <table className="w-full border-collapse text-ui-11">
                            <tbody>
                                {result.response.headers.map((h, i) => (
                                    <tr key={i} className="border-b border-outline-variant/40">
                                        <td className="w-1/3 px-2 py-1 align-top font-mono text-on-surface-variant">{h.key}</td>
                                        <td className="break-all px-2 py-1 font-mono text-on-surface">{h.value}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}

                    {onResp('history') && (
                        <div>
                            <div className="flex items-center justify-end px-2 py-1">
                                <button
                                    onClick={() => void HttpClearHistory(itemId ?? '').then(reloadHistory)}
                                    disabled={history.length === 0}
                                    title={t.http.request.clearHistoryTitle}
                                    className="rounded px-2 py-0.5 text-ui-11 text-on-surface-variant hover:bg-surface-variant hover:text-error disabled:opacity-30"
                                >
                                    {t.http.request.clearHistory}
                                </button>
                            </div>
                            {history.length === 0 ? (
                                <p className="px-3 py-4 text-ui-11 text-on-surface-variant/60">{t.http.request.noHistory}</p>
                            ) : (
                                <table className="w-full border-collapse text-ui-11">
                                    <tbody>
                                        {history.map((h) => (
                                            <tr key={h.id} className="border-b border-outline-variant/40">
                                                <td className={`w-12 px-2 py-1 font-mono ${statusColor(h.status)}`}>{h.status || '—'}</td>
                                                <td className="w-16 px-2 py-1 text-right font-mono text-on-surface-variant">{t.http.request.ms(h.durationMs)}</td>
                                                <td className="w-16 px-2 py-1 text-right font-mono text-on-surface-variant">{humanSize(h.sizeBytes)}</td>
                                                <td className="truncate px-2 py-1 font-mono text-on-surface-variant/80" title={h.error || h.url}>
                                                    {h.error || h.url}
                                                </td>
                                                <td className="w-28 px-2 py-1 text-right text-on-surface-variant/60">
                                                    {formatDateTime(h.executedAt)}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* Panel de IA anclado al borde derecho de la pestaña, no un modal:
                para explicar una respuesta hay que poder seguir viéndola. */}
            {aiAction && (
                <div className="absolute inset-y-0 right-0 z-30 flex shadow-2xl">
                    <AiPanel
                        action={aiAction}
                        itemId={itemId ?? ''}
                        request={request}
                        response={result?.response ?? new httpclient.Response({status: 0})}
                        errorText={result?.error ?? ''}
                        currentDocs={docs}
                        onApplyRequest={(req) => applyImported(req, '')}
                        onApplyDocs={(markdown) => {
                            setDocs(markdown)
                            setSection('docs')
                            setDirty(true)
                        }}
                        onApplyTests={(code) => {
                            setTestScript(code)
                            setSection('scripts')
                            setDirty(true)
                        }}
                        onClose={() => setAiAction(null)}
                        onFollowUp={
                            chat.isAvailable && chat.hasAgent
                                ? (label, answer) =>
                                      void askInChat([{label, text: answer, language: 'markdown', icon: 'auto_awesome'}])
                                : undefined
                        }
                    />
                </div>
            )}
        </div>
    )
}

// Una fila de la pestaña Settings: interruptor a la derecha, y el porqué
// debajo del nombre. El texto explica la CONSECUENCIA, no repite el título:
// "Verificar el certificado TLS" ya se lee solo, lo que hace falta saber es
// qué pasa si se apaga.
function SettingRow({
    label,
    hint,
    checked,
    onChange,
    disabled,
    danger,
}: {
    label: string
    hint: string
    checked: boolean
    onChange: (v: boolean) => void
    disabled?: boolean
    danger?: boolean
}) {
    const t = useT()
    return (
        <div className={`flex items-start gap-3 py-2 ${disabled ? 'opacity-40' : ''}`}>
            <div className="min-w-0 flex-1">
                <p className={danger ? 'text-error' : 'text-on-surface'}>{label}</p>
                <p className="text-ui-10 leading-relaxed text-on-surface-variant/70">{hint}</p>
            </div>
            <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(e) => onChange(e.target.checked)}
                title={disabled ? t.http.request.settings.needsFollow : hint}
                className="mt-0.5 shrink-0 accent-primary"
            />
        </div>
    )
}

// Modos de cuerpo ofrecidos. `name` es el nombre técnico (igual en todos los
// idiomas); el porqué de cada uno va en el tooltip, desde el diccionario
// (t.http.request.bodyModes).
const BODY_MODES: {id: 'none' | 'raw' | 'formdata' | 'urlencoded' | 'binary' | 'graphql'; name: string}[] = [
    {id: 'none', name: 'none'},
    {id: 'raw', name: 'raw'},
    {id: 'formdata', name: 'form-data'},
    {id: 'urlencoded', name: 'x-www-form-urlencoded'},
    {id: 'binary', name: 'binary'},
    {id: 'graphql', name: 'GraphQL'},
]

// Cuántos elementos tiene el cuerpo, para el contador de la pestaña: cada
// modo cuenta lo suyo.
function bodyCount(body: httpclient.Body): number {
    switch (body.mode) {
        case 'raw':
            return body.raw ? 1 : 0
        case 'formdata':
            return (body.formData ?? []).filter((f) => f.enabled && f.key).length
        case 'urlencoded':
            return (body.urlEncoded ?? []).filter((f) => f.enabled && f.key).length
        case 'binary':
            return body.binaryPath ? 1 : 0
        case 'graphql':
            return body.graphqlQuery ? 1 : 0
        default:
            return 0
    }
}

function fileBaseName(path: string): string {
    const parts = path.split(/[/\\]/)
    return parts[parts.length - 1] || path
}

// nameFromURL propone un nombre para una petición rápida que se está
// guardando: el último tramo de la ruta, que es lo que uno busca en el árbol.
function nameFromURL(url: string): string {
    const path = url.split('?')[0].replace(/^[a-zA-Z][\w+.-]*:\/\//, '')
    const parts = path.split('/').filter(Boolean)
    return parts[parts.length - 1] ?? ''
}
