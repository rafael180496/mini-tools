import {useEffect, useState} from 'react'
import Icon from '../Icon'
import {formatNumber, useT} from '../../i18n'

const PAGE_SIZES = [20, 50, 100, 200]

interface MongoPagerProps {
    page: number
    pageSize: number
    total: number
    loading: boolean
    onPage: (page: number) => void
    onPageSize: (size: number) => void
}

// Pager for the document browser.
//
// Prev/next alone stops being navigation the moment a collection has 56.876
// pages: there is no way to reach page 900 except by clicking 899 times. So
// this adds first/last jumps, a page number you can type into, and a page
// size selector — plus the range actually on screen ("1–20 de 1.137.520"),
// which is the number people look for and the old pager never showed.
export default function MongoPager({page, pageSize, total, loading, onPage, onPageSize}: MongoPagerProps) {
    const t = useT()
    const pg = t.mongo.pager
    const pages = Math.max(1, Math.ceil(total / pageSize))
    const first = total === 0 ? 0 : page * pageSize + 1
    const last = Math.min(total, (page + 1) * pageSize)

    // The input is free text while being typed — clamping on every keystroke
    // would make "12" impossible to reach on a 9-page collection (typing "1"
    // then "2" would snap to 9 in between). It commits on Enter or blur.
    const [draft, setDraft] = useState(String(page + 1))
    useEffect(() => {
        setDraft(String(page + 1))
    }, [page])

    function commit() {
        const n = parseInt(draft, 10)
        if (isNaN(n)) {
            setDraft(String(page + 1))
            return
        }
        const target = Math.min(pages, Math.max(1, n)) - 1
        setDraft(String(target + 1))
        if (target !== page) onPage(target)
    }

    const atStart = page === 0 || loading
    const atEnd = page + 1 >= pages || loading

    return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-outline-variant bg-surface-container-low px-2 py-1.5 text-xs">
            <span className="shrink-0 text-on-surface-variant" title={pg.rangeHint}>
                {total === 0 ? (
                    pg.noDocuments
                ) : (
                    <span className="font-mono text-on-surface">
                        {pg.range({first: formatNumber(first), last: formatNumber(last), total: formatNumber(total)})}
                    </span>
                )}
            </span>

            <div className="mx-auto flex items-center gap-0.5">
                <PagerButton icon="first_page" label={pg.first} disabled={atStart} onClick={() => onPage(0)} />
                <PagerButton icon="chevron_left" label={pg.prev} disabled={atStart} onClick={() => onPage(page - 1)} />

                <div className="flex items-center gap-1 px-1.5">
                    <input
                        value={draft}
                        onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
                        onBlur={commit}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') commit()
                            if (e.key === 'Escape') setDraft(String(page + 1))
                        }}
                        disabled={loading}
                        title={pg.pageInputHint}
                        className="w-14 rounded border border-outline-variant bg-surface-container-low px-1 py-0.5 text-center font-mono text-on-surface disabled:opacity-50"
                    />
                    <span className="whitespace-nowrap text-on-surface-variant">
                        {pg.ofPages({pages: formatNumber(pages)})}
                    </span>
                </div>

                <PagerButton icon="chevron_right" label={pg.next} disabled={atEnd} onClick={() => onPage(page + 1)} />
                <PagerButton
                    icon="last_page"
                    label={pg.last}
                    disabled={atEnd}
                    onClick={() => onPage(pages - 1)}
                />
            </div>

            <label className="flex shrink-0 items-center gap-1 text-on-surface-variant">
                {pg.perPage}
                <select
                    value={pageSize}
                    onChange={(e) => onPageSize(Number(e.target.value))}
                    disabled={loading}
                    title={pg.perPageHint}
                    className="rounded border border-outline-variant bg-surface-container-low px-1 py-0.5 font-mono text-on-surface disabled:opacity-50"
                >
                    {PAGE_SIZES.map((n) => (
                        <option key={n} value={n}>
                            {n}
                        </option>
                    ))}
                </select>
            </label>
        </div>
    )
}

function PagerButton({icon, label, disabled, onClick}: {icon: string; label: string; disabled: boolean; onClick: () => void}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            title={label}
            aria-label={label}
            className="rounded p-1 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-30 disabled:hover:bg-transparent"
        >
            <Icon name={icon} size={16} />
        </button>
    )
}
