import {useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode} from 'react'
import {DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent} from '@dnd-kit/core'
import {SortableContext, useSortable, verticalListSortingStrategy} from '@dnd-kit/sortable'
import {CSS} from '@dnd-kit/utilities'
import type {main} from '../../../../wailsjs/go/models'
import Icon from '../../Icon'
import Toggle from '../../Toggle'
import {HealthDot} from '../../agent/HealthIndicators'
import {useTreeMenu, type TreeMenuEntry} from '../../sidebar/TreeMenu'
import {useT} from '../../../i18n'
import {MODEL_SERVER_PREFIX, providerGroup, providerIcon, providerKind, type ProviderGroup} from '../../../lib/modelServers'
import type {Health} from '../../../lib/modelServerHealth'
import {hostOf} from './modelFormat'
import {GROUP_ORDER, moveByStep, moveToTarget, splitByGroup} from './providerOrder'

// Columna de proveedores de la utilidad «Proveedores de IA»: servidores propios
// (locales y remotos) y APIs alojadas (nube) en una lista de tres grupos, con lo
// que hace falta para elegir uno de un vistazo —ícono, tipo, si contesta, cuántos
// modelos tiene, si está activo— y el menú para administrarlo sin salir de la
// pestaña.
//
// **Quién decide qué.** Esta columna solo dibuja y avisa: elegir, editar,
// probar, duplicar, eliminar, encender/apagar y reordenar son callbacks de
// `ModelManagerTab`, que es quien tiene el estado y habla con el backend. Así la
// misma columna sirve en el costado y dentro del cajón de una pestaña angosta.
//
// **Orden.** Se arrastra del asa (dnd-kit) dentro de su grupo —entre grupos no:
// el grupo lo decide dónde corre el proveedor, no una preferencia— y, con el
// teclado, Alt+↑ / Alt+↓ sobre la fila. El orden es uno solo para todos
// (`providerOrder`), y los selectores de IA de la app lo respetan.
//
// **Teclado.** Cada fila es un botón: Tab entra, Enter elige, las flechas ↑ ↓
// (Inicio / Fin) pasan de una a otra sin recorrer todo con Tab. El interruptor y
// el «⋯» de cada fila son controles aparte (el «⋯» se ve al pasar el mouse, al
// enfocar la fila o en la elegida) y el menú se abre también con el clic derecho.

// Con más proveedores que esto aparece el buscador: con cuatro o cinco, un campo
// de texto es ruido; con veinte, es lo único que ayuda.
const SEARCH_FROM = 7

// Solo el movimiento vertical: la fila no se sale de su columna.
const lockHorizontal = ({transform}: {transform: {x: number; y: number; scaleX: number; scaleY: number}}) => ({...transform, x: 0})

interface Props {
    servers: main.ModelServer[]
    healthById: Record<string, Health>
    // Cantidad de modelos conocida por servidor (la de la lectura real si es el
    // elegido, la de la última comprobación si no). Sin dato, no se muestra.
    modelCounts: Record<string, number>
    selectedId: string
    // Servidores con una prueba en curso.
    testing: Set<string>
    onSelect: (id: string) => void
    onAdd: () => void
    onEdit: (s: main.ModelServer) => void
    onTest: (s: main.ModelServer) => void
    onDuplicate: (s: main.ModelServer) => void
    onDelete: (s: main.ModelServer) => void
    onToggleEnabled: (s: main.ModelServer, enabled: boolean) => void
    // Orden nuevo de TODOS los ids.
    onReorder: (ids: string[]) => void
}

