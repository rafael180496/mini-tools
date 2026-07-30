package redisquery

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// Lua script support.
//
// Running a script against Redis is not like running a command: a script is
// atomic and blocks the whole server while it executes, so a bad one does
// not fail politely, it stalls every other client. That is why validation
// comes first and is a separate step the UI can offer on its own.

// LuaResult is what running or checking a script returns.
type LuaResult struct {
	// SHA is the script's digest, as returned by SCRIPT LOAD. Present after
	// a successful validation OR run — it is what EVALSHA would use.
	SHA string `json:"sha,omitempty"`
	// Kind/Value normalise the reply the same way command results are (see
	// NormalizeReply), so the frontend renders both through one path.
	Kind  string      `json:"kind,omitempty"`
	Value interface{} `json:"value,omitempty"`
	// DurationMs is how long EVALSHA took. Worth showing: a script is
	// atomic, so this number is also how long every other client waited.
	DurationMs int64 `json:"durationMs,omitempty"`
}

// CheckLuaScript compiles a script WITHOUT running it, returning its SHA.
//
// SCRIPT LOAD parses and caches the script and reports a syntax error, but
// never executes it — which is exactly the "validate before sending"
// step. The cached entry is also what makes the subsequent EVALSHA cheap,
// so validating is not wasted work even when the script is fine.
func CheckLuaScript(ctx context.Context, client redis.UniversalClient, script string) (LuaResult, error) {
	if strings.TrimSpace(script) == "" {
		return LuaResult{}, fmt.Errorf("redisquery: el script está vacío")
	}

	sha, err := client.ScriptLoad(ctx, script).Result()
	if err != nil {
		// Redis reports compilation problems as a normal command error with
		// the Lua parser's own message, which is far more useful than
		// anything this layer could invent — pass it through.
		return LuaResult{}, fmt.Errorf("redisquery: el script no compila: %w", err)
	}
	return LuaResult{SHA: sha}, nil
}

// RunLuaScript validates and then runs a script.
//
// keys and args map to Lua's KEYS[] and ARGV[]. The split matters and is
// not cosmetic: Redis routes and (on a cluster) validates a script by the
// KEYS it declares, so passing a key through ARGV works on a single node
// and breaks the day the deployment is sharded.
//
// It always loads before evaluating rather than calling EVAL directly, so a
// script with a syntax error is reported as such instead of as a runtime
// failure halfway through.
func RunLuaScript(ctx context.Context, runner commandRunner, client redis.UniversalClient, script string, keys, args []string) (LuaResult, error) {
	loaded, err := CheckLuaScript(ctx, client, script)
	if err != nil {
		return LuaResult{}, err
	}

	// Built as a plain argument list rather than through client.EvalSha so
	// it can be dispatched against `runner` — which is the reserved
	// connection when the user has a transaction open (see tx.go). Calling
	// the typed helper on the pooled client instead would run the script
	// OUTSIDE that transaction.
	cmd := make([]interface{}, 0, 3+len(keys)+len(args))
	cmd = append(cmd, "EVALSHA", loaded.SHA, strconv.Itoa(len(keys)))
	for _, k := range keys {
		cmd = append(cmd, k)
	}
	for _, a := range args {
		cmd = append(cmd, a)
	}

	start := time.Now()
	res, err := runner.Do(ctx, cmd...).Result()
	duration := time.Since(start).Milliseconds()

	if err != nil {
		if err == redis.Nil {
			return LuaResult{SHA: loaded.SHA, Kind: "nil", DurationMs: duration}, nil
		}
		return LuaResult{SHA: loaded.SHA, DurationMs: duration}, fmt.Errorf("redisquery: ejecutando el script: %w", err)
	}

	kind, value := NormalizeReply(res)
	return LuaResult{SHA: loaded.SHA, Kind: kind, Value: value, DurationMs: duration}, nil
}
