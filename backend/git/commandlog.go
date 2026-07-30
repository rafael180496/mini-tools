package git

import (
	"strings"
	"sync"
	"time"
)

// Command log: exactly which git command ran, and what it said.
//
// Every operation in this module is a wrapper around a real git invocation,
// and when one fails the useful question is always "what did it actually
// run?". Answering that inside the app removes the step where somebody
// reproduces the failure in a terminal to find out.
//
// It records the ARGUMENTS, never the environment. That is the line that
// matters: tokens and passphrases travel through the askpass helper's env
// (see auth.go), so logging env would be logging credentials, while argv is
// safe by construction — nothing in this package ever puts a secret there.

// CommandEntry is one git invocation.
type CommandEntry struct {
	// Command is the assembled command line, for display and copying.
	Command string `json:"command"`
	// Dir is the repository it ran in.
	Dir string `json:"dir"`
	// AtMs is when it started, so the log reads as a timeline.
	AtMs       int64 `json:"atMs"`
	DurationMs int64 `json:"durationMs"`
	// Failed plus Output: git's stderr on failure, empty on success. Output
	// is capped — a `git log` of a huge repository would otherwise pin
	// megabytes in memory for a debugging aid.
	Failed bool   `json:"failed"`
	Output string `json:"output,omitempty"`
}

const (
	// commandLogSize bounds the ring. Enough to cover a session's worth of
	// operations; old entries fall off rather than growing without limit.
	commandLogSize = 200
	// maxLoggedOutput caps one entry's stderr.
	maxLoggedOutput = 4_000
)

type commandLog struct {
	mu      sync.Mutex
	entries []CommandEntry
}

func (l *commandLog) add(e CommandEntry) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.entries = append(l.entries, e)
	if len(l.entries) > commandLogSize {
		l.entries = l.entries[len(l.entries)-commandLogSize:]
	}
}

// snapshot returns a copy, newest first — the order a log is read in.
func (l *commandLog) snapshot() []CommandEntry {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]CommandEntry, 0, len(l.entries))
	for i := len(l.entries) - 1; i >= 0; i-- {
		out = append(out, l.entries[i])
	}
	return out
}

func (l *commandLog) clear() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.entries = nil
}

// CommandLog returns the recent git invocations, newest first.
func (r *Runner) CommandLog() []CommandEntry {
	return r.log.snapshot()
}

// ClearCommandLog empties the log.
func (r *Runner) ClearCommandLog() {
	r.log.clear()
}

// record builds an entry. Called by runRaw around every invocation.
func (r *Runner) record(dir string, args []string, started time.Time, failed bool, output string) {
	if len(output) > maxLoggedOutput {
		output = output[:maxLoggedOutput] + "\n… (salida recortada)"
	}
	r.log.add(CommandEntry{
		Command:    "git " + strings.Join(args, " "),
		Dir:        dir,
		AtMs:       started.UnixMilli(),
		DurationMs: time.Since(started).Milliseconds(),
		Failed:     failed,
		Output:     strings.TrimSpace(output),
	})
}
