import {useCallback, useEffect, useRef, useState} from 'react'
import {
    HttpImportDetect,
    HttpImportFiles,
    HttpImportPickFiles,
    HttpImportPickFolder,
    HttpImportText,
} from '../../../wailsjs/go/main/App'
import {httpclient, main, vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import Select from '../Select'
import {registerDropZone} from '../../lib/desktopFileDrop'
import {methodColor} from './httpShared'

// El diálogo de importar del módulo HTTP: una sola puerta para todo lo que
// viene de afuera.
//
// Antes había dos entradas sin relación entre sí —un botón que abría el
// selector de archivos esperando una colección de Postman, y un diálogo
// aparte para pegar un cURL—, así que había que saber de antemano qué clase
// de cosa se tenía y por dónde entraba. Acá se pega o se suelta y la
// aplicación dice qué reconoció ANTES de escribir nada: importar a ciegas y
// después ir a buscar al árbol qué entró es lo que hace que uno no se anime a
// arrastrar un archivo que no recuerda qué tenía.

interface ImportDialogProps {
    collections: vault.HTTPCollection[]
    // Colección preseleccionada para lo que sea UNA petición (un cURL, una
    // URL). "" significa "creá una".
    defaultCollectionId: string
    onClose: () => void
    // Avisa que algo entró, para que el árbol relea y se abra lo importado.
    onImported: (batch: main.HttpImportBatch) => void
}

const PLACEHOLDER = `curl 'https://api.ejemplo.com/pedidos' -H 'Accept: application/json'

…o el JSON de una colección de Postman, una petición en texto plano
(POST /v1/pedidos HTTP/1.1) o una URL suelta.`

export default function ImportDialog({collections, defaultCollectionId, onClose, onImported}: ImportDialogProps) {
    const [text, setText] = useState('')
    const [detection, setDetection] = useState<httpclient.ImportDetection | null>(null)
    const [target, setTarget] = useState(defaultCollectionId)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [batch, setBatch] = useState<main.HttpImportBatch | null>(null)
    const [dragging, setDragging] = useState(false)
    const dropRef = useRef<HTMLDivElement>(null)

    // La detección corre mientras se escribe, con un respiro: pegar un
    // volcado de 4 MB y clasificarlo en cada tecla es trabajo tirado, pero
    // esperar a que alguien apriete un botón para recién decir qué es
    // convierte el diálogo en una apuesta.
    useEffect(() => {
        const raw = text.trim()
        if (!raw) {
            setDetection(null)
            return
        }
        let alive = true
        const timer = setTimeout(() => {
            void HttpImportDetect(raw)
                .then((d) => alive && setDetection(d))
                .catch(() => alive && setDetection(null))
        }, 250)
        return () => {
            alive = false
            clearTimeout(timer)
        }
    }, [text])

    const run = useCallback(
        async (fn: () => Promise<main.HttpImportBatch>) => {
            setBusy(true)
            setError('')
            try {
                const res = await fn()
                setBatch(res)
                if (res && res.items.length > res.failed) onImported(res)
            } catch (e) {
                setError(String(e))
            } finally {
                setBusy(false)
            }
        },
        [onImported],
    )

    const importFiles = useCallback((paths: string[]) => {
        if (paths.length === 0) return
        void run(() => HttpImportFiles(paths))
    }, [run])

    // Arrastre desde el escritorio. Los eventos de arrastre del navegador NO
    // sirven: un WebView recibe solo el NOMBRE del archivo, nunca la ruta, y
    // sin ruta no hay nada que leer. Por eso el gancho nativo de Wails.
    //
    // La zona se registra UNA vez y el handler vive en un ref: el gancho de
    // Wails es global y registrarse es darse de baja y de alta: rehacerlo en
    // cada render del padre deja ventanas en las que un archivo soltado no
    // cae en ningún lado.
    const importRef = useRef(importFiles)
    importRef.current = importFiles
    useEffect(() => {
        const el = dropRef.current
        if (!el) return
        return registerDropZone(el, (paths) => {
            setDragging(false)
            importRef.current(paths)
        })
    }, [])

    // Ese gancho nativo no avisa cuándo algo entra o sale de la zona, así que
    // el resaltado se maneja con los eventos del navegador, que sí llegan
    // aunque el arrastre traiga rutas que el WebView no puede leer.
    useEffect(() => {
        const el = dropRef.current
        if (!el) return
        const over = (e: DragEvent) => {
            e.preventDefault()
            setDragging(true)
        }
        const leave = () => setDragging(false)
        el.addEventListener('dragover', over)
        el.addEventListener('dragleave', leave)
        el.addEventListener('drop', leave)
        return () => {
            el.removeEventListener('dragover', over)
            el.removeEventListener('dragleave', leave)
            el.removeEventListener('drop', leave)
        }
    }, [])

    const isSingleRequest =
        detection?.kind === 'curl' || detection?.kind === 'raw-http' || detection?.kind === 'url'
    const canImport = !!detection && detection.kind !== '' && !busy

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onClick={onClose}>
            <div
                className="flex max-h-[85vh] w-[44rem] max-w-full flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface-container shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-3 py-2">
                    <Icon name="download" size={16} className="text-on-surface-variant" />
                    <p className="flex-1 text-sm font-medium text-on-surface">Importar</p>
                    <button
                        onClick={onClose}
                        title="Cerrar sin importar nada"
                        className="rounded p-1 text-on-surface-variant/60 hover:bg-surface-variant hover:text-on-surface"
                    >
                        <Icon name="close" size={16} />
                    </button>
                </div>

                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
                    <div>
                        <textarea
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                            spellCheck={false}
                            placeholder={PLACEHOLDER}
                            className="h-28 w-full resize-none rounded border border-outline-variant bg-surface-container-lowest px-2 py-1.5 font-mono text-ui-11 text-on-surface outline-none placeholder:text-on-surface-variant/40 focus:border-primary"
                        />
                        <DetectionLine detection={detection} hasText={text.trim() !== ''} />
                    </div>

                    {isSingleRequest && (
                        <div className="flex items-center gap-2 text-ui-11 text-on-surface-variant">
                            <span className="shrink-0">Guardar en</span>
                            {/* El selector temado y no un <select> nativo: ese
                                abre el menú del sistema operativo, que ignora
                                el tema y la tipografía de la app. */}
                            <Select
                                value={target}
                                options={[
                                    {value: '', label: 'Colección nueva', hint: 'Se llama «Importadas»', separatorAfter: collections.length > 0},
                                    ...collections.map((c) => ({
                                        value: c.id,
                                        label: c.name,
                                        icon: c.favoriteAt ? <Icon name="star" size={13} filled className="text-primary" /> : undefined,
                                    })),
                                ]}
                                onChange={setTarget}
                                size="sm"
                                ariaLabel="Colección destino"
                                title="Colección donde queda la petición importada. Una petición que no queda en ningún lado se pierde al cerrar la pestaña."
                                className="min-w-0 flex-1"
                            />
                        </div>
                    )}

                    <div
                        ref={dropRef}
                        className={`flex flex-col items-center justify-center gap-1 rounded border border-dashed py-8 text-center transition-colors ${
                            dragging ? 'border-primary bg-primary/5' : 'border-outline-variant'
                        }`}
                    >
                        <Icon name="upload_file" size={20} className="text-on-surface-variant/60" />
                        <p className="text-ui-11 font-medium text-on-surface">Soltá archivos acá para importarlos</p>
                        <p className="text-ui-10 text-on-surface-variant">
                            o elegí{' '}
                            <button
                                onClick={() => void HttpImportPickFiles().then(importFiles)}
                                title="Elegir uno o varios .json exportados de Postman"
                                className="text-primary underline underline-offset-2 hover:opacity-80"
                            >
                                archivos
                            </button>{' '}
                            o una{' '}
                            <button
                                onClick={() =>
                                    void HttpImportPickFolder().then((dir) => dir && importFiles([dir]))
                                }
                                title="Elegir una carpeta: se recorre entera buscando colecciones y entornos"
                                className="text-primary underline underline-offset-2 hover:opacity-80"
                            >
                                carpeta
                            </button>
                        </p>
                        <p className="mt-1 text-ui-9 text-on-surface-variant/60">
                            Colección de Postman (v2.0/v2.1), entorno o volcado de datos
                        </p>
                    </div>

                    {error && (
                        <p className="rounded bg-error-container px-2 py-1 text-ui-10 text-on-error-container">{error}</p>
                    )}

                    {batch && <BatchSummary batch={batch} />}
                </div>

                <div className="flex shrink-0 items-center justify-end gap-2 border-t border-outline-variant px-3 py-2">
                    <button
                        onClick={onClose}
                        title="Cerrar el diálogo"
                        className="rounded px-3 py-1 text-xs text-on-surface-variant hover:text-on-surface"
                    >
                        {batch ? 'Listo' : 'Cancelar'}
                    </button>
                    <button
                        onClick={() => void run(() => HttpImportText(text, target))}
                        disabled={!canImport}
                        title={
                            canImport
                                ? 'Importar lo que está en la caja'
                                : 'Pegá algo que se pueda reconocer: un cURL, una URL, una petición en texto o el JSON de una colección'
                        }
                        className="rounded bg-primary px-3 py-1 text-xs text-on-primary hover:opacity-90 disabled:opacity-40"
                    >
                        {busy ? 'Importando…' : 'Importar'}
                    </button>
                </div>
            </div>
        </div>
    )
}

