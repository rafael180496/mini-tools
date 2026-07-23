package query

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"time"
)

// Paged result fetching — the "traé las primeras N filas y seguí cuando te lo
// pidan" behaviour a SQL client needs so `SELECT * FROM tabla_enorme` does not
// try to stream a million rows into the UI.
//
// # Why an open cursor instead of LIMIT/OFFSET
//
// Re-running the statement with LIMIT/OFFSET per page would be dialect-specific
// (each engine spells it differently) and, worse, *wrong*: without a total
// ORDER BY the engine may return rows in a different order each run, so page 2
// could repeat or skip rows from page 1. Holding the original `*sql.Rows` open
// and reading the next chunk from it is the only way to page a result set
// consistently, and it is what DataGrip does.
//
// # The cost, and how it is bounded
//
// An open `*sql.Rows` pins one connection from that connection's pool (5 by
// default, see db.defaultMaxOpenConns). Left unchecked, a handful of forgotten
// paused cursors would exhaust the pool and every later query on that
// connection would block forever. Three rules keep that from happening:
//
//   - **One paused cursor per connection.** Starting any new query on a
//     connection closes that connection's previous paused cursor, so a
//     connection can never pin more than one.
//   - **TTL sweep.** A cursor untouched for cursorTTL is closed by the janitor,
//     so an abandoned result set (tab closed, user walked away) releases its
//     connection on its own.
//   - **Explicit close** on cancel and on executor shutdown.

// defaultPageSize is how many rows one page carries unless the user picks
// another size. 500 matches what a SQL client user expects from a first fetch
// (and what DataGrip defaults to): enough to fill a screen many times over,
// small enough that a huge table does not stall the UI or the connection.
const defaultPageSize = 500

// PageSizeAll disables paging entirely — the whole result set is streamed in
// one go, the pre-paging behaviour. Exposed because "All" is a legitimate
// choice for a query the user KNOWS is small, and matches DataGrip's menu.
const PageSizeAll = 0

// SetPageSize changes how many rows a page carries from here on. 0 means "All"
// (no paging). Already-open cursors keep serving pages at the size in effect
// when they were created only for the row already peeked; the next page uses
// the new size, which is what a user changing the setting expects.
func (e *Executor) SetPageSize(n int) {
	if n < 0 {
		n = 0
	}
	e.pageMu.Lock()
	e.pageSize = n
	e.pageMu.Unlock()
}

// pageLimit is the size to use for the next page read.
func (e *Executor) pageLimit() int {
	e.pageMu.Lock()
	defer e.pageMu.Unlock()
	return e.pageSize
}

// cursorTTL is how long a paused cursor may sit untouched before the janitor
// closes it and frees its pooled connection.
const cursorTTL = 5 * time.Minute

// pausedCursor is a result set that delivered a page and still has rows left.
// pending holds the one row that had to be scanned to discover "there is more"
// (see readPage) so it is not lost.
type pausedCursor struct {
	rows *sql.Rows
	// cancel belongs to the query's context. A paused cursor OWNS it: the
	// context must outlive run(), because database/sql closes an open
	// *sql.Rows as soon as its context is cancelled — cancelling on run()'s
	// exit (the original behaviour) killed the cursor before FetchMore could
	// ever read from it. Closing the cursor is what finally cancels.
	cancel  context.CancelFunc
	connID  string
	sqlText string
	columns []string
	// pending is the already-scanned row that proved more rows exist; it is
	// the first row handed out by the next page.
	pending  []interface{}
	fetched  int64
	lastUsed time.Time
	// idx/total identify which statement of the script this cursor belongs
	// to, so resumed pages are emitted onto the same result tab.
	idx   int
	total int
}

// close releases the cursor and its context (in that order — the rows must be
// closed before the context that owns them goes away).
func (c *pausedCursor) close() {
	c.rows.Close()
	if c.cancel != nil {
		c.cancel()
	}
}

// cursors is the registry of paused cursors, keyed by queryID.
type cursors struct {
	mu sync.Mutex
	m  map[string]*pausedCursor
}

func newCursors() *cursors { return &cursors{m: make(map[string]*pausedCursor)} }

// put stores c under queryID, first closing any cursor already paused on the
// same connection — the "one paused cursor per connection" rule that bounds
// how many pooled connections paging can pin.
func (cs *cursors) put(queryID string, c *pausedCursor) {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	for id, existing := range cs.m {
		if existing.connID == c.connID {
			existing.close()
			delete(cs.m, id)
		}
	}
	c.lastUsed = time.Now()
	cs.m[queryID] = c
}

// take removes and returns the cursor for queryID, if any. The caller owns it
// afterwards and must either close it or put it back.
func (cs *cursors) take(queryID string) (*pausedCursor, bool) {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	c, ok := cs.m[queryID]
	if ok {
		delete(cs.m, queryID)
	}
	return c, ok
}

// closeQuery closes and forgets the cursor for queryID, if any.
func (cs *cursors) closeQuery(queryID string) {
	if c, ok := cs.take(queryID); ok {
		c.close()
	}
}

// closeConn closes every cursor paused on connID — used when a new query
// starts on that connection and when the connection itself goes away.
func (cs *cursors) closeConn(connID string) {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	for id, c := range cs.m {
		if c.connID == connID {
			c.close()
			delete(cs.m, id)
		}
	}
}

// closeAll releases every paused cursor — executor shutdown.
func (cs *cursors) closeAll() {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	for id, c := range cs.m {
		c.close()
		delete(cs.m, id)
	}
}

