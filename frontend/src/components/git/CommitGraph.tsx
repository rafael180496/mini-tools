import {useMemo} from 'react'
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
    loading: boolean
}

const ROW_HEIGHT = 44
const LANE_WIDTH = 14
const GRAPH_PAD = 10

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

export default function CommitGraph({commits, selectedHash, onSelect, onContextMenu, loading}: CommitGraphProps) {
    const placed = useMemo(() => assignLanes(commits), [commits])
    const laneCount = useMemo(() => placed.reduce((max, p) => Math.max(max, p.lane + 1, ...p.edges.map((e) => e.to + 1)), 1), [placed])
    const graphWidth = GRAPH_PAD * 2 + laneCount * LANE_WIDTH

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

    return (
        <div className="relative h-full overflow-y-auto">
            {/* The lane graph is one absolutely-positioned SVG behind the rows
                rather than a per-row SVG, so an edge can span the boundary
                between two rows without being clipped by either. */}
            <svg
                width={graphWidth}
                height={placed.length * ROW_HEIGHT}
                className="pointer-events-none absolute left-0 top-0"
                aria-hidden="true"
            >
                {placed.map((p, rowIndex) =>
                    p.edges.map((edge, i) => {
                        const x1 = GRAPH_PAD + edge.from * LANE_WIDTH
                        const x2 = GRAPH_PAD + edge.to * LANE_WIDTH
                        const y1 = rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2
                        const y2 = y1 + ROW_HEIGHT
                        const color = LANE_COLORS[edge.lane % LANE_COLORS.length]
                        return (
                            <path
                                key={`${p.commit.hash}-${i}`}
                                d={`M ${x1} ${y1} C ${x1} ${y1 + ROW_HEIGHT * 0.4}, ${x2} ${y2 - ROW_HEIGHT * 0.4}, ${x2} ${y2}`}
                                stroke={color}
                                strokeWidth={1.5}
                                fill="none"
                                opacity={0.8}
                            />
                        )
                    }),
                )}
                {placed.map((p, rowIndex) => (
                    <circle
                        key={p.commit.hash}
                        cx={GRAPH_PAD + p.lane * LANE_WIDTH}
                        cy={rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2}
                        r={p.commit.isHead ? 5 : 3.5}
                        fill={LANE_COLORS[p.lane % LANE_COLORS.length]}
                        stroke="var(--color-surface)"
                        strokeWidth={p.commit.isHead ? 2 : 0}
                    />
                ))}
            </svg>

            <div style={{paddingLeft: graphWidth}}>
                {placed.map((p) => (
                    <CommitRow
                        key={p.commit.hash}
                        commit={p.commit}
                        selected={selectedHash === p.commit.hash}
                        onSelect={() => onSelect(p.commit)}
                        onContextMenu={(e) => onContextMenu(p.commit, e)}
                    />
                ))}
            </div>
        </div>
    )
}

function CommitRow({commit, selected, onSelect, onContextMenu}: {commit: git.CommitInfo; selected: boolean; onSelect: () => void; onContextMenu: (e: React.MouseEvent) => void}) {
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
            className={`flex w-full items-center gap-2 border-b border-outline-variant/40 px-3 text-left ${
                selected ? 'bg-primary-container/50' : 'hover:bg-surface-variant/50'
            }`}
        >
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                    {(commit.branches ?? []).map((b) => <RefBadge key={b} label={b} kind={b.includes('/') ? 'remote' : 'local'} />)}
                    {(commit.tags ?? []).map((t) => <RefBadge key={t} label={t} kind="tag" />)}
                    <span className="truncate text-xs text-on-surface">{commit.subject}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[10px] text-on-surface-variant/70">
                    <span className="truncate">{commit.author}</span>
                    <span className="shrink-0">{formatDate(commit.date)}</span>
                </div>
            </div>
            <span className="shrink-0 font-mono text-[10px] text-on-surface-variant/60">{commit.shortHash}</span>
        </button>
    )
}

function RefBadge({label, kind}: {label: string; kind: 'local' | 'remote' | 'tag'}) {
    const styles = {
        // Active local branch reads as "where you are" — the primary role.
        local: 'bg-primary-container text-on-primary-container',
        // Remote-tracking refs are context, not position — deliberately
        // quieter so a row with several of them stays readable.
        remote: 'bg-surface-variant text-on-surface-variant',
        tag: 'bg-tertiary-container text-on-tertiary-container',
    }[kind]
    return (
        <span
            title={kind === 'tag' ? `Tag: ${label}` : kind === 'remote' ? `Rama remota: ${label}` : `Rama local: ${label}`}
            className={`flex shrink-0 items-center gap-0.5 rounded px-1 py-px text-[9px] font-medium ${styles}`}
        >
            {kind === 'tag' && <Icon name="sell" size={10} />}
            {label}
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
