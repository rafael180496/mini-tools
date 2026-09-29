import {useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode} from 'react'
import {createPortal} from 'react-dom'
import Icon from '../Icon'
import {t as dict, useT} from '../../i18n'

// Menú contextual de los árboles de la barra lateral (clic derecho o botón
// «⋯» de una fila). Uno solo para los cinco módulos: el mismo gesto tiene que
// abrir el mismo menú, con la misma forma, esté uno en Notas o en SSH.
//
// Tiene submenús («Mover a…») que se abren EN EL MISMO panel, con una fila
// para volver, y no hacia el costado: la barra es angosta y un flyout lateral
// quedaría tapando el editor o fuera de la ventana.
//
// Se maneja con teclado: flechas, Enter, ← para volver del submenú y Esc.

export interface TreeMenuItem {
    label: string
    icon?: string
    // Texto a la derecha, atenuado: un atajo o un dato corto ("3 notas").
    hint?: string
    // Explicación larga, en el title.
    title?: string
    danger?: boolean
    disabled?: boolean
    // Marca de la opción vigente (por ejemplo, la carpeta actual en «Mover a…»).
    checked?: boolean
    // Sangría en el submenú, para mostrar un árbol de carpetas.
    depth?: number
    onSelect?: () => void
    submenu?: TreeMenuEntry[]
}

export type TreeMenuEntry = TreeMenuItem | 'separator'

export interface Anchor {
    x: number
    y: number
}

// useTreeMenu devuelve con qué abrir el menú y el elemento a dibujar. Los
// ítems se arman al abrir, no al dibujar la fila: así una fila no construye
// quince closures por render para un menú que casi nunca se abre.
export function useTreeMenu() {
    const [state, setState] = useState<{anchor: Anchor; items: TreeMenuEntry[]} | null>(null)

    const openAt = useCallback((e: ReactMouseEvent, items: TreeMenuEntry[]) => {
        e.preventDefault()
        e.stopPropagation()
        // Desde un botón se ancla debajo del botón; desde el clic derecho, en
        // el cursor.
        setState({anchor: menuAnchor(e), items})
    }, [])

    // openAtPoint es para el menú que se arma DESPUÉS del evento (porque
    // espera una lista que se pide al abrir): React no conserva
    // `currentTarget` cuando el handler ya terminó, así que se guarda el
    // ancla con menuAnchor(e) y se abre con ella.
    const openAtPoint = useCallback((anchor: Anchor, items: TreeMenuEntry[]) => setState({anchor, items}), [])

    const close = useCallback(() => setState(null), [])

    const element = state ? <TreeMenu anchor={state.anchor} items={state.items} onClose={close} /> : null
    return {openAt, openAtPoint, close, element, isOpen: !!state}
}

// menuAnchor dice dónde abrir: desde un botón, debajo del botón; desde el clic
// derecho, en el cursor.
export function menuAnchor(e: ReactMouseEvent): Anchor {
    const target = e.currentTarget as HTMLElement
    if (e.type === 'click' && target.tagName === 'BUTTON') {
        const r = target.getBoundingClientRect()
        return {x: r.left, y: r.bottom + 4}
    }
    return {x: e.clientX, y: e.clientY}
}

function tidy(entries: TreeMenuEntry[]): TreeMenuEntry[] {
    const out: TreeMenuEntry[] = []
    for (const e of entries) {
        if (e === 'separator' && (out.length === 0 || out[out.length - 1] === 'separator')) continue
        out.push(e)
    }
    while (out[out.length - 1] === 'separator') out.pop()
    return out
}

const WIDTH = 236

