import {useEffect, useMemo, useRef, useState} from 'react'
import type {git} from '../../../wailsjs/go/models'
import Icon from '../Icon'

interface CommitGraphProps {
    commits: git.CommitInfo[]
    selectedHash: string | null
    onSelect: (commit: git.CommitInfo) => void
    // Right-click on a commit row. The menu itself is owned by GitRepoTab,
    // which has the repoId and the mutation handlers — this component only
    // reports where and on what.
    onContextMenu: (commit: git.CommitInfo, e: React.MouseEvent) => void
    // Scroll a commit into view and flash it. Carries a token instead of just a
    // hash so clicking the same branch twice scrolls again, and so a reload
    // that rebuilds the rows does not re-scroll on its own.
    reveal: {hash: string; token: number} | null
    loading: boolean
}

const ROW_HEIGHT = 44
const LANE_WIDTH = 14
const GRAPH_PAD = 10
// Most lanes the graph gutter will ever occupy. Beyond this the extra lanes are
// clipped so the commit-message column never gets pushed off-screen — see the
// note in CommitGraph. 12 lanes ≈ a 188px gutter, comfortable in the center
// panel while still showing the mainline and its immediate branches.
const MAX_GUTTER_LANES = 12

// Lane colors, cycled by lane index. Kept as explicit CSS variables rather than
// Tailwind classes because they are consumed by SVG stroke/fill attributes,
// which Tailwind utilities cannot reach.
const LANE_COLORS = [
    'var(--color-primary)',
    'var(--color-tertiary)',
    'var(--color-secondary)',
    'var(--color-error)',
    'var(--color-inverse-primary)',
]

interface PlacedCommit {
    commit: git.CommitInfo
    lane: number
    // edges are the lines drawn from this row down to the next, one per lane
    // that is alive across the boundary. `from`/`to` are lane indices, so a
    // merge or a branch point renders as a diagonal.
    edges: {from: number; to: number; lane: number}[]
}

// assignLanes lays commits (already newest-first) onto vertical lanes.
//
// The algorithm is the standard one: keep an array of "lanes", each holding the
// hash the lane is currently waiting to draw. For each commit, take the lane
// reserved for it (or the first free lane if nothing reserved it — that is a
// branch tip), then hand the lane to its first parent and give any additional
// parents their own lanes, which is what makes a merge fan out.
//
// It is deliberately local: it only sees the commits that were loaded, so a
// parent outside the window simply ends its lane. That keeps paging cheap; a
// globally-correct layout would need the whole history.
function assignLanes(commits: git.CommitInfo[]): PlacedCommit[] {
    const lanes: (string | null)[] = []
    const placed: PlacedCommit[] = []

    const claimLane = (hash: string): number => {
        const existing = lanes.indexOf(hash)
        if (existing !== -1) return existing
        const free = lanes.indexOf(null)
        if (free !== -1) {
            lanes[free] = hash
            return free
        }
        lanes.push(hash)
        return lanes.length - 1
    }

    for (const commit of commits) {
        const lane = claimLane(commit.hash)

        // Snapshot which lanes were occupied before this commit rewires them,
        // so every lane that survives the row keeps a continuous line.
        const before = [...lanes]

        const parents = commit.parents ?? []
        lanes[lane] = parents.length > 0 ? parents[0] : null
        for (let i = 1; i < parents.length; i++) {
            // A second parent may already have a lane (a merge of a branch
            // still visible in the window) — reuse it instead of duplicating.
            claimLane(parents[i])
        }

        const edges: {from: number; to: number; lane: number}[] = []
        for (let i = 0; i < before.length; i++) {
            const hash = before[i]
            if (hash === null) continue
            if (i === lane) {
                // This row's own lane continues into its first parent.
                if (parents.length > 0) {
                    const target = lanes.indexOf(parents[0])
                    if (target !== -1) edges.push({from: i, to: target, lane: i})
                }
            } else {
                // An unrelated lane passes straight through this row.
                const target = lanes.indexOf(hash)
                if (target !== -1) edges.push({from: i, to: target, lane: i})
            }
        }
        // Extra parents of a merge branch off diagonally from this commit.
        for (let i = 1; i < parents.length; i++) {
            const target = lanes.indexOf(parents[i])
            if (target !== -1) edges.push({from: lane, to: target, lane: target})
        }

        placed.push({commit, lane, edges})

        // Trim trailing dead lanes so the graph does not keep widening after
        // branches end.
        while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()
    }

    return placed
}

