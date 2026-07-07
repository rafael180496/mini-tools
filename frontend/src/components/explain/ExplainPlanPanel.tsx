import {explain} from '../../../wailsjs/go/models'
import Icon from '../Icon'

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
                className={`flex flex-wrap items-center gap-2 rounded px-2 py-1 font-mono text-xs ${
                    node.isFullScan ? 'bg-error-container text-on-error-container' : 'text-on-surface'
                }`}
                style={{paddingLeft: `${depth * 16 + 8}px`}}
            >
                <span className="font-medium">{node.operation}</span>
                {node.objectName && <span className="text-on-surface-variant">{node.objectName}</span>}
                {!!node.rows && <span className="text-on-surface-variant/70">~{node.rows} filas</span>}
                {!!node.cost && <span className="text-on-surface-variant/70">cost {node.cost.toFixed(2)}</span>}
                {!!node.actualTimeMs && <span className="text-on-surface-variant/70">{node.actualTimeMs.toFixed(3)}ms</span>}
                {node.isFullScan && (
                    <span className="flex items-center gap-1 font-sans font-medium">
                        <Icon name="warning" size={13} filled />
                        full scan
                    </span>
                )}
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
        <div className="flex h-64 flex-col border-t border-outline-variant bg-surface-container-low">
            <div className="flex items-center justify-between border-b border-outline-variant px-3 py-1">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-on-surface-variant">
                    <Icon name="query_stats" size={15} />
                    EXPLAIN PLAN{plan?.durationMs ? ` · ${plan.durationMs.toFixed(3)}ms` : ''}
                </span>
                <button
                    onClick={onClose}
                    title="Cierra este panel del plan de ejecución"
                    className="rounded p-0.5 text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
                >
                    <Icon name="close" size={16} />
                </button>
            </div>
            <div className="flex-1 overflow-auto p-2">
                {loading && <p className="text-xs text-on-surface-variant">Generando plan…</p>}
                {error && <p className="text-xs text-error">{error}</p>}
                {!loading && !error && plan?.root && <PlanNodeView node={plan.root} depth={0} />}
                {!loading && !error && !plan?.root && <p className="text-xs text-on-surface-variant">Sin plan.</p>}
            </div>
        </div>
    )
}
