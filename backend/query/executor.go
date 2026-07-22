package query

import (
	"context"
	"database/sql"
	"fmt"
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
	Type            string `json:"type"` // "columns" | "rows" | "done" | "cancelled" | "error"
	StatementIndex  int    `json:"statementIndex"`
	TotalStatements int    `json:"totalStatements"`
	// SQLText is this statement's own source text. Sent on "columns" so the
	// frontend can re-issue it wrapped in an ORDER BY for column-header
	// sort, and ALSO on every terminal event ("done"/"error"/"cancelled") —
	// including for exec/PL-SQL-block statements that never emit a
	// "columns" event at all — so the frontend's execution console can
	// echo the exact statement/block that just finished next to its
	// result line, the same way a script's statements are only known by
	// splitting here (see splitter.go).
	SQLText      string          `json:"sqlText,omitempty"`
	Columns      []string        `json:"columns,omitempty"`
	Rows         [][]interface{} `json:"rows,omitempty"`
	RowsAffected int64           `json:"rowsAffected,omitempty"`
	DurationMs   int64           `json:"durationMs,omitempty"`
	Error        string          `json:"error,omitempty"`
	DBMSOutput   []string        `json:"dbmsOutput,omitempty"`
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

// queryExecer is satisfied by both *sql.DB and *sql.Conn — runQuery/runExec
// don't care which one they got, only the caller (run) decides based on
// whether connID has an open transaction reserving a single connection.
type queryExecer interface {
	QueryContext(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error)
	ExecContext(ctx context.Context, query string, args ...interface{}) (sql.Result, error)
}

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

	// txMu/txns implement the auto-commit-off flow: BeginTransaction
	// reserves one *sql.Conn per connID (auto-commit gets genuinely
	// disabled there, not just simulated) and every subsequent
	// ExecuteQuery for that connID routes through this same connection
	// until Commit/RollbackTransaction releases it. Deliberately a raw
	// *sql.Conn, not Go's *sql.Tx — SQL text that manages its own
	// transaction boundary (an explicit COMMIT/ROLLBACK the user typed, or
	// one inside a PL/SQL block) needs to behave exactly like it would in
	// psql/sqlplus, which a *sql.Tx wrapper would fight with. See
	// .claude/specs/vault-migrations.md's sibling doc on transactions for
	// the full design writeup.
	txMu sync.Mutex
	txns map[string]*sql.Conn
}

// NewExecutor builds an Executor. parentCtx is only used to derive each
// query's cancellable context (context.Background() is fine in tests);
// emit is how results actually reach the frontend; history records each
// statement's terminal outcome (pass a no-op func if not needed).
func NewExecutor(parentCtx context.Context, pools *db.PoolManager, emit EmitFunc, history HistorySink) *Executor {
	return &Executor{
		parentCtx: parentCtx, pools: pools, emit: emit, history: history,
		cancels: make(map[string]context.CancelFunc),
		txns:    make(map[string]*sql.Conn),
	}
}

// txConn returns connID's reserved connection if a transaction is open, or
// nil if auto-commit is on (the common case) — callers fall back to the
// shared pool.
func (e *Executor) txConn(connID string) *sql.Conn {
	e.txMu.Lock()
	defer e.txMu.Unlock()
	return e.txns[connID]
}

// HasOpenTransaction reports whether connID currently has a reserved
// connection (auto-commit off) — lets the frontend re-sync its toggle state
// (e.g. after a reload) without guessing.
func (e *Executor) HasOpenTransaction(connID string) bool {
	return e.txConn(connID) != nil
}

// BeginTransaction reserves a single connection from connID's pool so every
// statement ExecuteQuery sends for it from here on runs on that same
// connection instead of the shared pool — i.e. auto-commit off. Fails if a
// transaction is already open for connID.
func (e *Executor) BeginTransaction(ctx context.Context, connID string, dbType db.DBType) error {
	e.txMu.Lock()
	defer e.txMu.Unlock()
	if _, ok := e.txns[connID]; ok {
		return fmt.Errorf("query: ya hay una transacción abierta para esta conexión")
	}

	pool, err := e.pools.Get(connID)
	if err != nil {
		return err
	}
	conn, err := pool.Conn(ctx)
	if err != nil {
		return fmt.Errorf("query: reservando conexión: %w", err)
	}

	// Oracle has no explicit BEGIN — a transaction starts implicitly with
	// the first statement on the session. Postgres/SQLite open one with plain
	// "BEGIN"; SQL Server's "BEGIN" starts a T-SQL block, not a transaction,
	// so it needs "BEGIN TRANSACTION" instead (COMMIT/ROLLBACK in
	// endTransaction are valid T-SQL for both engines, no change needed there).
	if beginStmt := transactionBeginStmt(dbType); beginStmt != "" {
		if _, err := conn.ExecContext(ctx, beginStmt); err != nil {
			conn.Close()
			return fmt.Errorf("query: iniciando transacción: %w", err)
		}
	}

	e.txns[connID] = conn
	return nil
}