export default function CommitGraph({commits, selectedHash, onSelect, onContextMenu, reveal, loading}: CommitGraphProps) {
    const placed = useMemo(() => assignLanes(commits), [commits])
    const laneCount = useMemo(() => placed.reduce((max, p) => Math.max(max, p.lane + 1, ...p.edges.map((e) => e.to + 1)), 1), [placed])

    const scrollRef = useRef<HTMLDivElement>(null)
    // Hash briefly ringed after a reveal. Landing on a row 400px down without
    // any motion cue reads as "nothing happened"; the ring says where we went.
    const [flashHash, setFlashHash] = useState<string | null>(null)
    // Tokens already scrolled to, so a status poll or a reload re-running this
    // effect does not yank the user back to an old target.
    const doneToken = useRef(0)

    useEffect(() => {
        if (!reveal || reveal.token === doneToken.current) return
        const index = placed.findIndex((p) => p.commit.hash === reveal.hash)
        const box = scrollRef.current
        // Not found yet: the log may still be loading. Leave the token
        // unconsumed so this runs again once the rows arrive.
        if (index === -1 || !box) return
        doneToken.current = reveal.token
        // Centered rather than scrolled-to-top: the commits around the tip are
        // the context that makes it readable.
        const top = index * ROW_HEIGHT - box.clientHeight / 2 + ROW_HEIGHT / 2
        box.scrollTo({top: Math.max(0, top), behavior: 'smooth'})
        setFlashHash(reveal.hash)
    }, [reveal, placed])

    // The fade-out lives in its own effect keyed on the flash itself. Folded
    // into the one above, a reload landing mid-flash would run that effect's
    // cleanup, cancel the timer, and then bail on the consumed token — leaving
    // the ring stuck on the row permanently.
    useEffect(() => {
        if (!flashHash) return
        const timer = setTimeout(() => setFlashHash(null), 1400)
        return () => clearTimeout(timer)
    }, [flashHash])

    // The SVG is drawn at its true width (every lane), but the gutter it lives
    // in is capped: a busy repository can reach 30+ concurrent lanes (a real
    // case — a chatwoot-style repo hit exactly that), and an ungated gutter
    // then grows to ~440px and pushes the commit messages/author/hash entirely
    // off the panel. Capping the gutter and clipping the extra lanes keeps the
    // commit text always visible — which is what the panel is for. The far
    // lanes (usually old side branches) are hidden past the cap; a commit whose
    // dot sits beyond it still shows its row, just not its dot.
    const fullGraphWidth = GRAPH_PAD * 2 + laneCount * LANE_WIDTH
    const gutterWidth = GRAPH_PAD * 2 + Math.min(laneCount, MAX_GUTTER_LANES) * LANE_WIDTH
    const clipped = laneCount > MAX_GUTTER_LANES

    if (loading) {
        return (
            <div className="flex items-center gap-2 p-4 text-xs text-primary">
                <span aria-hidden className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-t-transparent border-primary" />
                Cargando historial…
            </div>
        )
    }
    if (commits.length === 0) {
        return <p className="p-4 text-xs text-on-surface-variant/70">Este repositorio todavía no tiene commits.</p>
    }

    const contentHeight = placed.length * ROW_HEIGHT

    return (
        <div ref={scrollRef} className="relative h-full overflow-y-auto">
            {/* The lane graph is one absolutely-positioned SVG behind the rows
                rather than a per-row SVG, so an edge can span the boundary
                between two rows without being clipped by either. It lives in a
                gutter of capped width with overflow-hidden, so lanes past the
                cap are clipped instead of overlapping the commit text.

                The height is the FULL content height, not h-full: `h-full` here
                resolves against the scroll container's padding box — i.e. one
                viewport — and combined with overflow-hidden it cropped the
                graph at the first screenful, so scrolling down showed rows with
                no lanes behind them. Being positioned itself, this div is also
                what the clipped-edge fade below anchors to. */}
            <div
                style={{width: gutterWidth, height: contentHeight}}
                className="pointer-events-none absolute left-0 top-0 overflow-hidden"
                aria-hidden="true"
            >
                <svg width={fullGraphWidth} height={contentHeight}>
                    {placed.map((p, rowIndex) =>
                        p.edges.map((edge, i) => {
                            const x1 = GRAPH_PAD + edge.from * LANE_WIDTH
                            const x2 = GRAPH_PAD + edge.to * LANE_WIDTH
                            const y1 = rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2
                            const y2 = y1 + ROW_HEIGHT
                            const color = LANE_COLORS[edge.lane % LANE_COLORS.length]
                            // The first lane is the mainline in practice — drawn
                            // a touch heavier so it stays readable once a dozen
                            // side branches cross it.
                            const main = edge.lane === 0
                            return (
                                <path
                                    key={`${p.commit.hash}-${i}`}
                                    d={`M ${x1} ${y1} C ${x1} ${y1 + ROW_HEIGHT * 0.4}, ${x2} ${y2 - ROW_HEIGHT * 0.4}, ${x2} ${y2}`}
                                    stroke={color}
                                    strokeWidth={main ? 2.25 : 1.75}
                                    strokeLinecap="round"
                                    fill="none"
                                    opacity={main ? 0.95 : 0.75}
                                />
                            )
                        }),
                    )}
                    {placed.map((p, rowIndex) => {
                        const cx = GRAPH_PAD + p.lane * LANE_WIDTH
                        const cy = rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2
                        const color = LANE_COLORS[p.lane % LANE_COLORS.length]
                        const selected = selectedHash === p.commit.hash
                        return (
                            <g key={p.commit.hash}>
                                {/* A halo in the surface color punches the dot
                                    out of the lines running past it, so a dot on
                                    a busy row still reads as a node. */}
                                <circle cx={cx} cy={cy} r={p.commit.isHead ? 6.5 : 5} fill="var(--color-surface)" />
                                {p.commit.isHead && <circle cx={cx} cy={cy} r={6.5} fill="none" stroke={color} strokeWidth={1.5} opacity={0.5} />}
                                <circle
                                    cx={cx}
                                    cy={cy}
                                    r={p.commit.isHead ? 4.5 : selected ? 4 : 3.25}
                                    fill={color}
                                    stroke={selected ? 'var(--color-on-surface)' : 'none'}
                                    strokeWidth={selected ? 1.5 : 0}
                                />
                            </g>
                        )
                    })}
                </svg>
                {/* A subtle fade at the gutter's right edge hints that lanes were
                    clipped, so a hidden dot does not read as a rendering glitch. */}
                {clipped && <div className="absolute right-0 top-0 h-full w-4 bg-linear-to-l from-surface to-transparent" />}
            </div>

            <div style={{paddingLeft: gutterWidth}}>
                {placed.map((p) => (
                    <CommitRow
                        key={p.commit.hash}
                        commit={p.commit}
                        selected={selectedHash === p.commit.hash}
                        flash={flashHash === p.commit.hash}
                        onSelect={() => onSelect(p.commit)}
                        onContextMenu={(e) => onContextMenu(p.commit, e)}
                    />
                ))}
            </div>
        </div>
    )
}

