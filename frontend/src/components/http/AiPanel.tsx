import {useCallback, useEffect, useState} from 'react'
import {
    AgentDiagnoseHTTP,
    AgentDraftHTTPDocs,
    AgentDraftHTTPTests,
    AgentExplainHTTP,
    AgentGenerateHTTP,
    HttpImportCurl,
} from '../../../wailsjs/go/main/App'
import {httpclient, main} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import MarkdownPreview from '../MarkdownPreview'

// Ayuda con IA sobre una petición: explicar la respuesta, diagnosticar un
// fallo, escribir la petición desde una descripción, redactar la documentación
// y escribir los tests.
//
// **El agente propone y el usuario aplica.** Ninguna de las cinco manda la
// petición ni escribe en la colección: devuelven texto, y lo que lo mete en el
// editor es el botón «Aplicar». Es la misma regla que la IA de bases de datos,
// por el mismo motivo — un asistente que ejecuta contra producción lo que acaba
// de escribir es exactamente el producto que nadie pidió.
//
// **Qué se le manda.** Lo que se ve acá: método, URL con los `{{marcadores}}`
// SIN resolver, cabeceras con los valores de credencial tapados, cuerpo
// recortado, y de la autenticación solo su tipo. El filtrado vive en Go
// (app_httpagent.go), que es el único lado con acceso a las variables.

export type AiAction = 'explain' | 'diagnose' | 'generate' | 'docs' | 'tests'

export const AI_ACTIONS: {id: AiAction; label: string; icon: string; hint: string; needsResponse: boolean}[] = [
    {
        id: 'explain',
        label: 'Explicar la respuesta',
        icon: 'quiz',
        hint: 'Qué contestó la API y qué significa',
        needsResponse: true,
    },
    {
        id: 'diagnose',
        label: 'Diagnosticar el fallo',
        icon: 'troubleshoot',
        hint: 'Por qué falló y qué cambiar',
        needsResponse: true,
    },
    {
        id: 'generate',
        label: 'Escribir la petición…',
        icon: 'auto_fix_high',
        // Se nombra el cURL primero: es de lejos el caso más frecuente —se
        // copia del navegador con «Copy as cURL»— y ahí ni siquiera hace falta
        // el agente (ver el importador del panel).
        hint: 'Pegá un cURL y se importa, o describila',
        needsResponse: false,
    },
    {
        id: 'docs',
        label: 'Redactar la documentación',
        icon: 'menu_book',
        hint: 'Va a la pestaña Docs',
        needsResponse: false,
    },
    {
        id: 'tests',
        label: 'Escribir los tests',
        icon: 'science',
        hint: 'Formato de Postman; esta app no los corre',
        needsResponse: false,
    },
]

interface AiPanelProps {
    action: AiAction
    itemId: string
    request: httpclient.Request
    // La respuesta recibida, o una vacía si todavía no se mandó: `status: 0`
    // es lo que el backend lee como "no hubo respuesta" (ningún servidor
    // contesta con 0). Va como valor y no como null porque Wails no expresa
    // punteros del lado de TypeScript.
    response: httpclient.Response
    errorText: string
    currentDocs: string
    onApplyRequest: (req: httpclient.Request) => void
    onApplyDocs: (markdown: string) => void
    onApplyTests: (code: string) => void
    onClose: () => void
}

