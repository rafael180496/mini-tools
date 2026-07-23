import {useEffect} from 'react'
import {createPortal} from 'react-dom'
import Icon from '../Icon'
import type {DropdownItem} from './DropdownMenu'

interface ContextMenuProps {
    x: number
    y: number
    items: (DropdownItem | 'separator')[]
    onClose: () => void
    width?: number
}

// Right-click menu anchored at the cursor.
//
// Shares DropdownItem with DropdownMenu because the two are the same menu with
// different anchoring — a "Fetch from origin" entry should look and behave
// identically whether it was reached from a toolbar dropdown or a right-click.
//
// Position is clamped to the viewport: right-clicking near the bottom or right
// edge of the window otherwise opens a menu partly off-screen, which in a
// desktop webview cannot be scrolled into view.
export default function ContextMenu({x, y, items, onClose, width = 220}: ContextMenuProps) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onClose])

    const rowCount = items.filter((i) => i !== 'separator').length
    const estimatedHeight = rowCount * 28 + 8
    const left = Math.max(8, Math.min(x, window.innerWidth - width - 8))
    const top = Math.max(8, Math.min(y, window.innerHeight - estimatedHeight - 8))

    return createPortal(
        <>
            <div
                className="fixed inset-0 z-40"
                onClick={onClose}
                onContextMenu={(e) => {
                    // Without this, a second right-click would open the browser
                    // menu on top of ours instead of dismissing it.
                    e.preventDefault()
                    onClose()
                }}
            />
            <div
                style={{position: 'fixed', top, left, width}}
                className="z-50 rounded-lg border border-outline-variant bg-surface-container-high p-1 text-xs text-on-surface shadow-lg"
            >
                {items.map((item, i) =>
                    item === 'separator' ? (
                        <div key={`sep-${i}`} className="my-1 border-t border-outline-variant" />
                    ) : (
                        <button
                            key={item.label}
                            disabled={item.disabled}
                            title={item.hint ?? item.label}
                            onClick={() => {
                                onClose()
                                item.onSelect()
                            }}
                            className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left disabled:opacity-40 ${
                                item.danger ? 'text-error hover:bg-error-container/40' : 'hover:bg-surface-variant'
                            }`}
                        >
                            {item.icon && <Icon name={item.icon} size={15} className="shrink-0 opacity-70" />}
                            <span className="truncate">{item.label}</span>
                        </button>
                    ),
                )}
            </div>
        </>,
        document.body,
    )
}
