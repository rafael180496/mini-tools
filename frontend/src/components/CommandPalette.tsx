import {useEffect, useId, useMemo, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import Icon from './Icon'
import {useT} from '../i18n'

export interface CommandPaletteItem {
    id: string
    group: 'files' | 'modes' | 'tabs' | 'connections' | 'actions'
    label: string
    subtitle?: string
    icon: string
    shortcut?: string
    active?: boolean
    keywords?: string
    onSelect: () => void
}

interface CommandPaletteProps {
    open: boolean
    onClose: () => void
    items: CommandPaletteItem[]
}

// Cuántos resultados se muestran como máximo por grupo. Se corta DESPUÉS de
// filtrar: buscar siempre recorre todos los archivos del proyecto.
const GROUP_LIMIT: Partial<Record<CommandPaletteItem['group'], number>> = {files: 50}

function normalizeText(s: string): string {
    return s
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
}

export default function CommandPalette({open, onClose, items}: CommandPaletteProps) {
    const t = useT()
    const [query, setQuery] = useState('')
    const [selectedIdx, setSelectedIdx] = useState(0)
    const inputRef = useRef<HTMLInputElement>(null)
    const listRef = useRef<HTMLDivElement>(null)
    const navByKeyboardRef = useRef(false)
    const listId = useId()

    useEffect(() => {
        if (!open) return
        setQuery('')
        setSelectedIdx(0)
        navByKeyboardRef.current = false
        // Enfocar en el siguiente frame para asegurar que el nodo esté montado.
        const id = window.requestAnimationFrame(() => inputRef.current?.focus())
        return () => window.cancelAnimationFrame(id)
    }, [open])

    // El texto normalizado de cada ítem se arma una vez por lista, no en cada
    // tecla: con un repo grande la paleta trae miles de archivos.
    const haystacks = useMemo(
        () => items.map((it) => normalizeText(`${it.label} ${it.subtitle ?? ''} ${it.keywords ?? ''}`)),
        [items],
    )

    const filtered = useMemo(() => {
        const q = normalizeText(query.trim())
        if (!q) return items
        const tokens = q.split(/\s+/).filter(Boolean)
        return items.filter((_, i) => {
            const h = haystacks[i]
            return tokens.every((tok) => h.includes(tok))
        })
    }, [items, haystacks, query])

    useEffect(() => {
        setSelectedIdx(0)
    }, [query])

    // La opción resaltada con las flechas siempre queda a la vista.
    // Solo cuando se navega por teclado (nunca en mouseover, para no mover
    // el botón debajo del cursor antes de que se dispare el clic).
    useEffect(() => {
        if (!open || !navByKeyboardRef.current) return
        navByKeyboardRef.current = false
        listRef.current?.querySelector(`[data-idx="${selectedIdx}"]`)?.scrollIntoView({block: 'nearest'})
    }, [open, selectedIdx])

    if (!open) return null

    const groupOrder: CommandPaletteItem['group'][] = ['files', 'modes', 'tabs', 'connections', 'actions']
    const grouped = groupOrder
        .map((group) => ({
            group,
            label: t.shell.ade.palette.groups[group],
            items: filtered.filter((it) => it.group === group).slice(0, GROUP_LIMIT[group] ?? Infinity),
        }))
        .filter((g) => g.items.length > 0)

    const flatList = grouped.flatMap((g) => g.items)
    const safeIdx = Math.min(selectedIdx, Math.max(0, flatList.length - 1))

    function runItem(item: CommandPaletteItem | undefined) {
        if (!item) return
        item.onSelect()
        onClose()
    }

    function onKeyDown(e: React.KeyboardEvent) {
        if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
        } else if (e.key === 'Tab') {
            // Diálogo modal: el foco no sale de la paleta. Todo se maneja desde
            // el buscador (flechas y Enter), así que Tab no tiene a dónde ir.
            e.preventDefault()
            inputRef.current?.focus()
        } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            navByKeyboardRef.current = true
            if (flatList.length > 0) setSelectedIdx((i) => (i + 1) % flatList.length)
        } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            navByKeyboardRef.current = true
            if (flatList.length > 0) setSelectedIdx((i) => (i - 1 + flatList.length) % flatList.length)
        } else if (e.key === 'Enter') {
            e.preventDefault()
            runItem(flatList[safeIdx])
        }
    }

    let runningIndex = -1

    return createPortal(
        <div
            role="dialog"
            aria-modal="true"
            aria-label={t.shell.ade.searchTrigger}
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) onClose()
            }}
            onKeyDown={onKeyDown}
            className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 px-4 pt-[12vh] backdrop-blur-[1px]"
        >
            <div className="flex w-full max-w-xl flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface-container-high text-on-surface shadow-2xl">
                <div className="flex items-center gap-2 border-b border-outline-variant px-3.5 py-2.5">
                    <Icon name="search" size={16} className="shrink-0 text-on-surface-variant" />
                    <input
                        ref={inputRef}
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        role="combobox"
                        aria-expanded={true}
                        aria-controls={listId}
                        aria-autocomplete="list"
                        aria-activedescendant={flatList.length > 0 ? `${listId}-opt-${safeIdx}` : undefined}
                        aria-label={t.shell.ade.palette.placeholder}
                        placeholder={t.shell.ade.palette.placeholder}
                        className="min-w-0 flex-1 bg-transparent text-sm text-on-surface outline-none placeholder:text-on-surface-variant/70"
                    />
                    <kbd className="rounded border border-outline-variant bg-surface-container px-1.5 py-0.5 font-mono text-ui-10 text-on-surface-variant">
                        ESC
                    </kbd>
                </div>

                <div ref={listRef} id={listId} role="listbox" aria-label={t.shell.ade.searchTrigger} className="max-h-[55vh] overflow-y-auto p-1.5">
                    {grouped.length === 0 ? (
                        <div className="px-3 py-8 text-center text-xs text-on-surface-variant">
                            {t.shell.ade.palette.empty}
                        </div>
                    ) : (
                        grouped.map((section) => (
                            <div key={section.group} role="group" aria-label={section.label} className="mb-1.5 last:mb-0">
                                <div aria-hidden className="px-2.5 py-1 text-ui-10 font-semibold uppercase tracking-wider text-on-surface-variant">
                                    {section.label}
                                </div>
                                {section.items.map((item) => {
                                    runningIndex += 1
                                    const isSelected = runningIndex === safeIdx
                                    const currentIdx = runningIndex
                                    return (
                                        <button
                                            key={item.id}
                                            id={`${listId}-opt-${currentIdx}`}
                                            data-idx={currentIdx}
                                            role="option"
                                            aria-selected={isSelected}
                                            tabIndex={-1}
                                            type="button"
                                            onMouseEnter={() => setSelectedIdx(currentIdx)}
                                            onMouseDown={(e) => {
                                                // Evita que el blur del input o un re-render se coman el clic en WebKit/Wails.
                                                e.preventDefault()
                                            }}
                                            onClick={() => runItem(item)}
                                            className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                                                isSelected
                                                    ? 'bg-primary-container text-on-primary-container'
                                                    : 'text-on-surface hover:bg-surface-variant/70'
                                            }`}
                                        >
                                            <Icon
                                                name={item.icon}
                                                size={16}
                                                className={isSelected ? 'shrink-0 text-on-primary-container' : 'shrink-0 text-on-surface-variant'}
                                            />
                                            <div className="min-w-0 flex-1">
                                                <div className="truncate text-xs font-medium">{item.label}</div>
                                                {item.subtitle && (
                                                    <div
                                                        className={`truncate text-ui-10 ${
                                                            isSelected ? 'text-on-primary-container/80' : 'text-on-surface-variant'
                                                        }`}
                                                    >
                                                        {item.subtitle}
                                                    </div>
                                                )}
                                            </div>
                                            {item.active && (
                                                <span
                                                    aria-hidden
                                                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                                        isSelected ? 'bg-on-primary-container' : 'bg-secondary'
                                                    }`}
                                                />
                                            )}
                                            {item.shortcut && (
                                                <kbd
                                                    className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-ui-10 ${
                                                        isSelected
                                                            ? 'border-on-primary-container/30 bg-on-primary-container/10 text-on-primary-container'
                                                            : 'border-outline-variant bg-surface-container text-on-surface-variant'
                                                    }`}
                                                >
                                                    {item.shortcut}
                                                </kbd>
                                            )}
                                        </button>
                                    )
                                })}
                            </div>
                        ))
                    )}
                </div>

                <div className="flex items-center justify-between border-t border-outline-variant bg-surface-container px-3.5 py-1.5 text-ui-10 text-on-surface-variant">
                    <div className="flex items-center gap-3">
                        <span>↑↓ {t.shell.ade.palette.hintNavigate}</span>
                        <span>↵ {t.shell.ade.palette.hintSelect}</span>
                        <span>ESC {t.shell.ade.palette.hintClose}</span>
                    </div>
                </div>
            </div>
        </div>,
        document.body,
    )
}
