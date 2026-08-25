import {useCallback, useEffect, useMemo, useState} from 'react'
import {
    HttpDeleteCollection,
    HttpDeleteItem,
    HttpExportPostman,
    HttpImportCurl,
    HttpImportPostman,
    HttpListCollections,
    HttpListItems,
    HttpSaveCollection,
    HttpSaveItem,
} from '../../../wailsjs/go/main/App'
import {httpclient, vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'
// ContextMenu vive bajo components/git/ porque nació ahí, pero no tiene nada
// de Git adentro: es un menú anclado con portal. Se importa en vez de
// copiarlo — dos implementaciones del mismo menú divergen, y moverlo
// obligaría a tocar media docena de archivos de Git sin ganar nada.
import ContextMenu from '../git/ContextMenu'
import type {DropdownItem} from '../git/DropdownMenu'
import ConfirmDialog from '../ConfirmDialog'
import {methodColor, parseComputed, parseVariables, type HttpComputed, type HttpVariable} from './httpShared'
import EnvironmentsDialog from './EnvironmentsDialog'
import HttpDocsDialog from './HttpDocsDialog'
import RunPanel from './RunPanel'
import CookiesDialog from './CookiesDialog'
import VariablesTable from './VariablesTable'
import AuthPanel from './AuthPanel'
import ComputedTable from './ComputedTable'

// Árbol de colecciones del módulo HTTP.
//
// Misma forma que el resto de los árboles de la barra lateral (conexiones,
// repositorios, notas): las filas llegan PLANAS desde el vault y el árbol se
// arma acá con parent_id. Es lo que permite que mover un ítem sea un UPDATE
// de una columna y no una reescritura de la estructura.

interface HttpTreeProps {
    filter: string
    // Petición abierta en la pestaña activa, para marcarla en el árbol.
    activeItemId: string | null
    onOpenRequest: (item: vault.HTTPItem) => void
    // Sube cuando algo cambió afuera (renombrar desde la pestaña, por
    // ejemplo) y el árbol tiene que releer.
    refreshToken: number
    onChanged: () => void
    // Abre una nota en el módulo de notas. Lo usa la documentación publicada
    // de una colección para poder saltar a lo que acaba de escribir.
    onOpenNote?: (noteId: string) => void
    // Abre una petición rápida: una pestaña para probar un endpoint sin
    // guardarla en ninguna colección.
    onNewScratch: () => void
}

interface PendingPrompt {
    title: string
    label: string
    initial: string
    confirmLabel: string
    onSubmit: (value: string) => void
}

export default function HttpTree({filter, activeItemId, onOpenRequest, refreshToken, onChanged, onOpenNote, onNewScratch}: HttpTreeProps) {
    const [collections, setCollections] = useState<vault.HTTPCollection[]>([])
    const [itemsByCollection, setItemsByCollection] = useState<Record<string, vault.HTTPItem[]>>({})
    const [expanded, setExpanded] = useState<Set<string>>(new Set())
    const [menu, setMenu] = useState<{x: number; y: number; items: (DropdownItem | 'separator')[]} | null>(null)
    const [prompt, setPrompt] = useState<PendingPrompt | null>(null)
    const [promptValue, setPromptValue] = useState('')
    const [confirm, setConfirm] = useState<{title: string; description: string; run: () => Promise<unknown>} | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [showEnvironments, setShowEnvironments] = useState(false)
    // Colección cuyas variables se están editando. Su propio diálogo y no una
    // pestaña del editor: las variables son de la COLECCIÓN, y meterlas
    // adentro de una petición sugeriría que son suyas.
    const [varsFor, setVarsFor] = useState<vault.HTTPCollection | null>(null)
    const [varsRows, setVarsRows] = useState<HttpVariable[]>([])
    // Autenticación de una colección o de una carpeta: es el nivel del que
    // heredan sus peticiones, y es lo que hace que cambiar un token sea UNA
    // edición y no treinta.
    const [authFor, setAuthFor] = useState<{kind: 'collection' | 'folder'; id: string; name: string; collectionId: string} | null>(null)
    const [authDraft, setAuthDraft] = useState<httpclient.Auth>(new httpclient.Auth({type: 'inherit'}))
    // Variables calculadas de la colección: el nivel donde más sirven, porque
    // una firma suele aplicar a TODAS sus peticiones. Sin esto, el motor las
    // soportaba pero había que repetirlas petición por petición.
    const [computedFor, setComputedFor] = useState<vault.HTTPCollection | null>(null)
    const [computedRows, setComputedRows] = useState<HttpComputed[]>([])
    // Resumen del último import, para decir qué entró en vez de dejar al
    // usuario contando peticiones en el árbol.
    const [importSummary, setImportSummary] = useState<{name: string; requests: number; folders: number; warnings: string[]} | null>(null)
    // Pegar un comando cURL: la vía más corta desde "el navegador me dio
    // esto" hasta "puedo modificarlo y reenviarlo".
    const [curlFor, setCurlFor] = useState<vault.HTTPCollection | null>(null)
    // Colección cuya documentación se está viendo o publicando.
    const [docsFor, setDocsFor] = useState<vault.HTTPCollection | null>(null)
    // Corrida en curso (colección entera o una carpeta) y tarro de cookies.
    const [runFor, setRunFor] = useState<{collectionId: string; folderId: string; title: string} | null>(null)
    const [cookiesFor, setCookiesFor] = useState<vault.HTTPCollection | null>(null)
    const [curlText, setCurlText] = useState('')

    const reloadCollections = useCallback(async () => {
        try {
            setCollections((await HttpListCollections()) ?? [])
        } catch (e) {
            setError(String(e))
        }
    }, [])

    const reloadItems = useCallback(async (collectionId: string) => {
        try {
            const items = (await HttpListItems(collectionId)) ?? []
            setItemsByCollection((prev) => ({...prev, [collectionId]: items}))
        } catch (e) {
            setError(String(e))
        }
    }, [])

    useEffect(() => {
        void reloadCollections()
    }, [reloadCollections, refreshToken])

    // Los ítems se cargan solo de las colecciones ABIERTAS. Con veinte
    // colecciones guardadas, leerlas todas al abrir la barra sería descifrar
    // cientos de cuerpos para dibujar veinte renglones plegados.
    useEffect(() => {
        for (const id of expanded) {
            if (collections.some((c) => c.id === id)) void reloadItems(id)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [expanded, collections, refreshToken])

    const query = filter.trim().toLowerCase()

    // Con una búsqueda activa se abren todas las colecciones: dejar el
    // resultado escondido adentro de una carpeta plegada haría parecer que
    // no hay coincidencias.
    const forceOpen = query !== ''
    useEffect(() => {
        if (!forceOpen) return
        setExpanded(new Set(collections.map((c) => c.id)))
    }, [forceOpen, collections])

    function toggle(id: string) {
        setExpanded((prev) => {
            const next = new Set(prev)
            next.has(id) ? next.delete(id) : next.add(id)
            return next
        })
    }

    const guard = useCallback(
        async (fn: () => Promise<unknown>) => {
            setError(null)
            try {
                await fn()
                onChanged()
                await reloadCollections()
            } catch (e) {
                setError(String(e))
            }
        },
        [onChanged, reloadCollections],
    )

    function askName(spec: PendingPrompt) {
        setPromptValue(spec.initial)
        setPrompt(spec)
    }

    // --- altas -------------------------------------------------------------

    function newCollection() {
        askName({
            title: 'Nueva colección',
            label: 'Nombre',
            initial: '',
            confirmLabel: 'Crear',
            onSubmit: (name) =>
                void guard(async () => {
                    const c = await HttpSaveCollection(new vault.HTTPCollection({name}))
                    if (c) setExpanded((prev) => new Set([...prev, c.id]))
                }),
        })
    }

    function newItem(collectionId: string, parentId: string, kind: 'folder' | 'request') {
        askName({
            title: kind === 'folder' ? 'Nueva carpeta' : 'Nueva petición',
            label: 'Nombre',
            initial: '',
            confirmLabel: 'Crear',
            onSubmit: (name) =>
                void guard(async () => {
                    const created = await HttpSaveItem(
                        new vault.HTTPItem({
                            collectionId,
                            parentId,
                            kind,
                            name,
                            // Una petición nace en GET: es el método que no
                            // modifica nada, así que es el único seguro para
                            // que alguien apriete "Enviar" sin leer.
                            method: kind === 'request' ? 'GET' : '',
                        }),
                    )
                    await reloadItems(collectionId)
                    setExpanded((prev) => new Set([...prev, collectionId, ...(parentId ? [parentId] : [])]))
                    if (created && kind === 'request') onOpenRequest(created)
                }),
        })
    }

    // --- menús -------------------------------------------------------------

    function collectionMenu(c: vault.HTTPCollection, e: React.MouseEvent) {
        e.preventDefault()
        setMenu({
            x: e.clientX,
            y: e.clientY,
            items: [
                {label: 'Nueva petición…', icon: 'add', onSelect: () => newItem(c.id, '', 'request')},
                {label: 'Nueva carpeta…', icon: 'create_new_folder', onSelect: () => newItem(c.id, '', 'folder')},
                'separator',
                {
                    label: 'Pegar un comando cURL…',
                    icon: 'content_paste',
                    hint: 'Crea una petición desde un «Copy as cURL»',
                    onSelect: () => {
                        setCurlText('')
                        setCurlFor(c)
                    },
                },
                {
                    label: 'Exportar a Postman…',
                    icon: 'upload',
                    hint: 'Archivo .json compatible',
                    onSelect: () =>
                        void guard(async () => {
                            const dest = await HttpExportPostman(c.id)
                            if (dest) setImportSummary({name: `Exportada a ${dest}`, requests: 0, folders: 0, warnings: []})
                        }),
                },
                'separator',
                {
                    label: 'Autenticación de la colección…',
                    icon: 'key',
                    hint: 'La heredan todas sus peticiones',
                    onSelect: () => {
                        setAuthDraft(parseAuth(c.auth))
                        setAuthFor({kind: 'collection', id: c.id, name: c.name, collectionId: c.id})
                    },
                },
                {
                    label: 'Variables de la colección…',
                    icon: 'data_object',
                    hint: 'Valores por defecto que el entorno puede pisar',
                    onSelect: () => {
                        setVarsRows(parseVariables(c.variables))
                        setVarsFor(c)
                    },
                },
                {
                    label: 'Correr la colección',
                    icon: 'play_arrow',
                    hint: 'Todas sus peticiones, en orden',
                    onSelect: () => setRunFor({collectionId: c.id, folderId: '', title: c.name}),
                },
                {
                    label: 'Cookies…',
                    icon: 'cookie',
                    hint: 'Las del entorno con el que corre',
                    onSelect: () => setCookiesFor(c),
                },
                'separator',
                {
                    label: 'Documentación…',
                    icon: 'menu_book',
                    hint: 'Publicarla como nota del vault',
                    onSelect: () => setDocsFor(c),
                },
                {
                    label: 'Variables calculadas…',
                    icon: 'functions',
                    hint: 'Firmas y tokens derivados, para todas sus peticiones',
                    onSelect: () => {
                        setComputedRows(parseComputed(c.computed))
                        setComputedFor(c)
                    },
                },
                {
                    label: 'Renombrar…',
                    icon: 'edit',
                    onSelect: () =>
                        askName({
                            title: 'Renombrar colección',
                            label: 'Nombre',
                            initial: c.name,
                            confirmLabel: 'Guardar',
                            onSubmit: (name) => void guard(() => HttpSaveCollection(new vault.HTTPCollection({...c, name}))),
                        }),
                },
                {
                    label: 'Borrar colección',
                    icon: 'delete',
                    danger: true,
                    onSelect: () =>
                        setConfirm({
                            title: 'Borrar la colección',
                            description: `Se borra "${c.name}" con todas sus carpetas, sus peticiones y su historial. No se puede deshacer.`,
                            run: () => HttpDeleteCollection(c.id),
                        }),
                },
            ],
        })
    }

    function itemMenu(it: vault.HTTPItem, e: React.MouseEvent) {
        e.preventDefault()
        const items: (DropdownItem | 'separator')[] = []
        if (it.kind === 'folder') {
            items.push(
                {label: 'Nueva petición acá…', icon: 'add', onSelect: () => newItem(it.collectionId, it.id, 'request')},
                {label: 'Nueva carpeta acá…', icon: 'create_new_folder', onSelect: () => newItem(it.collectionId, it.id, 'folder')},
                {
                    label: 'Correr esta carpeta',
                    icon: 'play_arrow',
                    hint: 'Sus peticiones y las de sus subcarpetas, en orden',
                    onSelect: () => setRunFor({collectionId: it.collectionId, folderId: it.id, title: it.name}),
                },
                {
                    label: 'Autenticación de la carpeta…',
                    icon: 'key',
                    hint: 'La heredan las peticiones de adentro',
                    onSelect: () => {
                        setAuthDraft(parseAuth(it.auth))
                        setAuthFor({kind: 'folder', id: it.id, name: it.name, collectionId: it.collectionId})
                    },
                },
                'separator',
            )
        }
        items.push(
            {
                label: 'Renombrar…',
                icon: 'edit',
                onSelect: () =>
                    askName({
                        title: it.kind === 'folder' ? 'Renombrar carpeta' : 'Renombrar petición',
                        label: 'Nombre',
                        initial: it.name,
                        confirmLabel: 'Guardar',
                        onSubmit: (name) =>
                            void guard(async () => {
                                await HttpSaveItem(new vault.HTTPItem({...it, name}))
                                await reloadItems(it.collectionId)
                            }),
                    }),
            },
            {
                label: it.kind === 'folder' ? 'Borrar carpeta' : 'Borrar petición',
                icon: 'delete',
                danger: true,
                onSelect: () =>
                    setConfirm({
                        title: it.kind === 'folder' ? 'Borrar la carpeta' : 'Borrar la petición',
                        description:
                            it.kind === 'folder'
                                ? `Se borra "${it.name}" con todo lo que tenga adentro. No se puede deshacer.`
                                : `Se borra "${it.name}" y su historial de ejecuciones. No se puede deshacer.`,
                        run: async () => {
                            await HttpDeleteItem(it.id)
                            await reloadItems(it.collectionId)
                        },
                    }),
            },
        )
        setMenu({x: e.clientX, y: e.clientY, items})
    }

    // --- árbol -------------------------------------------------------------

    // Un ítem coincide si su nombre o su URL coinciden; una carpeta coincide
    // además si algo adentro coincide, porque si no el resultado quedaría
    // colgando de una carpeta invisible.
    const matches = useCallback(
        (it: vault.HTTPItem, all: vault.HTTPItem[]): boolean => {
            if (!query) return true
            const own = it.name.toLowerCase().includes(query) || (it.url ?? '').toLowerCase().includes(query)
            if (own) return true
            if (it.kind !== 'folder') return false
            return all.filter((c) => c.parentId === it.id).some((c) => matches(c, all))
        },
        [query],
    )

    function renderItems(collectionId: string, parentId: string, depth: number) {
        const all = itemsByCollection[collectionId] ?? []
        return all
            .filter((it) => (it.parentId ?? '') === parentId)
            .filter((it) => matches(it, all))
            .map((it) => {
                if (it.kind === 'folder') {
                    const open = forceOpen || expanded.has(it.id)
                    const count = all.filter((c) => c.parentId === it.id).length
                    return (
                        <div key={it.id}>
                            <button
                                onClick={() => toggle(it.id)}
                                onContextMenu={(e) => itemMenu(it, e)}
                                title={`Carpeta "${it.name}" — ${count} ${count === 1 ? 'elemento' : 'elementos'}. Botón derecho para agregar, renombrar o borrar.`}
                                style={{paddingLeft: 8 + depth * 12}}
                                className="flex w-full items-center gap-1 rounded py-1 pr-2 text-left text-ui-11 text-on-surface-variant hover:bg-surface-variant"
                            >
                                <Icon name={open ? 'expand_more' : 'chevron_right'} size={13} className="shrink-0 opacity-60" />
                                <Icon name={open ? 'folder_open' : 'folder'} size={13} className="shrink-0 opacity-60" />
                                <span className="truncate">{it.name}</span>
                                <span className="ml-auto shrink-0 font-mono text-ui-9 tabular-nums opacity-50">{count}</span>
                            </button>
                            {open && renderItems(collectionId, it.id, depth + 1)}
                        </div>
                    )
                }
                const active = activeItemId === it.id
                return (
                    <button
                        key={it.id}
                        onClick={() => onOpenRequest(it)}
                        onContextMenu={(e) => itemMenu(it, e)}
                        title={it.url ? `${it.method || 'GET'} ${it.url}` : 'Petición sin URL todavía'}
                        style={{paddingLeft: 8 + depth * 12}}
                        className={`flex w-full items-center gap-1.5 rounded py-1 pr-2 text-left text-ui-11 hover:bg-surface-variant ${
                            active ? 'bg-surface-variant text-on-surface' : 'text-on-surface-variant'
                        }`}
                    >
                        {/* El método en monoespaciada y con ancho fijo: es lo
                            que se escanea al buscar en una lista larga, y sin
                            ancho fijo los nombres quedan dentados. */}
                        <span className={`w-10 shrink-0 font-mono text-ui-9 font-semibold ${methodColor(it.method || 'GET')}`}>
                            {(it.method || 'GET').toUpperCase()}
                        </span>
                        <span className="truncate">{it.name}</span>
                    </button>
                )
            })
    }

    const visibleCollections = useMemo(
        () => collections.filter((c) => !query || c.name.toLowerCase().includes(query) || (itemsByCollection[c.id] ?? []).some((it) => matches(it, itemsByCollection[c.id] ?? []))),
        [collections, query, itemsByCollection, matches],
    )

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center pb-1 pl-2 pr-1 pt-2">
                <span className="flex-1 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant/60">Colecciones</span>
                <button
                    onClick={onNewScratch}
                    title="Probar un endpoint sin guardarlo: se abre una pestaña con una petición que no pertenece a ninguna colección. Si después querés conservarla, «Guardar en…» la mete en la que elijas."
                    className="shrink-0 rounded p-0.5 text-on-surface-variant/50 hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="bolt" size={14} />
                </button>
                <button
                    onClick={() =>
                        void guard(async () => {
                            const res = await HttpImportPostman()
                            // null = el usuario canceló el diálogo de archivos.
                            if (res) {
                                setImportSummary({name: res.name, requests: res.requests, folders: res.folders, warnings: res.warnings ?? []})
                                setExpanded((prev) => new Set([...prev, res.collectionId]))
                            }
                        })
                    }
                    title="Importar una colección exportada de Postman (.json). Se trae completa —peticiones, carpetas, variables, autenticación y scripts— y lo que esta aplicación todavía no ejecuta se guarda igual para no perderlo al volver a exportar."
                    className="shrink-0 rounded p-0.5 text-on-surface-variant/50 hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="download" size={14} />
                </button>
                <button
                    onClick={() => setShowEnvironments(true)}
                    title="Entornos: los valores que cambian entre dev, pruebas y producción. Pisan a las variables de la colección, así que la misma petición sirve contra los tres."
                    className="shrink-0 rounded p-0.5 text-on-surface-variant/50 hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="layers" size={14} />
                </button>
                <button
                    onClick={newCollection}
                    title="Crear una colección nueva. Una colección agrupa peticiones y comparte sus variables — es la unidad que después se importa y se exporta."
                    className="shrink-0 rounded p-0.5 text-on-surface-variant/50 hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="add" size={14} />
                </button>
            </div>

            {error && (
                <p className="mx-2 mb-1 rounded bg-error-container px-2 py-1 text-ui-10 text-on-error-container" title={error}>
                    {error}
                </p>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
                {collections.length === 0 && (
                    <p className="px-2 py-3 text-ui-11 leading-relaxed text-on-surface-variant/70">
                        Todavía no hay colecciones. Creá una con el <span className="font-mono">+</span> de arriba para empezar a guardar peticiones.
                    </p>
                )}
                {visibleCollections.map((c) => {
                    const open = forceOpen || expanded.has(c.id)
                    return (
                        <div key={c.id}>
                            <button
                                onClick={() => toggle(c.id)}
                                onContextMenu={(e) => collectionMenu(c, e)}
                                title={`Colección "${c.name}". Botón derecho para agregar una petición, renombrarla o borrarla.`}
                                className="flex w-full items-center gap-1 rounded px-2 py-1 text-left text-ui-11 font-medium text-on-surface hover:bg-surface-variant"
                            >
                                <Icon name={open ? 'expand_more' : 'chevron_right'} size={13} className="shrink-0 opacity-60" />
                                <Icon name="folder_special" size={13} className="shrink-0 opacity-70" />
                                <span className="truncate">{c.name}</span>
                            </button>
                            {open && renderItems(c.id, '', 1)}
                        </div>
                    )
                })}
            </div>

            {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} width={260} />}

            {importSummary && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={() => setImportSummary(null)}>
                    <div
                        className="w-96 max-w-full rounded-lg border border-outline-variant bg-surface-container p-4 shadow-xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <p className="mb-2 flex items-center gap-2 text-sm font-medium text-on-surface">
                            <Icon name="check_circle" size={16} className="text-secondary" />
                            {importSummary.requests > 0 || importSummary.folders > 0 ? 'Colección importada' : 'Listo'}
                        </p>
                        <p className="text-ui-11 leading-relaxed text-on-surface-variant">
                            {importSummary.requests > 0 || importSummary.folders > 0 ? (
                                <>
                                    «{importSummary.name}»: {importSummary.requests} {importSummary.requests === 1 ? 'petición' : 'peticiones'}
                                    {importSummary.folders > 0 && <> en {importSummary.folders} {importSummary.folders === 1 ? 'carpeta' : 'carpetas'}</>}.
                                </>
                            ) : (
                                importSummary.name
                            )}
                        </p>
                        {importSummary.warnings.length > 0 && (
                            <div className="mt-2 rounded bg-surface-container-lowest p-2">
                                <p className="mb-1 text-ui-10 font-semibold uppercase tracking-wider text-tertiary">Se importó, con salvedades</p>
                                <ul className="space-y-1 text-ui-10 leading-relaxed text-on-surface-variant">
                                    {importSummary.warnings.map((w, i) => (
                                        <li key={i}>· {w}</li>
                                    ))}
                                </ul>
                            </div>
                        )}
                        <div className="mt-3 flex justify-end">
                            <button
                                onClick={() => setImportSummary(null)}
                                title="Cerrar este resumen"
                                className="rounded bg-primary px-3 py-1 text-xs text-on-primary hover:opacity-90"
                            >
                                Entendido
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {curlFor && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={() => setCurlFor(null)}>
                    <div
                        className="flex h-80 w-[40rem] max-w-full flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface-container shadow-xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-3 py-2">
                            <Icon name="content_paste" size={16} className="text-on-surface-variant" />
                            <p className="flex-1 text-sm font-medium text-on-surface">Pegar un comando cURL en «{curlFor.name}»</p>
                            <button
                                onClick={() =>
                                    void guard(async () => {
                                        const req = await HttpImportCurl(curlText)
                                        if (!req) return
                                        const created = await HttpSaveItem(
                                            new vault.HTTPItem({
                                                collectionId: curlFor.id,
                                                kind: 'request',
                                                name: nameFromURL(req.url),
                                                method: req.method,
                                                url: req.url,
                                                headers: req.headers && req.headers.length > 0 ? JSON.stringify(req.headers) : '',
                                                body: req.body && req.body.mode !== 'none' ? JSON.stringify(req.body) : '',
                                                settings: JSON.stringify(req.settings),
                                                auth: req.auth && req.auth.type !== 'inherit' ? JSON.stringify(req.auth) : '',
                                            }),
                                        )
                                        await reloadItems(curlFor.id)
                                        setExpanded((prev) => new Set([...prev, curlFor.id]))
                                        setCurlFor(null)
                                        if (created) onOpenRequest(created)
                                    })
                                }
                                disabled={!curlText.trim()}
                                title={curlText.trim() ? 'Crear la petición a partir del comando' : 'Pegá un comando cURL primero'}
                                className="rounded bg-primary px-3 py-1 text-ui-11 text-on-primary hover:opacity-90 disabled:opacity-40"
                            >
                                Importar
                            </button>
                            <button onClick={() => setCurlFor(null)} title="Cerrar sin importar" className="rounded p-1 text-on-surface-variant hover:bg-surface-variant">
                                <Icon name="close" size={16} />
                            </button>
                        </div>
                        <textarea
                            autoFocus
                            value={curlText}
                            onChange={(e) => setCurlText(e.target.value)}
                            placeholder={"curl 'https://api/x' \\\n  -H 'Authorization: Bearer ...' \\\n  --data-raw '{\"a\":1}'"}
                            className="min-h-0 flex-1 resize-none bg-surface-container-lowest p-3 font-mono text-ui-11 text-on-surface outline-none placeholder:text-on-surface-variant/40"
                        />
                        <p className="shrink-0 border-t border-outline-variant px-3 py-2 text-ui-10 leading-relaxed text-on-surface-variant/70">
                            Sirve el «Copy as cURL» de las herramientas del navegador. Se leen método, URL, headers, cuerpo, formularios con archivos,
                            usuario y contraseña, y si el comando trae <span className="font-mono">-k</span> se respeta que no verifique el certificado.
                        </p>
                    </div>
                </div>
            )}

            {runFor && (
                <RunPanel
                    collectionId={runFor.collectionId}
                    folderId={runFor.folderId}
                    title={runFor.title}
                    onClose={() => {
                        setRunFor(null)
                        // Correr una colección deja historial nuevo en cada
                        // petición: la pestaña abierta tiene que enterarse.
                        onChanged()
                    }}
                />
            )}

            {cookiesFor && (
                <CookiesDialog collectionId={cookiesFor.id} collectionName={cookiesFor.name} onClose={() => setCookiesFor(null)} />
            )}

            {docsFor && (
                <HttpDocsDialog
                    collection={docsFor}
                    onClose={() => setDocsFor(null)}
                    onChanged={() => void reloadCollections()}
                    onOpenNote={onOpenNote}
                />
            )}

            {showEnvironments && (
                <EnvironmentsDialog
                    onClose={() => setShowEnvironments(false)}
                    onChanged={() => {
                        onChanged()
                        void reloadCollections()
                    }}
                />
            )}

            {authFor && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={() => setAuthFor(null)}>
                    <div
                        className="flex max-h-[34rem] w-[34rem] max-w-full flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface-container shadow-xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-3 py-2">
                            <Icon name="key" size={16} className="text-on-surface-variant" />
                            <p className="flex-1 truncate text-sm font-medium text-on-surface">
                                Autenticación de {authFor.kind === 'collection' ? 'la colección' : 'la carpeta'} «{authFor.name}»
                            </p>
                            <button
                                onClick={() =>
                                    void guard(async () => {
                                        const serialized = authDraft.type === 'inherit' ? '' : JSON.stringify(authDraft)
                                        if (authFor.kind === 'collection') {
                                            const current = collections.find((c) => c.id === authFor.id)
                                            if (current) await HttpSaveCollection(new vault.HTTPCollection({...current, auth: serialized}))
                                        } else {
                                            const items = itemsByCollection[authFor.collectionId] ?? []
                                            const current = items.find((i) => i.id === authFor.id)
                                            if (current) {
                                                await HttpSaveItem(new vault.HTTPItem({...current, auth: serialized}))
                                                await reloadItems(authFor.collectionId)
                                            }
                                        }
                                        setAuthFor(null)
                                    })
                                }
                                title="Guardar la autenticación de este nivel"
                                className="rounded bg-primary px-3 py-1 text-ui-11 text-on-primary hover:opacity-90"
                            >
                                Guardar
                            </button>
                            <button onClick={() => setAuthFor(null)} title="Cerrar sin guardar" className="rounded p-1 text-on-surface-variant hover:bg-surface-variant">
                                <Icon name="close" size={16} />
                            </button>
                        </div>
                        <div className="min-h-0 flex-1 overflow-y-auto">
                            <AuthPanel
                                auth={authDraft}
                                onChange={setAuthDraft}
                                inheritsFrom={authFor.kind === 'folder' ? 'la colección' : undefined}
                                onTokenObtained={setAuthDraft}
                            />
                        </div>
                    </div>
                </div>
            )}

            {computedFor && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={() => setComputedFor(null)}>
                    <div
                        className="flex h-[30rem] w-[44rem] max-w-full flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface-container shadow-xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-3 py-2">
                            <Icon name="functions" size={16} className="text-on-surface-variant" />
                            <p className="flex-1 truncate text-sm font-medium text-on-surface">Variables calculadas de «{computedFor.name}»</p>
                            <button
                                onClick={() =>
                                    void guard(async () => {
                                        await HttpSaveCollection(
                                            new vault.HTTPCollection({
                                                ...computedFor,
                                                computed: computedRows.length === 0 ? '' : JSON.stringify(computedRows),
                                            }),
                                        )
                                        setComputedFor(null)
                                    })
                                }
                                title="Guardar las variables calculadas de esta colección"
                                className="rounded bg-primary px-3 py-1 text-ui-11 text-on-primary hover:opacity-90"
                            >
                                Guardar
                            </button>
                            <button
                                onClick={() => setComputedFor(null)}
                                title="Cerrar sin guardar"
                                className="rounded p-1 text-on-surface-variant hover:bg-surface-variant"
                            >
                                <Icon name="close" size={16} />
                            </button>
                        </div>
                        <div className="min-h-0 flex-1 overflow-y-auto">
                            <ComputedTable rows={computedRows} onChange={setComputedRows} />
                        </div>
                        <p className="shrink-0 border-t border-outline-variant px-3 py-2 text-ui-10 leading-relaxed text-on-surface-variant/70">
                            Se calculan antes de cada envío de <strong>cualquier</strong> petición de esta colección, y sus resultados quedan disponibles como{' '}
                            <span className="font-mono">{'{{nombre}}'}</span>. Es el lugar natural para una firma: se configura una vez y vale para todas.
                        </p>
                    </div>
                </div>
            )}

            {varsFor && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={() => setVarsFor(null)}>
                    <div
                        className="flex h-96 w-[46rem] max-w-full flex-col overflow-hidden rounded-lg border border-outline-variant bg-surface-container shadow-xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant px-3 py-2">
                            <Icon name="data_object" size={16} className="text-on-surface-variant" />
                            <p className="flex-1 truncate text-sm font-medium text-on-surface">Variables de «{varsFor.name}»</p>
                            <button
                                onClick={() =>
                                    void guard(async () => {
                                        await HttpSaveCollection(
                                            new vault.HTTPCollection({...varsFor, variables: varsRows.length === 0 ? '' : JSON.stringify(varsRows)}),
                                        )
                                        setVarsFor(null)
                                    })
                                }
                                title="Guardar las variables de esta colección"
                                className="rounded bg-primary px-3 py-1 text-ui-11 text-on-primary hover:opacity-90"
                            >
                                Guardar
                            </button>
                            <button onClick={() => setVarsFor(null)} title="Cerrar sin guardar" className="rounded p-1 text-on-surface-variant hover:bg-surface-variant">
                                <Icon name="close" size={16} />
                            </button>
                        </div>
                        <div className="min-h-0 flex-1 overflow-y-auto">
                            <VariablesTable rows={varsRows} onChange={setVarsRows} />
                        </div>
                        <p className="shrink-0 border-t border-outline-variant px-3 py-2 text-ui-10 leading-relaxed text-on-surface-variant/70">
                            Son los valores por defecto de la colección. Un entorno activo con el mismo nombre de variable los pisa — es lo que hace que la
                            misma petición sirva contra dev y contra producción.
                        </p>
                    </div>
                </div>
            )}

            {prompt && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setPrompt(null)}>
                    <div className="w-80 rounded-lg border border-outline-variant bg-surface-container-high p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
                        <p className="mb-2 text-sm font-medium text-on-surface">{prompt.title}</p>
                        <label className="mb-1 block text-ui-10 uppercase tracking-wider text-on-surface-variant/60">{prompt.label}</label>
                        <input
                            autoFocus
                            value={promptValue}
                            onChange={(e) => setPromptValue(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && promptValue.trim()) {
                                    prompt.onSubmit(promptValue.trim())
                                    setPrompt(null)
                                }
                                if (e.key === 'Escape') setPrompt(null)
                            }}
                            className="w-full rounded bg-surface-container-highest px-2 py-1.5 text-xs text-on-surface outline-none focus:ring-1 focus:ring-primary"
                        />
                        <div className="mt-3 flex justify-end gap-2">
                            <button
                                onClick={() => setPrompt(null)}
                                title="Cerrar sin crear nada"
                                className="rounded px-3 py-1 text-xs text-on-surface-variant hover:bg-surface-variant"
                            >
                                Cancelar
                            </button>
                            <button
                                onClick={() => {
                                    if (!promptValue.trim()) return
                                    prompt.onSubmit(promptValue.trim())
                                    setPrompt(null)
                                }}
                                disabled={!promptValue.trim()}
                                title={promptValue.trim() ? prompt.confirmLabel : 'Escribí un nombre primero'}
                                className="rounded bg-primary px-3 py-1 text-xs text-on-primary hover:opacity-90 disabled:opacity-40"
                            >
                                {prompt.confirmLabel}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {confirm && (
                <ConfirmDialog
                    title={confirm.title}
                    description={confirm.description}
                    confirmLabel="Borrar"
                    danger
                    onConfirm={() => void guard(confirm.run)}
                    onClose={() => setConfirm(null)}
                />
            )}
        </div>
    )
}

// La autenticación se persiste como texto JSON; vacío significa "heredar".
function parseAuth(raw: string | undefined): httpclient.Auth {
    if (!raw || !raw.trim()) return new httpclient.Auth({type: 'inherit'})
    try {
        return new httpclient.Auth(JSON.parse(raw))
    } catch {
        return new httpclient.Auth({type: 'inherit'})
    }
}

// Un nombre legible para una petición importada de un cURL: el último tramo
// de la ruta. Sin esto todas se llamarían igual y el árbol sería inútil.
function nameFromURL(url: string): string {
    try {
        const path = url.split('?')[0].replace(/^[a-zA-Z][\w+.-]*:\/\//, '')
        const parts = path.split('/').filter(Boolean)
        return parts[parts.length - 1] || parts[0] || 'Petición'
    } catch {
        return 'Petición'
    }
}
