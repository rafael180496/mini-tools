import {useCallback, useEffect, useState} from 'react'
import {HttpClearCookies, HttpCookies} from '../../../wailsjs/go/main/App'
import {httpclient} from '../../../wailsjs/go/models'
import Icon from '../Icon'

// Las cookies que el cliente guardó, por dominio.
//
// **Hay un tarro por ENTORNO**, no por colección: probar producción y
// desarrollo a la vez es el caso normal, y las dos pruebas usan la misma
// colección. Un tarro por colección haría que la segunda petición saliera con
// la sesión de la primera — un error carísimo de ver.
//
// **Viven en memoria**: al cerrar la aplicación se pierden. Una cookie de
// sesión es una credencial viva, y guardarla en disco obliga a cifrarla y a
// explicar por qué una sesión sobrevive a cerrar el programa. Volver a hacer
// login es una petición más de la misma colección.

interface CookiesDialogProps {
    // Colección desde la que se abre: decide qué entorno —y por lo tanto qué
    // tarro— se está mirando.
    collectionId: string
    collectionName: string
    onClose: () => void
}

export default function CookiesDialog({collectionId, collectionName, onClose}: CookiesDialogProps) {
    const [cookies, setCookies] = useState<httpclient.Cookie[]>([])
    const [revealed, setRevealed] = useState<Set<string>>(new Set())
    const [error, setError] = useState<string | null>(null)

    const load = useCallback(async () => {
        try {
            setCookies((await HttpCookies(collectionId)) ?? [])
        } catch (e) {
            setError(String(e))
        }
    }, [collectionId])

    useEffect(() => {
        void load()
    }, [load])

    const domains = [...new Set(cookies.map((c) => c.domain))].sort()

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
            <div
                className="flex h-[28rem] w-[40rem] max-w-full flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface-container shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-3 py-2">
                    <Icon name="cookie" size={16} className="text-on-surface-variant" />
                    <p className="flex-1 text-sm font-medium text-on-surface">Cookies de «{collectionName}»</p>
                    {cookies.length > 0 && (
                        <button
                            onClick={() =>
                                void HttpClearCookies(collectionId, '')
                                    .then(load)
                                    .catch((e) => setError(String(e)))
                            }
                            title="Vaciar el tarro entero de este entorno: equivale a cerrar sesión en todos los dominios."
                            className="rounded border border-outline-variant px-2 py-0.5 text-[11px] text-on-surface-variant hover:bg-surface-variant"
                        >
                            Borrar todas
                        </button>
                    )}
                    <button onClick={onClose} title="Cerrar" className="rounded p-1 text-on-surface-variant hover:bg-surface-variant">
                        <Icon name="close" size={16} />
                    </button>
                </div>

                {error && <p className="shrink-0 bg-error-container px-3 py-1 text-[11px] text-on-error-container">{error}</p>}

                <div className="min-h-0 flex-1 overflow-y-auto">
                    {cookies.length === 0 && (
                        <p className="px-3 py-4 text-[11px] leading-relaxed text-on-surface-variant">
                            Todavía no hay cookies en este entorno. Aparecen solas cuando un servidor manda una: el login de una petición vale para las
                            siguientes sin copiar nada a mano.
                        </p>
                    )}
                    {domains.map((domain) => (
                        <div key={domain}>
                            <div className="flex items-center gap-2 bg-surface-container-lowest px-3 py-1">
                                <span className="flex-1 truncate font-mono text-[11px] text-on-surface">{domain}</span>
                                <button
                                    onClick={() =>
                                        void HttpClearCookies(collectionId, domain)
                                            .then(load)
                                            .catch((e) => setError(String(e)))
                                    }
                                    title={`Borrar las cookies de ${domain}: la próxima petición a ese dominio sale sin sesión.`}
                                    className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-error"
                                >
                                    <Icon name="delete" size={14} />
                                </button>
                            </div>
                            {cookies
                                .filter((c) => c.domain === domain)
                                .map((c) => {
                                    const key = `${c.domain}|${c.name}`
                                    const shown = revealed.has(key)
                                    return (
                                        <div key={key} className="flex items-center gap-2 border-b border-outline-variant/40 px-3 py-1 text-[11px]">
                                            <span className="w-40 shrink-0 truncate font-mono text-on-surface" title={c.name}>
                                                {c.name}
                                            </span>
                                            <span className="min-w-0 flex-1 truncate font-mono text-on-surface-variant" title={shown ? c.value : undefined}>
                                                {shown ? c.value : '•'.repeat(Math.min(24, Math.max(6, c.value.length)))}
                                            </span>
                                            <button
                                                onClick={() =>
                                                    setRevealed((prev) => {
                                                        const next = new Set(prev)
                                                        if (shown) next.delete(key)
                                                        else next.add(key)
                                                        return next
                                                    })
                                                }
                                                title={shown ? 'Volver a ocultar el valor' : 'Ver el valor. Una cookie de sesión es una credencial: por eso viene tapada.'}
                                                className="shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant"
                                            >
                                                <Icon name={shown ? 'visibility_off' : 'visibility'} size={13} />
                                            </button>
                                        </div>
                                    )
                                })}
                        </div>
                    ))}
                </div>

                <p className="shrink-0 border-t border-outline-variant px-3 py-2 text-[10px] leading-relaxed text-on-surface-variant/70">
                    Hay un tarro por entorno: probar producción y desarrollo a la vez no mezcla las sesiones. Viven en memoria — al cerrar la aplicación
                    se pierden, y volver a hacer login es una petición más de la colección.
                </p>
            </div>
        </div>
    )
}