// attachCancel hands the query context's cancel func to the cursor paused under
// queryID, if any. Reports whether a cursor took it — run() uses that to decide
// between cancelling the context itself and letting the cursor own it.
func (cs *cursors) attachCancel(queryID string, cancel context.CancelFunc) bool {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	c, ok := cs.m[queryID]
	if !ok {
		return false
	}
	c.cancel = cancel
	return true
}

// sweep closes cursors untouched for longer than cursorTTL.
func (cs *cursors) sweep() {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	cutoff := time.Now().Add(-cursorTTL)
	for id, c := range cs.m {
		if c.lastUsed.Before(cutoff) {
			c.close()
			delete(cs.m, id)
		}
	}
}

// isCancellation reports whether err came from the context being cancelled
// (the user hitting stop) rather than a real failure. Drivers wrap it
// differently, so this matches on the sentinel rather than the message.
func isCancellation(err error) bool {
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}

// readPage pulls up to pageSize rows out of c, starting with any pending row.
// hasMore reports whether the cursor still has rows after this page — decided
// by scanning one row past the page, which is why pendingcolumns exists.
func readPage(c *pausedCursor, limit int) (batch [][]interface{}, hasMore bool, err error) {
	values := make([]interface{}, len(c.columns))
	scanArgs := make([]interface{}, len(c.columns))
	for i := range values {
		scanArgs[i] = &values[i]
	}

	if c.pending != nil {
		batch = append(batch, c.pending)
		c.pending = nil
	}

	for limit == PageSizeAll || len(batch) < limit {
		if !c.rows.Next() {
			return batch, false, c.rows.Err()
		}
		if err := c.rows.Scan(scanArgs...); err != nil {
			return batch, false, err
		}
		row := make([]interface{}, len(c.columns))
		for i, v := range values {
			row[i] = normalizeValue(v)
		}
		batch = append(batch, row)
	}

	// With "All" the loop above only exits when the cursor is exhausted, so
	// there is nothing left to peek at.
	if limit == PageSizeAll {
		return batch, false, c.rows.Err()
	}
	// One row past the page: if it exists, keep it as `pending` for the next
	// page rather than discarding it (Next() already consumed it).
	if c.rows.Next() {
		if err := c.rows.Scan(scanArgs...); err != nil {
			return batch, false, err
		}
		row := make([]interface{}, len(c.columns))
		for i, v := range values {
			row[i] = normalizeValue(v)
		}
		c.pending = row
		return batch, true, nil
	}
	return batch, false, c.rows.Err()
}

// FetchMore delivers the next page of a paused result set, emitting the same
// "rows" events the initial page used so the frontend appends them to the same
// tab. It is a no-op (with a clear error) if the cursor is gone — expired by
// TTL, closed by a newer query on that connection, or already exhausted.
func (e *Executor) FetchMore(queryID string) {
	c, ok := e.cursors.take(queryID)
	if !ok {
		e.emit(queryID, Event{Type: "error", Error: "el resultado ya no está disponible para paginar (se cerró por inactividad o por una consulta nueva en esa conexión) — volvé a ejecutar la consulta"})
		return
	}
	// Async so the binding returns immediately and the page can be cancelled
	// while it reads: registering the cursor's cancel under queryID is what
	// makes Cancel(queryID) abort a fetch that is taking too long.
	go e.fetchPage(queryID, c)
}

func (e *Executor) fetchPage(queryID string, c *pausedCursor) {
	e.registerCancel(queryID, c.cancel)
	defer e.clearCancel(queryID)

	batch, hasMore, err := readPage(c, e.pageLimit())
	if err != nil {
		c.close()
		// A cancelled read is a user action, not a failure — report it as such
		// so the UI stops the spinner without showing a scary error.
		if e.parentCtx.Err() != nil || isCancellation(err) {
			e.emit(queryID, Event{Type: "cancelled", StatementIndex: c.idx, TotalStatements: c.total, SQLText: c.sqlText})
			return
		}
		e.emit(queryID, Event{Type: "error", StatementIndex: c.idx, TotalStatements: c.total, Error: err.Error(), SQLText: c.sqlText})
		return
	}

	c.fetched += int64(len(batch))
	if len(batch) > 0 {
		e.emit(queryID, Event{Type: "rows", StatementIndex: c.idx, TotalStatements: c.total, Rows: batch})
	}

	if hasMore {
		e.cursors.put(queryID, c)
	} else {
		c.close()
	}
	e.emit(queryID, Event{
		Type:            "page",
		StatementIndex:  c.idx,
		TotalStatements: c.total,
		RowsAffected:    c.fetched,
		HasMore:         hasMore,
		SQLText:         c.sqlText,
	})
}

// CancelPaging closes a paused cursor without fetching anything — used when the
// frontend drops a result (tab closed, new run) and wants its connection back.
func (e *Executor) CancelPaging(queryID string) { e.cursors.closeQuery(queryID) }

// startCursorJanitor runs the TTL sweep until the executor's context ends.
func (e *Executor) startCursorJanitor() {
	go func() {
		t := time.NewTicker(cursorTTL / 2)
		defer t.Stop()
		for {
			select {
			case <-e.parentCtx.Done():
				e.cursors.closeAll()
				return
			case <-t.C:
				e.cursors.sweep()
			}
		}
	}()
}

var _ = fmt.Sprintf