// endTransaction sends stmt ("COMMIT" or "ROLLBACK") on connID's reserved
// connection and releases it back to the pool — auto-commit is back on
// afterward regardless of whether stmt succeeded, since the connection is
// always released.
func (e *Executor) endTransaction(ctx context.Context, connID, stmt string) error {
	e.txMu.Lock()
	conn, ok := e.txns[connID]
	if ok {
		delete(e.txns, connID)
	}
	e.txMu.Unlock()

	if !ok {
		return fmt.Errorf("query: no hay una transacción abierta para esta conexión")
	}
	defer conn.Close()

	if _, err := conn.ExecContext(ctx, stmt); err != nil {
		return fmt.Errorf("query: %s: %w", stmt, err)
	}
	return nil
}

// transactionBeginStmt returns the statement that opens an explicit
// transaction for dbType, or "" if the engine starts one implicitly on the
// first statement (Oracle). SQL Server needs "BEGIN TRANSACTION" because a
// bare "BEGIN" opens a T-SQL statement block, not a transaction.
func transactionBeginStmt(dbType db.DBType) string {
	switch dbType {
	case db.DBTypeOracle:
		return ""
	case db.DBTypeSQLServer:
		return "BEGIN TRANSACTION"
	default:
		return "BEGIN"
	}
}

func (e *Executor) CommitTransaction(ctx context.Context, connID string) error {
	return e.endTransaction(ctx, connID, "COMMIT")
}

func (e *Executor) RollbackTransaction(ctx context.Context, connID string) error {
	return e.endTransaction(ctx, connID, "ROLLBACK")
}

// RollbackAll releases every currently-reserved transaction connection —
// called on app shutdown, before the pools themselves get closed, so none
// of them leak (see app.go's rollbackIfOpen for the same concern on a
// single connID). Best-effort, same reasoning as rollbackIfOpen: the app is
// closing regardless of whether any individual ROLLBACK succeeds.
func (e *Executor) RollbackAll(ctx context.Context) {
	e.txMu.Lock()
	connIDs := make([]string, 0, len(e.txns))
	for connID := range e.txns {
		connIDs = append(connIDs, connID)
	}
	e.txMu.Unlock()

	for _, connID := range connIDs {
		_ = e.RollbackTransaction(ctx, connID)
	}
}

// Execute splits sqlText into statements and runs them in order against
// connID, streaming Events under queryID. The frontend must call
// EventsOn(queryID, ...) before invoking the ExecuteQuery binding that
// calls this — queryID is client-generated precisely so there is no race
// with the first emitted event. captureDBMSOutput is the toolbar toggle —
// see runOraclePLSQLBlock's doc comment.
func (e *Executor) Execute(connID, queryID, sqlText string, captureDBMSOutput bool) {
	go e.run(connID, queryID, sqlText, captureDBMSOutput)
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

func (e *Executor) run(connID, queryID, sqlText string, captureDBMSOutput bool) {
	pool, err := e.pools.Get(connID)
	if err != nil {
		e.emit(queryID, Event{Type: "error", Error: err.Error()})
		return
	}
	dbType, _ := e.pools.Type(connID)

	// If auto-commit is off for connID, every statement below runs on its
	// one reserved connection instead of the shared pool — see txConn's doc
	// comment and BeginTransaction.
	var execer queryExecer = pool
	if conn := e.txConn(connID); conn != nil {
		execer = conn
	}

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
			e.runPLSQLBlock(ctx, pool, connID, queryID, stmt.Text, idx, total, start, captureDBMSOutput)
			continue
		}

		if isSelectLike(stmt.Text) {
			e.runQuery(ctx, execer, connID, queryID, stmt.Text, idx, total, start)
		} else {
			e.runExec(ctx, execer, connID, queryID, stmt.Text, idx, total, start)
		}
	}
}

