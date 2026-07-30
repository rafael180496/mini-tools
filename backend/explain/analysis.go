package explain

import (
	"fmt"
	"sort"
	"strings"
)

// Row-count thresholds that turn a full scan from "the right plan" into
// "the reason this is slow". A scan of a few hundred rows is cheaper than
// the index lookup that would replace it — flagging it loudly is noise, and
// noise is what makes real warnings get ignored.
const (
	fullScanNoticeRows   = 1_000
	fullScanCriticalRows = 100_000
	// A node owning this share of the plan's weight is critical — but only
	// once the plan has weight worth owning, see isSignificant. Share alone
	// is meaningless: the single node of a single-node plan is always 100%
	// of it, including when that plan reads ten rows.
	criticalImpactPct = 25.0
	// The floor under which a node's own time is not worth flagging no
	// matter what share of the plan it represents.
	significantSelfTimeMs = 50.0
	// How far the planner's row estimate must be off before it is worth
	// telling the user their statistics are stale. An order of magnitude is
	// where join-strategy choices start going wrong.
	misestimateFactor = 10.0
	// Below this many actual rows a misestimate is arithmetically dramatic
	// but practically irrelevant (expected 1, got 20).
	misestimateMinRows = 100
	// A hit rate under this, on a plan that read a meaningful number of
	// blocks, is worth surfacing.
	lowBufferHitRatePct = 90.0
	minBlocksForBufferInsight = 1_000
)

// Analyze fills in everything the engines cannot know from their own node
// alone: per-node self time, relative impact, graded severity, plan-wide
// totals, and the actionable insights. It mutates plan in place and is the
// last step of every engine's plan builder.
//
// Every engine goes through here so the grading rules live in exactly one
// place — an engine that starts reporting a new metric improves the output
// for free, and a threshold change does not have to be made four times.
func Analyze(plan *Plan, engine string, analyzed bool) {
	if plan == nil || plan.Root == nil {
		return
	}
	plan.Engine = engine
	plan.Analyzed = analyzed

	nodes := flatten(plan.Root)
	plan.NodeCount = len(nodes)
	plan.TotalCost = plan.Root.Cost
	plan.EstimatedRows = plan.Root.Rows
	plan.ActualRows = plan.Root.ActualRows

	computeSelfWeights(plan.Root)

	// Impact is measured against whichever weight the plan actually has:
	// real time when analyzed, estimated cost otherwise. Mixing the two
	// would rank nodes by a number that means different things per node.
	totalWeight := 0.0
	for _, n := range nodes {
		totalWeight += weightOf(n, analyzed)
	}
	var heaviest *PlanNode
	for _, n := range nodes {
		if totalWeight > 0 {
			n.ImpactPct = weightOf(n, analyzed) / totalWeight * 100
		}
		if n.Rows > 0 && n.ActualRows > 0 {
			n.RowsRatio = float64(n.ActualRows) / float64(n.Rows)
		}
		if heaviest == nil || weightOf(n, analyzed) > weightOf(heaviest, analyzed) {
			heaviest = n
		}
	}
	if heaviest != nil && weightOf(heaviest, analyzed) > 0 {
		heaviest.IsBottleneck = true
	}

	for _, n := range nodes {
		n.Severity = gradeNode(n, analyzed)
	}

	plan.Insights = buildInsights(plan, nodes, analyzed)
}

// flatten returns every node, parents before children.
func flatten(root *PlanNode) []*PlanNode {
	var out []*PlanNode
	var walk func(*PlanNode)
	walk = func(n *PlanNode) {
		out = append(out, n)
		for _, c := range n.Children {
			walk(c)
		}
	}
	walk(root)
	return out
}

