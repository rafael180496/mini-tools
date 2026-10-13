import {useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode} from 'react'
import Icon from '../../Icon'
import {useT} from '../../../i18n'
import {activeCount, EMPTY_FILTERS, isDefault, type DateFilter, type HistoryFilters, type OrderFilter, type StateFilter} from './historyFilters'

// Barra de filtros del historial del Chat de IA.
//
// Una sola fila siempre: el buscador y un botón «Filtros» con la cuenta de los
// criterios activos. El panel con todas las opciones se abre SOBRE la lista
// (no empuja nada), y lo que está activo se resume debajo en una línea de
// fichas que se desplaza en horizontal. Antes eran los proveedores como fichas
// que se partían en tres renglones y se comían la columna entera.
//
// Es un popover no modal: Esc o un clic afuera lo cierran y el foco vuelve al
// botón. Cada opción es un botón con `aria-pressed` y además se dice con texto
// y ícono, no solo con color.

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary'

export interface FilterProvider {
    id: string
    label: string
    n: number
}

export interface FilterOrigin {
    key: string
    label: string
    icon: string
    n: number
}

interface Props {
    filters: HistoryFilters
    onChange: (f: HistoryFilters) => void
    providers: FilterProvider[]
    origins: FilterOrigin[]
    providerIcon: (id: string) => string
    // El campo de búsqueda; la barra lo pone junto al botón de filtros.
    search: ReactNode
}

const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id])

