import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {
    HttpActiveEnvironment,
    HttpAuthPreview,
    HttpBuildRequest,
    HttpCancel,
    HttpClearHistory,
    HttpDefaultSettings,
    HttpFormatBody,
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
import {HTTP_METHODS, humanSize, methodColor, parseComputed, parseRows, pathVarsFromURL, serializeRows, statusColor, type HttpComputed} from './httpShared'

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
    editorThemeId: string
    appTheme: Theme
    appearance: EditorAppearance
    // Avisa que el nombre o el método cambiaron, para que el árbol y el
    // título de la pestaña se actualicen.
    onChanged: () => void
    // Avisa que una petición rápida se guardó y ahora es un ítem de verdad,
    // para que la pestaña deje de ser rápida y pase a apuntar a él.
    onSaved?: (item: vault.HTTPItem) => void
    active: boolean
}

type EditorSection = 'params' | 'auth' | 'headers' | 'body' | 'scripts' | 'docs' | 'settings'
type ResponseSection = 'body' | 'headers' | 'history'

const RAW_LANGS: {id: string; label: string; lang: LanguageId}[] = [
    {id: 'json', label: 'JSON', lang: 'json'},
    {id: 'xml', label: 'XML', lang: 'xml'},
    {id: 'html', label: 'HTML', lang: 'html'},
    {id: 'text', label: 'Texto', lang: 'plaintext'},
]

