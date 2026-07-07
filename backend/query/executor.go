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
//
// A script can contain several statements (see splitter.go); each gets its
// own columns/rows/done-or-error sequence tagged with StatementIndex, so
// the frontend can render one result-tab per statement.
type Event struct {
	Type            string          `json:"type"` // "columns" | "rows" | "done" | "cancelled" | "error"
	StatementIndex  int             `json:"statementIndex"`
	TotalStatements int             `json:"totalStatements"`
	Columns         []string        `json:"columns,omitempty"`
	Rows            [][]interface{} `json:"rows,omitempty"`
	RowsAffected    int64           `json:"rowsAffected,omitempty"`
	DurationMs      int64           `json:"durationMs,omitempty"`
	Error           string          `json:"error,omitempty"`
	DBMSOutput      []string        `json:"dbmsOutput,omitempty"`
}

const rowsPerChunk = 200

// EmitFunc sends an event to the frontend under the given event name (the
// queryID). In production this wraps runtime.EventsEmit; tests supply a
// stub instead, since EventsEmit itself requires a live Wails-injected
// context and otherwise kills the process.
type EmitFunc func(event string, data interface{})

// HistorySink records the terminal outcome of one statement's execution.
// Kept separate from EmitFunc (and free of any vault import) so the query
// package stays decoupled from persistence — the caller (app.go) is the one
// that knows how to store it.
type HistorySink func(connID, sqlText, status string, rowsAffected, durationMs int64, errMsg string)

// Executor runs (possibly multi-statement) scripts against pooled
// connections and streams the results back as Events, one statement at a
// time. See detect.go/splitter.go for how statements are classified and
// split, and dbmsoutput.go for Oracle PL/SQL block handling.
type Executor struct {
	parentCtx context.Context
	pools     *db.PoolManager
	emit      EmitFunc
	history   HistorySink

	mu      sync.Mutex
	cancels map[string]context.CancelFunc
}

// NewExecutor builds an Executor. parentCtx is only used to derive each
// query's cancellable context (context.Background() is fine in tests);
// emit is how results actually reach the frontend; history records each
// statement's terminal outcome (pass a no-op func if not needed).
func NewExecutor(parentCtx context.Context, pools *db.PoolManager, emit EmitFunc, history HistorySink) *Executor {
	return &Executor{parentCtx: parentCtx, pools: pools, emit: emit, history: history, cancels: make(map[string]context.CancelFunc)}
}

// Execute splits sqlText into statements and runs them in order against
// connID, streaming Events under queryID. The frontend must call
// EventsOn(queryID, ...) before invoking the ExecuteQuery binding that
// calls this — queryID is client-generated precisely so there is no race
// with the first emitted event.
func (e *Executor) Execute(connID, queryID, sqlText string) {
	go e.run(connID, queryID, sqlText)
}

// Cancel cancels the in-flight script registered under queryID, if any —
// stops before running any further statements, and interrupts the
// statement currently in flight. The pool itself is left open and healthy.
func (e *Executor) Cancel(queryID string) {
	e.mu.Lock()
	cancel, ok := e.cancels[queryID]
	e.mu.Unlock()
	if ok {
		cancel()
	}
}