export default function HistoryFilterBar({filters, onChange, providers, origins, providerIcon, search}: Props) {
    const t = useT()
    const tf = t.utilities.aiChat.filters
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement>(null)
    const buttonRef = useRef<HTMLButtonElement>(null)
    const panelRef = useRef<HTMLDivElement>(null)
    const panelId = useId()
    const count = activeCount(filters)

    const close = (refocus: boolean) => {
        setOpen(false)
        if (refocus) buttonRef.current?.focus()
    }

    // Clic afuera cierra. Se escucha el pointerdown de la ventana y no un velo:
    // un velo taparía la lista, y mirar la lista mientras se filtra es el punto.
    useEffect(() => {
        if (!open) return
        const onDown = (e: PointerEvent) => {
            if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
        }
        window.addEventListener('pointerdown', onDown)
        return () => window.removeEventListener('pointerdown', onDown)
    }, [open])

    // Al abrir, el foco entra al panel (a la primera opción).
    useEffect(() => {
        if (open) panelRef.current?.querySelector<HTMLElement>('button')?.focus()
    }, [open])

    const set = (patch: Partial<HistoryFilters>) => onChange({...filters, ...patch})

    // --- Fichas activas ---------------------------------------------------
    const chips: {id: string; icon: string; label: string; remove: () => void}[] = [
        ...filters.providers.map((id) => ({
            id: `p:${id}`,
            icon: providerIcon(id),
            label: providers.find((p) => p.id === id)?.label ?? id,
            remove: () => set({providers: filters.providers.filter((x) => x !== id)}),
        })),
        ...filters.origins.map((key) => {
            const o = origins.find((x) => x.key === key)
            return {id: `o:${key}`, icon: o?.icon ?? 'folder', label: o?.label ?? key, remove: () => set({origins: filters.origins.filter((x) => x !== key)})}
        }),
        ...(filters.date !== 'all' ? [{id: 'date', icon: 'calendar_today', label: tf.date[filters.date], remove: () => set({date: 'all'})}] : []),
        ...(filters.state !== 'any' ? [{id: 'state', icon: STATE_ICON[filters.state], label: tf.state[filters.state], remove: () => set({state: 'any'})}] : []),
        ...(filters.order !== 'recent' ? [{id: 'order', icon: 'sort_by_alpha', label: tf.order[filters.order], remove: () => set({order: 'recent'})}] : []),
    ]

    // La línea de fichas se desplaza en horizontal; el degradado del borde
    // aparece solo si de verdad hay más fichas de las que entran.
    const stripRef = useRef<HTMLDivElement>(null)
    const [overflow, setOverflow] = useState(false)
    useLayoutEffect(() => {
        const el = stripRef.current
        if (!el) {
            setOverflow(false)
            return
        }
        const measure = () => setOverflow(el.scrollWidth > el.clientWidth + 1)
        measure()
        const ro = new ResizeObserver(measure)
        ro.observe(el)
        return () => ro.disconnect()
    }, [chips.length, filters, t])

    return (
        <div ref={rootRef} className="relative">
            <div className="flex items-center gap-1.5">
                <div className="min-w-0 flex-1">{search}</div>
                <button
                    ref={buttonRef}
                    type="button"
                    data-filters-toggle
                    onClick={() => setOpen((v) => !v)}
                    aria-expanded={open}
                    aria-controls={open ? panelId : undefined}
                    aria-haspopup="dialog"
                    title={count > 0 ? tf.buttonTitleActive({n: count}) : tf.buttonTitle}
                    className={`relative flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1.5 text-xs transition-colors ${FOCUS} ${
                        open || count > 0
                            ? 'border-primary/50 bg-primary/15 text-primary'
                            : 'border-outline-variant text-on-surface-variant hover:border-primary/40 hover:text-on-surface'
                    }`}
                >
                    <Icon name="tune" size={14} />
                    <span>{tf.button}</span>
                    {count > 0 && (
                        <span
                            data-filters-count
                            aria-label={tf.activeCount({n: count})}
                            className="min-w-4 rounded-full bg-primary px-1 text-center font-mono text-ui-10 font-semibold tabular-nums text-on-primary"
                        >
                            {count}
                        </span>
                    )}
                </button>
            </div>

            {chips.length > 0 && (
                <div className="mt-2 flex items-center gap-1.5">
                    <div
                        ref={stripRef}
                        role="list"
                        data-filter-chips
                        aria-label={tf.activeLabel}
                        onWheel={(e) => {
                            // La rueda vertical desplaza la línea: sin esto, ver las
                            // fichas que no entran exigiría arrastrar una barra que
                            // está oculta a propósito.
                            if (e.deltaY !== 0 && stripRef.current) stripRef.current.scrollLeft += e.deltaY
                        }}
                        style={overflow ? {maskImage: 'linear-gradient(to right, black calc(100% - 18px), transparent)'} : undefined}
                        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                    >
                        {chips.map((c) => (
                            <span
                                key={c.id}
                                role="listitem"
                                className="flex shrink-0 items-center gap-1 rounded-full border border-primary/40 bg-primary/10 py-0.5 pl-2 pr-0.5 text-ui-10 text-primary"
                            >
                                <Icon name={c.icon} size={11} className="shrink-0" />
                                <span className="max-w-32 truncate whitespace-nowrap">{c.label}</span>
                                <button
                                    type="button"
                                    onClick={c.remove}
                                    title={tf.removeChipTitle({label: c.label})}
                                    aria-label={tf.removeChip({label: c.label})}
                                    className={`rounded-full p-0.5 hover:bg-primary/20 ${FOCUS}`}
                                >
                                    <Icon name="close" size={11} />
                                </button>
                            </span>
                        ))}
                    </div>
                    <button
                        type="button"
                        data-filters-clear
                        onClick={() => onChange(EMPTY_FILTERS)}
                        title={tf.clearTitle}
                        className={`shrink-0 rounded px-1 text-ui-10 text-on-surface-variant underline-offset-2 hover:text-on-surface hover:underline ${FOCUS}`}
                    >
                        {tf.clear}
                    </button>
                </div>
            )}

            {open && (
                <div
                    ref={panelRef}
                    id={panelId}
                    role="dialog"
                    aria-label={tf.panel}
                    data-filters-panel
                    onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                            e.stopPropagation()
                            close(true)
                        }
                    }}
                    className="absolute inset-x-0 top-full z-20 mt-1 max-h-[min(85vh,42rem)] overflow-y-auto rounded-lg border border-outline-variant bg-surface-container-high p-2.5 text-on-surface shadow-lg"
                >
                    <Section title={tf.providerSection} hint={tf.noneMeansAll}>
                        {providers.map((p) => (
                            <Option
                                key={p.id}
                                pressed={filters.providers.includes(p.id)}
                                onClick={() => set({providers: toggle(filters.providers, p.id)})}
                                icon={providerIcon(p.id)}
                                label={p.label}
                                count={p.n}
                                title={tf.providerTitle({agent: p.label, n: p.n})}
                                multi
                            />
                        ))}
                    </Section>

                    {origins.length > 0 && (
                        <Section title={tf.originSection} hint={tf.noneMeansAll}>
                            <div className="max-h-36 overflow-y-auto">
                                {origins.map((o) => (
                                    <Option
                                        key={o.key}
                                        pressed={filters.origins.includes(o.key)}
                                        onClick={() => set({origins: toggle(filters.origins, o.key)})}
                                        icon={o.icon}
                                        label={o.label}
                                        count={o.n}
                                        title={tf.originTitle({name: o.label, n: o.n})}
                                        multi
                                    />
                                ))}
                            </div>
                        </Section>
                    )}

                    <Section title={tf.dateSection}>
                        <Segmented<DateFilter>
                            value={filters.date}
                            onChange={(date) => set({date})}
                            options={(['all', 'today', 'd7', 'd30'] as const).map((id) => ({id, label: tf.date[id], title: tf.dateTitle[id]}))}
                        />
                    </Section>

                    <Section title={tf.stateSection}>
                        <Segmented<StateFilter>
                            value={filters.state}
                            onChange={(state) => set({state})}
                            options={(['any', 'working', 'unread', 'background'] as const).map((id) => ({id, label: tf.state[id], title: tf.stateTitle[id], icon: id === 'any' ? undefined : STATE_ICON[id]}))}
                        />
                    </Section>

                    <Section title={tf.orderSection}>
                        <Segmented<OrderFilter>
                            value={filters.order}
                            onChange={(order) => set({order})}
                            options={(['recent', 'name'] as const).map((id) => ({id, label: tf.order[id], title: tf.orderTitle[id]}))}
                        />
                    </Section>

                    <div className="mt-2 flex items-center justify-between gap-2 border-t border-outline-variant pt-2">
                        <button
                            type="button"
                            onClick={() => onChange(EMPTY_FILTERS)}
                            disabled={isDefault(filters)}
                            title={isDefault(filters) ? tf.clearNothingTitle : tf.clearTitle}
                            className={`rounded px-1.5 py-0.5 text-ui-11 text-on-surface-variant hover:text-on-surface disabled:opacity-40 ${FOCUS}`}
                        >
                            {tf.clear}
                        </button>
                        <button
                            type="button"
                            onClick={() => close(true)}
                            title={tf.doneTitle}
                            className={`rounded-md bg-primary px-3 py-1 text-ui-11 font-medium text-on-primary hover:opacity-90 ${FOCUS}`}
                        >
                            {tf.done}
                        </button>
                    </div>
                </div>
            )}
        </div>
    )
}