// La línea que dice qué se reconoció. Un formato que NO se reconoce muestra
// el motivo: «no se reconoce» pelado deja a quien pegó algo sin nada que
// corregir.
function DetectionLine({detection, hasText}: {detection: httpclient.ImportDetection | null; hasText: boolean}) {
    if (!hasText) {
        return (
            <p className="mt-1 text-ui-10 text-on-surface-variant/60">
                También se puede pegar un cURL en la barra de URL de una petición.
            </p>
        )
    }
    if (!detection) return <p className="mt-1 text-ui-10 text-on-surface-variant/60">Reconociendo…</p>
    if (!detection.kind) {
        return (
            <p className="mt-1 flex items-start gap-1 text-ui-10 text-tertiary">
                <Icon name="help" size={13} className="mt-px shrink-0" />
                <span>{detection.reason}</span>
            </p>
        )
    }
    const bits: string[] = []
    if (detection.name) bits.push(`«${detection.name}»`)
    if (detection.requests) bits.push(`${detection.requests} ${detection.requests === 1 ? 'petición' : 'peticiones'}`)
    if (detection.folders) bits.push(`${detection.folders} ${detection.folders === 1 ? 'carpeta' : 'carpetas'}`)
    if (detection.variables) bits.push(`${detection.variables} ${detection.variables === 1 ? 'variable' : 'variables'}`)
    if (detection.collections) bits.push(`${detection.collections} ${detection.collections === 1 ? 'colección' : 'colecciones'}`)
    return (
        <p className="mt-1 flex items-center gap-1.5 text-ui-10 text-on-surface-variant">
            <Icon name="check_circle" size={13} className="shrink-0 text-secondary" />
            <span className="text-on-surface">Se detectó: {detection.label}</span>
            {detection.method && (
                <span className={`font-mono font-semibold ${methodColor(detection.method)}`}>{detection.method}</span>
            )}
            {detection.url && <span className="truncate font-mono opacity-70">{detection.url}</span>}
            {bits.length > 0 && <span className="opacity-70">· {bits.join(' · ')}</span>}
        </p>
    )
}