export default function AiPanel({
    action,
    itemId,
    request,
    response,
    errorText,
    currentDocs,
    onApplyRequest,
    onApplyDocs,
    onApplyTests,
    onClose,
}: AiPanelProps) {
    const meta = AI_ACTIONS.find((a) => a.id === action)!
    const [prompt, setPrompt] = useState('')
    const [running, setRunning] = useState(false)
    const [answer, setAnswer] = useState('')
    const [generated, setGenerated] = useState<main.HTTPGenerated | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [importing, setImporting] = useState(false)

    // Lo pegado ES un comando cURL, y entonces no hay nada que inventar: se
    // traduce con el mismo parser que usa la importación de la barra lateral
    // (httpclient.ParseCurl), sin agente de por medio.
    //
    // Mandarlo al modelo era el camino largo para un problema resuelto: tarda
    // segundos en vez de nada, depende de que haya un CLI agéntico instalado
    // —quien no tiene ninguno no podía pegar un cURL en toda la app—, gasta
    // cuota, y puede devolver el comando "mejorado": una cabecera menos, un
    // parámetro renombrado. Un `curl` copiado del navegador con «Copy as cURL»
    // hay que reproducirlo EXACTO o deja de reproducir el problema que se está
    // mirando.
    //
    // El agente sigue estando para lo que sí es suyo: escribir la petición
    // desde una descripción, o partir de un cURL y cambiarle algo.
    const looksLikeCurl = /^\s*curl\b/i.test(prompt)

    const run = useCallback(async () => {
        setRunning(true)
        setError(null)
        setAnswer('')
        setGenerated(null)
        try {
            switch (action) {
                case 'explain':
                    setAnswer((await AgentExplainHTTP(itemId, request, response, errorText)) ?? '')
                    break
                case 'diagnose':
                    setAnswer((await AgentDiagnoseHTTP(itemId, request, response, errorText)) ?? '')
                    break
                case 'generate': {
                    const out = await AgentGenerateHTTP(itemId, prompt, request)
                    if (out) {
                        setGenerated(out)
                        setAnswer(out.answer ?? '')
                    }
                    break
                }
                case 'docs':
                    setAnswer((await AgentDraftHTTPDocs(itemId, request, response, currentDocs)) ?? '')
                    break
                case 'tests':
                    setAnswer((await AgentDraftHTTPTests(itemId, request, response)) ?? '')
                    break
            }
        } catch (e) {
            setError(String(e))
        } finally {
            setRunning(false)
        }
    }, [action, itemId, request, response, errorText, currentDocs, prompt])

    const importCurl = useCallback(async () => {
        setImporting(true)
        setError(null)
        try {
            const req = await HttpImportCurl(prompt)
            if (req) {
                onApplyRequest(req as httpclient.Request)
                onClose()
            }
        } catch (e) {
            // El error del parser dice qué parte no entendió. Se muestra tal
            // cual y el panel queda abierto con el texto puesto: casi siempre
            // se arregla borrando una opción que no viaja (`--compressed`) o
            // pegando de nuevo sin el salto de línea de la consola. Y si no,
            // el botón del agente sigue ahí.
            setError(String(e))
        } finally {
            setImporting(false)
        }
    }, [prompt, onApplyRequest, onClose])

    // Las cuatro acciones que no piden nada más arrancan solas: un botón
    // «Ejecutar» que solo repite lo que el usuario ya eligió en el menú es un
    // clic de más. Solo al montar —`run` cambia con cada tecla del pedido, y
    // depender de él dispararía una consulta por letra.
    useEffect(() => {
        if (action !== 'generate') void run()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [action])

    return (
        <div className="flex w-[26rem] shrink-0 flex-col border-l border-outline-variant bg-surface-container-low">
            <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-3 py-2">
                <Icon name={meta.icon} size={16} className="text-primary" />
                <p className="flex-1 truncate text-ui-11 font-medium text-on-surface" title={meta.hint}>
                    {meta.label.replace('…', '')}
                </p>
                {answer && !running && (
                    <button
                        onClick={() => void run()}
                        title="Volver a preguntar"
                        className="rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="refresh" size={14} />
                    </button>
                )}
                <button onClick={onClose} title="Cerrar" className="rounded p-1 text-on-surface-variant hover:bg-surface-variant">
                    <Icon name="close" size={14} />
                </button>
            </div>

            {action === 'generate' && (
                <div className="shrink-0 border-b border-outline-variant p-2">
                    <textarea
                        autoFocus
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        onKeyDown={(e) => {
                            // Con un cURL pegado, Ctrl+Enter importa en vez de
                            // preguntar: es lo que hace el botón principal, y
                            // el atajo tiene que hacer lo mismo que el botón
                            // que está mirando el usuario.
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && prompt.trim()) {
                                if (looksLikeCurl) void importCurl()
                                else void run()
                            }
                        }}
                        placeholder={'Pegá un cURL —se importa tal cual, sin agente— o describí qué tiene que hacer la petición.\n\nCtrl+Enter.'}
                        rows={6}
                        // Monoespaciada en cuanto lo pegado es un comando: un
                        // cURL con seis cabeceras en tipografía de interfaz no
                        // se puede revisar antes de importarlo.
                        className={`w-full resize-none rounded border border-outline-variant bg-surface-container-lowest p-2 text-ui-11 leading-relaxed text-on-surface outline-none placeholder:text-on-surface-variant/40 ${
                            looksLikeCurl ? 'font-mono' : ''
                        }`}
                    />

                    {looksLikeCurl ? (
                        <>
                            <div className="mt-2 flex gap-1.5">
                                <button
                                    onClick={() => void importCurl()}
                                    disabled={importing}
                                    title="Traduce el comando exactamente como está —método, URL, cabeceras, cuerpo— y lo pone en el editor. No pasa por el agente: es instantáneo, no gasta cuota y no cambia nada de lo que pegaste."
                                    className="flex flex-1 items-center justify-center gap-1.5 rounded bg-primary px-3 py-1 text-ui-11 text-on-primary hover:opacity-90 disabled:opacity-40"
                                >
                                    <Icon name="content_paste" size={14} />
                                    {importing ? 'Importando…' : 'Importar tal cual'}
                                </button>
                                <button
                                    onClick={() => void run()}
                                    disabled={running}
                                    title="Mandarle el comando al agente en vez de importarlo. Sirve cuando además querés que le cambie algo: «este cURL pero contra staging y sin el header de traza»."
                                    className="flex shrink-0 items-center gap-1.5 rounded border border-outline-variant px-3 py-1 text-ui-11 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-40"
                                >
                                    <Icon name="auto_fix_high" size={14} />
                                    {running ? 'Pensando…' : 'Pedirle un cambio'}
                                </button>
                            </div>
                            <p className="mt-1.5 text-ui-10 leading-relaxed text-on-surface-variant/70">
                                Detecté un comando cURL. Importarlo lo reproduce <strong>exacto</strong> y no usa el agente; pedile un cambio
                                solo si querés que además lo modifique.
                            </p>
                        </>
                    ) : (
                        <button
                            onClick={() => void run()}
                            disabled={running || !prompt.trim()}
                            title="Le describís qué tiene que hacer la petición y el agente la escribe. Devuelve texto: aplicarla al editor es un clic tuyo."
                            className="mt-2 w-full rounded bg-primary px-3 py-1 text-ui-11 text-on-primary hover:opacity-90 disabled:opacity-40"
                        >
                            {running ? 'Pensando…' : 'Escribir la petición'}
                        </button>
                    )}
                </div>
            )}

            {error && (
                <p className="shrink-0 bg-error-container px-3 py-1.5 text-ui-11 leading-relaxed text-on-error-container">{error}</p>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-ui-11 leading-relaxed text-on-surface">
                {running && !answer && (
                    <p className="flex items-center gap-2 text-on-surface-variant">
                        <Icon name="hourglass_empty" size={14} className="animate-pulse" />
                        Preguntándole al agente…
                    </p>
                )}
                {answer && (action === 'tests' ? <pre className="whitespace-pre-wrap font-mono">{answer}</pre> : <MarkdownPreview source={answer} />)}
            </div>

            {answer && !running && (
                <div className="shrink-0 border-t border-outline-variant p-2">
                    {action === 'generate' &&
                        (generated?.request ? (
                            <button
                                onClick={() => {
                                    onApplyRequest(generated.request as httpclient.Request)
                                    onClose()
                                }}
                                title="Reemplazar método, URL, cabeceras y cuerpo con lo que propuso el agente. Podés deshacerlo sin guardar."
                                className="w-full rounded bg-primary px-3 py-1 text-ui-11 text-on-primary hover:opacity-90"
                            >
                                Aplicar al editor
                            </button>
                        ) : (
                            <p className="text-ui-10 leading-relaxed text-on-surface-variant">
                                El comando que devolvió no se pudo interpretar como una petición, así que no hay nada que aplicar automáticamente.
                                Copialo del bloque de arriba.
                            </p>
                        ))}
                    {action === 'docs' && (
                        <button
                            onClick={() => {
                                onApplyDocs(answer)
                                onClose()
                            }}
                            title="Poner este texto en la pestaña Docs de la petición. Se guarda con Ctrl+S como cualquier otro cambio."
                            className="w-full rounded bg-primary px-3 py-1 text-ui-11 text-on-primary hover:opacity-90"
                        >
                            Poner en Docs
                        </button>
                    )}
                    {action === 'tests' && (
                        <>
                            <button
                                onClick={() => {
                                    onApplyTests(answer)
                                    onClose()
                                }}
                                title="Poner este script en el campo de tests. Se guarda y se exporta con la colección."
                                className="w-full rounded bg-primary px-3 py-1 text-ui-11 text-on-primary hover:opacity-90"
                            >
                                Poner en el script de tests
                            </button>
                            <p className="mt-2 text-ui-10 leading-relaxed text-on-surface-variant">
                                Esta aplicación no ejecuta scripts: el test se guarda y viaja en el export, y quien lo corre es Postman o newman.
                            </p>
                        </>
                    )}
                </div>
            )}
        </div>
    )
}