// isSelectLike decides which of runQuery/runExec a statement goes through.
// It strips leading "--"/"/* */" comments first (skipLeadingNoise, shared
// with splitter.go's classification) — otherwise a statement with an
// explanatory comment before the real SELECT (a common pattern pasted from
// scripts, e.g. "-- optional filter:\nSELECT ... FROM DUAL;") would fail
// this check, get routed to runExec, and silently produce an empty result
// tab (a "done" with rows-affected instead of columns/rows) even though the
// query ran fine.
func isSelectLike(sqlText string) bool {
	upper := strings.ToUpper(strings.TrimSpace(skipLeadingNoise(sqlText)))
	for _, prefix := range []string{"SELECT", "WITH", "PRAGMA", "EXPLAIN"} {
		if strings.HasPrefix(upper, prefix) {
			return true
		}
	}
	return false
}

func (e *Executor) runQuery(ctx context.Context, execer queryExecer, connID, queryID, sqlText string, idx, total int, start time.Time) {
	rows, err := execer.QueryContext(ctx, sqlText)
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
	e.emit(queryID, Event{Type: "columns", StatementIndex: idx, TotalStatements: total, Columns: columns, SQLText: sqlText})

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
	// History is recorded before the terminal event is emitted (not after)
	// so that by the time the frontend receives "done" and, say, refreshes
	// its history panel, the row it's about to query for already exists —
	// otherwise that refresh could race the write and miss the statement
	// that just finished.
	e.recordHistory(connID, sqlText, "done", rowCount, durationMs, "")
	e.emit(queryID, Event{Type: "done", StatementIndex: idx, TotalStatements: total, RowsAffected: rowCount, DurationMs: durationMs, SQLText: sqlText})
}

func (e *Executor) runExec(ctx context.Context, execer queryExecer, connID, queryID, sqlText string, idx, total int, start time.Time) {
	result, err := execer.ExecContext(ctx, sqlText)
	if err != nil {
		e.emitTerminal(ctx, connID, queryID, sqlText, err, idx, total)
		return
	}

	affected, _ := result.RowsAffected()
	durationMs := time.Since(start).Milliseconds()
	e.recordHistory(connID, sqlText, "done", affected, durationMs, "")
	e.emit(queryID, Event{Type: "done", StatementIndex: idx, TotalStatements: total, RowsAffected: affected, DurationMs: durationMs, SQLText: sqlText})
}

func (e *Executor) runPLSQLBlock(ctx context.Context, pool *sql.DB, connID, queryID, sqlText string, idx, total int, start time.Time, captureDBMSOutput bool) {
	// If a transaction is open for connID, DBMS_OUTPUT must run on that SAME
	// reserved connection (its ENABLE/PUT_LINE/GET_LINE state is
	// per-session) — reusing it here also means an explicit COMMIT/ROLLBACK
	// inside the block affects the transaction the Commit/Rollback buttons
	// are tracking, not some other connection. Otherwise reserve one just
	// for this block, exactly as before this feature existed.
	conn := e.txConn(connID)
	ownsConn := conn == nil
	if ownsConn {
		var err error
		conn, err = pool.Conn(ctx)
		if err != nil {
			e.emitError(connID, queryID, sqlText, fmt.Errorf("query: reservando conexión para bloque PL/SQL: %w", err), idx, total)
			return
		}
		defer conn.Close()
	}

	result, dbmsOutput, err := runOraclePLSQLBlock(ctx, conn, sqlText, captureDBMSOutput)
	if err != nil {
		e.emitTerminal(ctx, connID, queryID, sqlText, err, idx, total)
		return
	}

	affected, _ := result.RowsAffected()
	durationMs := time.Since(start).Milliseconds()
	e.recordHistory(connID, sqlText, "done", affected, durationMs, "")
	e.emit(queryID, Event{
		Type: "done", StatementIndex: idx, TotalStatements: total,
		RowsAffected: affected, DurationMs: durationMs, DBMSOutput: dbmsOutput, SQLText: sqlText,
	})
}

// emitTerminal distinguishes a cancellation (ctx was cancelled) from a real
// error, so the frontend can render "cancelada" instead of an error.
func (e *Executor) emitTerminal(ctx context.Context, connID, queryID, sqlText string, err error, idx, total int) {
	if ctx.Err() != nil {
		e.recordHistory(connID, sqlText, "cancelled", 0, 0, "")
		e.emit(queryID, Event{Type: "cancelled", StatementIndex: idx, TotalStatements: total, SQLText: sqlText})
		return
	}
	e.emitError(connID, queryID, sqlText, err, idx, total)
}

func (e *Executor) emitError(connID, queryID, sqlText string, err error, idx, total int) {
	e.recordHistory(connID, sqlText, "error", 0, 0, err.Error())
	e.emit(queryID, Event{Type: "error", StatementIndex: idx, TotalStatements: total, Error: err.Error(), SQLText: sqlText})
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
