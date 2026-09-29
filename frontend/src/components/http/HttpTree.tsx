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
import {t as dict, useT} from '../../i18n'

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
    const t = useT()
    const tr = t.sidebar.http
    const tf = t.sidebar.folders
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
            title: tr.newCollection,
            label: tf.nameLabel,
            initial: '',
            confirmLabel: tf.create,
            onSubmit: (name) =>
                void guard(async () => {
                    const c = await HttpSaveCollection(new vault.HTTPCollection({name}))
                    if (c) setExpanded((prev) => new Set([...prev, c.id]))
                }),
        })
    }

    function newItem(collectionId: string, parentId: string, kind: 'folder' | 'request') {
        askName({
            title: kind === 'folder' ? tf.newFolder : tr.newRequest,
            label: tf.nameLabel,
            initial: '',
            confirmLabel: tf.create,
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
            title: tr.renameCollection,
            label: tf.nameLabel,
            initial: c.name,
            confirmLabel: t.common.save,
            onSubmit: (name) => void guard(() => HttpSaveCollection(new vault.HTTPCollection({...c, name}))),
        })
    }

    function renameItem(it: vault.HTTPItem) {
        askName({
            title: it.kind === 'folder' ? tr.renameFolder : tr.renameRequest,
            label: tf.nameLabel,
            initial: it.name,
            confirmLabel: t.common.save,
            onSubmit: (name) =>
                void guard(async () => {
                    await HttpSaveItem(new vault.HTTPItem({...it, name}))
                    await reloadItems(it.collectionId)
                }),
        })
    }

    function deleteItem(it: vault.HTTPItem) {
        setConfirm({
            title: it.kind === 'folder' ? tr.deleteFolderTitle : tr.deleteRequestTitle,
            description: it.kind === 'folder' ? tr.deleteFolderDesc({name: it.name}) : tr.deleteRequestDesc({name: it.name}),
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
            const copy = await HttpSaveItem(new vault.HTTPItem({...full, id: '', sortOrder: 0, name: tr.copyName({name: full.name})}))
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
            {label: tr.newRequest, icon: 'add', onSelect: () => newItem(c.id, '', 'request')},
            {label: tf.newFolder, icon: 'create_new_folder', onSelect: () => newItem(c.id, '', 'folder')},
            {
                label: tr.pasteCurl,
                icon: 'content_paste',
                title: tr.pasteCurlTitle,
                onSelect: () => {
                    setCurlText('')
                    setCurlFor(c)
                },
            },
            'separator',
            {
                label: tr.runCollection,
                icon: 'play_arrow',
                title: tr.runCollectionTitle,
                onSelect: () => setRunFor({collectionId: c.id, folderId: '', title: c.name}),
            },
            {label: tr.docs, icon: 'menu_book', title: tr.docsTitle, onSelect: () => setDocsFor(c)},
            {label: open ? t.common.collapse : t.common.expand, icon: open ? 'unfold_less' : 'unfold_more', disabled: forceOpen, onSelect: () => toggle(c.id)},
            'separator',
            {
                label: tr.auth,
                icon: 'key',
                title: tr.authCollectionTitle,
                onSelect: () => {
                    setAuthDraft(parseAuth(c.auth))
                    setAuthFor({kind: 'collection', id: c.id, name: c.name, collectionId: c.id})
                },
            },
            {
                label: tr.variables,
                icon: 'data_object',
                title: tr.variablesTitle,
                onSelect: () => {
                    setVarsRows(parseVariables(c.variables))
                    setVarsFor(c)
                },
            },
            {
                label: tr.computed,
                icon: 'functions',
                title: tr.computedTitle,
                onSelect: () => {
                    setComputedRows(parseComputed(c.computed))
                    setComputedFor(c)
                },
            },
            {label: tr.cookies, icon: 'cookie', title: tr.cookiesTitle, onSelect: () => setCookiesFor(c)},
            'separator',
            {
                label: c.favoriteAt ? tr.unfavorite : tr.favorite,
                icon: 'star',
                title: tr.favoriteTitle,
                onSelect: () => void guard(() => HttpSetCollectionFavorite(c.id, !c.favoriteAt)),
            },
            {label: tf.rename, icon: 'edit', onSelect: () => renameCollection(c)},
            {
                label: tr.exportPostman,
                icon: 'upload',
                title: tr.exportPostmanTitle,
                onSelect: () =>
                    void guard(async () => {
                        const dest = await HttpExportPostman(c.id)
                        if (dest) setImportSummary({name: tr.exportedTo({path: dest}), requests: 0, folders: 0, warnings: []})
                    }),
            },
            'separator',
            {
                label: tr.deleteCollection,
                icon: 'delete',
                danger: true,
                onSelect: () =>
                    setConfirm({
                        title: tr.deleteCollectionTitle,
                        description: tr.deleteCollectionDesc({name: c.name}),
                        run: () => HttpDeleteCollection(c.id),
                    }),
            },
        ])
    }

    function folderMenu(e: ReactMouseEvent, it: vault.HTTPItem) {
        const open = forceOpen || expanded.has(it.id)
        menu.openAt(e, [
            {label: tr.newRequestHere, icon: 'add', onSelect: () => newItem(it.collectionId, it.id, 'request')},
            {label: tf.newSubfolder, icon: 'create_new_folder', onSelect: () => newItem(it.collectionId, it.id, 'folder')},
            'separator',
            {
                label: tr.runFolder,
                icon: 'play_arrow',
                title: tr.runFolderTitle,
                onSelect: () => setRunFor({collectionId: it.collectionId, folderId: it.id, title: it.name}),
            },
            {label: open ? t.common.collapse : t.common.expand, icon: open ? 'unfold_less' : 'unfold_more', disabled: forceOpen, onSelect: () => toggle(it.id)},
            {
                label: tr.auth,
                icon: 'key',
                title: tr.authFolderTitle,
                onSelect: () => {
                    setAuthDraft(parseAuth(it.auth))
                    setAuthFor({kind: 'folder', id: it.id, name: it.name, collectionId: it.collectionId})
                },
            },
            'separator',
            {label: tf.rename, icon: 'edit', onSelect: () => renameItem(it)},
            {label: tf.moveTo, icon: 'drive_file_move', submenu: moveToFolderSubmenu(moveTargets(it), it.parentId ?? '', (f) => moveItem(it, f), tr.collectionRoot)},
            'separator',
            {label: t.sidebar.git.deleteFolder, icon: 'delete', danger: true, title: tr.deleteFolderMenuTitle, onSelect: () => deleteItem(it)},
        ])
    }

    function requestMenu(e: ReactMouseEvent, it: vault.HTTPItem) {
        const items: TreeMenuEntry[] = [
            {label: tr.open, icon: 'open_in_new', onSelect: () => onOpenRequest(it)},
            'separator',
            {label: tf.rename, icon: 'edit', onSelect: () => renameItem(it)},
            {label: t.sidebar.notes.duplicate, icon: 'content_copy', title: tr.duplicateTitle, onSelect: () => duplicateRequest(it)},
            {label: tf.moveTo, icon: 'drive_file_move', submenu: moveToFolderSubmenu(moveTargets(it), it.parentId ?? '', (f) => moveItem(it, f), tr.collectionRoot)},
            'separator',
            {
                label: tr.copyAsCurl,
                icon: 'terminal',
                title: tr.copyAsCurlTitle,
                onSelect: () => copyAsCurl(it),
            },
            {label: t.sidebar.git.copyUrl, icon: 'link', disabled: !it.url, title: it.url ? it.url : tr.noUrlYet, onSelect: () => copy(it.url ?? '')},
            'separator',
            {label: tr.deleteRequest, icon: 'delete', danger: true, title: tr.deleteRequestMenuTitle, onSelect: () => deleteItem(it)},
        ]
        menu.openAt(e, items)
    }

    // Clic derecho en el espacio vacío: lo mismo que los botones del
    // encabezado, para quien ya tiene el mouse en el árbol.
    function blankMenu(e: ReactMouseEvent) {
        menu.openAt(e, [
            {label: tr.newCollection, icon: 'create_new_folder', onSelect: newCollection},
            {label: tr.scratch, icon: 'bolt', title: tr.scratchMenuTitle, onSelect: onNewScratch},
            {label: tr.importEllipsis, icon: 'download', title: tr.importMenuTitle, onSelect: () => setShowImport(true)},
            {label: tr.environments, icon: 'layers', onSelect: () => setShowEnvironments(true)},
            'separator',
            {label: tf.expandAll, icon: 'unfold_more', disabled: forceOpen || collections.length === 0, onSelect: expandAll},
            {label: tf.collapseAll, icon: 'unfold_less', disabled: forceOpen || expanded.size === 0, onSelect: collapseAll},
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
                                title={tr.folderTitle({name: it.name, count})}
                                expanded={open}
                                onToggle={() => toggle(it.id)}
                                onClick={() => toggle(it.id)}
                                onContextMenu={(e) => folderMenu(e, it)}
                                trailing={<span className="text-ui-10 tabular-nums text-on-surface-variant/50">{count}</span>}
                                actions={
                                    <>
                                        <button
                                            onClick={() => newItem(collectionId, it.id, 'request')}
                                            title={tr.newRequestInFolder({name: it.name})}
                                            className="sidebar-icon !p-0.5"
                                        >
                                            <Icon name="add" size={14} />
                                        </button>
                                        <MenuButton onOpen={(e) => folderMenu(e, it)} title={tf.folderOptions} />
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
                        title={it.url ? `${method} ${it.url}` : tr.requestNoUrl({method})}
                        onClick={() => onOpenRequest(it)}
                        onContextMenu={(e) => requestMenu(e, it)}
                        active={active}
                        actions={<MenuButton onOpen={(e) => requestMenu(e, it)} title={tr.requestOptions} />}
                    />
                )
            })
    }

    const visibleCollections = useMemo(
        () => collections.filter((c) => !query || c.name.toLowerCase().includes(query) || (itemsByCollection[c.id] ?? []).some((it) => matches(it, itemsByCollection[c.id] ?? []))),
        [collections, query, itemsByCollection, matches],
    )

    const onCollections = section === 'collections'
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
                            s === 'collections' ? tr.collectionsTabTitle : tr.historyTabTitle
                        }
                        className={`rounded px-1.5 py-0.5 text-ui-10 font-semibold uppercase tracking-wider ${
                            section === s ? 'text-on-surface' : 'text-on-surface-variant/50 hover:text-on-surface-variant'
                        }`}
                    >
                        {s === 'collections' ? tr.collections : tr.history.title}
                    </button>
                ))}
                <span className="flex-1" />
                {onCollections && (
                    <button
                        onClick={() => (expanded.size > 0 ? collapseAll() : expandAll())}
                        disabled={forceOpen || collections.length === 0}
                        title={
                            forceOpen
                                ? tr.searchKeepsOpen
                                : expanded.size > 0
                                  ? tr.collapseAllTitle
                                  : tr.expandAllTitle
                        }
                        className={headerButton}
                    >
                        <Icon name={expanded.size > 0 ? 'unfold_less' : 'unfold_more'} size={16} />
                    </button>
                )}
                <button
                    onClick={onNewScratch}
                    title={tr.scratchTitle}
                    className={headerButton}
                >
                    <Icon name="bolt" size={16} />
                </button>
                <button
                    onClick={() => setShowImport(true)}
                    title={tr.importTitle}
                    className={headerButton}
                >
                    <Icon name="download" size={16} />
                </button>
                <button
                    onClick={() => setShowEnvironments(true)}
                    title={tr.environmentsTitle}
                    className={headerButton}
                >
                    <Icon name="layers" size={16} />
                </button>
                <button
                    onClick={newCollection}
                    title={tr.newCollectionTitle}
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
                        {tr.empty.before}
                        <Icon name="create_new_folder" size={12} className="inline align-text-bottom" />
                        {tr.empty.after}
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
                            title={fav ? tr.unfavoriteStarTitle : tr.favoriteStarTitle}
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
                                title={tr.collectionTitle({name: c.name})}
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
                                            title={tr.newRequestInCollection({name: c.name})}
                                            className="sidebar-icon !p-0.5"
                                        >
                                            <Icon name="add" size={14} />
                                        </button>
                                        <MenuButton onOpen={(e) => collectionMenu(e, c)} title={tr.collectionOptions} />
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
                            {importSummary.requests > 0 || importSummary.folders > 0 ? tr.imported : tr.done}
                        </p>
                        <p className="text-ui-11 leading-relaxed text-on-surface-variant">
                            {importSummary.requests > 0 || importSummary.folders > 0 ? (
                                tr.importSummary({name: importSummary.name, requests: importSummary.requests, folders: importSummary.folders})
                            ) : (
                                importSummary.name
                            )}
                        </p>
                        {importSummary.warnings.length > 0 && (
                            <div className="mt-2 rounded bg-surface-container-lowest p-2">
                                <p className="mb-1 text-ui-10 font-semibold uppercase tracking-wider text-tertiary">{tr.importWarnings}</p>
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
                                title={tr.closeSummary}
                                className="rounded bg-primary px-3 py-1 text-xs text-on-primary hover:opacity-90"
                            >
                                {tr.gotIt}
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
                            <p className="flex-1 text-sm font-medium text-on-surface">{tr.pasteCurlInto({name: curlFor.name})}</p>
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
                                title={curlText.trim() ? tr.curlCreateTitle : tr.curlPasteFirst}
                                className="rounded bg-primary px-3 py-1 text-ui-11 text-on-primary hover:opacity-90 disabled:opacity-40"
                            >
                                {tr.importAction}
                            </button>
                            <button onClick={() => setCurlFor(null)} title={tr.closeWithoutImporting} className="rounded p-1 text-on-surface-variant hover:bg-surface-variant">
                                <Icon name="close" size={16} />
                            </button>
                        </div>
                        <textarea
                            autoFocus
                            value={curlText}
                            onChange={(e) => setCurlText(e.target.value)}
                            placeholder={CURL_PLACEHOLDER}
                            className="min-h-0 flex-1 resize-none bg-surface-container-lowest p-3 font-mono text-ui-11 text-on-surface outline-none placeholder:text-on-surface-variant/40"
                        />
                        <p className="shrink-0 border-t border-outline-variant px-3 py-2 text-ui-10 leading-relaxed text-on-surface-variant/70">
                            {tr.curlHelp.before}
                            <span className="font-mono">-k</span>
                            {tr.curlHelp.after}
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
                                {tr.authDialogTitle({isCollection: authFor.kind === 'collection', name: authFor.name})}
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
                                title={tr.saveAuthTitle}
                                className="rounded bg-primary px-3 py-1 text-ui-11 text-on-primary hover:opacity-90"
                            >
                                {t.common.save}
                            </button>
                            <button onClick={() => setAuthFor(null)} title={tr.closeWithoutSaving} className="rounded p-1 text-on-surface-variant hover:bg-surface-variant">
                                <Icon name="close" size={16} />
                            </button>
                        </div>
                        <div className="min-h-0 flex-1 overflow-y-auto">
                            <AuthPanel
                                auth={authDraft}
                                onChange={setAuthDraft}
                                inheritsFrom={authFor.kind === 'folder' ? tr.inheritsFromCollection : undefined}
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
                            <p className="flex-1 truncate text-sm font-medium text-on-surface">{tr.computedDialogTitle({name: computedFor.name})}</p>
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
                                title={tr.saveComputedTitle}
                                className="rounded bg-primary px-3 py-1 text-ui-11 text-on-primary hover:opacity-90"
                            >
                                {t.common.save}
                            </button>
                            <button
                                onClick={() => setComputedFor(null)}
                                title={tr.closeWithoutSaving}
                                className="rounded p-1 text-on-surface-variant hover:bg-surface-variant"
                            >
                                <Icon name="close" size={16} />
                            </button>
                        </div>
                        <div className="min-h-0 flex-1 overflow-y-auto">
                            <ComputedTable rows={computedRows} onChange={setComputedRows} />
                        </div>
                        <p className="shrink-0 border-t border-outline-variant px-3 py-2 text-ui-10 leading-relaxed text-on-surface-variant/70">
                            {tr.computedHelp.before}
                            <strong>{tr.computedHelp.strong}</strong>
                            {tr.computedHelp.middle}
                            <span className="font-mono">{tr.computedHelp.code}</span>
                            {tr.computedHelp.after}
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
                            <p className="flex-1 truncate text-sm font-medium text-on-surface">{tr.varsDialogTitle({name: varsFor.name})}</p>
                            <button
                                onClick={() =>
                                    void guard(async () => {
                                        await HttpSaveCollection(
                                            new vault.HTTPCollection({...varsFor, variables: varsRows.length === 0 ? '' : JSON.stringify(varsRows)}),
                                        )
                                        setVarsFor(null)
                                    })
                                }
                                title={tr.saveVarsTitle}
                                className="rounded bg-primary px-3 py-1 text-ui-11 text-on-primary hover:opacity-90"
                            >
                                {t.common.save}
                            </button>
                            <button onClick={() => setVarsFor(null)} title={tr.closeWithoutSaving} className="rounded p-1 text-on-surface-variant hover:bg-surface-variant">
                                <Icon name="close" size={16} />
                            </button>
                        </div>
                        <div className="min-h-0 flex-1 overflow-y-auto">
                            <VariablesTable rows={varsRows} onChange={setVarsRows} />
                        </div>
                        <p className="shrink-0 border-t border-outline-variant px-3 py-2 text-ui-10 leading-relaxed text-on-surface-variant/70">
                            {tr.varsHelp}
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
                    confirmLabel={t.common.delete}
                    danger
                    onConfirm={() => void guard(confirm.run)}
                    onClose={() => setConfirm(null)}
                />
            )}
        </div>
    )
}

// Ejemplo de comando, no texto: igual en todos los idiomas.
const CURL_PLACEHOLDER = "curl 'https://api/x' \\\n  -H 'Authorization: Bearer ...' \\\n  --data-raw '{\"a\":1}'"

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
        return parts[parts.length - 1] || parts[0] || dict().sidebar.http.defaultRequestName
    } catch {
        return dict().sidebar.http.defaultRequestName
    }
}