// computeSelfWeights subtracts each node's children from its reported
// totals, which is what turns an inclusive measurement into an attributable
// one. Without this, the root always looks like the bottleneck because it
// reports the whole query's time.
func computeSelfWeights(n *PlanNode) (totalTimeMs, totalCost float64) {
	// Engines report per-loop timings; a node on the inner side of a nested
	// loop runs once per outer row, so its real contribution is the product.
	own := n.ActualTimeMs
	if n.Loops > 1 {
		own *= float64(n.Loops)
	}

	childTime, childCost := 0.0, 0.0
	for _, c := range n.Children {
		t, cost := computeSelfWeights(c)
		childTime += t
		childCost += cost
	}

	n.SelfTimeMs = own - childTime
	if n.SelfTimeMs < 0 {
		// Rounding, or a node whose children are not strictly nested inside
		// its measurement. Clamping beats reporting a negative share.
		n.SelfTimeMs = 0
	}
	n.SelfCost = n.Cost - childCost
	if n.SelfCost < 0 {
		n.SelfCost = 0
	}
	return own, n.Cost
}

func weightOf(n *PlanNode, analyzed bool) float64 {
	if analyzed {
		return n.SelfTimeMs
	}
	return n.SelfCost
}

// rowsOf is the node's row count, preferring the measured one.
func rowsOf(n *PlanNode) int64 {
	if n.ActualRows > 0 {
		return n.ActualRows
	}
	return n.Rows
}

// gradeNode decides how loudly to flag a node — the core of "less alarm,
// more hierarchy". A full scan is graded by how much it actually reads and
// how much of the query it accounts for, never by the fact that it is a
// full scan.
func gradeNode(n *PlanNode, analyzed bool) Severity {
	heavy := n.ImpactPct >= criticalImpactPct && isSignificant(n, analyzed)

	if !n.IsFullScan {
		// A non-scan node still earns a warning if it is where the time
		// goes: an expensive sort or hash is just as worth seeing.
		if heavy && analyzed {
			return SeverityWarning
		}
		return SeverityNone
	}

	rows := rowsOf(n)
	switch {
	case heavy, rows >= fullScanCriticalRows:
		return SeverityCritical
	case rows >= fullScanNoticeRows:
		return SeverityWarning
	default:
		// Small table, or no row information at all (SQLite reports none).
		// Scanning it is almost certainly the right plan — worth labelling,
		// never worth alarming about.
		return SeverityInfo
	}
}

// isSignificant reports whether a node carries enough absolute weight for
// its SHARE of the plan to mean anything. Without this gate a relative
// measure escalates trivia: every node of a one-node plan owns 100% of it,
// so a ten-row scan of a lookup table came out as critical as a five-
// million-row scan — the exact "everything is red, so nothing is" problem
// this grading exists to avoid.
func isSignificant(n *PlanNode, analyzed bool) bool {
	if analyzed {
		return n.SelfTimeMs >= significantSelfTimeMs
	}
	return rowsOf(n) >= fullScanNoticeRows
}

