import {useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent} from 'react'
import {
    HttpBuildRequest,
    HttpDeleteCollection,
    HttpDeleteItem,
    HttpExportPostman,
    HttpGenerateCode,
    HttpGetItem,
    HttpImportCurl,
    HttpListCollections,
    HttpListItems,
    HttpMoveItem,
    HttpSaveCollection,
    HttpSaveItem,
    HttpSetCollectionFavorite,
} from '../../../wailsjs/go/main/App'
import {httpclient, vault} from '../../../wailsjs/go/models'
import Icon from '../Icon'
import TreeRow, {TREE_FOLDER_ICON} from '../sidebar/TreeRow'
import {MenuButton, moveToFolderSubmenu, useTreeMenu, type TreeMenuEntry} from '../sidebar/TreeMenu'
import ConfirmDialog from '../ConfirmDialog'
import PromptDialog from '../git/PromptDialog'
import {methodColor, parseComputed, parseVariables, type HttpComputed, type HttpVariable} from './httpShared'
import EnvironmentsDialog from './EnvironmentsDialog'
import HttpDocsDialog from './HttpDocsDialog'
import RunPanel from './RunPanel'
import CookiesDialog from './CookiesDialog'
import VariablesTable from './VariablesTable'
import AuthPanel from './AuthPanel'
import ComputedTable from './ComputedTable'
import ImportDialog from './ImportDialog'
import HistoryPanel from './HistoryPanel'

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
    // Abre una petición rápida YA cargada con un método y una URL. Lo usa el
    // historial para reabrir un envío que no quedó guardado en ninguna
    // colección: es todo lo que se puede reconstruir de él, porque el
    // historial no guarda headers ni cuerpo a propósito.
    onOpenScratchWith: (method: string, url: string) => void
    // Sube con cada envío: es lo que mantiene vivo el panel de historial sin
    // releer el árbol de colecciones, que no cambia al mandar una petición.
    historyToken: number
}

interface PendingPrompt {
    title: string
    label: string
    initial: string
    confirmLabel: string
    onSubmit: (value: string) => void
}