export default function ModelServersColumn({servers, healthById, modelCounts, selectedId, testing, onSelect, onAdd, onEdit, onTest, onDuplicate, onDelete, onToggleEnabled, onReorder}: Props) {
    const t = useT()
    const L = t.models.servers
    const P = t.models.providers
    const [query, setQuery] = useState('')
    const rootRef = useRef<HTMLDivElement>(null)
    const menu = useTreeMenu()
    const [menuFor, setMenuFor] = useState('')
    // Anuncio para el lector de pantalla tras mover una fila con el teclado, y
    // fila a la que devolver el foco (el nodo se reubica y pierde el foco).
    const [announce, setAnnounce] = useState('')
    const refocus = useRef('')

    const q = query.trim().toLowerCase()
    const shown = useMemo(
        () =>
            q
                ? servers.filter((s) =>
                      `${s.name} ${s.baseUrl} ${P.kindShort[providerKind(s.kind)]} ${P.groups[providerGroup(s)]} ${s.enabled ? '' : P.disabled}`.toLowerCase().includes(q),
                  )
                : servers,
        [servers, q, P],
    )
    const groups = useMemo(() => splitByGroup(shown), [shown])
    // Con una búsqueda activa la lista es un recorte: arrastrar ahí reordenaría
    // sobre algo que no se ve completo.
    const sortable = q === ''

    const sensors = useSensors(useSensor(PointerSensor, {activationConstraint: {distance: 5}}))

    useEffect(() => {
        if (!refocus.current) return
        const el = rootRef.current?.querySelector<HTMLButtonElement>(`button[data-server-row="${refocus.current}"]`)
        refocus.current = ''
        el?.focus()
    }, [servers])

    function items(s: main.ModelServer): TreeMenuEntry[] {
        const busy = testing.has(s.id)
        return [
            {label: L.actions.edit, icon: 'edit', title: L.actions.editTitle({name: s.name}), onSelect: () => onEdit(s)},
            {label: busy ? L.actions.testing : L.actions.test, icon: 'network_check', disabled: busy, title: L.actions.testTitle({name: s.name}), onSelect: () => onTest(s)},
            {
                label: s.enabled ? P.disable : P.enable,
                icon: s.enabled ? 'toggle_off' : 'toggle_on',
                title: s.enabled ? P.switchOnTitle({name: s.name}) : P.switchOffTitle({name: s.name}),
                onSelect: () => onToggleEnabled(s, !s.enabled),
            },
            {label: L.actions.duplicate, icon: 'content_copy', title: L.actions.duplicateTitle({name: s.name}), onSelect: () => onDuplicate(s)},
            'separator',
            {label: L.actions.delete, icon: 'delete', danger: true, title: L.actions.deleteTitle({name: s.name}), onSelect: () => onDelete(s)},
        ]
    }

    function openMenu(e: ReactMouseEvent, s: main.ModelServer) {
        setMenuFor(s.id)
        menu.openAt(e, items(s))
    }

    function onDragEnd(e: DragEndEvent) {
        if (!e.over || e.active.id === e.over.id) return
        const ids = moveToTarget(servers, String(e.active.id), String(e.over.id))
        if (ids) onReorder(ids)
    }

    // Flechas entre filas (el interruptor y el «⋯» no entran en el recorrido:
    // se llega con Tab) y Alt+↑ / Alt+↓ para mover la fila dentro de su grupo.
    function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
        const rows = [...(rootRef.current?.querySelectorAll<HTMLButtonElement>('button[data-server-row]') ?? [])]
        const at = rows.indexOf(document.activeElement as HTMLButtonElement)
        if (at < 0) return
        e.preventDefault()
        if (e.altKey) {
            if (!sortable || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
            const id = rows[at].dataset.serverRow ?? ''
            const moved = moveByStep(servers, id, e.key === 'ArrowDown' ? 1 : -1)
            if (!moved) return
            refocus.current = id
            setAnnounce(P.movedAnnounce({name: servers.find((s) => s.id === id)?.name ?? '', position: moved.position, total: moved.total}))
            onReorder(moved.ids)
            return
        }
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : e.key === 'ArrowDown' ? Math.min(rows.length - 1, at + 1) : Math.max(0, at - 1)
        rows[next].focus()
    }

    const visibleGroups = GROUP_ORDER.filter((g) => groups[g].length > 0)

    return (
        <div data-model-servers-column className="flex h-full min-h-0 flex-col bg-surface-container-low text-on-surface">
            <div className="flex shrink-0 flex-col gap-2 border-b border-outline-variant px-3 py-2">
                <h2 className="flex items-center gap-2 text-xs font-semibold">
                    <Icon name="hub" size={16} className="shrink-0 text-primary" />
                    <span className="min-w-0 flex-1 truncate">{L.title}</span>
                    <span className="shrink-0 rounded-full bg-surface-container-highest px-1.5 text-ui-10 font-normal text-on-surface-variant">{servers.length}</span>
                </h2>
                <button
                    type="button"
                    data-model-server-add
                    onClick={onAdd}
                    title={L.addTitle}
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-on-primary hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                    <Icon name="add" size={14} />
                    {L.add}
                </button>
            </div>

            {servers.length >= SEARCH_FROM && (
                <div className="shrink-0 border-b border-outline-variant px-2 py-1.5">
                    <div className="flex items-center gap-1.5 rounded-lg bg-surface-container-highest px-2 py-1 focus-within:ring-1 focus-within:ring-primary">
                        <Icon name="search" size={14} className="shrink-0 text-on-surface-variant/60" />
                        <input
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder={L.searchPlaceholder}
                            aria-label={L.searchPlaceholder}
                            title={L.searchTitle}
                            className="min-w-0 flex-1 bg-transparent text-xs text-on-surface outline-none placeholder:text-on-surface-variant/60"
                        />
                        {query && (
                            <button type="button" onClick={() => setQuery('')} title={L.clearSearch} aria-label={L.clearSearch} className="shrink-0 rounded text-on-surface-variant/60 hover:text-on-surface">
                                <Icon name="close" size={14} />
                            </button>
                        )}
                    </div>
                </div>
            )}

            <div ref={rootRef} role="group" aria-label={L.listLabel} onKeyDown={onKeyDown} className="min-h-0 flex-1 overflow-y-auto pb-1">
                {shown.length === 0 && <p className="px-4 py-6 text-center text-xs text-on-surface-variant">{L.noMatch({query: query.trim()})}</p>}
                <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[lockHorizontal]} onDragEnd={onDragEnd}>
                    {visibleGroups.map((g) => (
                        <GroupSection key={g} group={g} count={groups[g].length}>
                            <SortableContext items={groups[g].map((s) => s.id)} strategy={verticalListSortingStrategy} disabled={!sortable}>
                                {groups[g].map((s) => (
                                    <ServerRow
                                        key={s.id}
                                        s={s}
                                        selected={s.id === selectedId}
                                        health={healthById[MODEL_SERVER_PREFIX + s.id]}
                                        count={modelCounts[s.id]}
                                        testing={testing.has(s.id)}
                                        menuOpen={menu.isOpen && menuFor === s.id}
                                        sortable={sortable}
                                        onSelect={onSelect}
                                        onOpenMenu={openMenu}
                                        onToggleEnabled={onToggleEnabled}
                                    />
                                ))}
                            </SortableContext>
                        </GroupSection>
                    ))}
                </DndContext>
            </div>
            <p aria-live="polite" className="sr-only">
                {announce}
            </p>
            {sortable && servers.length > 1 && <p className="shrink-0 border-t border-outline-variant px-3 py-1.5 text-ui-10 text-on-surface-variant">{P.orderHint}</p>}
            {menu.element}
        </div>
    )
}