const STATE_ICON: Record<Exclude<StateFilter, 'any'>, string> = {working: 'progress_activity', unread: 'mark_chat_unread', background: 'layers'}

function Section({title, hint, children}: {title: string; hint?: string; children: ReactNode}) {
    return (
        <section className="mb-2.5 last:mb-0">
            <h4 className="mb-1 flex items-baseline gap-1.5 px-0.5 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant">
                {title}
                {hint && <span className="font-normal normal-case tracking-normal opacity-60">{hint}</span>}
            </h4>
            {children}
        </section>
    )
}

// Una opción de selección múltiple: casilla + ícono + nombre + cuántas.
function Option({
    pressed,
    onClick,
    icon,
    label,
    count,
    title,
    multi,
}: {
    pressed: boolean
    onClick: () => void
    icon: string
    label: string
    count?: number
    title: string
    multi?: boolean
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={pressed}
            title={title}
            className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs ${FOCUS} ${
                pressed ? 'bg-primary/10 text-on-surface' : 'text-on-surface-variant hover:bg-surface-variant hover:text-on-surface'
            }`}
        >
            {multi && <Icon name={pressed ? 'check_box' : 'check_box_outline_blank'} size={15} filled={pressed} className={`shrink-0 ${pressed ? 'text-primary' : ''}`} />}
            <Icon name={icon} size={14} className="shrink-0 opacity-80" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {count !== undefined && <span className="shrink-0 font-mono text-ui-10 tabular-nums opacity-60">{count}</span>}
        </button>
    )
}

// Selección única en una fila de botones unidos. Los que no entran bajan de
// renglón: en la columna angosta del historial no caben cuatro de una.
function Segmented<T extends string>({
    value,
    onChange,
    options,
}: {
    value: T
    onChange: (v: T) => void
    options: {id: T; label: string; title: string; icon?: string}[]
}) {
    return (
        <div role="group" className="flex flex-wrap gap-1">
            {options.map((o) => {
                const on = o.id === value
                return (
                    <button
                        key={o.id}
                        type="button"
                        onClick={() => onChange(o.id)}
                        aria-pressed={on}
                        title={o.title}
                        className={`flex items-center gap-1 rounded-md border px-2 py-0.5 text-ui-11 transition-colors ${FOCUS} ${
                            on ? 'border-primary/50 bg-primary/15 text-primary' : 'border-outline-variant text-on-surface-variant hover:border-primary/40 hover:text-on-surface'
                        }`}
                    >
                        {o.icon && <Icon name={o.icon} size={12} className="shrink-0" />}
                        {o.label}
                    </button>
                )
            })}
        </div>
    )
}