function TreeMenu({anchor, items, onClose}: {anchor: Anchor; items: TreeMenuEntry[]; onClose: () => void}) {
    const t = useT()
    // Pila de niveles: el raíz y, si se entró, el submenú con su título.
    const [stack, setStack] = useState<{title?: string; items: TreeMenuEntry[]}[]>([{items}])
    const level = stack[stack.length - 1]
    const entries = tidy(level.items)
    const selectable = entries.flatMap((e, i) => (e !== 'separator' && !e.disabled ? [i] : []))
    const [focus, setFocus] = useState(-1)
    const panelRef = useRef<HTMLDivElement>(null)
    const [pos, setPos] = useState({left: anchor.x, top: anchor.y})

    // Se mide después de dibujar y se corre dentro de la ventana: abierto
    // cerca del borde de abajo, un menú a medias no se puede scrollear en un
    // webview de escritorio.
    useLayoutEffect(() => {
        const el = panelRef.current
        if (!el) return
        const h = el.offsetHeight
        const left = Math.max(8, Math.min(anchor.x, window.innerWidth - WIDTH - 8))
        const top = anchor.y + h + 8 > window.innerHeight ? Math.max(8, anchor.y - h) : anchor.y
        setPos({left, top})
    }, [anchor, stack])

    useEffect(() => setFocus(-1), [stack])

    const choose = useCallback(
        (item: TreeMenuItem) => {
            if (item.disabled) return
            if (item.submenu) {
                setStack((s) => [...s, {title: item.label, items: item.submenu!}])
                return
            }
            onClose()
            item.onSelect?.()
        },
        [onClose],
    )

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault()
                if (stack.length > 1) setStack((s) => s.slice(0, -1))
                else onClose()
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                if (selectable.length === 0) return
                const at = selectable.indexOf(focus)
                const next = e.key === 'ArrowDown' ? (at + 1) % selectable.length : (at - 1 + selectable.length) % selectable.length
                setFocus(selectable[at < 0 && e.key === 'ArrowUp' ? selectable.length - 1 : next])
            } else if (e.key === 'Enter' || e.key === 'ArrowRight') {
                const item = entries[focus]
                if (item && item !== 'separator' && (e.key === 'Enter' || item.submenu)) {
                    e.preventDefault()
                    choose(item)
                }
            } else if (e.key === 'ArrowLeft' && stack.length > 1) {
                e.preventDefault()
                setStack((s) => s.slice(0, -1))
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [stack, entries, focus, selectable, choose, onClose])

    return createPortal(
        <>
            <div
                className="fixed inset-0 z-40"
                onMouseDown={onClose}
                onContextMenu={(e) => {
                    e.preventDefault()
                    onClose()
                }}
            />
            <div
                ref={panelRef}
                role="menu"
                style={{position: 'fixed', ...pos, width: WIDTH}}
                className="z-50 max-h-[70vh] overflow-y-auto rounded-lg border border-outline-variant bg-surface-container-high p-1 text-ui-12 text-on-surface shadow-xl"
            >
                {stack.length > 1 && (
                    <>
                        <button
                            onClick={() => setStack((s) => s.slice(0, -1))}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-medium text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                        >
                            <Icon name="arrow_back" size={16} className="shrink-0" />
                            <span className="truncate">{level.title}</span>
                        </button>
                        <div className="my-1 border-t border-outline-variant" />
                    </>
                )}
                {entries.map((item, i) =>
                    item === 'separator' ? (
                        <div key={`sep-${i}`} className="my-1 border-t border-outline-variant" />
                    ) : (
                        <MenuRow key={`${item.label}-${i}`} item={item} focused={focus === i} onHover={() => setFocus(i)} onChoose={() => choose(item)} />
                    ),
                )}
                {entries.length === 0 && <p className="px-2 py-1.5 text-on-surface-variant">{t.common.nothingToPick}</p>}
            </div>
        </>,
        document.body,
    )
}

function MenuRow({item, focused, onHover, onChoose}: {item: TreeMenuItem; focused: boolean; onHover: () => void; onChoose: () => void}) {
    const tone = item.danger
        ? `text-error ${focused ? 'bg-error-container/40' : ''}`
        : `${focused ? 'bg-surface-variant text-on-surface' : 'text-on-surface'}`
    return (
        <button
            role="menuitem"
            disabled={item.disabled}
            title={item.title}
            onMouseEnter={onHover}
            onClick={onChoose}
            style={item.depth ? {paddingLeft: `${8 + item.depth * 14}px`} : undefined}
            className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left disabled:opacity-40 ${tone}`}
        >
            <Icon
                name={item.checked ? 'check' : item.icon ?? 'circle'}
                size={16}
                className={`shrink-0 ${item.icon || item.checked ? '' : 'invisible'} ${item.danger ? '' : 'text-on-surface-variant'} ${item.checked ? 'text-primary' : ''}`}
            />
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.hint && <span className="shrink-0 text-ui-10 text-on-surface-variant/70">{item.hint}</span>}
            {item.submenu && <Icon name="chevron_right" size={16} className="shrink-0 text-on-surface-variant" />}
        </button>
    )
}

// moveToFolderSubmenu arma el submenú «Mover a…» a partir del árbol de
// carpetas aplanado, con la raíz primero y la carpeta actual marcada.
export function moveToFolderSubmenu(
    flatFolders: {folder: {id: string; name: string}; depth: number}[],
    currentId: string,
    onMove: (folderId: string) => void,
    rootLabel = dict().common.rootNoFolder,
): TreeMenuEntry[] {
    return [
        {label: rootLabel, icon: 'home', checked: currentId === '', onSelect: () => onMove('')},
        ...(flatFolders.length ? (['separator'] as TreeMenuEntry[]) : []),
        ...flatFolders.map(({folder, depth}) => ({
            label: folder.name,
            icon: 'folder',
            depth,
            checked: folder.id === currentId,
            onSelect: () => onMove(folder.id),
        })),
    ]
}

// MenuButton es el «⋯» de una fila: el mismo menú que el clic derecho, para
// quien no sabe que existe el clic derecho.
export function MenuButton({onOpen, title}: {onOpen: (e: ReactMouseEvent) => void; title?: string}): ReactNode {
    const t = useT()
    return (
        <button onClick={onOpen} title={title ?? t.common.moreOptions} className="sidebar-icon !p-0.5">
            <Icon name="more_horiz" size={14} />
        </button>
    )
}
