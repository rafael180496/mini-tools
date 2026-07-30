package explain

// Severity grades how much attention a plan node deserves. It exists
// because "full scan" alone is not a problem: a sequential scan over ten
// rows is the correct plan, and painting it the same alarming colour as one
// over five million rows trains the user to ignore the colour entirely.
// Engines set IsFullScan; analysis.go decides how loud to be about it.
type Severity string

const (
	// SeverityNone is a node with nothing worth flagging.
	SeverityNone Severity = ""
	// SeverityInfo is worth labelling but not worth worrying about — a full
	// scan over a small table, which is usually the optimal plan.
	SeverityInfo Severity = "info"
	// SeverityWarning is worth looking at.
	SeverityWarning Severity = "warning"
	// SeverityCritical is the node most likely responsible for the query
	// being slow.
	SeverityCritical Severity = "critical"
)

// PlanNode is one node of a unified EXPLAIN PLAN tree, shared across all 4
// engines despite their wildly different native formats (SQLite's flat
// id/parent rows, Postgres's nested JSON, Oracle's PLAN_TABLE rows, SQL
// Server's SHOWPLAN_ALL columns).
//
// Fields split into three groups: what the engine reported (Operation …
// Filter), what analysis.go computed from the whole tree (SelfTimeMs …
// IsBottleneck), and the children. Engines fill the first group and leave
// the rest zeroed; nothing else may write to the computed group.
type PlanNode struct {
	Operation  string `json:"operation"`
	ObjectName string `json:"objectName,omitempty"`
	// Cost is the engine's estimated total cost for this node and its
	// subtree, in whatever unit the engine uses (they are not comparable
	// across engines, only within one plan).
	Cost float64 `json:"cost,omitempty"`
	// Rows is the planner's ESTIMATE. ActualRows is what execution really
	// produced, and is only populated by an analyzed run.
	Rows       int64 `json:"rows,omitempty"`
	ActualRows int64 `json:"actualRows,omitempty"`
	// Loops is how many times the node ran (Postgres: nested loop inner
	// sides run once per outer row). Actual timings are PER LOOP, so any
	// total has to multiply by this — see analysis.go's totalTime.
	Loops int64 `json:"loops,omitempty"`
	// ActualTimeMs is the engine-reported time for one loop of this node,
	// inclusive of its children.
	ActualTimeMs float64 `json:"actualTimeMs,omitempty"`
	// IsFullScan marks a scan that reads the whole relation rather than
	// using an index. Not a verdict on its own — see Severity.
	IsFullScan bool `json:"isFullScan,omitempty"`
	// IndexName is the index this node used, when it used one.
	IndexName string `json:"indexName,omitempty"`
	// Filter is the predicate applied at this node, which is what an index
	// suggestion is derived from.
	Filter string `json:"filter,omitempty"`
	Detail string `json:"detail,omitempty"`

	// --- computed by analysis.go ---

	// SelfTimeMs is this node's own time with its children's subtracted —
	// the number that actually identifies a bottleneck. A node reporting
	// 900ms of which 890 belong to its child is not the problem.
	SelfTimeMs float64 `json:"selfTimeMs,omitempty"`
	// SelfCost is the estimate-side equivalent of SelfTimeMs, used to rank
	// nodes when the plan was not analyzed.
	SelfCost float64 `json:"selfCost,omitempty"`
	// ImpactPct is this node's share of the plan's total self time (or self
	// cost, when not analyzed), 0-100.
	ImpactPct float64 `json:"impactPct,omitempty"`
	// RowsRatio is ActualRows / Rows — how far off the planner was. 1 is
	// perfect; 100 means it expected a hundred times fewer rows than it got,
	// which is how a plan ends up choosing a nested loop over a hash join.
	RowsRatio float64 `json:"rowsRatio,omitempty"`
	// Severity is how prominently the UI should flag this node.
	Severity Severity `json:"severity,omitempty"`
	// IsBottleneck marks the single heaviest node in the plan. Exactly one
	// node carries it (none, if the plan has no measurable weight).
	IsBottleneck bool `json:"isBottleneck,omitempty"`

	Children []*PlanNode `json:"children,omitempty"`
}

// BufferStats is Postgres's BUFFERS output: how much of the data came from
// the shared buffer cache versus the disk. A low hit rate on a repeated
// query usually means the working set does not fit in memory.
type BufferStats struct {
	Hit     int64 `json:"hit"`
	Read    int64 `json:"read"`
	Dirtied int64 `json:"dirtied,omitempty"`
	Written int64 `json:"written,omitempty"`
	// HitRatePct is hit / (hit + read) * 100.
	HitRatePct float64 `json:"hitRatePct"`
}

// Insight is an actionable observation about the plan — the difference
// between showing a red row and telling the user what to do about it. SQL,
// when set, is a ready-to-run statement the UI offers to copy.
type Insight struct {
	// Kind identifies the rule that produced it, and is the contract the
	// frontend maps to an icon: "full-scan", "misestimate", "bottleneck",
	// "buffer-miss", "not-analyzed".
	Kind     string   `json:"kind"`
	Severity Severity `json:"severity"`
	Title    string   `json:"title"`
	Detail   string   `json:"detail"`
	// Node is the operation this refers to, for locating it in the tree.
	Node string `json:"node,omitempty"`
	// SQL is the suggested remedy (CREATE INDEX …, ANALYZE …), empty when
	// the insight is informational only.
	SQL string `json:"sql,omitempty"`
}

// Plan is one EXPLAIN result: the tree for visualization, the engine's own
// raw text for anyone who wants it, the headline metrics, and the insights
// derived from all of it.
type Plan struct {
	Root    *PlanNode `json:"root"`
	RawText string    `json:"rawText"`
	// DurationMs is the query's real execution time. Kept under its
	// original name for the callers that already read it; it mirrors
	// ExecutionTimeMs.
	DurationMs float64 `json:"durationMs,omitempty"`

	// Engine is the db type this plan came from, so the UI can explain what
	// is and is not available (SQLite reports no cost, Oracle never
	// executes the query).
	Engine string `json:"engine,omitempty"`
	// Analyzed is true when the plan carries real execution measurements
	// rather than planner estimates only.
	Analyzed bool `json:"analyzed,omitempty"`
	// RolledBack is true when the analyzed run was wrapped in a transaction
	// that was rolled back — how a mutating statement is measured without
	// changing any data.
	RolledBack bool `json:"rolledBack,omitempty"`

	PlanningTimeMs  float64 `json:"planningTimeMs,omitempty"`
	ExecutionTimeMs float64 `json:"executionTimeMs,omitempty"`
	TotalCost       float64 `json:"totalCost,omitempty"`
	EstimatedRows   int64   `json:"estimatedRows,omitempty"`
	ActualRows      int64   `json:"actualRows,omitempty"`
	NodeCount       int     `json:"nodeCount,omitempty"`

	Buffers  *BufferStats `json:"buffers,omitempty"`
	Insights []Insight    `json:"insights,omitempty"`
}
