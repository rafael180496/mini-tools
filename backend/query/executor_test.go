package query

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"mini-tools/backend/db"
)

func newTestExecutor(t *testing.T) (*Executor, chan Event) {
	t.Helper()

	path := filepath.Join(t.TempDir(), "test.db")

	connector, err := db.ConnectorFor(db.DBTypeSQLite)
	if err != nil {
		t.Fatalf("ConnectorFor: %v", err)
	}
	dsn, err := connector.BuildDSN(map[string]string{"path": path})
	if err != nil {
		t.Fatalf("BuildDSN: %v", err)
	}

	pools := db.NewPoolManager()
	t.Cleanup(pools.CloseAll)
	if _, err := pools.Open("conn-1", db.DBTypeSQLite, dsn); err != nil {
		t.Fatalf("Open: %v", err)
	}

	events := make(chan Event, 256)
	exec := NewExecutor(context.Background(), pools, func(_ string, data interface{}) {
		e, ok := data.(Event)
		if !ok {
			t.Fatalf("unexpected emitted payload type %T", data)
		}
		events <- e
	}, nil)

	return exec, events
}

// waitForTerminal drains events until a done/cancelled/error event arrives.
func waitForTerminal(t *testing.T, events chan Event) Event {
	t.Helper()

	deadline := time.After(5 * time.Second)
	for {
		select {
		case e := <-events:
			switch e.Type {
			case "done", "cancelled", "error":
				return e
			}
		case <-deadline:
			t.Fatal("timed out waiting for a terminal event")
		}
	}
}

func TestExecutorRunsSelectAndStreamsRows(t *testing.T) {
	exec, events := newTestExecutor(t)

	exec.Execute("conn-1", "q1", "SELECT 1 AS one", true)

	final := waitForTerminal(t, events)
	if final.Type != "done" {
		t.Fatalf("expected done, got %+v", final)
	}
	if final.RowsAffected != 1 {
		t.Fatalf("expected 1 row, got %+v", final)
	}
}

// Regression test for a real bug: a SELECT preceded by a "--" line comment
// (a common pasted-from-a-script pattern) was misclassified by
// isSelectLike as non-SELECT because it only checked the statement's raw
// prefix — routing it through runExec instead of runQuery, which never
// emits a "columns" event, silently producing an apparently empty result
// tab for a query that actually ran fine.
func TestExecutorSelectWithLeadingCommentStillReturnsRows(t *testing.T) {
	exec, events := newTestExecutor(t)

	exec.Execute("conn-1", "q1b", "-- explanatory comment\n\nSELECT 1 AS one", true)

	var sawColumns bool
	deadline := time.After(5 * time.Second)
	for {
		select {
		case e := <-events:
			if e.Type == "columns" {
				sawColumns = true
			}
			if e.Type == "done" || e.Type == "cancelled" || e.Type == "error" {
				if e.Type != "done" {
					t.Fatalf("expected done, got %+v", e)
				}
				if !sawColumns {
					t.Fatalf("expected a columns event before done — statement was likely misrouted to runExec")
				}
				if e.RowsAffected != 1 {
					t.Fatalf("expected 1 row, got %+v", e)
				}
				return
			}
		case <-deadline:
			t.Fatal("timed out waiting for a terminal event")
		}
	}
}

func TestExecutorRunsExecStatement(t *testing.T) {
	exec, events := newTestExecutor(t)

	exec.Execute("conn-1", "q2", "CREATE TABLE t (id INTEGER)", true)

	final := waitForTerminal(t, events)
	if final.Type != "done" {
		t.Fatalf("expected done, got %+v", final)
	}
}

func TestExecutorUnknownConnectionEmitsError(t *testing.T) {
	exec, events := newTestExecutor(t)

	exec.Execute("no-such-conn", "q3", "SELECT 1", true)

	final := waitForTerminal(t, events)
	if final.Type != "error" {
		t.Fatalf("expected error, got %+v", final)
	}
}

func TestExecutorCancelStopsLongRunningQuery(t *testing.T) {
	exec, events := newTestExecutor(t)

	// A recursive CTE that would otherwise run for a very long time —
	// long enough that Cancel must actually interrupt it for the test to
	// pass quickly instead of timing out.
	slowQuery := `WITH RECURSIVE cnt(x) AS (
		SELECT 1
		UNION ALL
		SELECT x + 1 FROM cnt WHERE x < 100000000
	) SELECT x FROM cnt`

	exec.Execute("conn-1", "q4", slowQuery, true)
	time.Sleep(50 * time.Millisecond) // let it actually start running
	exec.Cancel("q4")

	final := waitForTerminal(t, events)
	if final.Type != "cancelled" {
		t.Fatalf("expected cancelled, got %+v", final)
	}
}