// El resumen dice QUÉ entró, uno por uno. Un «importado con éxito» sin
// detalle obliga a ir a contar peticiones al árbol, que es justo lo que no se
// puede hacer con una colección de cuarenta.
function BatchSummary({batch}: {batch: main.HttpImportBatch}) {
    return (
        <div className="rounded border border-outline-variant bg-surface-container-lowest p-2">
            <p className="mb-1.5 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/70">
                {batch.failed > 0 && batch.items.length === batch.failed ? 'No entró nada' : 'Se importó'}
            </p>
            <ul className="space-y-1.5">
                {batch.items.map((o, i) => (
                    <li key={i} className="text-ui-10 leading-relaxed">
                        <span className="flex items-start gap-1.5">
                            <Icon
                                name={o.error ? 'error' : o.kind === 'environment' ? 'layers' : o.kind === 'request' ? 'api' : 'folder_special'}
                                size={13}
                                className={`mt-px shrink-0 ${o.error ? 'text-error' : 'text-secondary'}`}
                            />
                            <span className="min-w-0">
                                <span className="text-on-surface">{o.name}</span>
                                {!o.error && o.kind === 'collection' && (
                                    <span className="text-on-surface-variant">
                                        {' '}
                                        · {o.requests} {o.requests === 1 ? 'petición' : 'peticiones'}
                                        {o.folders > 0 && ` en ${o.folders} ${o.folders === 1 ? 'carpeta' : 'carpetas'}`}
                                    </span>
                                )}
                                {!o.error && o.kind === 'environment' && (
                                    <span className="text-on-surface-variant">
                                        {' '}
                                        · entorno con {o.variables} {o.variables === 1 ? 'variable' : 'variables'}
                                    </span>
                                )}
                                {!o.error && o.kind === 'request' && (
                                    <span className="text-on-surface-variant"> · {o.method} {o.url}</span>
                                )}
                                {o.error && <span className="text-error"> — {o.error}</span>}
                            </span>
                        </span>
                        {o.warnings && o.warnings.length > 0 && (
                            <ul className="ml-5 mt-0.5 space-y-0.5 text-ui-9 text-tertiary">
                                {o.warnings.map((w, j) => (
                                    <li key={j}>· {w}</li>
                                ))}
                            </ul>
                        )}
                    </li>
                ))}
            </ul>
            {batch.skipped > 0 && (
                <p className="mt-1.5 text-ui-9 text-on-surface-variant/70">
                    {batch.skipped} {batch.skipped === 1 ? 'archivo salteado' : 'archivos salteados'} (no eran JSON, o se
                    pasó el tope de 200 por carpeta).
                </p>
            )}
        </div>
    )
}
