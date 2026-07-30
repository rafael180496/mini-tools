package redisquery

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"

	"mini-tools/backend/db"
)

// Live monitoring: Pub/Sub subscriptions and stream consumption.
//
// This is a SECOND execution path, deliberately separate from Executor.
// Everything else in this package is command → single result: the caller
// sends a script, gets events, and it ends. A subscription has no result
// and no end — it produces messages until somebody stops it. Folding that
// into Executor would have meant a "command" that never completes, breaking
// the cancel registry, the history sink and the done/error contract all at
// once.
//
// It was previously out of scope for exactly that reason (see the Redis
// section of .claude/skills/mini-tools-patterns/SKILL.md). It is in scope
// now because it got its own path rather than being bolted onto the wrong
// one.

// StreamEvent is one live-monitor event, emitted under the monitor's id.
type StreamEvent struct {
	// Type is "message" (a batch of payloads), "started", "stopped" or
	// "error".
	Type string `json:"type"`
	// Messages is a batch, never a single item: a busy channel can produce
	// thousands of messages a second, and one IPC hop each would saturate
	// the bridge and freeze the UI. See flushInterval.
	Messages []StreamMessage `json:"messages,omitempty"`
	// Dropped counts messages discarded because the consumer could not keep
	// up. Reported rather than hidden — a monitor silently missing messages
	// is worse than one saying it missed them.
	Dropped int64  `json:"dropped,omitempty"`
	Error   string `json:"error,omitempty"`
}

// StreamMessage is one Pub/Sub message or one stream entry.
type StreamMessage struct {
	// Channel is the Pub/Sub channel, or the stream key.
	Channel string `json:"channel"`
	// Pattern is set when the message arrived through a PSUBSCRIBE.
	Pattern string `json:"pattern,omitempty"`
	// Payload is a Pub/Sub message body.
	Payload string `json:"payload,omitempty"`
	// ID and Fields are set for stream entries instead of Payload.
	ID     string            `json:"id,omitempty"`
	Fields map[string]string `json:"fields,omitempty"`
	// ReceivedAtMs is when this process saw it, so the UI can show the gap
	// between messages without needing a clock of its own.
	ReceivedAtMs int64 `json:"receivedAtMs"`
}

const (
	// flushInterval bounds how often a monitor crosses the IPC bridge. A
	// firehose channel is the normal case, not the pathological one, and
	// emitting per message would make the app unusable exactly when the
	// monitor is most needed.
	flushInterval = 250 * time.Millisecond
	// flushSize forces an early flush so a burst is not held for the whole
	// interval.
	flushSize = 200
	// bufferSize is how many messages may queue between flushes. Past this
	// they are dropped and counted — bounded memory beats a monitor that
	// grows until the app dies.
	bufferSize = 5_000
	// xreadBlock is how long a blocking XREAD waits before returning empty
	// and looping. NOT 0 (block forever): a blocking command holds a
	// connection out of the pool for its whole duration, and it must also
	// come back regularly so cancellation is responsive.
	xreadBlock = 2 * time.Second
)

// StreamManager owns the running monitors. One per app, alongside Executor.
type StreamManager struct {
	parentCtx context.Context
	pools     *db.RedisPoolManager
	emit      EmitFunc

	mu       sync.Mutex
	monitors map[string]context.CancelFunc
}

// NewStreamManager builds the manager — same shape as NewExecutor, and it
// takes the SAME injected EmitFunc, so tests can capture events without a
// Wails runtime (see backend/query/executor.go's note on why emit is
// injected rather than called directly).
func NewStreamManager(parentCtx context.Context, pools *db.RedisPoolManager, emit EmitFunc) *StreamManager {
	return &StreamManager{parentCtx: parentCtx, pools: pools, monitors: map[string]context.CancelFunc{}, emit: emit}
}

// Subscribe starts a Pub/Sub monitor under monitorID, delivering messages
// from the given channels (SUBSCRIBE) and patterns (PSUBSCRIBE).
//
// Returns as soon as the subscription is registered; messages arrive as
// events. An already-running monitorID is an error rather than a silent
// replacement — losing a subscription because a click double-fired is the
// kind of thing nobody notices until messages are missing.
func (m *StreamManager) Subscribe(connID, monitorID string, channels, patterns []string) error {
	if len(channels) == 0 && len(patterns) == 0 {
		return fmt.Errorf("redisquery: hay que indicar al menos un canal o un patrón")
	}

	client, err := m.pools.Get(connID)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithCancel(m.parentCtx)
	if err := m.register(monitorID, cancel); err != nil {
		cancel()
		return err
	}

	// go-redis's PubSub holds its own dedicated connection for the
	// subscription's lifetime — which is exactly right here and exactly
	// what made this impossible to express through the pooled command path.
	var sub *redis.PubSub
	if len(patterns) > 0 {
		sub = client.PSubscribe(ctx, patterns...)
		if len(channels) > 0 {
			_ = sub.Subscribe(ctx, channels...)
		}
	} else {
		sub = client.Subscribe(ctx, channels...)
	}

	go m.pump(ctx, monitorID, sub, func(send func(StreamMessage)) {
		ch := sub.Channel(redis.WithChannelSize(bufferSize))
		for {
			select {
			case <-ctx.Done():
				return
			case msg, ok := <-ch:
				if !ok {
					return
				}
				send(StreamMessage{
					Channel:      msg.Channel,
					Pattern:      msg.Pattern,
					Payload:      msg.Payload,
					ReceivedAtMs: time.Now().UnixMilli(),
				})
			}
		}
	})

	return nil
}