function CommitRow({
    commit,
    selected,
    flash,
    onSelect,
    onContextMenu,
}: {
    commit: git.CommitInfo
    selected: boolean
    flash: boolean
    onSelect: () => void
    onContextMenu: (e: React.MouseEvent) => void
}) {
    return (
        <button
            onClick={onSelect}
            onContextMenu={(e) => {
                // Select as well as open the menu: acting on a commit the user
                // cannot see highlighted is disorienting, and every entry in
                // the menu operates on this commit.
                onSelect()
                onContextMenu(e)
            }}
            title={`Ver los archivos y el diff de este commit — ${commit.shortHash} por ${commit.author}. Click derecho para revert, cherry-pick, crear rama/tag o reset`}
            style={{height: ROW_HEIGHT}}
            className={`group relative flex w-full items-center gap-3 border-b border-outline-variant/30 pl-3 pr-2 text-left transition-colors ${
                selected ? 'bg-primary-container/45' : 'hover:bg-surface-variant/40'
            } ${flash ? 'ring-1 ring-inset ring-primary' : ''}`}
        >
            {/* Accent bar instead of a heavier fill: the selected row has to
                stand out against a background already carrying the lane colors,
                without drowning the ref badges sitting on it. */}
            <span className={`absolute inset-y-0 left-0 w-0.5 ${selected ? 'bg-primary' : 'bg-transparent'}`} />

            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                    {(commit.branches ?? []).map((b) => <RefBadge key={b} label={b} kind={b.includes('/') ? 'remote' : 'local'} />)}
                    {(commit.tags ?? []).map((t) => <RefBadge key={t} label={t} kind="tag" />)}
                    <span className="truncate text-xs text-on-surface">{commit.subject}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-ui-10 text-on-surface-variant/70">
                    <span className="truncate">{commit.author}</span>
                    <span aria-hidden className="shrink-0 opacity-40">
                        ·
                    </span>
                    <span className="shrink-0 tabular-nums">{formatDate(commit.date)}</span>
                </div>
            </div>
            {/* Fixed-width so the hashes form a straight column down the panel
                instead of jittering with each subject's length. */}
            <span className="w-16 shrink-0 text-right font-mono text-ui-10 tabular-nums text-on-surface-variant/60">{commit.shortHash}</span>
        </button>
    )
}

function RefBadge({label, kind}: {label: string; kind: 'local' | 'remote' | 'tag'}) {
    const styles = {
        // Active local branch reads as "where you are" — the primary role.
        local: 'bg-primary-container text-on-primary-container',
        // Remote-tracking refs are context, not position — deliberately
        // quieter so a row with several of them stays readable.
        remote: 'bg-surface-variant/80 text-on-surface-variant',
        tag: 'bg-tertiary-container text-on-tertiary-container',
    }[kind]
    return (
        <span
            title={kind === 'tag' ? `Tag: ${label}` : kind === 'remote' ? `Rama remota: ${label}` : `Rama local: ${label}`}
            // Capped width: names like "origin/feature/TIGOCHAT-9595" are long
            // enough that two of them would push the subject out of the row.
            className={`flex max-w-52 shrink-0 items-center gap-0.5 rounded-full py-px pl-1 pr-1.5 text-ui-9 font-medium ${styles}`}
        >
            <Icon name={kind === 'tag' ? 'sell' : kind === 'remote' ? 'cloud' : 'account_tree'} size={10} className="shrink-0 opacity-80" />
            <span className="truncate">{label}</span>
        </span>
    )
}

// formatDate renders the RFC 3339 author date compactly. Invalid input falls
// back to the raw string instead of "Invalid Date" — a malformed date should
// not look like a bug in the commit.
function formatDate(iso: string): string {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString(undefined, {year: '2-digit', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'})
}
