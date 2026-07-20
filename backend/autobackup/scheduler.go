// Package autobackup runs a periodic, unattended backup of the vault while
// the app is open — see backend/vault/backup.go's Backup, which this
// package calls directly. Its own package (not inline in app.go) per the
// project's "non-trivial domain logic gets its own backend/<name>/"
// convention.
package autobackup

import (
	"context"
	"path/filepath"
	"sync"
	"time"

	"mini-tools/backend/vault"
)

// FileName is the FIXED name written inside the configured folder — every
// run overwrites this same file, unlike the manual backup (BackupVault),
// which stamps a timestamp into the filename and therefore accumulates one
// file per run.
const FileName = "mini-tools-auto-backup.mtbackup"

// Scheduler is the background ticker that calls vault.Store.Backup every
// so many hours.
type Scheduler struct {
	store *vault.Store

	// mu guards only the cancellation bookkeeping — Reconfigure/Stop must
	// return control right away even if a backup is in flight, so mu never
	// holds the (potentially slow) call to store.Backup. That's backupMu's
	// job.
	mu     sync.Mutex
	cancel context.CancelFunc

	// backupMu serializes the actual store.Backup calls across
	// "generations" — Reconfigure always starts a new goroutine before the
	// previous one has necessarily observed ctx.Done(), so without this
	// mutex a config change landing right at tick time could leave two
	// goroutines writing the same destination file at once (a corrupt zip
	// from interleaved writes). This mutex only adds a short wait for the
	// previous write to finish; it doesn't change which folder/interval
	// wins from here on.
	backupMu sync.Mutex
}

// New wraps store — the caller (App.startup) owns the Scheduler's lifetime.
func New(store *vault.Store) *Scheduler {
	return &Scheduler{store: store}
}

// Reconfigure (re)starts or stops the background loop based on
// enabled/intervalHours/dir. Safe to call repeatedly and from multiple
// goroutines (every SettingsDialog change calls this) — it always stops the
// current generation first, and only starts a new one if every value is
// valid. Never returns an error: an invalid combination (disabled, no
// folder chosen yet, or an out-of-range interval — the latter should
// already be impossible thanks to vault.Store.SetAutoBackupIntervalHours's
// validation; this is just the last line of defense against handing
// time.NewTicker a non-positive duration, which panics) simply leaves the
// scheduler stopped.
func (s *Scheduler) Reconfigure(enabled bool, intervalHours int, dir string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}

	if !enabled || dir == "" ||
		intervalHours < vault.MinAutoBackupIntervalHours ||
		intervalHours > vault.MaxAutoBackupIntervalHours {
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	go s.run(ctx, time.Duration(intervalHours)*time.Hour, dir)
}

// Stop halts the background loop, if one is running — called from
// App.shutdown before the vault starts closing, so no tick can race the
// final Close.
func (s *Scheduler) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
}

// run is one generation's loop. It backs up immediately on start, in
// addition to once per interval afterward — mini-tools is a desktop app
// that isn't necessarily left open uninterrupted, and since there's no
// "last backup" persisted anywhere, waiting a full interval within a
// single process run could mean a short session never produces any
// automatic backup at all. This immediate run is harmless precisely because
// FileName is fixed: at worst the snapshot ends up a few ticks "fresher"
// than strictly necessary, never a cost that accumulates.
func (s *Scheduler) run(ctx context.Context, interval time.Duration, dir string) {
	s.backupOnce(dir)

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.backupOnce(dir)
		}
	}
}

func (s *Scheduler) backupOnce(dir string) {
	s.backupMu.Lock()
	defer s.backupMu.Unlock()

	dest := filepath.Join(dir, FileName)
	// Best-effort, same reasoning as the history sink in App.startup: a
	// failed automatic backup (e.g. the folder was a USB drive that's no
	// longer plugged in) shouldn't interrupt anything — it just retries
	// next interval.
	_ = s.store.Backup(dest)
}
