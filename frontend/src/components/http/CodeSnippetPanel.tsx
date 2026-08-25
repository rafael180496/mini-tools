import {useCallback, useEffect, useState} from 'react'
import {HttpCodeLanguages, HttpGenerateCode} from '../../../wailsjs/go/main/App'
import {httpclient} from '../../../wailsjs/go/models'
import Icon from '../Icon'

// El panel de "Code snippet": la misma petición escrita en el lenguaje que
// use quien la va a llevar a producción.
//
// El snippet se genera con las variables YA RESUELTAS —uno con {{HOST}}
// adentro no sirve para pegarlo en ningún lado— y con los secretos
// enmascarados por defecto: el uso típico es pegarlo en un ticket o un chat,
// y ahí un token real es una filtración. Mostrarlos es una decisión
// consciente, con su interruptor.

interface CodeSnippetPanelProps {
    itemId: string
    request: httpclient.Request
    onClose: () => void
}

export default function CodeSnippetPanel({itemId, request, onClose}: CodeSnippetPanelProps) {
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

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
            <div
                className="flex h-[30rem] w-[46rem] max-w-full flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface-container shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-outline-variant px-3 py-2">
                    <Icon name="code" size={16} className="text-on-surface-variant" />
                    <p className="text-sm font-medium text-on-surface">Código</p>

                    <select
                        value={lang}
                        onChange={(e) => setLang(e.target.value)}
                        title="Lenguaje del snippet"
                        className="rounded bg-surface-container-highest px-2 py-1 text-ui-11 text-on-surface outline-none focus:ring-1 focus:ring-primary"
                    >
                        {languages.map((l) => (
                            <option key={l.id} value={l.id}>
                                {l.label}
                            </option>
                        ))}
                    </select>

                    <label
                        className="flex items-center gap-1 text-ui-11 text-on-surface-variant"
                        title="Por defecto los valores que vienen de variables secretas salen tapados: un snippet suele terminar pegado en un ticket o un chat. Encendelo solo si el destino es de confianza."
                    >
                        <input type="checkbox" checked={withSecrets} onChange={(e) => setWithSecrets(e.target.checked)} className="accent-primary" />
                        Incluir secretos
                    </label>

                    <button
                        onClick={() => {
                            void navigator.clipboard.writeText(code)
                            setCopied(true)
                            window.setTimeout(() => setCopied(false), 1500)
                        }}
                        title="Copiar el snippet al portapapeles"
                        className="ml-auto rounded bg-primary px-3 py-1 text-ui-11 text-on-primary hover:opacity-90"
                    >
                        {copied ? 'Copiado' : 'Copiar'}
                    </button>
                    <button onClick={onClose} title="Cerrar" className="rounded p-1 text-on-surface-variant hover:bg-surface-variant">
                        <Icon name="close" size={16} />
                    </button>
                </div>

                {withSecrets && (
                    <p className="shrink-0 bg-error-container px-3 py-1 text-ui-10 text-on-error-container">
                        Este snippet incluye credenciales reales. No lo pegues en un ticket, un chat ni un repositorio.
                    </p>
                )}
                {error && <p className="shrink-0 bg-error-container px-3 py-1 text-ui-10 text-on-error-container">{error}</p>}

                <pre className="min-h-0 flex-1 overflow-auto bg-surface-container-lowest p-3 font-mono text-ui-11 leading-relaxed text-on-surface">
                    {code}
                </pre>
            </div>
        </div>
    )
}
