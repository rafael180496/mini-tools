package sftpx

import (
	"context"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"time"
)

// EmitFunc mirrors sshconn.EmitFunc / query.EmitFunc — injected by app.go's
// startup(), never calling the Wails runtime from this package directly (same
// reason the executors don't own the runtime import).
type EmitFunc func(event string, data interface{})

const (
	// defaultWorkers bounds how many files transfer concurrently within a
	// single job. A single pkg/sftp client multiplexes concurrent requests, so
	// the pool shares one client per side; 4 keeps big batches moving without
	// flooding the server or the local disk.
	defaultWorkers = 4
	copyChunkSize  = 256 * 1024
	// progressInterval throttles per-byte progress emits so a fast transfer of
	// many small files doesn't flood the frontend event bus.
	progressInterval = 150 * time.Millisecond
)

// Endpoint is one side of a transfer, already resolved by app.go: Local uses
// the machine's own filesystem, otherwise DSN is the decrypted SSH DSN for the
// remote host (never seen by the frontend).
type Endpoint struct {
	Local bool
	DSN   string
}

// Item is one thing the user asked to transfer — a file or a directory (which
// is walked recursively).
type Item struct {
	Path  string `json:"path"`
	IsDir bool   `json:"isDir"`
}

// Request is a resolved transfer job. ID doubles as the Wails event name the
// frontend subscribes to (EventsOn(ID, ...)) before StartTransfer, same
// race-avoidance contract as the SSH terminal / query execution.
type Request struct {
	ID     string
	Src    Endpoint
	Dst    Endpoint
	DstDir string
	Items  []Item
}

// ProgressEvent is emitted on the transfer's ID-named event. One "start", many
// throttled "progress"/"file-done", then exactly one terminal event
// ("done" | "error" | "cancelled").
type ProgressEvent struct {
	Type       string `json:"type"`
	FileName   string `json:"fileName,omitempty"`
	FilesDone  int64  `json:"filesDone"`
	TotalFiles int    `json:"totalFiles"`
	BytesDone  int64  `json:"bytesDone"`
	BytesTotal int64  `json:"bytesTotal"`
	Percent    int    `json:"percent"`
	Error      string `json:"error,omitempty"`
}

// TransferManager owns every in-flight transfer, keyed by ID, so any of them
// can be cancelled individually or all torn down on shutdown.
type TransferManager struct {
	mu        sync.Mutex
	transfers map[string]*transfer
	emit      EmitFunc
}

func NewTransferManager(emit EmitFunc) *TransferManager {
	return &TransferManager{transfers: make(map[string]*transfer), emit: emit}
}

type fileJob struct {
	srcPath string
	rel     []string // path components under DstDir, so the dest tree mirrors the source
	size    int64
}

type transfer struct {
	id     string
	ctx    context.Context
	cancel context.CancelFunc
	emit   EmitFunc
	mgr    *TransferManager

	src fileSystem
	dst fileSystem

	dstDir     string
	jobs       []fileJob
	totalFiles int
	bytesTotal int64

	bytesDone int64 // atomic
	filesDone int64 // atomic

	mu           sync.Mutex
	lastEmit     time.Time
	terminal     bool
	errMsg       string
	userCanceled bool
}

// Start resolves both endpoints (dialing dedicated connections isolated from
// the browse panes), enumerates the work, and runs the transfer in the
// background. It returns after enumeration so the binding call is quick; all
// further status flows through emitted ProgressEvents. Any setup failure is
// reported both as a returned error and as an "error" terminal event.
func (m *TransferManager) Start(req Request) error {
	if req.ID == "" {
		return fmt.Errorf("sftpx: falta el id de la transferencia")
	}

	src, err := openEndpoint(req.Src)
	if err != nil {
		m.emit(req.ID, ProgressEvent{Type: "error", Error: err.Error()})
		return err
	}
	dst, err := openEndpoint(req.Dst)
	if err != nil {
		src.Close()
		m.emit(req.ID, ProgressEvent{Type: "error", Error: err.Error()})
		return err
	}

	ctx, cancel := context.WithCancel(context.Background())
	t := &transfer{
		id: req.ID, ctx: ctx, cancel: cancel, emit: m.emit, mgr: m,
		src: src, dst: dst, dstDir: req.DstDir,
	}

	if err := t.enumerate(req.Items); err != nil {
		cancel()
		src.Close()
		dst.Close()
		m.emit(req.ID, ProgressEvent{Type: "error", Error: err.Error()})
		return err
	}
	t.totalFiles = len(t.jobs)

	m.mu.Lock()
	m.transfers[req.ID] = t
	m.mu.Unlock()

	// If a dialed connection drops, cancel the transfer promptly instead of
	// letting a worker block forever on a dead socket — the watcher exits
	// cleanly once the connection is closed normally at cleanup too.
	watchConn(src, t.failConn)
	watchConn(dst, t.failConn)

	go t.run()
	return nil
}