func (e *Executor) run(connID, queryID, sqlText string) {
	pool, err := e.pools.Get(connID)
	if err != nil {
		e.emit(queryID, Event{Type: "error", Error: err.Error()})
		return
	}
	dbType, _ := e.pools.Type(connID)

	statements := SplitStatements(sqlText)
	if len(statements) == 0 {
		e.emit(queryID, Event{Type: "error", Error: "query: no hay ninguna sentencia para ejecutar"})
		return
	}
	total := len(statements)

	ctx, cancel := context.WithCancel(e.parentCtx)
	e.registerCancel(queryID, cancel)
	defer e.clearCancel(queryID)
	defer cancel()

	for idx, stmt := range statements {
		if ctx.Err() != nil {
			// The script was cancelled while an earlier statement was
			// running — that statement already emitted its own "cancelled"
			// event via emitTerminal. Remaining statements never started,
			// so there's nothing further to emit or record for them.
			break
		}

		start := time.Now()

		if stmt.Kind == KindPLSQLBlock && dbType == db.DBTypeOracle {
			e.runPLSQLBlock(ctx, pool, connID, queryID, stmt.Text, idx, total, start)
			continue
		}

		if isSelectLike(stmt.Text) {
			e.runQuery(ctx, pool, connID, queryID, stmt.Text, idx, total, start)
		} else {
			e.runExec(ctx, pool, connID, queryID, stmt.Text, idx, total, start)
		}
	}
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

func (e *Executor) runQuery(ctx context.Context, pool *sql.DB, connID, queryID, sqlText string, idx, total int, start time.Time) {
	rows, err := pool.QueryContext(ctx, sqlText)
	if err != nil {
		e.emitTerminal(ctx, connID, queryID, sqlText, err, idx, total)
		return
	}
	defer rows.Close()

	columns, err := rows.Columns()
	if err != nil {
		e.emitError(connID, queryID, sqlText, err, idx, total)
		return
	}
	e.emit(queryID, Event{Type: "columns", StatementIndex: idx, TotalStatements: total, Columns: columns})

	values := make([]interface{}, len(columns))
	scanArgs := make([]interface{}, len(columns))
	for i := range values {
		scanArgs[i] = &values[i]
	}

	var batch [][]interface{}
	var rowCount int64

	flush := func() {
		if len(batch) == 0 {
			return
		}
		e.emit(queryID, Event{Type: "rows", StatementIndex: idx, TotalStatements: total, Rows: batch})
		batch = nil
	}

	for rows.Next() {
		if err := rows.Scan(scanArgs...); err != nil {
			e.emitError(connID, queryID, sqlText, err, idx, total)
			return
		}

		row := make([]interface{}, len(columns))
		for i, v := range values {
			row[i] = normalizeValue(v)
		}
		batch = append(batch, row)
		rowCount++

		if len(batch) >= rowsPerChunk {
			flush()
		}
	}
	flush()

	if err := rows.Err(); err != nil {
		e.emitTerminal(ctx, connID, queryID, sqlText, err, idx, total)
		return
	}

	durationMs := time.Since(start).Milliseconds()
	e.emit(queryID, Event{Type: "done", StatementIndex: idx, TotalStatements: total, RowsAffected: rowCount, DurationMs: durationMs})
	e.recordHistory(connID, sqlText, "done", rowCount, durationMs, "")
}

func (e *Executor) runExec(ctx context.Context, pool *sql.DB, connID, queryID, sqlText string, idx, total int, start time.Time) {
	result, err := pool.ExecContext(ctx, sqlText)
	if err != nil {
		e.emitTerminal(ctx, connID, queryID, sqlText, err, idx, total)
		return
	}

	affected, _ := result.RowsAffected()
	durationMs := time.Since(start).Milliseconds()
	e.emit(queryID, Event{Type: "done", StatementIndex: idx, TotalStatements: total, RowsAffected: affected, DurationMs: durationMs})
	e.recordHistory(connID, sqlText, "done", affected, durationMs, "")
}

func (e *Executor) runPLSQLBlock(ctx context.Context, pool *sql.DB, connID, queryID, sqlText string, idx, total int, start time.Time) {
	result, dbmsOutput, err := runOraclePLSQLBlock(ctx, pool, sqlText)
	if err != nil {
		e.emitTerminal(ctx, connID, queryID, sqlText, err, idx, total)
		return
	}

	affected, _ := result.RowsAffected()
	durationMs := time.Since(start).Milliseconds()
	e.emit(queryID, Event{
		Type: "done", StatementIndex: idx, TotalStatements: total,
		RowsAffected: affected, DurationMs: durationMs, DBMSOutput: dbmsOutput,
	})
	e.recordHistory(connID, sqlText, "done", affected, durationMs, "")
}

// emitTerminal distinguishes a cancellation (ctx was cancelled) from a real
// error, so the frontend can render "cancelada" instead of an error.
func (e *Executor) emitTerminal(ctx context.Context, connID, queryID, sqlText string, err error, idx, total int) {
	if ctx.Err() != nil {
		e.emit(queryID, Event{Type: "cancelled", StatementIndex: idx, TotalStatements: total})
		e.recordHistory(connID, sqlText, "cancelled", 0, 0, "")
		return
	}
	e.emitError(connID, queryID, sqlText, err, idx, total)
}

func (e *Executor) emitError(connID, queryID, sqlText string, err error, idx, total int) {
	e.emit(queryID, Event{Type: "error", StatementIndex: idx, TotalStatements: total, Error: err.Error()})
	e.recordHistory(connID, sqlText, "error", 0, 0, err.Error())
}

func (e *Executor) recordHistory(connID, sqlText, status string, rowsAffected, durationMs int64, errMsg string) {
	if e.history == nil {
		return
	}
	e.history(connID, sqlText, status, rowsAffected, durationMs, errMsg)
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
