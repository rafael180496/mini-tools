import {useCallback, useEffect, useMemo, useState} from 'react'
import {HttpCodeLanguages, HttpGenerateCode} from '../../../wailsjs/go/main/App'
import {httpclient} from '../../../wailsjs/go/models'
import type {LanguageId} from '../../codemirror/languageRegistry'
import type {EditorAppearance} from '../../codemirror/editorAppearance'
import type {Theme} from '../../hooks/useTheme'
import Icon from '../Icon'
import Select from '../Select'
import Toggle from '../Toggle'
import CodePane from './CodePane'
import {methodColor} from './httpShared'

// El panel de "Code snippet": la misma petición escrita en el lenguaje que
// use quien la va a llevar a producción.
//
// El snippet se genera con las variables YA RESUELTAS —uno con {{HOST}}
// adentro no sirve para pegarlo en ningún lado— y con los secretos
// enmascarados por defecto: el uso típico es pegarlo en un ticket o un chat,
// y ahí un token real es una filtración. Mostrarlos es una decisión
// consciente, con su interruptor.
//
// # Por qué el código va en CodeMirror y no en un <pre>
//
// Un `<pre>` de un solo color obliga a leer diez líneas de shell buscando
// dónde termina el header y empieza el cuerpo, que es justo lo que uno va a
// revisar antes de pegarlo. CodePane trae el MISMO resaltado y la misma
// fuente que el editor de la app —incluido el tamaño de letra elegido—, así
// que el snippet se lee igual que el código del resto del programa.

interface CodeSnippetPanelProps {
    itemId: string
    request: httpclient.Request
    editorThemeId: string
    appTheme: Theme
    appearance: EditorAppearance
    onClose: () => void
}

// Con qué resaltador se dibuja cada lenguaje del generador. `http` no tiene
// modo propio en el registro y cae en texto plano: inventarle uno parecido
// (shell, por ejemplo) pintaría de colores cosas que no son lo que dice.
const SNIPPET_LANG: Record<string, LanguageId> = {
    curl: 'shell',
    http: 'plaintext',
    go: 'go',
    javascript: 'javascript',
    python: 'python',
    java: 'java',
    csharp: 'csharp',
    php: 'php',
    ruby: 'ruby',
    powershell: 'powershell',
}