// ReadStream starts a stream monitor under monitorID, consuming new entries
// of key from fromID onward ("$" = only entries added from now on, "0" =
// from the beginning).
func (m *StreamManager) ReadStream(connID, monitorID, key, fromID string) error {
	if strings.TrimSpace(key) == "" {
		return fmt.Errorf("redisquery: hay que indicar el nombre del stream")
	}
	if fromID == "" {
		fromID = "$"
	}

	client, err := m.pools.Get(connID)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithCancel(m.parentCtx)
	if err := m.register(monitorID, cancel); err != nil {
		cancel()
		return err
	}

	go m.pump(ctx, monitorID, nil, func(send func(StreamMessage)) {
		lastID := fromID
		for {
			if ctx.Err() != nil {
				return
			}

			res, err := client.XRead(ctx, &redis.XReadArgs{
				Streams: []string{key, lastID},
				Block:   xreadBlock,
				Count:   200,
			}).Result()

			if err != nil {
				// redis.Nil is the normal "the block window expired with
				// nothing new" answer, not a failure — looping on it is how
				// a tail works.
				if err == redis.Nil || ctx.Err() != nil {
					continue
				}
				m.emitEvent(monitorID, StreamEvent{Type: "error", Error: err.Error()})
				return
			}

			for _, stream := range res {
				for _, entry := range stream.Messages {
					fields := make(map[string]string, len(entry.Values))
					for k, v := range entry.Values {
						fields[k] = fmt.Sprint(v)
					}
					send(StreamMessage{
						Channel:      stream.Stream,
						ID:           entry.ID,
						Fields:       fields,
						ReceivedAtMs: time.Now().UnixMilli(),
					})
					lastID = entry.ID
				}
			}
		}
	})

	return nil
}

// Stop ends a monitor. Stopping one that is not running is not an error:
// the UI can call it on unmount without having to track whether the start
// actually succeeded.
func (m *StreamManager) Stop(monitorID string) {
	m.mu.Lock()
	cancel, ok := m.monitors[monitorID]
	delete(m.monitors, monitorID)
	m.mu.Unlock()

	if ok {
		cancel()
	}
}

// StopAll ends every monitor — called on shutdown, so a subscription's
// dedicated connection is not left dangling when the app closes.
func (m *StreamManager) StopAll() {
	m.mu.Lock()
	cancels := make([]context.CancelFunc, 0, len(m.monitors))
	for id, cancel := range m.monitors {
		cancels = append(cancels, cancel)
		delete(m.monitors, id)
	}
	m.mu.Unlock()

	for _, cancel := range cancels {
		cancel()
	}
}

// Running reports how many monitors are active, for the UI's indicator.
func (m *StreamManager) Running() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.monitors)
}

func (m *StreamManager) register(monitorID string, cancel context.CancelFunc) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.monitors[monitorID]; exists {
		return fmt.Errorf("redisquery: ya hay un monitor corriendo con el id %q", monitorID)
	}
	m.monitors[monitorID] = cancel
	return nil
}

// pump runs the producer and batches what it produces into flushed events.
//
// The producer writes into an unbuffered-from-its-side channel with a
// bounded queue; the batching loop drains it on a timer. This is the piece
// that makes a firehose survivable: without it, a channel doing 20.000
// messages a second would be 20.000 IPC hops a second.
func (m *StreamManager) pump(ctx context.Context, monitorID string, sub *redis.PubSub, produce func(send func(StreamMessage))) {
	out := make(chan StreamMessage, bufferSize)
	done := make(chan struct{})

	// The producer must never block on a slow consumer: a Pub/Sub reader
	// that stalls stops draining go-redis's own channel, which then drops
	// messages where nothing can count them. Dropping HERE, on a full
	// buffer, is what makes the reported count real instead of decorative.
	var dropped atomic.Int64
	send := func(msg StreamMessage) {
		select {
		case out <- msg:
		default:
			dropped.Add(1)
		}
	}

	go func() {
		defer close(done)
		defer func() {
			// A producer panicking (a malformed reply, a driver edge case)
			// must not take the app with it — the monitor dies, reports,
			// and the rest keeps running.
			if r := recover(); r != nil {
				m.emitEvent(monitorID, StreamEvent{Type: "error", Error: fmt.Sprint(r)})
			}
		}()
		produce(send)
	}()

	m.emitEvent(monitorID, StreamEvent{Type: "started"})

	ticker := time.NewTicker(flushInterval)
	defer ticker.Stop()

	batch := make([]StreamMessage, 0, flushSize)

	flush := func() {
		lost := dropped.Swap(0)
		if len(batch) == 0 && lost == 0 {
			return
		}
		m.emitEvent(monitorID, StreamEvent{Type: "message", Messages: batch, Dropped: lost})
		batch = make([]StreamMessage, 0, flushSize)
	}

	for {
		select {
		case <-ctx.Done():
			flush()
			if sub != nil {
				_ = sub.Close()
			}
			m.emitEvent(monitorID, StreamEvent{Type: "stopped"})
			m.Stop(monitorID)
			return

		case <-done:
			flush()
			if sub != nil {
				_ = sub.Close()
			}
			m.emitEvent(monitorID, StreamEvent{Type: "stopped"})
			m.Stop(monitorID)
			return

		case msg := <-out:
			if len(batch) >= flushSize {
				flush()
			}
			batch = append(batch, msg)

		case <-ticker.C:
			flush()
		}
	}
}

func (m *StreamManager) emitEvent(monitorID string, ev StreamEvent) {
	if m.emit != nil {
		m.emit(monitorID, ev)
	}
}