export default function HttpTree({
    filter,
    activeItemId,
    onOpenRequest,
    refreshToken,
    onChanged,
    onOpenNote,
    onNewScratch,
    onOpenScratchWith,
    historyToken,
}: HttpTreeProps) {
    // Qué muestra la barra: el árbol de colecciones o el historial. Dos
    // secciones y no dos módulos de la barra lateral porque las dos son el
    // mismo trabajo —peticiones HTTP— y el buscador de arriba filtra las dos.
    const [section, setSection] = useState<'collections' | 'history'>('collections')
    const [showImport, setShowImport] = useState(false)
    const [collections, setCollections] = useState<vault.HTTPCollection[]>([])
    const [itemsByCollection, setItemsByCollection] = useState<Record<string, vault.HTTPItem[]>>({})
    const [expanded, setExpanded] = useState<Set<string>>(new Set())
    const menu = useTreeMenu()
    // «Desplegar todo» no puede abrir las carpetas de una colección que
    // todavía no se leyó: sus ítems se cargan recién al abrirla. La marca
    // queda puesta hasta que llegan, y ahí se suman sus carpetas.
    const expandAllRef = useRef(false)
    const [prompt, setPrompt] = useState<PendingPrompt | null>(null)
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
            if (expandAllRef.current) {
                const folders = items.filter((it) => it.kind === 'folder').map((it) => it.id)
                if (folders.length > 0) setExpanded((prev) => new Set([...prev, ...folders]))
            }
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
        expandAllRef.current = false
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
        setPrompt(spec)
    }

    // Plegar a mano cualquier rama cancela un «desplegar todo» pendiente: si
    // no, la próxima colección que termine de cargar volvería a abrir lo que
    // el usuario acaba de cerrar.
    const expandAll = () => {
        expandAllRef.current = true
        const folders = Object.values(itemsByCollection)
            .flat()
            .filter((it) => it.kind === 'folder')
            .map((it) => it.id)
        setExpanded(new Set([...collections.map((c) => c.id), ...folders]))
    }
    const collapseAll = () => {
        expandAllRef.current = false
        setExpanded(new Set())
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

    // --- acciones sobre ítems ----------------------------------------------

    function renameCollection(c: vault.HTTPCollection) {
        askName({
            title: 'Renombrar colección',
            label: 'Nombre',
            initial: c.name,
            confirmLabel: 'Guardar',
            onSubmit: (name) => void guard(() => HttpSaveCollection(new vault.HTTPCollection({...c, name}))),
        })
    }

    function renameItem(it: vault.HTTPItem) {
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
        })
    }

    function deleteItem(it: vault.HTTPItem) {
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
        })
    }

    // Duplicar relee el ítem entero antes de copiarlo: el listado del árbol
    // alcanza para dibujar, pero la copia tiene que llevarse cuerpo,
    // autenticación y scripts, y eso es lo que HttpGetItem garantiza. Sin id,
    // el vault la da de alta al final de la misma carpeta.
    function duplicateRequest(it: vault.HTTPItem) {
        void guard(async () => {
            const full = (await HttpGetItem(it.id)) ?? it
            const copy = await HttpSaveItem(new vault.HTTPItem({...full, id: '', sortOrder: 0, name: `${full.name} (copia)`}))
            await reloadItems(it.collectionId)
            if (copy) onOpenRequest(copy)
        })
    }

    // Mover dentro de la misma colección: el vault reordena a los hermanos y
    // un orden fuera de rango lo deja al final, que es donde lo buscaría
    // quien acaba de moverlo.
    function moveItem(it: vault.HTTPItem, folderId: string) {
        if ((it.parentId ?? '') === folderId) return
        void guard(async () => {
            await HttpMoveItem(it.id, folderId, 1_000_000)
            await reloadItems(it.collectionId)
            if (folderId) setExpanded((prev) => new Set([...prev, folderId]))
        })
    }

    // Carpetas a las que se puede mover un ítem, aplanadas y en el orden del
    // árbol. Una carpeta no se ofrece a sí misma ni a su propia rama: el
    // backend lo rechaza igual, pero una opción que siempre falla no debería
    // estar en el menú.
    function moveTargets(it: vault.HTTPItem) {
        const all = itemsByCollection[it.collectionId] ?? []
        const out: {folder: {id: string; name: string}; depth: number}[] = []
        const walk = (parent: string, depth: number) => {
            for (const f of all) {
                if (f.kind !== 'folder' || (f.parentId ?? '') !== parent || f.id === it.id) continue
                out.push({folder: {id: f.id, name: f.name}, depth})
                walk(f.id, depth + 1)
            }
        }
        walk('', 0)
        return out
    }

    // «Copiar como cURL» sale del mismo generador que el panel de snippets, y
    // con los secretos ENMASCARADOS: el portapapeles termina pegado en un
    // ticket o un chat, y ahí un token real es una filtración. Quien lo
    // necesite con valores reales lo saca del panel, que tiene el interruptor.
    function copyAsCurl(it: vault.HTTPItem) {
        void (async () => {
            setError(null)
            try {
                const req = await HttpBuildRequest(it.id)
                if (!req) return
                await navigator.clipboard.writeText(await HttpGenerateCode(it.id, req, 'curl', false))
            } catch (e) {
                setError(String(e))
            }
        })()
    }

    const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {})

    // --- menús -------------------------------------------------------------
    //
    // Mismo menú y misma forma que el resto de los árboles (TreeMenu): crear
    // arriba, lo que se hace con el elemento en el medio, configuración
    // después y el borrado siempre último y en rojo. Las explicaciones largas
    // van en el title de cada opción, no en la fila: la fila tiene que
    // leerse de un vistazo.

    function collectionMenu(e: ReactMouseEvent, c: vault.HTTPCollection) {
        const open = forceOpen || expanded.has(c.id)
        menu.openAt(e, [
            {label: 'Nueva petición', icon: 'add', onSelect: () => newItem(c.id, '', 'request')},
            {label: 'Nueva carpeta', icon: 'create_new_folder', onSelect: () => newItem(c.id, '', 'folder')},
            {
                label: 'Pegar un comando cURL…',
                icon: 'content_paste',
                title: 'Crea una petición desde un «Copy as cURL» del navegador',
                onSelect: () => {
                    setCurlText('')
                    setCurlFor(c)
                },
            },
            'separator',
            {
                label: 'Correr la colección',
                icon: 'play_arrow',
                title: 'Todas sus peticiones, en orden',
                onSelect: () => setRunFor({collectionId: c.id, folderId: '', title: c.name}),
            },
            {label: 'Documentación…', icon: 'menu_book', title: 'Verla o publicarla como nota del vault', onSelect: () => setDocsFor(c)},
            {label: open ? 'Plegar' : 'Desplegar', icon: open ? 'unfold_less' : 'unfold_more', disabled: forceOpen, onSelect: () => toggle(c.id)},
            'separator',
            {
                label: 'Autenticación…',
                icon: 'key',
                title: 'La heredan todas sus peticiones: cambiar un token es UNA edición y no treinta',
                onSelect: () => {
                    setAuthDraft(parseAuth(c.auth))
                    setAuthFor({kind: 'collection', id: c.id, name: c.name, collectionId: c.id})
                },
            },
            {
                label: 'Variables…',
                icon: 'data_object',
                title: 'Valores por defecto de la colección, que el entorno activo puede pisar',
                onSelect: () => {
                    setVarsRows(parseVariables(c.variables))
                    setVarsFor(c)
                },
            },
            {
                label: 'Variables calculadas…',
                icon: 'functions',
                title: 'Firmas y tokens derivados, para todas sus peticiones',
                onSelect: () => {
                    setComputedRows(parseComputed(c.computed))
                    setComputedFor(c)
                },
            },
            {label: 'Cookies…', icon: 'cookie', title: 'Las del entorno con el que corre', onSelect: () => setCookiesFor(c)},
            'separator',
            {
                label: c.favoriteAt ? 'Quitar de favoritas' : 'Marcar como favorita',
                icon: 'star',
                title: 'Las favoritas quedan arriba de la lista',
                onSelect: () => void guard(() => HttpSetCollectionFavorite(c.id, !c.favoriteAt)),
            },
            {label: 'Cambiar nombre', icon: 'edit', onSelect: () => renameCollection(c)},
            {
                label: 'Exportar a Postman…',
                icon: 'upload',
                title: 'Un archivo .json de Postman v2.1, con todo lo que se importó',
                onSelect: () =>
                    void guard(async () => {
                        const dest = await HttpExportPostman(c.id)
                        if (dest) setImportSummary({name: `Exportada a ${dest}`, requests: 0, folders: 0, warnings: []})
                    }),
            },
            'separator',
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
        ])
    }

    function folderMenu(e: ReactMouseEvent, it: vault.HTTPItem) {
        const open = forceOpen || expanded.has(it.id)
        menu.openAt(e, [
            {label: 'Nueva petición aquí', icon: 'add', onSelect: () => newItem(it.collectionId, it.id, 'request')},
            {label: 'Subcarpeta nueva', icon: 'create_new_folder', onSelect: () => newItem(it.collectionId, it.id, 'folder')},
            'separator',
            {
                label: 'Correr esta carpeta',
                icon: 'play_arrow',
                title: 'Sus peticiones y las de sus subcarpetas, en orden',
                onSelect: () => setRunFor({collectionId: it.collectionId, folderId: it.id, title: it.name}),
            },
            {label: open ? 'Plegar' : 'Desplegar', icon: open ? 'unfold_less' : 'unfold_more', disabled: forceOpen, onSelect: () => toggle(it.id)},
            {
                label: 'Autenticación…',
                icon: 'key',
                title: 'La heredan las peticiones de adentro',
                onSelect: () => {
                    setAuthDraft(parseAuth(it.auth))
                    setAuthFor({kind: 'folder', id: it.id, name: it.name, collectionId: it.collectionId})
                },
            },
            'separator',
            {label: 'Cambiar nombre', icon: 'edit', onSelect: () => renameItem(it)},
            {label: 'Mover a…', icon: 'drive_file_move', submenu: moveToFolderSubmenu(moveTargets(it), it.parentId ?? '', (f) => moveItem(it, f), 'Raíz de la colección')},
            'separator',
            {label: 'Borrar carpeta', icon: 'delete', danger: true, title: 'Con todo lo que tenga adentro', onSelect: () => deleteItem(it)},
        ])
    }

    function requestMenu(e: ReactMouseEvent, it: vault.HTTPItem) {
        const items: TreeMenuEntry[] = [
            {label: 'Abrir', icon: 'open_in_new', onSelect: () => onOpenRequest(it)},
            'separator',
            {label: 'Cambiar nombre', icon: 'edit', onSelect: () => renameItem(it)},
            {label: 'Duplicar', icon: 'content_copy', title: 'Copia la petición entera —headers, cuerpo, autenticación y scripts— en la misma carpeta', onSelect: () => duplicateRequest(it)},
            {label: 'Mover a…', icon: 'drive_file_move', submenu: moveToFolderSubmenu(moveTargets(it), it.parentId ?? '', (f) => moveItem(it, f), 'Raíz de la colección')},
            'separator',
            {
                label: 'Copiar como cURL',
                icon: 'terminal',
                title: 'Con las variables resueltas y los secretos enmascarados. Para los valores reales, usá el panel de código de la petición.',
                onSelect: () => copyAsCurl(it),
            },
            {label: 'Copiar URL', icon: 'link', disabled: !it.url, title: it.url ? it.url : 'La petición todavía no tiene URL', onSelect: () => copy(it.url ?? '')},
            'separator',
            {label: 'Borrar petición', icon: 'delete', danger: true, title: 'Con su historial de ejecuciones', onSelect: () => deleteItem(it)},
        ]
        menu.openAt(e, items)
    }

    // Clic derecho en el espacio vacío: lo mismo que los botones del
    // encabezado, para quien ya tiene el mouse en el árbol.
    function blankMenu(e: ReactMouseEvent) {
        menu.openAt(e, [
            {label: 'Nueva colección', icon: 'create_new_folder', onSelect: newCollection},
            {label: 'Petición rápida', icon: 'bolt', title: 'Una pestaña para probar un endpoint sin guardarlo en ninguna colección', onSelect: onNewScratch},
            {label: 'Importar…', icon: 'download', title: 'cURL, una URL, una petición en texto o archivos de Postman', onSelect: () => setShowImport(true)},
            {label: 'Entornos…', icon: 'layers', onSelect: () => setShowEnvironments(true)},
            'separator',
            {label: 'Desplegar todo', icon: 'unfold_more', disabled: forceOpen || collections.length === 0, onSelect: expandAll},
            {label: 'Plegar todo', icon: 'unfold_less', disabled: forceOpen || expanded.size === 0, onSelect: collapseAll},
        ])
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
                            <TreeRow
                                depth={depth}
                                icon={open ? 'folder_open' : 'folder'}
                                iconClass={TREE_FOLDER_ICON}
                                iconFilled={!open}
                                label={it.name}
                                labelClass="text-on-surface font-medium"
                                title={`Carpeta "${it.name}" — ${count} ${count === 1 ? 'elemento' : 'elementos'}. Clic derecho: agregar, correr, mover o borrar.`}
                                expanded={open}
                                onToggle={() => toggle(it.id)}
                                onClick={() => toggle(it.id)}
                                onContextMenu={(e) => folderMenu(e, it)}
                                trailing={<span className="text-ui-10 tabular-nums text-on-surface-variant/50">{count}</span>}
                                actions={
                                    <>
                                        <button
                                            onClick={() => newItem(collectionId, it.id, 'request')}
                                            title={`Crear una petición dentro de «${it.name}»`}
                                            className="sidebar-icon !p-0.5"
                                        >
                                            <Icon name="add" size={14} />
                                        </button>
                                        <MenuButton onOpen={(e) => folderMenu(e, it)} title="Opciones de la carpeta" />
                                    </>
                                }
                            />
                            {open && renderItems(collectionId, it.id, depth + 1)}
                        </div>
                    )
                }
                const active = activeItemId === it.id
                const method = (it.method || 'GET').toUpperCase()
                return (
                    <TreeRow
                        key={it.id}
                        depth={depth}
                        // El «ícono» de una petición es su método: es lo que
                        // se escanea en una lista larga, y un glifo genérico
                        // repetiría lo mismo en cada fila. Monoespaciado y con
                        // ancho fijo: sin eso los nombres quedan dentados y la
                        // columna del método deja de leerse como columna.
                        icon={
                            <span className={`inline-block w-[30px] font-mono text-ui-9 font-semibold ${methodColor(method)}`}>
                                {shortMethod(method)}
                            </span>
                        }
                        label={it.name}
                        title={it.url ? `${method} ${it.url}` : `${method} — petición sin URL todavía`}
                        onClick={() => onOpenRequest(it)}
                        onContextMenu={(e) => requestMenu(e, it)}
                        active={active}
                        actions={<MenuButton onOpen={(e) => requestMenu(e, it)} title="Opciones de la petición" />}
                    />
                )
            })
    }

    const visibleCollections = useMemo(
        () => collections.filter((c) => !query || c.name.toLowerCase().includes(query) || (itemsByCollection[c.id] ?? []).some((it) => matches(it, itemsByCollection[c.id] ?? []))),
        [collections, query, itemsByCollection, matches],
    )

    const headerButton = 'shrink-0 rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-40'

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-0.5 pb-1 pl-2 pr-2 pt-2">
                {/* Dos secciones y no dos módulos de la barra lateral: son el
                    mismo trabajo y las filtra el mismo buscador de arriba. */}
                {(['collections', 'history'] as const).map((s) => (
                    <button
                        key={s}
                        onClick={() => setSection(s)}
                        title={
                            s === 'collections'
                                ? 'Las colecciones guardadas, con sus carpetas y peticiones'
                                : 'Todo lo que se mandó desde la aplicación, de lo más nuevo a lo más viejo'
                        }
                        className={`rounded px-1.5 py-0.5 text-ui-10 font-semibold uppercase tracking-wider ${
                            section === s ? 'text-on-surface' : 'text-on-surface-variant/50 hover:text-on-surface-variant'
                        }`}
                    >
                        {s === 'collections' ? 'Colecciones' : 'Historial'}
                    </button>
                ))}
                <span className="flex-1" />
                {section === 'collections' && (
                    <button
                        onClick={() => (expanded.size > 0 ? collapseAll() : expandAll())}
                        disabled={forceOpen || collections.length === 0}
                        title={
                            forceOpen
                                ? 'Con una búsqueda activa todo queda desplegado, para que ningún resultado quede escondido'
                                : expanded.size > 0
                                  ? 'Plegar todas las colecciones y carpetas'
                                  : 'Desplegar todas las colecciones y sus carpetas'
                        }
                        className={headerButton}
                    >
                        <Icon name={expanded.size > 0 ? 'unfold_less' : 'unfold_more'} size={16} />
                    </button>
                )}
                <button
                    onClick={onNewScratch}
                    title="Probar un endpoint sin guardarlo: se abre una pestaña con una petición que no pertenece a ninguna colección. Si después querés conservarla, «Guardar en…» la mete en la que elijas."
                    className={headerButton}
                >
                    <Icon name="bolt" size={16} />
                </button>
                <button
                    onClick={() => setShowImport(true)}
                    title="Importar: pegá un comando cURL, una URL o una petición en texto, o soltá colecciones y entornos exportados de Postman. Una colección se trae completa —peticiones, carpetas, variables, autenticación y scripts— y lo que esta aplicación todavía no ejecuta se guarda igual para no perderlo al volver a exportar."
                    className={headerButton}
                >
                    <Icon name="download" size={16} />
                </button>
                <button
                    onClick={() => setShowEnvironments(true)}
                    title="Entornos: los valores que cambian entre dev, pruebas y producción. Pisan a las variables de la colección, así que la misma petición sirve contra los tres."
                    className={headerButton}
                >
                    <Icon name="layers" size={16} />
                </button>
                <button
                    onClick={newCollection}
                    title="Crear una colección nueva. Una colección agrupa peticiones y comparte sus variables — es la unidad que después se importa y se exporta."
                    className={headerButton}
                >
                    <Icon name="create_new_folder" size={16} />
                </button>
            </div>

            {error && (
                <p className="mx-2 mb-1 rounded bg-error-container px-2 py-1 text-ui-10 text-on-error-container" title={error}>
                    {error}
                </p>
            )}

            {section === 'history' ? (
                <HistoryPanel
                    filter={filter}
                    refreshToken={refreshToken + historyToken}
                    onOpenItem={(itemId) =>
                        void guard(async () => {
                            const it = await HttpGetItem(itemId)
                            if (it) onOpenRequest(it)
                        })
                    }
                    onOpenScratch={onOpenScratchWith}
                />
            ) : (
            <div className="min-h-0 flex-1 overflow-y-auto pb-6" onContextMenu={blankMenu}>
                {collections.length === 0 && (
                    <p className="px-3 py-3 text-ui-11 leading-relaxed text-on-surface-variant/70">
                        Todavía no hay colecciones. Creá una con{' '}
                        <Icon name="create_new_folder" size={12} className="inline align-text-bottom" /> de arriba, o con clic derecho acá, para
                        empezar a guardar peticiones.
                    </p>
                )}
                {visibleCollections.map((c) => {
                    const open = forceOpen || expanded.has(c.id)
                    const fav = !!c.favoriteAt
                    // La estrella: marcar una favorita es un gesto ocasional,
                    // pero SABER cuáles lo son se lee todo el tiempo — por
                    // eso queda fija a la derecha de las favoritas y en las
                    // demás aparece solo al pasar el mouse.
                    const star = (
                        <button
                            onClick={() => void guard(() => HttpSetCollectionFavorite(c.id, !fav))}
                            title={fav ? 'Quitar de favoritas: vuelve a su lugar en la lista' : 'Marcar como favorita: queda arriba de la lista'}
                            className={`sidebar-icon !p-0.5 ${fav ? '!text-primary' : ''}`}
                        >
                            {/* Material Symbols no tiene un `star_border`: la
                                estrella es la misma y lo que cambia es el eje
                                FILL. */}
                            <Icon name="star" size={14} filled={fav} />
                        </button>
                    )
                    return (
                        <div key={c.id}>
                            <TreeRow
                                depth={0}
                                icon="collections_bookmark"
                                iconClass={TREE_FOLDER_ICON}
                                iconFilled={!open}
                                label={c.name}
                                labelClass="text-on-surface font-medium"
                                title={`Colección "${c.name}". Clic derecho: peticiones, variables, autenticación, correrla o exportarla.`}
                                expanded={open}
                                onToggle={() => toggle(c.id)}
                                onClick={() => toggle(c.id)}
                                onContextMenu={(e) => collectionMenu(e, c)}
                                trailing={fav ? <Icon name="star" size={13} filled className="text-primary" /> : undefined}
                                actions={
                                    <>
                                        {star}
                                        <button
                                            onClick={() => newItem(c.id, '', 'request')}
                                            title={`Crear una petición en «${c.name}»`}
                                            className="sidebar-icon !p-0.5"
                                        >
                                            <Icon name="add" size={14} />
                                        </button>
                                        <MenuButton onOpen={(e) => collectionMenu(e, c)} title="Opciones de la colección" />
                                    </>
                                }
                            />
                            {open && renderItems(c.id, '', 1)}
                        </div>
                    )
                })}
            </div>
            )}

            {menu.element}

            {showImport && (
                <ImportDialog
                    collections={collections}
                    // La favorita más reciente va primero en la lista, así que
                    // es la que corresponde ofrecer para una petición suelta:
                    // es contra la que se está trabajando.
                    defaultCollectionId={collections[0]?.id ?? ''}
                    onClose={() => setShowImport(false)}
                    onImported={(batch) => {
                        onChanged()
                        void reloadCollections()
                        const ids = batch.items.map((o) => o.collectionId).filter((id): id is string => !!id)
                        if (ids.length > 0) setExpanded((prev) => new Set([...prev, ...ids]))
                        for (const id of ids) void reloadItems(id)
                    }}
                />
            )}

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
                // El diálogo de la app y no un window.prompt: uno nativo
                // dentro del webview no se percibe como un diálogo (ver
                // .claude/rules/conventions.md).
                <PromptDialog
                    title={prompt.title}
                    label={prompt.label}
                    initial={prompt.initial}
                    confirmLabel={prompt.confirmLabel}
                    onSubmit={(value) => {
                        if (value.trim()) prompt.onSubmit(value.trim())
                    }}
                    onClose={() => setPrompt(null)}
                />
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

// El método abreviado como en Postman: la columna del árbol tiene ancho fijo y
// DELETE u OPTIONS completos la obligarían a ser más ancha para todas las
// filas. El método entero sigue en el title de la fila.
function shortMethod(method: string): string {
    switch (method) {
        case 'DELETE':
            return 'DEL'
        case 'OPTIONS':
            return 'OPT'
        default:
            return method
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