// Cancel requests cancellation of a running transfer. Marks it user-initiated
// so the terminal event is "cancelled" rather than "error".
func (m *TransferManager) Cancel(id string) error {
	m.mu.Lock()
	t := m.transfers[id]
	m.mu.Unlock()
	if t == nil {
		return fmt.Errorf("sftpx: no hay una transferencia activa con id %q", id)
	}
	t.mu.Lock()
	t.userCanceled = true
	t.mu.Unlock()
	t.cancel()
	return nil
}

// CancelAll cancels every in-flight transfer — used on app shutdown. Does not
// wait; each transfer's own cleanup closes its connections.
func (m *TransferManager) CancelAll() {
	m.mu.Lock()
	transfers := make([]*transfer, 0, len(m.transfers))
	for _, t := range m.transfers {
		transfers = append(transfers, t)
	}
	m.mu.Unlock()
	for _, t := range transfers {
		t.cancel()
	}
}

func openEndpoint(e Endpoint) (fileSystem, error) {
	if e.Local {
		return newLocalFS(), nil
	}
	return dialRemote(e.DSN)
}

// watchConn cancels the transfer if a remote connection closes underneath it.
// Only remote endpoints have a connection to watch; local ones are skipped.
func watchConn(fs fileSystem, onLost func()) {
	r, ok := fs.(*remoteFS)
	if !ok {
		return
	}
	go func() {
		// ssh.Client.Wait blocks until the connection is torn down — whether by
		// the remote host dropping it or by our own Close() at cleanup. In both
		// cases we signal; failConn is a no-op once the transfer is terminal, so
		// a normal close does not produce a spurious error event.
		_ = r.ssh.Wait()
		onLost()
	}()
}

// enumerate walks the requested items into a flat list of file jobs and the
// total byte count, so progress can be reported as a real percentage. Empty
// directories are not recreated on the destination (v1) — files carry their
// parent directories via Create's MkdirAll.
func (t *transfer) enumerate(items []Item) error {
	for _, it := range items {
		base := t.src.Base(it.Path)
		if err := t.walk(it.Path, it.IsDir, []string{base}); err != nil {
			return err
		}
	}
	return nil
}

func (t *transfer) walk(p string, isDir bool, rel []string) error {
	if t.ctx.Err() != nil {
		return t.ctx.Err()
	}
	if !isDir {
		info, err := t.src.Stat(p)
		if err != nil {
			return err
		}
		t.jobs = append(t.jobs, fileJob{srcPath: p, rel: rel, size: info.Size})
		t.bytesTotal += info.Size
		return nil
	}
	entries, err := t.src.ReadDir(p)
	if err != nil {
		return err
	}
	for _, e := range entries {
		childRel := append(append([]string{}, rel...), e.Name)
		if e.IsDir {
			if err := t.walk(e.Path, true, childRel); err != nil {
				return err
			}
			continue
		}
		t.jobs = append(t.jobs, fileJob{srcPath: e.Path, rel: childRel, size: e.Size})
		t.bytesTotal += e.Size
	}
	return nil
}

func (t *transfer) run() {
	defer t.cleanup()

	t.emit(t.id, t.snapshot("start", ""))

	jobs := make(chan fileJob)
	var wg sync.WaitGroup
	workers := defaultWorkers
	if t.totalFiles < workers {
		workers = t.totalFiles
	}
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for job := range jobs {
				if t.ctx.Err() != nil {
					continue // drain the channel without doing work after cancel/error
				}
				if err := t.transferOne(job); err != nil {
					t.fail(err)
				}
			}
		}()
	}

	for _, job := range t.jobs {
		select {
		case <-t.ctx.Done():
			// stop feeding; workers drain and exit
			goto feedDone
		case jobs <- job:
		}
	}
feedDone:
	close(jobs)
	wg.Wait()

	t.finish()
}

