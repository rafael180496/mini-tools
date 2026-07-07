package explain

// PlanNode is one node of a unified EXPLAIN PLAN tree, shared across all 3
// engines despite their wildly different native formats (SQLite's flat
// id/parent rows, Postgres's nested JSON, Oracle's PLAN_TABLE rows).
type PlanNode struct {
	Operation    string      `json:"operation"`
	ObjectName   string      `json:"objectName,omitempty"`
	Cost         float64     `json:"cost,omitempty"`
	Rows         int64       `json:"rows,omitempty"`
	ActualTimeMs float64     `json:"actualTimeMs,omitempty"`
	IsFullScan   bool        `json:"isFullScan,omitempty"`
	Detail       string      `json:"detail,omitempty"`
	Children     []*PlanNode `json:"children,omitempty"`
}

// Plan is one EXPLAIN result: the tree for visualization, the engine's own
// raw text for anyone who wants it, and (Postgres ANALYZE only) actual
// execution duration.
type Plan struct {
	Root       *PlanNode `json:"root"`
	RawText    string    `json:"rawText"`
	DurationMs float64   `json:"durationMs,omitempty"`
}
