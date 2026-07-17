package sftpx

import (
	"fmt"
	"os"
	"sync"
)

// LocalSession is the reserved sessionID that routes browse operations to the
// user's own machine (os.*) instead of a remote SFTP client. The frontend
// passes it for the "Local" pane so every pane speaks the same binding API.
const LocalSession = "local"

// BrowseManager holds one persistent SFTP session per file-explorer pane,
// keyed by a frontend-generated paneID (sessionID). Persisting the session
// means navigating directories does not re-dial SSH on every click. The
// "local" sessionID is served without any stored session at all.
//
// It is intentionally separate from TransferManager: browse sessions are for
// the explorer only, so a slow or stuck transfer never blocks directory
// listings, and closing a pane never interrupts an in-flight transfer.
type BrowseManager struct {
	mu       sync.Mutex
	sessions map[string]*remoteFS
	local    fileSystem
}

func NewBrowseManager() *BrowseManager {
	return &BrowseManager{sessions: make(map[string]*remoteFS), local: newLocalFS()}
}

// Open dials dsn and stores the resulting SFTP session under sessionID,
// returning the remote home directory to seed the pane. Any session already
// open under sessionID is closed first (a pane switching hosts). dsn is
// resolved by app.go from an opaque connID — this package never sees the
// vault or a persisted DSN.
func (m *BrowseManager) Open(sessionID, dsn string) (string, error) {
	if sessionID == LocalSession {
		return "", fmt.Errorf("sftpx: %q está reservado para la máquina local", LocalSession)
	}
	fs, err := dialRemote(dsn)
	if err != nil {
		return "", err
	}
	home, err := fs.Home()
	if err != nil {
		fs.Close()
		return "", err
	}

	m.mu.Lock()
	old := m.sessions[sessionID]
	m.sessions[sessionID] = fs
	m.mu.Unlock()

	if old != nil {
		old.Close()
	}
	return home, nil
}

// fsFor resolves a sessionID to its filesystem — the shared local FS for the
// "local" sentinel, otherwise the pane's stored remote session.
func (m *BrowseManager) fsFor(sessionID string) (fileSystem, error) {
	if sessionID == LocalSession {
		return m.local, nil
	}
	m.mu.Lock()
	fs := m.sessions[sessionID]
	m.mu.Unlock()
	if fs == nil {
		return nil, fmt.Errorf("sftpx: no hay una sesión abierta para %q", sessionID)
	}
	return fs, nil
}

// Home returns the home/start directory for a pane (local user home, or the
// remote session's login directory).
func (m *BrowseManager) Home(sessionID string) (string, error) {
	fs, err := m.fsFor(sessionID)
	if err != nil {
		return "", err
	}
	return fs.Home()
}

func (m *BrowseManager) ListDir(sessionID, dir string) ([]FileEntry, error) {
	fs, err := m.fsFor(sessionID)
	if err != nil {
		return nil, err
	}
	if dir == "" {
		if dir, err = fs.Home(); err != nil {
			return nil, err
		}
	}
	return fs.ReadDir(dir)
}

func (m *BrowseManager) MkdirAll(sessionID, dir string) error {
	fs, err := m.fsFor(sessionID)
	if err != nil {
		return err
	}
	return fs.MkdirAll(dir)
}

func (m *BrowseManager) Remove(sessionID, p string) error {
	fs, err := m.fsFor(sessionID)
	if err != nil {
		return err
	}
	return fs.Remove(p)
}

func (m *BrowseManager) Rename(sessionID, oldPath, newPath string) error {
	fs, err := m.fsFor(sessionID)
	if err != nil {
		return err
	}
	return fs.Rename(oldPath, newPath)
}

// PermInfo returns p's permission bits + ownership for the "Editar permisos"
// dialog.
func (m *BrowseManager) PermInfo(sessionID, p string) (PermInfo, error) {
	fs, err := m.fsFor(sessionID)
	if err != nil {
		return PermInfo{}, err
	}
	return fs.PermInfo(p)
}

// Chmod sets p's permission bits (owner/group/other × rwx). mode is the raw
// 0..0o777 value the frontend builds from the toggles.
func (m *BrowseManager) Chmod(sessionID, p string, mode int) error {
	fs, err := m.fsFor(sessionID)
	if err != nil {
		return err
	}
	return fs.Chmod(p, os.FileMode(mode)&os.ModePerm)
}

// Close tears down sessionID's remote session, if any. Idempotent; the
// "local" sentinel has no session to close. Called when a pane switches hosts
// or its SFTP tab closes.
func (m *BrowseManager) Close(sessionID string) error {
	if sessionID == LocalSession {
		return nil
	}
	m.mu.Lock()
	fs := m.sessions[sessionID]
	delete(m.sessions, sessionID)
	m.mu.Unlock()
	if fs != nil {
		return fs.Close()
	}
	return nil
}

// CloseAll tears down every open browse session — used on app shutdown.
func (m *BrowseManager) CloseAll() {
	m.mu.Lock()
	sessions := m.sessions
	m.sessions = make(map[string]*remoteFS)
	m.mu.Unlock()
	for _, fs := range sessions {
		fs.Close()
	}
}