func (t *transfer) transferOne(job fileJob) error {
	in, err := t.src.Open(job.srcPath)
	if err != nil {
		return err
	}
	defer in.Close()

	dstPath := t.dst.Join(append([]string{t.dstDir}, job.rel...)...)
	out, err := t.dst.Create(dstPath)
	if err != nil {
		return err
	}

	name := job.rel[len(job.rel)-1]
	if err := t.copy(out, in, name); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	atomic.AddInt64(&t.filesDone, 1)
	t.emit(t.id, t.snapshot("file-done", name))
	return nil
}

// copy streams src→dst in bounded chunks, checking the transfer context
// between chunks so a cancel (or a dropped connection, which cancels the
// context via watchConn) stops promptly instead of after the whole file.
func (t *transfer) copy(dst io.Writer, src io.Reader, name string) error {
	buf := make([]byte, copyChunkSize)
	for {
		select {
		case <-t.ctx.Done():
			return t.ctx.Err()
		default:
		}
		n, rerr := src.Read(buf)
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return werr
			}
			done := atomic.AddInt64(&t.bytesDone, int64(n))
			t.maybeEmitProgress(name, done)
		}
		if rerr == io.EOF {
			return nil
		}
		if rerr != nil {
			return rerr
		}
	}
}

func (t *transfer) maybeEmitProgress(name string, bytesDone int64) {
	t.mu.Lock()
	now := time.Now()
	if now.Sub(t.lastEmit) < progressInterval {
		t.mu.Unlock()
		return
	}
	t.lastEmit = now
	t.mu.Unlock()
	t.emit(t.id, t.snapshot("progress", name))
}

// fail records the first error and cancels the transfer; later errors from
// other workers reacting to the cancellation are ignored.
func (t *transfer) fail(err error) {
	t.mu.Lock()
	if t.errMsg == "" && !t.userCanceled {
		t.errMsg = err.Error()
	}
	t.mu.Unlock()
	t.cancel()
}

// failConn is the connection-lost hook. It records a clear error unless the
// transfer already finished or was cancelled by the user (a normal Close()
// also triggers this path).
func (t *transfer) failConn() {
	t.mu.Lock()
	if t.terminal || t.userCanceled || t.errMsg != "" {
		t.mu.Unlock()
		return
	}
	t.mu.Unlock()
	t.fail(fmt.Errorf("sftpx: se perdió la conexión con el host"))
}

// finish emits exactly one terminal event based on how the run ended.
func (t *transfer) finish() {
	t.mu.Lock()
	switch {
	case t.userCanceled:
		t.emitTerminalLocked("cancelled", "")
	case t.errMsg != "":
		t.emitTerminalLocked("error", t.errMsg)
	default:
		t.emitTerminalLocked("done", "")
	}
	t.mu.Unlock()
}

// emitTerminalLocked emits the terminal event once; must hold t.mu.
func (t *transfer) emitTerminalLocked(evType, errMsg string) {
	if t.terminal {
		return
	}
	t.terminal = true
	t.emit(t.id, ProgressEvent{
		Type:       evType,
		FilesDone:  atomic.LoadInt64(&t.filesDone),
		TotalFiles: t.totalFiles,
		BytesDone:  atomic.LoadInt64(&t.bytesDone),
		BytesTotal: t.bytesTotal,
		Percent:    t.percent(),
		Error:      errMsg,
	})
}

func (t *transfer) snapshot(evType, name string) ProgressEvent {
	return ProgressEvent{
		Type:       evType,
		FileName:   name,
		FilesDone:  atomic.LoadInt64(&t.filesDone),
		TotalFiles: t.totalFiles,
		BytesDone:  atomic.LoadInt64(&t.bytesDone),
		BytesTotal: t.bytesTotal,
		Percent:    t.percent(),
	}
}

func (t *transfer) percent() int {
	if t.bytesTotal <= 0 {
		return 100
	}
	p := int(atomic.LoadInt64(&t.bytesDone) * 100 / t.bytesTotal)
	if p > 100 {
		p = 100
	}
	return p
}

// cleanup runs after every worker has returned (wg.Wait in run) — so closing
// the connections can never race a goroutine still reading/writing them. This
// is what guarantees no zombie goroutines or half-open connections survive a
// finished, cancelled, or failed transfer.
func (t *transfer) cleanup() {
	t.cancel() // release the context in every exit path
	t.src.Close()
	t.dst.Close()
	t.mgr.mu.Lock()
	delete(t.mgr.transfers, t.id)
	t.mgr.mu.Unlock()
}