// buildInsights turns the graded tree into things the user can act on.
// Ordered most severe first, capped so the panel stays readable.
func buildInsights(plan *Plan, nodes []*PlanNode, analyzed bool) []Insight {
	var out []Insight

	for _, n := range nodes {
		if !n.IsFullScan || n.Severity == SeverityInfo || n.Severity == SeverityNone {
			continue
		}
		insight := Insight{
			Kind:     "full-scan",
			Severity: n.Severity,
			Title:    scanTitle(n),
			Node:     n.Operation,
			Detail: fmt.Sprintf("Lee %s sin usar un índice (%.0f%% del peso del plan).",
				formatRows(rowsOf(n)), n.ImpactPct),
		}
		if sql := SuggestIndex(plan.Engine, n); sql != "" {
			insight.SQL = sql
			insight.Detail += " Un índice sobre las columnas del filtro evitaría recorrer la tabla entera."
		} else if n.ObjectName != "" {
			insight.Detail += " No hay un filtro del que deducir el índice: revisá el WHERE o el JOIN que alimenta este nodo."
		}
		out = append(out, insight)
	}

	// Planner miscalibration: only detectable with real numbers to compare
	// the estimate against.
	if analyzed {
		for _, n := range nodes {
			if n.RowsRatio == 0 || n.ActualRows < misestimateMinRows {
				continue
			}
			if n.RowsRatio < misestimateFactor && n.RowsRatio > 1/misestimateFactor {
				continue
			}
			direction := "muchas más"
			if n.RowsRatio < 1 {
				direction = "muchas menos"
			}
			insight := Insight{
				Kind:     "misestimate",
				Severity: SeverityWarning,
				Title:    "El planner está descalibrado",
				Node:     n.Operation,
				Detail: fmt.Sprintf("%s estimó %s filas y devolvió %s (%s de las previstas). Con estadísticas desactualizadas el motor elige mal entre nested loop y hash join.",
					nodeLabel(n), formatRows(n.Rows), formatRows(n.ActualRows), direction),
			}
			if sql := SuggestAnalyze(plan.Engine, n.ObjectName); sql != "" {
				insight.SQL = sql
			}
			out = append(out, insight)
			break // One is enough; the fix is the same for the whole plan.
		}
	}

	// Where the time goes, when it is not a scan (a sort spilling to disk,
	// an expensive hash) — otherwise the user only ever hears about scans.
	for _, n := range nodes {
		if n.IsBottleneck && !n.IsFullScan && n.ImpactPct >= criticalImpactPct && isSignificant(n, analyzed) {
			metric := fmt.Sprintf("%.0f%% del costo estimado", n.ImpactPct)
			if analyzed {
				metric = fmt.Sprintf("%.1f ms propios (%.0f%% del total)", n.SelfTimeMs, n.ImpactPct)
			}
			out = append(out, Insight{
				Kind:     "bottleneck",
				Severity: SeverityWarning,
				Title:    "Nodo más pesado del plan",
				Node:     n.Operation,
				Detail:   fmt.Sprintf("%s concentra %s.", nodeLabel(n), metric),
			})
			break
		}
	}

	if b := plan.Buffers; b != nil && b.Hit+b.Read >= minBlocksForBufferInsight && b.HitRatePct < lowBufferHitRatePct {
		out = append(out, Insight{
			Kind:     "buffer-miss",
			Severity: SeverityInfo,
			Title:    "Buena parte de los datos vino del disco",
			Detail: fmt.Sprintf("%.0f%% de aciertos en caché (%s bloques de memoria, %s leídos de disco). Si la consulta se repite seguido, el conjunto de trabajo no entra en shared_buffers.",
				b.HitRatePct, formatRows(b.Hit), formatRows(b.Read)),
		})
	}

	if !analyzed && plan.Engine == "postgres" {
		out = append(out, Insight{
			Kind:     "not-analyzed",
			Severity: SeverityInfo,
			Title:    "Solo estimaciones",
			Detail:   "Este plan son las previsiones del planner, no mediciones. Usá Explain Analyze para ver filas y tiempos reales — corre la consulta de verdad.",
		})
	}

	sort.SliceStable(out, func(i, j int) bool {
		return severityRank(out[i].Severity) > severityRank(out[j].Severity)
	})
	if len(out) > 8 {
		out = out[:8]
	}
	return out
}

func severityRank(s Severity) int {
	switch s {
	case SeverityCritical:
		return 3
	case SeverityWarning:
		return 2
	case SeverityInfo:
		return 1
	default:
		return 0
	}
}

func scanTitle(n *PlanNode) string {
	if n.ObjectName != "" {
		return "Recorrido completo de " + n.ObjectName
	}
	return "Recorrido completo de tabla"
}

func nodeLabel(n *PlanNode) string {
	if n.ObjectName != "" {
		return n.Operation + " sobre " + n.ObjectName
	}
	return n.Operation
}

// formatRows groups thousands so a seven-digit row count is readable at a
// glance — the whole point of showing it.
func formatRows(n int64) string {
	s := fmt.Sprintf("%d", n)
	if len(s) <= 3 {
		return s
	}
	var b strings.Builder
	lead := len(s) % 3
	if lead > 0 {
		b.WriteString(s[:lead])
	}
	for i := lead; i < len(s); i += 3 {
		if b.Len() > 0 {
			b.WriteByte('.')
		}
		b.WriteString(s[i : i+3])
	}
	return b.String()
}
