package query

import (
	"context"
	"database/sql"
	"strings"
	"sync"
	"time"

	"mini-tools/backend/db"
)

// Event is what gets emitted (via EmitFunc) as a Wails runtime event under
// the query's ID. Bindings themselves are request/response only, so
// results stream this way instead of as ExecuteQuery's return value — see
// .claude/skills/mini-tools-patterns/SKILL.md.
type Event struct {
	Type         string          `json:"type"` // "columns" | "rows" | "done" | "cancelled" | "error"
	Columns      []string        `json:"columns,omitempty"`
	Rows         [][]interface{} `json:"rows,omitempty"`
	RowsAffected int64           `json:"rowsAffected,omitempty"`
	DurationMs   int64           `json:"durationMs,omitempty"`
	Error        string          `json:"error,omitempty"`
}

const rowsPerChunk = 200

// EmitFunc sends an event to the frontend under the given event name (the
// queryID). In production this wraps runtime.EventsEmit; tests supply a
// stub instead, since EventsEmit itself requires a live Wails-injected
// context and otherwise kills the process.
type EmitFunc func(event string, data interface{})

// Executor runs queries against pooled connections and streams the results
// back as Events. Statement classification here is a minimal heuristic
// (SELECT-shaped vs everything else); PL/SQL block detection and
// multi-statement splitting land in Fase 5 (see backend/query/detect.go,
// splitter.go once they exist).
type Executor struct {
	parentCtx context.Context
	pools     *db.PoolManager
	emit      EmitFunc

	mu      sync.Mutex
	cancels map[string]context.CancelFunc
}

// NewExecutor builds an Executor. parentCtx is only used to derive each
// query's cancellable context (context.Background() is fine in tests);
// emit is how results actually reach the frontend.
func NewExecutor(parentCtx context.Context, pools *db.PoolManager, emit EmitFunc) *Executor {
	return &Executor{parentCtx: parentCtx, pools: pools, emit: emit, cancels: make(map[string]context.CancelFunc)}
}

// Execute runs sqlText against connID and streams Events under queryID. The
// frontend must call EventsOn(queryID, ...) before invoking the ExecuteQuery
// binding that calls this — queryID is client-generated precisely so there
// is no race with the first emitted event.
func (e *Executor) Execute(connID, queryID, sqlText string) {
	go e.run(connID, queryID, sqlText)
}

// Cancel cancels the in-flight query registered under queryID, if any. The
// pool itself is left open and healthy — only the in-flight statement is
// interrupted.
func (e *Executor) Cancel(queryID string) {
	e.mu.Lock()
	cancel, ok := e.cancels[queryID]
	e.mu.Unlock()
	if ok {
		cancel()
	}
}

func (e *Executor) run(connID, queryID, sqlText string) {
	start := time.Now()

	ctx, cancel := context.WithCancel(e.parentCtx)
	e.registerCancel(queryID, cancel)
	defer e.clearCancel(queryID)
	defer cancel()

	pool, err := e.pools.Get(connID)
	if err != nil {
		e.emitError(queryID, err)
		return
	}

	if isSelectLike(sqlText) {
		e.runQuery(ctx, pool, queryID, sqlText, start)
		return
	}
	e.runExec(ctx, pool, queryID, sqlText, start)
}

func isSelectLike(sqlText string) bool {
	upper := strings.ToUpper(strings.TrimSpace(sqlText))
	for _, prefix := range []string{"SELECT", "WITH", "PRAGMA", "EXPLAIN"} {
		if strings.HasPrefix(upper, prefix) {
			return true
		}
	}
	return false
}

func (e *Executor) runQuery(ctx context.Context, pool *sql.DB, queryID, sqlText string, start time.Time) {
	rows, err := pool.QueryContext(ctx, sqlText)
	if err != nil {
		e.emitTerminal(ctx, queryID, err)
		return
	}
	defer rows.Close()

	columns, err := rows.Columns()
	if err != nil {
		e.emitError(queryID, err)
		return
	}
	e.emit(queryID, Event{Type: "columns", Columns: columns})

	values := make([]interface{}, len(columns))
	scanArgs := make([]interface{}, len(columns))
	for i := range values {
		scanArgs[i] = &values[i]
	}

	var batch [][]interface{}
	var total int64

	flush := func() {
		if len(batch) == 0 {
			return
		}
		e.emit(queryID, Event{Type: "rows", Rows: batch})
		batch = nil
	}

	for rows.Next() {
		if err := rows.Scan(scanArgs...); err != nil {
			e.emitError(queryID, err)
			return
		}

		row := make([]interface{}, len(columns))
		for i, v := range values {
			row[i] = normalizeValue(v)
		}
		batch = append(batch, row)
		total++

		if len(batch) >= rowsPerChunk {
			flush()
		}
	}
	flush()

	if err := rows.Err(); err != nil {
		e.emitTerminal(ctx, queryID, err)
		return
	}

	e.emit(queryID, Event{
		Type:         "done",
		RowsAffected: total,
		DurationMs:   time.Since(start).Milliseconds(),
	})
}

func (e *Executor) runExec(ctx context.Context, pool *sql.DB, queryID, sqlText string, start time.Time) {
	result, err := pool.ExecContext(ctx, sqlText)
	if err != nil {
		e.emitTerminal(ctx, queryID, err)
		return
	}

	affected, _ := result.RowsAffected()
	e.emit(queryID, Event{
		Type:         "done",
		RowsAffected: affected,
		DurationMs:   time.Since(start).Milliseconds(),
	})
}

// emitTerminal distinguishes a cancellation (ctx was cancelled) from a real
// query error, so the frontend can render "cancelada" instead of an error.
func (e *Executor) emitTerminal(ctx context.Context, queryID string, err error) {
	if ctx.Err() != nil {
		e.emit(queryID, Event{Type: "cancelled"})
		return
	}
	e.emitError(queryID, err)
}

func (e *Executor) emitError(queryID string, err error) {
	e.emit(queryID, Event{Type: "error", Error: err.Error()})
}

func (e *Executor) registerCancel(queryID string, cancel context.CancelFunc) {
	e.mu.Lock()
	e.cancels[queryID] = cancel
	e.mu.Unlock()
}

func (e *Executor) clearCancel(queryID string) {
	e.mu.Lock()
	delete(e.cancels, queryID)
	e.mu.Unlock()
}

// normalizeValue converts a database/sql scanned value into something that
// marshals cleanly to JSON for the frontend grid.
func normalizeValue(v interface{}) interface{} {
	switch x := v.(type) {
	case []byte:
		return string(x)
	default:
		return x
	}
}
