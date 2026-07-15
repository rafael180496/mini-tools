package redisquery

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"mini-tools/backend/db"
)

// Event is what gets emitted (via EmitFunc) as a Wails runtime event under
// the command script's ID — same streaming contract as query.Event (see
// backend/query/executor.go), but a command's result isn't tabular (a GET
// returns a scalar, an HGETALL returns a flat field/value array under
// RESP2, an LRANGE returns a positional list), so there's no
// Columns/Rows here — just a normalized Result plus its ResultKind.
type Event struct {
	Type          string `json:"type"` // "done" | "cancelled" | "error"
	CommandIndex  int    `json:"commandIndex"`
	TotalCommands int    `json:"totalCommands"`
	// CommandText is this command's own source line, mirroring
	// query.Event.SQLText.
	CommandText string      `json:"commandText,omitempty"`
	ResultKind  string      `json:"resultKind,omitempty"` // "nil"|"string"|"int"|"float"|"bool"|"array"
	Result      interface{} `json:"result,omitempty"`
	DurationMs  int64       `json:"durationMs,omitempty"`
	Error       string      `json:"error,omitempty"`
}

// EmitFunc/HistorySink have the exact same signatures as
// query.EmitFunc/query.HistorySink — app.go passes the SAME closures
// already built for the SQL executor (same Wails event name = queryID, same
// query_history table, commandText standing in for sqlText).
type EmitFunc func(event string, data interface{})
type HistorySink func(connID, commandText, status string, rowsAffected, durationMs int64, errMsg string)

// Executor runs (possibly multi-command) redis-cli-style scripts against a
// pooled redis.UniversalClient and streams the results back as Events, one
// command at a time.
type Executor struct {
	parentCtx context.Context
	pools     *db.RedisPoolManager
	emit      EmitFunc
	history   HistorySink

	mu      sync.Mutex
	cancels map[string]context.CancelFunc
}

// NewExecutor builds an Executor — same shape as query.NewExecutor.
func NewExecutor(parentCtx context.Context, pools *db.RedisPoolManager, emit EmitFunc, history HistorySink) *Executor {
	return &Executor{
		parentCtx: parentCtx, pools: pools, emit: emit, history: history,
		cancels: make(map[string]context.CancelFunc),
	}
}

// Execute splits commandText into individual commands and runs them in
// order against connID, streaming Events under queryID — same
// fire-and-forget goroutine + EventsOn(queryID,...)-before-invoking contract
// as query.Executor.Execute.
func (e *Executor) Execute(connID, queryID, commandText string) {
	go e.run(connID, queryID, commandText)
}

// Cancel cancels the in-flight command script registered under queryID, if
// any — stops before running any further commands, interrupts the command
// currently in flight. The client itself is left open and healthy.
func (e *Executor) Cancel(queryID string) {
	e.mu.Lock()
	cancel, ok := e.cancels[queryID]
	e.mu.Unlock()
	if ok {
		cancel()
	}
}

func (e *Executor) run(connID, queryID, commandText string) {
	client, err := e.pools.Get(connID)
	if err != nil {
		e.emit(queryID, Event{Type: "error", Error: err.Error()})
		return
	}

	commands := SplitCommands(commandText)
	if len(commands) == 0 {
		e.emit(queryID, Event{Type: "error", Error: "redisquery: no hay ningún comando para ejecutar"})
		return
	}
	total := len(commands)

	ctx, cancel := context.WithCancel(e.parentCtx)
	e.registerCancel(queryID, cancel)
	defer e.clearCancel(queryID)
	defer cancel()

	for idx, line := range commands {
		if ctx.Err() != nil {
			// The script was cancelled while an earlier command was
			// in flight — that command already emitted its own
			// "cancelled" event via emitTerminal. Remaining commands
			// never started. Same real bug precedent as
			// query.Executor.run: break, not continue — continue would
			// emit a phantom "cancelled" event per remaining command.
			break
		}

		tokens := TokenizeCommand(line)
		if len(tokens) == 0 {
			continue
		}
		args := make([]interface{}, len(tokens))
		for i, t := range tokens {
			args[i] = t
		}

		start := time.Now()
		result, err := client.Do(ctx, args...).Result()
		durationMs := time.Since(start).Milliseconds()

		if err != nil {
			if err == redis.Nil {
				// A GET miss (or similar) is normal, not an error.
				e.recordHistory(connID, line, "done", 0, durationMs, "")
				e.emit(queryID, Event{
					Type: "done", CommandIndex: idx, TotalCommands: total,
					CommandText: line, ResultKind: "nil", DurationMs: durationMs,
				})
				continue
			}
			e.emitTerminal(ctx, connID, queryID, line, err, idx, total)
			continue
		}

		kind, normalized := NormalizeReply(result)
		e.recordHistory(connID, line, "done", 0, durationMs, "")
		e.emit(queryID, Event{
			Type: "done", CommandIndex: idx, TotalCommands: total,
			CommandText: line, ResultKind: kind, Result: normalized, DurationMs: durationMs,
		})
	}
}

// emitTerminal distinguishes a cancellation (ctx was cancelled) from a real
// error, so the frontend can render "cancelado" instead of an error — same
// role as query.Executor.emitTerminal.
func (e *Executor) emitTerminal(ctx context.Context, connID, queryID, commandText string, err error, idx, total int) {
	if ctx.Err() != nil {
		e.recordHistory(connID, commandText, "cancelled", 0, 0, "")
		e.emit(queryID, Event{Type: "cancelled", CommandIndex: idx, TotalCommands: total, CommandText: commandText})
		return
	}
	e.recordHistory(connID, commandText, "error", 0, 0, err.Error())
	e.emit(queryID, Event{Type: "error", CommandIndex: idx, TotalCommands: total, CommandText: commandText, Error: err.Error()})
}

func (e *Executor) recordHistory(connID, commandText, status string, rowsAffected, durationMs int64, errMsg string) {
	if e.history == nil {
		return
	}
	e.history(connID, commandText, status, rowsAffected, durationMs, errMsg)
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

// NormalizeReply recursively flattens a go-redis generic-Do() reply (as
// returned under the pinned RESP2 protocol, see redisUniversalOptionsFromDSN)
// into a JSON-safe shape plus a ResultKind tag. Deliberately command-agnostic
// — e.g. HGETALL's RESP2 reply is a flat field/value []interface{}, not a
// map; pairing it back into field/value rows is a rendering concern for the
// frontend (which knows the command name), not this generic layer.
func NormalizeReply(v interface{}) (kind string, value interface{}) {
	switch x := v.(type) {
	case nil:
		return "nil", nil
	case string:
		return "string", x
	case []byte:
		return "string", string(x)
	case int64:
		return "int", x
	case float64:
		return "float", x
	case bool:
		return "bool", x
	case []interface{}:
		items := make([]interface{}, len(x))
		for i, item := range x {
			_, items[i] = NormalizeReply(item)
		}
		return "array", items
	default:
		return "string", fmt.Sprintf("%v", x)
	}
}