function GroupSection({group, count, children}: {group: ProviderGroup; count: number; children: ReactNode}) {
    const P = useT().models.providers
    const id = `provider-group-${group}`
    return (
        <section aria-labelledby={id} data-provider-group={group}>
            <h3 id={id} title={P.groupTitles[group]} className="flex items-center gap-1.5 px-3 pb-1 pt-2.5 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant">
                <Icon name={group === 'local' ? 'computer' : group === 'remote' ? 'lan' : 'cloud'} size={12} className="shrink-0" />
                {P.groups[group]}
                <span className="font-normal normal-case tracking-normal opacity-70">{count}</span>
            </h3>
            <ul>{children}</ul>
        </section>
    )
}

interface RowProps {
    s: main.ModelServer
    selected: boolean
    health: Health | undefined
    count: number | undefined
    testing: boolean
    menuOpen: boolean
    sortable: boolean
    onSelect: (id: string) => void
    onOpenMenu: (e: ReactMouseEvent, s: main.ModelServer) => void
    onToggleEnabled: (s: main.ModelServer, enabled: boolean) => void
}

function ServerRow({s, selected, health, count, testing, menuOpen, sortable, onSelect, onOpenMenu, onToggleEnabled}: RowProps) {
    const t = useT()
    const L = t.models.servers
    const P = t.models.providers
    const {attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging} = useSortable({id: s.id, disabled: !sortable})
    const host = hostOf(s.baseUrl)
    const kind = providerKind(s.kind)
    const off = !s.enabled
    return (
        <li
            ref={setNodeRef}
            style={{transform: CSS.Transform.toString(transform), transition}}
            className={`group relative flex items-start border-l-2 ${
                selected ? 'border-primary bg-primary/10' : 'border-transparent hover:bg-surface-container-high'
            } ${isDragging ? 'z-10 bg-surface-container-high shadow-md' : ''}`}
            data-server-id={s.id}
            data-enabled={s.enabled ? 'true' : 'false'}
        >
            {sortable && (
                <span
                    ref={setActivatorNodeRef}
                    {...attributes}
                    {...listeners}
                    tabIndex={-1}
                    role="presentation"
                    aria-hidden="true"
                    data-server-handle={s.id}
                    title={P.handleTitle({name: s.name})}
                    className="absolute left-0 top-1/2 z-[1] flex h-8 w-3.5 -translate-y-1/2 cursor-grab touch-none items-center justify-center rounded-r text-on-surface-variant/70 opacity-0 hover:bg-surface-variant hover:text-on-surface group-focus-within:opacity-100 group-hover:opacity-100 active:cursor-grabbing"
                >
                    <Icon name="drag_indicator" size={14} />
                </span>
            )}
            <button
                type="button"
                data-server-row={s.id}
                aria-current={selected ? 'true' : undefined}
                aria-keyshortcuts={sortable ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
                onClick={() => onSelect(s.id)}
                onContextMenu={(e) => onOpenMenu(e, s)}
                title={off ? P.disabledRowTitle({name: s.name}) : L.rowTitle({name: s.name, host})}
                className={`flex min-w-0 flex-1 items-start gap-2.5 py-2 pl-3 pr-1 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary ${off ? 'opacity-60' : ''}`}
            >
                <span
                    className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${selected ? 'bg-primary text-on-primary' : 'bg-primary/15 text-primary'}`}
                    title={P.kindTitles[kind]}
                >
                    <Icon name={providerIcon(s)} size={16} />
                </span>
                <span className="min-w-0 flex-1">
                    <span className={`block truncate text-xs ${selected ? 'font-semibold' : 'font-medium'}`}>{s.name}</span>
                    <span className="block truncate font-mono text-ui-10 text-on-surface-variant">{host}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-ui-10">
                        <span className="shrink-0 rounded-full bg-surface-container-highest px-1.5 py-px text-on-surface-variant">{P.kindShort[kind]}</span>
                        {off ? (
                            <span className="shrink-0 text-on-surface-variant">{P.disabled}</span>
                        ) : (
                            <>
                                {health && <RowHealth health={health} name={s.name} testing={testing} />}
                                {count !== undefined && (
                                    <span title={L.modelCountTitle} className="shrink-0 text-on-surface-variant">
                                        {L.modelCount({n: count})}
                                    </span>
                                )}
                            </>
                        )}
                    </span>
                </span>
            </button>
            <span className="mt-2.5 shrink-0">
                <Toggle
                    size="sm"
                    checked={s.enabled}
                    onChange={(v) => onToggleEnabled(s, v)}
                    ariaLabel={P.switchLabel({name: s.name})}
                    title={s.enabled ? P.switchOnTitle({name: s.name}) : P.switchOffTitle({name: s.name})}
                />
            </span>
            <button
                type="button"
                data-server-menu={s.id}
                onClick={(e) => onOpenMenu(e, s)}
                title={L.menuTitle({name: s.name})}
                aria-label={L.menuLabel({name: s.name})}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                className={`mr-1 mt-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-on-surface-variant hover:bg-surface-variant hover:text-on-surface focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-primary group-focus-within:opacity-100 group-hover:opacity-100 ${
                    selected || menuOpen ? 'opacity-100' : 'opacity-0'
                }`}
            >
                <Icon name="more_horiz" size={16} />
            </button>
        </li>
    )
}

// Punto de salud + latencia (o «sin respuesta») de una fila. El color nunca es
// lo único que informa: el punto lleva su propio `aria-label` y el texto dice lo
// mismo con palabras.
function RowHealth({health, name, testing}: {health: Health; name: string; testing: boolean}) {
    const t = useT()
    const h = t.agent.health
    const status = testing ? 'checking' : health.status
    const text = status === 'ok' ? h.badgeOk({latency: health.latencyMs}) : status === 'error' ? h.badgeError : status === 'checking' ? h.badgeChecking : h.statusUnknown
    return (
        <span className={`flex shrink-0 items-center gap-1 ${status === 'error' ? 'text-error' : 'text-on-surface-variant'}`}>
            <HealthDot health={{...health, status}} server={name} />
            {text}
        </span>
    )
}
