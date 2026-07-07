import {explain} from '../../../wailsjs/go/models'

interface PlanNodeViewProps {
    node: explain.PlanNode
    depth: number
}

// Recursive tree renderer, self-contained here rather than factored into a
// shared common/Tree.tsx (the plan envisioned reusing one between this and
// the sidebar — ConnectionTree.tsx ended up with its own inline tree
// instead; extracting a shared component wasn't necessary for either to
// work correctly, just architectural tidiness, so it was skipped given the
// time budget).
function PlanNodeView({node, depth}: PlanNodeViewProps) {
    return (
        <div>
            <div
                className={`flex flex-wrap items-center gap-2 rounded px-2 py-1 text-xs ${
                    node.isFullScan ? 'bg-red-950/40 text-red-300' : 'text-neutral-300'
                }`}
                style={{paddingLeft: `${depth * 16 + 8}px`}}
            >
                <span className="font-medium">{node.operation}</span>
                {node.objectName && <span className="text-neutral-500">{node.objectName}</span>}
                {!!node.rows && <span className="text-neutral-600">~{node.rows} filas</span>}
                {!!node.cost && <span className="text-neutral-600">cost {node.cost.toFixed(2)}</span>}
                {!!node.actualTimeMs && <span className="text-neutral-600">{node.actualTimeMs.toFixed(3)}ms</span>}
                {node.isFullScan && <span className="text-red-400">⚠ full scan</span>}
            </div>
            {node.children?.map((child, i) => (
                <PlanNodeView key={i} node={child} depth={depth + 1} />
            ))}
        </div>
    )
}

interface ExplainPlanPanelProps {
    plan: explain.Plan | null
    loading: boolean
    error: string
    onClose: () => void
}

// Spec: "mostrar el plan como árbol visual, no solo texto crudo" +
// "detectar full table scan, warning visual" + "estadísticas post-ejecución
// (filas, tiempo)".
export default function ExplainPlanPanel({plan, loading, error, onClose}: ExplainPlanPanelProps) {
    return (
        <div className="flex h-64 flex-col border-t border-neutral-800 bg-neutral-950">
            <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-1">
                <span className="text-xs font-semibold text-neutral-400">
                    EXPLAIN PLAN{plan?.durationMs ? ` · ${plan.durationMs.toFixed(3)}ms` : ''}
                </span>
                <button onClick={onClose} className="text-xs text-neutral-500 hover:text-neutral-300">
                    Cerrar
                </button>
            </div>
            <div className="flex-1 overflow-auto p-2">
                {loading && <p className="text-xs text-neutral-600">Generando plan…</p>}
                {error && <p className="text-xs text-red-400">{error}</p>}
                {!loading && !error && plan?.root && <PlanNodeView node={plan.root} depth={0} />}
                {!loading && !error && !plan?.root && <p className="text-xs text-neutral-600">Sin plan.</p>}
            </div>
        </div>
    )
}