export default function CodeSnippetPanel({
    itemId,
    request,
    editorThemeId,
    appTheme,
    appearance,
    onClose,
}: CodeSnippetPanelProps) {
    const [languages, setLanguages] = useState<httpclient.CodeLanguage[]>([])
    const [lang, setLang] = useState('curl')
    const [withSecrets, setWithSecrets] = useState(false)
    const [code, setCode] = useState('')
    const [copied, setCopied] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        void HttpCodeLanguages()
            .then((l) => setLanguages(l ?? []))
            .catch(() => {})
    }, [])

    const regenerate = useCallback(async () => {
        setError(null)
        try {
            setCode(await HttpGenerateCode(itemId, request, lang, withSecrets))
        } catch (e) {
            setError(String(e))
        }
    }, [itemId, request, lang, withSecrets])

    useEffect(() => {
        void regenerate()
    }, [regenerate])

    // El generador rotula «Go — net/http»: el nombre del lenguaje y la
    // librería con la que escribe el snippet. En el selector se parten en
    // rótulo y aclaración, así que la lista se escanea por lenguaje —que es
    // como se busca— y la librería queda disponible sin competir con él.
    const options = useMemo(
        () =>
            languages.map((l) => {
                const [name, lib] = l.label.split(' — ')
                return {value: l.id, label: name, hint: lib}
            }),
        [languages],
    )

    const lineCount = code ? code.split('\n').length : 0

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onClick={onClose}>
            <div
                className="flex h-[34rem] w-[52rem] max-w-full flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface-container shadow-2xl"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Dos filas y no una: antes el título, el selector, el
                    interruptor de secretos y dos botones compartían renglón y
                    en una ventana angosta se plegaban en dos filas desparejas.
                    Arriba qué es y sobre qué petición; abajo, los controles. */}
                <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-4 py-2.5">
                    <Icon name="code" size={18} className="text-primary" />
                    <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium leading-tight text-on-surface">Código</p>
                        <p className="flex items-center gap-1.5 truncate text-ui-10 leading-tight text-on-surface-variant">
                            <span className={`font-mono font-semibold ${methodColor(request.method || 'GET')}`}>
                                {(request.method || 'GET').toUpperCase()}
                            </span>
                            <span className="truncate font-mono">{request.url || 'sin URL'}</span>
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        title="Cerrar"
                        className="shrink-0 rounded-lg p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="close" size={16} />
                    </button>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-outline-variant px-4 py-2">
                    {/* El selector temado de la app y no un <select> nativo: el
                        nativo abre el menú del sistema operativo, que ignora el
                        tema y la tipografía elegidos —una lista blanca sobre
                        una app oscura, como se veía acá. */}
                    <Select
                        value={lang}
                        options={options}
                        onChange={setLang}
                        size="sm"
                        ariaLabel="Lenguaje del snippet"
                        title="Lenguaje del snippet. La petición se escribe con las variables ya resueltas, lista para pegar."
                        className="w-56"
                    />

                    <label
                        className="flex cursor-pointer items-center gap-2 text-ui-11 text-on-surface-variant"
                        title="Por defecto los valores que vienen de variables secretas salen tapados: un snippet suele terminar pegado en un ticket o un chat. Encendelo solo si el destino es de confianza."
                    >
                        <Toggle
                            checked={withSecrets}
                            onChange={setWithSecrets}
                            size="sm"
                            ariaLabel="Incluir secretos en el snippet"
                        />
                        Incluir secretos
                    </label>

                    <span className="ml-auto shrink-0 font-mono text-ui-9 tabular-nums text-on-surface-variant/50">
                        {lineCount} {lineCount === 1 ? 'línea' : 'líneas'}
                    </span>

                    <button
                        onClick={() => {
                            void navigator.clipboard.writeText(code)
                            setCopied(true)
                            window.setTimeout(() => setCopied(false), 1500)
                        }}
                        disabled={!code}
                        title="Copiar el snippet al portapapeles"
                        className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1 text-ui-11 text-on-primary hover:opacity-90 disabled:opacity-40"
                    >
                        <Icon name={copied ? 'check' : 'content_copy'} size={14} />
                        {copied ? 'Copiado' : 'Copiar'}
                    </button>
                </div>

                {withSecrets && (
                    <p className="flex shrink-0 items-center gap-1.5 bg-error-container px-4 py-1.5 text-ui-10 text-on-error-container">
                        <Icon name="warning" size={13} className="shrink-0" />
                        Este snippet incluye credenciales reales. No lo pegues en un ticket, un chat ni un repositorio.
                    </p>
                )}
                {error && (
                    <p className="flex shrink-0 items-center gap-1.5 bg-error-container px-4 py-1.5 text-ui-10 text-on-error-container">
                        <Icon name="error" size={13} className="shrink-0" />
                        {error}
                    </p>
                )}

                {/* `key` por lenguaje: CodePane recarga el resaltador cuando
                    cambia `language`, pero el documento entero cambia también
                    —es otro snippet—, y remontarlo evita arrastrar el scroll
                    de un lenguaje al siguiente. */}
                <div className="min-h-0 flex-1 overflow-hidden bg-surface-container-lowest">
                    <CodePane
                        key={lang}
                        value={code}
                        language={SNIPPET_LANG[lang] ?? 'plaintext'}
                        readOnly
                        editorThemeId={editorThemeId}
                        appTheme={appTheme}
                        appearance={appearance}
                        placeholder="Generando…"
                    />
                </div>
            </div>
        </div>
    )
}