export default function HttpRequestTab({itemId, editorThemeId, appTheme, appearance, onChanged, onSaved, active}: HttpRequestTabProps) {
    // Una petición rápida no tiene ítem, así que tampoco tiene colección de la
    // que heredar: ni variables, ni autenticación, ni carpeta. Lo que se ve en
    // pantalla es todo lo que se manda.
    const scratch = itemId === null
    const [item, setItem] = useState<vault.HTTPItem | null>(null)
    const [method, setMethod] = useState('GET')
    const [url, setUrl] = useState('')
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
    // Diálogo de "guardar en una colección" de una petición rápida: la lista
    // de colecciones, cuál se eligió y con qué nombre.
    const [saveTo, setSaveTo] = useState<{collections: vault.HTTPCollection[]; collectionId: string; name: string} | null>(null)
    const [authPreview, setAuthPreview] = useState<{type: string; executable: boolean; needsToken: boolean} | null>(null)
    const [settings, setSettings] = useState<httpclient.Settings | null>(null)

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

    // --- guardar -------------------------------------------------------------

    const openSaveDialog = useCallback(async () => {
        try {
            const cols = (await HttpListCollections()) ?? []
            setSaveTo({
                collections: cols,
                collectionId: cols[0]?.id ?? '',
                // Un nombre propuesto a partir de la URL: el último tramo de
                // la ruta es lo que uno reconocería en el árbol.
                name: nameFromURL(url) || 'Petición',
            })
        } catch (e) {
            setError(String(e))
        }
    }, [url])

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
            setError('Escribí una URL antes de enviar.')
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
        return <div className="flex flex-1 items-center justify-center text-ui-11 text-on-surface-variant">Cargando la petición…</div>
    }

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
                    ariaLabel="Método HTTP"
                    title="Método HTTP. GET solo lee; POST, PUT y PATCH modifican; DELETE borra — por eso cada uno tiene su color acá, en el árbol y en el historial."
                    className="w-28 shrink-0 font-mono"
                />

                <input
                    value={url}
                    onChange={(e) => touch(setUrl)(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') void send()
                    }}
                    placeholder="localhost:3000/dev/blocks/:slug/:date"
                    title="URL de la petición. Un segmento que empiece con dos puntos (:id) se convierte en una variable de ruta y aparece para completar en la pestaña Params."
                    className="min-w-0 flex-1 rounded bg-surface-container px-2 py-1 font-mono text-ui-11 text-on-surface outline-none focus:ring-1 focus:ring-primary"
                />

                {sending ? (
                    <button
                        onClick={() => void HttpCancel(execId)}
                        title="Cortar la petición en curso. El servidor puede haberla recibido igual: cancelar corta la espera de la respuesta, no deshace lo que ya hizo."
                        className="shrink-0 rounded bg-error px-3 py-1 text-ui-11 text-on-error hover:opacity-90"
                    >
                        Cancelar
                    </button>
                ) : (
                    <button
                        onClick={() => void send()}
                        // Sin settings cargados no se manda: son los que dicen
                        // si hay que verificar el certificado del servidor, y
                        // mandar antes de saberlo dejaba esa decisión en manos
                        // del valor por defecto de un booleano.
                        disabled={!settings}
                        title={
                            settings
                                ? 'Enviar la petición tal como está en pantalla, incluso con cambios sin guardar — es lo que permite probar antes de decidir si vale la pena guardarla.'
                                : 'Esperando la configuración de la petición…'
                        }
                        className="shrink-0 rounded bg-primary px-3 py-1 text-ui-11 font-medium text-on-primary hover:opacity-90 disabled:opacity-40"
                    >
                        Enviar
                    </button>
                )}

                <Select
                    value={activeEnv}
                    options={[
                        // "Sin entorno" no es un entorno más: es no usar
                        // ninguno, y por eso va separado de la lista real.
                        {value: '', label: 'Sin entorno', separatorAfter: envs.length > 0},
                        ...envs.map((e) => ({value: e.id, label: e.name, icon: <Icon name="lan" size={14} />})),
                    ]}
                    onChange={(id) => {
                        setActiveEnv(id)
                        void HttpSetActiveEnvironment(id).catch(() => {})
                    }}
                    size="sm"
                    ariaLabel="Entorno activo"
                    title="Entorno activo: define los valores de las {{llaves}} y pisa a las variables de la colección. Si un entorno está anclado a esta colección, gana él sin importar lo que diga este selector."
                    className="w-36 shrink-0"
                />

                <div className="relative shrink-0">
                    <button
                        onClick={() => setAiMenu((v) => !v)}
                        title="Ayuda con IA sobre esta petición: explicar la respuesta, diagnosticar un fallo, escribirla desde una descripción, redactar su documentación o sus tests. El agente propone; aplicarlo es un clic tuyo."
                        className={`rounded p-1 hover:bg-surface-variant ${aiMenu || aiAction ? 'text-primary' : 'text-on-surface-variant hover:text-on-surface'}`}
                    >
                        <Icon name="auto_awesome" size={16} />
                    </button>
                    {aiMenu && (
                        <>
                            <div className="fixed inset-0 z-40" onClick={() => setAiMenu(false)} />
                            <div className="absolute right-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-lg border border-outline-variant bg-surface-container shadow-xl">
                                {AI_ACTIONS.map((a) => {
                                    // Sin respuesta todavía no hay nada que explicar ni que
                                    // diagnosticar: se deshabilita y se dice por qué, en vez de
                                    // dejar que el agente conteste sobre la nada.
                                    const blocked = a.needsResponse && !result
                                    return (
                                        <button
                                            key={a.id}
                                            onClick={() => {
                                                setAiMenu(false)
                                                setAiAction(a.id)
                                            }}
                                            disabled={blocked}
                                            title={blocked ? 'Mandá la petición primero: todavía no hay respuesta que mirar.' : a.hint}
                                            className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-surface-variant disabled:opacity-40 disabled:hover:bg-transparent"
                                        >
                                            <Icon name={a.icon} size={14} className="mt-0.5 text-on-surface-variant" />
                                            <span className="min-w-0 flex-1">
                                                <span className="block text-ui-11 text-on-surface">{a.label}</span>
                                                <span className="block text-ui-10 leading-relaxed text-on-surface-variant/70">{a.hint}</span>
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
                    title="Ver esta petición escrita como cURL, Go, Python, JavaScript y otros — con las variables ya resueltas, listo para pegar."
                    className="shrink-0 rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="code" size={16} />
                </button>

                <button
                    onClick={() => void (scratch && !item ? openSaveDialog() : save())}
                    disabled={saving || (!scratch && !dirty)}
                    title={
                        scratch && !item
                            ? 'Guardar esta petición en una colección (Ctrl+S). Hasta que lo hagas vive solo en esta pestaña.'
                            : dirty
                              ? 'Guardar los cambios en la colección (Ctrl+S)'
                              : 'No hay cambios sin guardar'
                    }
                    className="shrink-0 rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-30"
                >
                    <Icon name={scratch && !item ? 'bookmark_add' : 'save'} size={16} />
                </button>
            </div>

            {scratch && !item && (
                <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant bg-surface-container-lowest px-2 py-1 text-ui-11 text-on-surface-variant">
                    <Icon name="bolt" size={14} className="text-tertiary" />
                    <span className="flex-1 leading-relaxed">
                        Petición rápida: no está guardada en ninguna colección, así que no hereda variables ni autenticación de ninguna. Las variables
                        del entorno activo sí valen. Se pierde al cerrar la pestaña.
                    </span>
                    <button
                        onClick={() => void openSaveDialog()}
                        title="Guardarla en una colección para conservarla"
                        className="shrink-0 rounded border border-outline-variant px-2 py-0.5 hover:bg-surface-variant"
                    >
                        Guardar en…
                    </button>
                </div>
            )}

            {saveTo && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={() => setSaveTo(null)}>
                    <div
                        className="w-96 max-w-full rounded-lg border border-outline-variant bg-surface-container p-4 shadow-xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <p className="mb-3 text-sm font-medium text-on-surface">Guardar la petición</p>
                        {saveTo.collections.length === 0 ? (
                            <p className="text-ui-11 leading-relaxed text-on-surface-variant">
                                Todavía no hay ninguna colección. Creá una desde la barra lateral y volvé a intentarlo — la petición sigue acá mientras
                                tanto.
                            </p>
                        ) : (
                            <>
                                <label className="mb-1 block text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">Colección</label>
                                <Select
                                    value={saveTo.collectionId}
                                    options={saveTo.collections.map((c) => ({value: c.id, label: c.name, icon: <Icon name="folder" size={14} />}))}
                                    onChange={(v) => setSaveTo({...saveTo, collectionId: v})}
                                    size="sm"
                                    ariaLabel="Colección donde guardar"
                                    title="En qué colección se guarda la petición. Las variables y la autenticación de esa colección pasan a aplicarle."
                                    className="mb-3 w-full"
                                />
                                <label className="mb-1 block text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">Nombre</label>
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
                                Cancelar
                            </button>
                            <button
                                onClick={() => void saveInto(saveTo.collectionId, saveTo.name.trim())}
                                disabled={saving || !saveTo.collectionId || !saveTo.name.trim()}
                                className="rounded bg-primary px-3 py-1 text-xs text-on-primary hover:opacity-90 disabled:opacity-40"
                            >
                                Guardar
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {authPreview && !authPreview.executable && (
                <div
                    className="flex shrink-0 items-start gap-2 border-b border-outline-variant px-2 py-1 text-ui-11 text-tertiary"
                    title="Esta autenticación se guarda y se exporta intacta, pero esta versión todavía no la firma: la petición va a salir sin autenticar."
                >
                    <Icon name="warning" size={14} className="mt-0.5 shrink-0" />
                    <span>
                        La autenticación <span className="font-mono">{authPreview.type}</span> todavía no se firma: la petición sale sin autenticar.
                    </span>
                </div>
            )}

            {showCode && <CodeSnippetPanel itemId={itemId ?? ''} request={request} onClose={() => setShowCode(false)} />}

            {computedErrors.length > 0 && (
                <div
                    className="flex shrink-0 items-start gap-2 border-b border-outline-variant bg-error-container px-2 py-1 text-ui-11 text-on-error-container"
                    title="Una variable calculada no se pudo derivar, así que lo que dependa de ella va a salir con las llaves sin resolver."
                >
                    <Icon name="functions" size={14} className="mt-0.5 shrink-0" />
                    <span className="min-w-0 flex-1 break-words">{computedErrors.join(' · ')}</span>
                </div>
            )}

            {missing.length > 0 && (
                <div
                    className="flex shrink-0 items-start gap-2 border-b border-outline-variant px-2 py-1 text-ui-11 text-tertiary"
                    title="Estas variables se usan en la petición pero no las define ni el entorno activo ni la colección. Se envían tal cual, con las llaves adentro, así que el servidor va a recibir una URL o un header que no tienen sentido."
                >
                    <Icon name="warning" size={14} className="mt-0.5 shrink-0" />
                    <span className="min-w-0 flex-1 break-words">
                        Sin definir: <span className="font-mono">{missing.map((m) => `{{${m}}}`).join('  ')}</span>
                    </span>
                </div>
            )}

            {error && (
                <div className="flex shrink-0 items-start gap-2 border-b border-outline-variant bg-error-container px-2 py-1 text-ui-11 text-on-error-container">
                    <Icon name="error" size={14} className="mt-0.5 shrink-0" />
                    <span className="min-w-0 flex-1 break-words">{error}</span>
                    <button onClick={() => setError(null)} title="Cerrar el aviso" className="shrink-0 rounded p-0.5 hover:bg-error/20">
                        <Icon name="close" size={12} />
                    </button>
                </div>
            )}

            {/* Editor de la petición */}
            <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex shrink-0 items-center gap-0.5 border-b border-outline-variant px-2">
                    {(
                        [
                            ['params', 'Params', params.filter((p) => p.enabled && p.key).length + pathVars.length],
                            ['auth', 'Auth', authPreview && authPreview.type !== 'none' ? 1 : 0],
                            ['headers', 'Headers', headers.filter((h) => h.enabled && h.key).length],
                            ['body', 'Body', bodyCount(body)],
                            ['scripts', 'Pre-request', computed.filter((c) => c.enabled && c.name).length + (preRequest ? 1 : 0) + (testScript ? 1 : 0)],
                            ['docs', 'Docs', docs.trim() ? 1 : 0],
                            ['settings', 'Settings', 0],
                        ] as [EditorSection, string, number][]
                    ).map(([id, label, count]) => (
                        <button
                            key={id}
                            onClick={() => setSection(id)}
                            title={`Ver ${label} de esta petición`}
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
                    {section === 'params' && (
                        <>
                            <p className="px-2 pt-2 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">Query Params</p>
                            <KeyValueTable rows={params} onChange={touch(setParams)} />
                            <p className="px-2 pt-3 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">Path Variables</p>
                            <KeyValueTable
                                rows={pathVars}
                                onChange={touch(setPathVars)}
                                lockKeys
                                emptyHint="Escribí un segmento con dos puntos en la URL (por ejemplo /blocks/:slug) y va a aparecer acá para completar su valor."
                            />
                        </>
                    )}

                    {section === 'auth' && (
                        <>
                            {authPreview && auth.type === 'inherit' && (
                                <p className="px-3 pt-2 text-ui-10 leading-relaxed text-on-surface-variant/70">
                                    {authPreview.type === 'none'
                                        ? 'Ni la carpeta ni la colección definen autenticación, así que esta petición sale sin autenticar.'
                                        : `Heredando: se va a usar ${authPreview.type}${authPreview.executable ? '' : ' (que esta versión todavía no firma)'}.`}
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

                    {section === 'headers' && <KeyValueTable rows={headers} onChange={touch(setHeaders)} />}

                    {section === 'body' && (
                        <div className="flex h-full min-h-0 flex-col">
                            <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-2 py-1.5">
                                {BODY_MODES.map((m) => (
                                    <label key={m.id} className="flex items-center gap-1 text-ui-11 text-on-surface-variant" title={m.hint}>
                                        <input
                                            type="radio"
                                            checked={body.mode === m.id}
                                            onChange={() => touch(setBody)(new httpclient.Body({...body, mode: m.id}))}
                                            className="accent-primary"
                                        />
                                        {m.label}
                                    </label>
                                ))}
                                {/* form-data, x-www-form-urlencoded, binary y GraphQL entran
                                    en la fase 3 del plan; no se muestran como opciones
                                    apagadas porque una opción que no hace nada es peor que
                                    una que todavía no está. */}
                                {body.mode === 'raw' && (
                                    <>
                                        <Select
                                            value={body.rawLang ?? 'json'}
                                            options={RAW_LANGS.map((l) => ({value: l.id, label: l.label}))}
                                            onChange={(v) => touch(setBody)(new httpclient.Body({...body, rawLang: v}))}
                                            size="sm"
                                            variant="ghost"
                                            ariaLabel="Formato del cuerpo"
                                            title="Formato del cuerpo. Elige el resaltado y define el Content-Type que se manda si no escribiste uno a mano en Headers."
                                            className="w-24"
                                        />
                                        <button
                                            onClick={() => void formatBody()}
                                            disabled={!canFormat || !body.raw}
                                            title={
                                                canFormat
                                                    ? 'Indentar el cuerpo. Si el texto no parsea se deja tal cual, sin borrar nada.'
                                                    : 'Solo se puede formatear JSON y XML'
                                            }
                                            className="rounded px-1.5 py-0.5 text-ui-11 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-30"
                                        >
                                            Formatear
                                        </button>
                                    </>
                                )}
                            </div>
                            {body.mode === 'raw' && (
                                <div className="min-h-0 flex-1 border-t border-outline-variant">
                                    <CodePane
                                        value={body.raw ?? ''}
                                        onChange={(v) => touch(setBody)(new httpclient.Body({...body, raw: v}))}
                                        language={rawLang}
                                        editorThemeId={editorThemeId}
                                        appTheme={appTheme}
                                        appearance={appearance}
                                        placeholder='{ "clave": "valor" }'
                                    />
                                </div>
                            )}

                            {body.mode === 'formdata' && (
                                <div className="min-h-0 flex-1 overflow-y-auto border-t border-outline-variant">
                                    <FormDataTable
                                        rows={body.formData ?? []}
                                        onChange={(rows) => touch(setBody)(new httpclient.Body({...body, formData: rows}))}
                                    />
                                    <p className="px-2 py-2 text-ui-10 leading-relaxed text-on-surface-variant/70">
                                        De una fila de archivo se guarda la <strong>ruta</strong>, no el contenido: se lee recién al enviar, en streaming, así
                                        que subir algo grande no ocupa memoria ni deja una copia congelada en el vault.
                                    </p>
                                </div>
                            )}

                            {body.mode === 'urlencoded' && (
                                <div className="min-h-0 flex-1 overflow-y-auto border-t border-outline-variant">
                                    <KeyValueTable
                                        rows={body.urlEncoded ?? []}
                                        onChange={(rows) => touch(setBody)(new httpclient.Body({...body, urlEncoded: rows}))}
                                    />
                                </div>
                            )}

                            {body.mode === 'binary' && (
                                <div className="min-h-0 flex-1 border-t border-outline-variant p-3">
                                    <button
                                        onClick={() =>
                                            void HttpPickFile('Elegir el archivo a enviar como cuerpo')
                                                .then((path) => {
                                                    if (path) touch(setBody)(new httpclient.Body({...body, binaryPath: path}))
                                                })
                                                .catch(() => {})
                                        }
                                        title="El archivo entero se manda como cuerpo, con su Content-Type deducido de la extensión."
                                        className="flex items-center gap-1.5 rounded bg-surface-container px-2 py-1 text-ui-11 text-on-surface hover:bg-surface-variant"
                                    >
                                        <Icon name="attach_file" size={13} />
                                        {body.binaryPath ? fileBaseName(body.binaryPath) : 'Elegir archivo…'}
                                    </button>
                                    {body.binaryPath && <p className="mt-2 break-all font-mono text-ui-10 text-on-surface-variant/60">{body.binaryPath}</p>}
                                </div>
                            )}

                            {body.mode === 'graphql' && (
                                <div className="flex min-h-0 flex-1 flex-col border-t border-outline-variant">
                                    <p className="shrink-0 px-2 pt-1 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">Query</p>
                                    <div className="min-h-0 flex-1">
                                        <CodePane
                                            value={body.graphqlQuery ?? ''}
                                            onChange={(v) => touch(setBody)(new httpclient.Body({...body, graphqlQuery: v}))}
                                            language="plaintext"
                                            editorThemeId={editorThemeId}
                                            appTheme={appTheme}
                                            appearance={appearance}
                                            placeholder="query { me { id } }"
                                        />
                                    </div>
                                    <p className="shrink-0 border-t border-outline-variant px-2 pt-1 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">
                                        Variables (JSON)
                                    </p>
                                    <div className="h-24 shrink-0">
                                        <CodePane
                                            value={body.graphqlVariables ?? ''}
                                            onChange={(v) => touch(setBody)(new httpclient.Body({...body, graphqlVariables: v}))}
                                            language="json"
                                            editorThemeId={editorThemeId}
                                            appTheme={appTheme}
                                            appearance={appearance}
                                            placeholder='{ "id": 1 }'
                                        />
                                    </div>
                                </div>
                            )}

                            {body.mode === 'none' && (
                                <p className="px-3 py-4 text-ui-11 text-on-surface-variant/70">Esta petición no manda cuerpo.</p>
                            )}
                        </div>
                    )}

                    {section === 'scripts' && (
                        <div className="flex h-full min-h-0 flex-col">
                            <p className="shrink-0 px-2 pt-2 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">
                                Variables calculadas
                            </p>
                            <div className="shrink-0">
                                <ComputedTable rows={computed} onChange={touch(setComputed)} problems={computedErrors} />
                            </div>

                            <p className="shrink-0 border-t border-outline-variant bg-surface-container-lowest px-3 py-2 text-ui-10 leading-relaxed text-tertiary">
                                Los scripts de abajo <strong>se guardan y se exportan intactos, pero NO se ejecutan</strong>. Esta aplicación no incorpora un
                                motor de JavaScript —sumaba 20 MB al programa—, así que lo que un script hacía para firmar se configura arriba, en las
                                variables calculadas. Están acá para que una colección importada no los pierda y para poder leerlos y traducirlos.
                            </p>
                            <p className="shrink-0 px-2 pt-1 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">
                                Pre-request (no se ejecuta)
                            </p>
                            <div className="min-h-0 flex-1">
                                <CodePane
                                    value={preRequest}
                                    onChange={(v) => touch(setPreRequest)(v)}
                                    language="javascript"
                                    editorThemeId={editorThemeId}
                                    appTheme={appTheme}
                                    appearance={appearance}
                                    placeholder="pm.environment.set('sig', ...)"
                                />
                            </div>
                            <p className="shrink-0 border-t border-outline-variant px-2 pt-1 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">
                                Tests (no se ejecutan)
                            </p>
                            <div className="h-32 shrink-0">
                                <CodePane
                                    value={testScript}
                                    onChange={(v) => touch(setTestScript)(v)}
                                    language="javascript"
                                    editorThemeId={editorThemeId}
                                    appTheme={appTheme}
                                    appearance={appearance}
                                    placeholder="pm.test('ok', () => pm.expect(pm.response.status).to.equal(200))"
                                />
                            </div>
                        </div>
                    )}

                    {section === 'docs' && (
                        <div className="flex h-full min-h-0 flex-col">
                            <p className="shrink-0 px-3 pt-2 text-ui-10 leading-relaxed text-on-surface-variant/70">
                                Para qué sirve esta petición, qué devuelve, cuál hay que llamar antes. Es Markdown, y se publica junto con el resto de la
                                colección desde «Documentación…» en el menú de la colección. Un <span className="font-mono">[[enlace]]</span> escrito acá
                                queda enlazado de verdad con esa nota del vault.
                            </p>
                            <textarea
                                value={docs}
                                onChange={(e) => {
                                    setDocs(e.target.value)
                                    setDirty(true)
                                }}
                                placeholder={'Devuelve el token de sesión.\n\n- Hay que llamarla antes que el resto.\n- Ver [[Runbook de reservas]].'}
                                spellCheck={false}
                                className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-ui-11 leading-relaxed text-on-surface outline-none placeholder:text-on-surface-variant/40"
                            />
                        </div>
                    )}

                    {section === 'settings' && settings && (
                        <div className="divide-y divide-outline-variant/50 px-2 text-ui-11">
                            <SettingRow
                                label="Verificar el certificado TLS"
                                hint="Con esto apagado, la app acepta cualquier certificado: sirve para un entorno interno con certificado propio, y es exactamente lo que un atacante en el medio necesita. Apagalo solo si sabés contra qué estás hablando."
                                checked={settings.verifyTls}
                                onChange={(v) => touch(setSettings)(new httpclient.Settings({...settings, verifyTls: v}))}
                                danger={!settings.verifyTls}
                            />
                            <SettingRow
                                label="Seguir redirecciones"
                                hint="Seguir las respuestas 3xx hasta la URL final. Apagado, se ve el 301 o el 302 en crudo — que es lo que se quiere cuando lo que se está probando ES la redirección."
                                checked={settings.followRedirects}
                                onChange={(v) => touch(setSettings)(new httpclient.Settings({...settings, followRedirects: v}))}
                            />
                            <SettingRow
                                label="Conservar el método al redirigir"
                                hint="Por defecto un POST redirigido se reintenta como GET, que es lo que manda el estándar para 301/302. Esta opción repite el método original."
                                checked={settings.keepMethodOnRedirect}
                                onChange={(v) => touch(setSettings)(new httpclient.Settings({...settings, keepMethodOnRedirect: v}))}
                                disabled={!settings.followRedirects}
                            />
                            <SettingRow
                                label="Conservar el header Authorization al cambiar de host"
                                hint="Normalmente las credenciales NO se reenvían si la redirección lleva a otro servidor, justamente para no filtrarlas. Encendelo solo si confiás en el destino."
                                checked={settings.keepAuthOnRedirect}
                                onChange={(v) => touch(setSettings)(new httpclient.Settings({...settings, keepAuthOnRedirect: v}))}
                                disabled={!settings.followRedirects}
                                danger={settings.keepAuthOnRedirect}
                            />
                            <SettingRow
                                label="Quitar el header Referer al redirigir"
                                hint="Evita contarle al destino desde qué URL venías."
                                checked={settings.removeRefererOnRedirect}
                                onChange={(v) => touch(setSettings)(new httpclient.Settings({...settings, removeRefererOnRedirect: v}))}
                                disabled={!settings.followRedirects}
                            />
                            <div className="flex items-center gap-3 py-2">
                                <div className="min-w-0 flex-1">
                                    <p className="text-on-surface">Versión de HTTP</p>
                                    <p className="text-ui-10 leading-relaxed text-on-surface-variant/70">
                                        «Auto» negocia con el servidor y es lo correcto salvo que estés depurando algo que se comporta distinto según la versión.
                                    </p>
                                </div>
                                <Select
                                    value={settings.httpVersion}
                                    options={[
                                        {value: 'auto', label: 'Auto'},
                                        {value: '1.1', label: 'HTTP/1.1'},
                                        {value: '2', label: 'HTTP/2'},
                                    ]}
                                    onChange={(v) => touch(setSettings)(new httpclient.Settings({...settings, httpVersion: v}))}
                                    size="sm"
                                    ariaLabel="Versión de HTTP"
                                    title="Versión del protocolo a usar. «Auto» negocia con el servidor y es lo correcto salvo que estés depurando algo que se comporta distinto según la versión."
                                    className="w-32 shrink-0"
                                />
                            </div>
                            <div className="flex items-center gap-3 py-2">
                                <div className="min-w-0 flex-1">
                                    <p className="text-on-surface">Tiempo límite</p>
                                    <p className="text-ui-10 leading-relaxed text-on-surface-variant/70">
                                        Segundos a esperar antes de darse por vencido. Sin límite, un servidor que no contesta cuelga la petición para siempre.
                                    </p>
                                </div>
                                <input
                                    type="number"
                                    min={1}
                                    value={Math.round(settings.timeoutMs / 1000)}
                                    onChange={(e) =>
                                        touch(setSettings)(new httpclient.Settings({...settings, timeoutMs: Math.max(1, Number(e.target.value) || 1) * 1000}))
                                    }
                                    title="Tiempo límite en segundos"
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
                    <span className="text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">Respuesta</span>
                    {result?.response && (
                        <>
                            <span className={`font-mono text-ui-11 font-semibold ${statusColor(result.response.status)}`}>
                                {result.response.status} {result.response.statusText}
                            </span>
                            <span className="font-mono text-ui-11 text-on-surface-variant">{result.response.durationMs} ms</span>
                            <span className="font-mono text-ui-11 text-on-surface-variant">{humanSize(result.response.sizeBytes)}</span>
                            {result.response.redirects > 0 && (
                                <span
                                    className="text-ui-10 text-tertiary"
                                    title={`Se siguieron ${result.response.redirects} redirecciones hasta ${result.response.finalUrl}`}
                                >
                                    {result.response.redirects} redirección{result.response.redirects > 1 ? 'es' : ''}
                                </span>
                            )}
                            {result.response.truncated && (
                                <span
                                    className="text-ui-10 text-tertiary"
                                    title="Lo que se muestra está cortado por el tope de tamaño, pero el cuerpo COMPLETO se volcó a disco al recibirlo: «Guardar…» escribe el archivo entero."
                                >
                                    vista cortada
                                </span>
                            )}
                        </>
                    )}
                    {sending && <span className="text-ui-11 text-on-surface-variant">Enviando…</span>}

                    <div className="ml-auto flex items-center gap-0.5">
                        {(
                            [
                                ['body', 'Cuerpo'],
                                ['headers', 'Headers'],
                                ['history', 'Historial'],
                            ] as [ResponseSection, string][]
                        ).map(([id, label]) => (
                            <button
                                key={id}
                                onClick={() => setRespSection(id)}
                                title={id === 'history' ? 'Últimas ejecuciones de esta petición' : `Ver ${label.toLowerCase()} de la respuesta`}
                                className={`rounded px-2 py-0.5 text-ui-11 ${
                                    respSection === id ? 'bg-surface-variant text-on-surface' : 'text-on-surface-variant hover:text-on-surface'
                                }`}
                            >
                                {label}
                            </button>
                        ))}
                        {respSection === 'body' && result?.response && (
                            <button
                                onClick={() =>
                                    void HttpSaveResponseToFile(
                                        result.response?.spillPath ?? '',
                                        result.response?.bodyBase64 ?? '',
                                        result.response?.body ?? '',
                                        result.response?.filename ?? '',
                                    ).catch((e) => setError(String(e)))
                                }
                                title={
                                    result.response.truncated
                                        ? 'Guardar la respuesta COMPLETA. Lo que se ve está cortado, pero el cuerpo entero se volcó a disco al recibirlo.'
                                        : 'Guardar el cuerpo de la respuesta en un archivo'
                                }
                                className="rounded px-2 py-0.5 text-ui-11 text-on-surface-variant hover:text-on-surface"
                            >
                                Guardar…
                            </button>
                        )}
                        {respSection === 'body' && result?.response && item && (
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
                                title="Agregar esta respuesta como ejemplo a la documentación de la petición. Se suma al final: una petición útil tiene el caso que funciona y el error que explica qué valida el servidor."
                                className="rounded px-2 py-0.5 text-ui-11 text-on-surface-variant hover:text-on-surface"
                            >
                                Guardar de ejemplo
                            </button>
                        )}
                        {respSection === 'body' && result?.response && !result.response.isBinary && (
                            <button
                                onClick={() => setPretty((v) => !v)}
                                title={pretty ? 'Ver el cuerpo tal como llegó, sin indentar' : 'Indentar el cuerpo para poder leerlo'}
                                className="rounded px-2 py-0.5 text-ui-11 text-on-surface-variant hover:text-on-surface"
                            >
                                {pretty ? 'Crudo' : 'Formateado'}
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
                            Todavía no enviaste esta petición. Apretá «Enviar» o Enter en la URL.
                        </p>
                    )}

                    {result?.error && (
                        <div className="px-3 py-3 text-ui-11 leading-relaxed text-error">
                            <p className="font-medium">No se pudo completar la petición</p>
                            <p className="mt-1 break-words text-on-surface-variant">{result.error}</p>
                        </div>
                    )}

                    {respSection === 'body' && result?.response && (
                        result.response.isBinary ? (
                            <div className="px-3 py-3">
                                <p className="text-ui-11 leading-relaxed text-on-surface-variant">
                                    Respuesta binaria: {result.response.contentType || 'tipo desconocido'}, {humanSize(result.response.sizeBytes)}.
                                </p>
                                {/* Vista previa solo de imágenes: es el único tipo que el
                                    webview dibuja desde base64 sin ayuda, y prometer una
                                    previsualización de PDF que a veces no aparece sería
                                    peor que no ofrecerla. */}
                                {result.response.contentType.startsWith('image/') && result.response.bodyBase64 && (
                                    <img
                                        src={`data:${result.response.contentType};base64,${result.response.bodyBase64}`}
                                        alt="Vista previa de la respuesta"
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

                    {respSection === 'headers' && result?.response && (
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

                    {respSection === 'history' && (
                        <div>
                            <div className="flex items-center justify-end px-2 py-1">
                                <button
                                    onClick={() => void HttpClearHistory(itemId ?? '').then(reloadHistory)}
                                    disabled={history.length === 0}
                                    title="Borrar el historial de ejecuciones de esta petición"
                                    className="rounded px-2 py-0.5 text-ui-11 text-on-surface-variant hover:bg-surface-variant hover:text-error disabled:opacity-30"
                                >
                                    Limpiar
                                </button>
                            </div>
                            {history.length === 0 ? (
                                <p className="px-3 py-4 text-ui-11 text-on-surface-variant/60">Sin ejecuciones todavía.</p>
                            ) : (
                                <table className="w-full border-collapse text-ui-11">
                                    <tbody>
                                        {history.map((h) => (
                                            <tr key={h.id} className="border-b border-outline-variant/40">
                                                <td className={`w-12 px-2 py-1 font-mono ${statusColor(h.status)}`}>{h.status || '—'}</td>
                                                <td className="w-16 px-2 py-1 text-right font-mono text-on-surface-variant">{h.durationMs} ms</td>
                                                <td className="w-16 px-2 py-1 text-right font-mono text-on-surface-variant">{humanSize(h.sizeBytes)}</td>
                                                <td className="truncate px-2 py-1 font-mono text-on-surface-variant/80" title={h.error || h.url}>
                                                    {h.error || h.url}
                                                </td>
                                                <td className="w-28 px-2 py-1 text-right text-on-surface-variant/60">
                                                    {new Date(h.executedAt * 1000).toLocaleString()}
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
                        onApplyRequest={(req) => {
                            setMethod(req.method || 'GET')
                            setUrl(req.url ?? '')
                            setParams(req.params ?? [])
                            setPathVars(req.pathVars ?? [])
                            setHeaders(req.headers ?? [])
                            setBody(new httpclient.Body(req.body ?? {mode: 'none'}))
                            if (req.auth && req.auth.type && req.auth.type !== 'none') setAuth(new httpclient.Auth(req.auth))
                            setDirty(true)
                        }}
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
                title={disabled ? 'No aplica mientras «Seguir redirecciones» esté apagado' : hint}
                className="mt-0.5 shrink-0 accent-primary"
            />
        </div>
    )
}

// Modos de cuerpo ofrecidos, con el porqué de cada uno en el tooltip.
const BODY_MODES: {id: string; label: string; hint: string}[] = [
    {id: 'none', label: 'none', hint: 'Sin cuerpo — lo normal en un GET'},
    {id: 'raw', label: 'raw', hint: 'Texto: JSON, XML, HTML o plano'},
    {id: 'formdata', label: 'form-data', hint: 'Campos y archivos (multipart), como un formulario con adjuntos'},
    {id: 'urlencoded', label: 'x-www-form-urlencoded', hint: 'Campos codificados en la línea, como un formulario web clásico'},
    {id: 'binary', label: 'binary', hint: 'Un archivo del disco como cuerpo entero'},
    {id: 'graphql', label: 'GraphQL', hint: 'Query y variables, empaquetadas como el JSON que espera un servidor GraphQL'},
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
