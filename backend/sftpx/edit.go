package sftpx

import (
	"bytes"
	"fmt"
	"io"
)

// Reading and writing a remote file's contents, for editing it inside the
// app instead of downloading it, opening an external editor, and uploading
// it back by hand.
//
// Content travels through memory rather than a local temp file. The app
// already has an editor, so a temp copy would only add a lifecycle to get
// wrong — a watcher to wire, a directory to clean up on crash, and a window
// where the file on disk and the buffer on screen disagree. Nothing is
// written to the user's machine at any point.

const (
	// maxEditableBytes caps what will be loaded into an editor buffer.
	// Opening a multi-gigabyte log in a text editor is not a feature, and
	// the failure mode without a cap is the whole app freezing while it
	// reads.
	maxEditableBytes = 4 << 20 // 4 MiB
	// binarySniffBytes is how much of the head is inspected to decide
	// whether this is text at all.
	binarySniffBytes = 8000
)

// RemoteFile is a file's contents plus what is needed to save it safely.
type RemoteFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Size    int64  `json:"size"`
	// ModTimeUnix is the modification time AT READ. It is handed back on
	// save to detect that someone else changed the file meanwhile — without
	// it, saving is a blind overwrite of whatever is there now.
	ModTimeUnix int64 `json:"modTimeUnix"`
	// Binary is set when the content is not text; Content is then empty.
	// Reported rather than errored so the UI can say why instead of just
	// failing to open.
	Binary bool `json:"binary"`
	// TooLarge is set when the file exceeds the editable cap.
	TooLarge bool `json:"tooLarge"`
}

// ReadFileForEdit loads a remote file's contents.
func (m *BrowseManager) ReadFileForEdit(sessionID, path string) (RemoteFile, error) {
	fs, err := m.fsFor(sessionID)
	if err != nil {
		return RemoteFile{}, err
	}

	info, err := fs.Stat(path)
	if err != nil {
		return RemoteFile{}, err
	}
	out := RemoteFile{Path: path, Size: info.Size, ModTimeUnix: info.ModTime}

	if info.Size > maxEditableBytes {
		out.TooLarge = true
		return out, nil
	}

	rc, err := fs.Open(path)
	if err != nil {
		return RemoteFile{}, err
	}
	defer rc.Close()

	// LimitReader even though the size was already checked: the file can
	// grow between the stat and the read, and an unbounded copy of a log
	// being appended to is exactly the case that would hang.
	data, err := io.ReadAll(io.LimitReader(rc, maxEditableBytes+1))
	if err != nil {
		return RemoteFile{}, fmt.Errorf("sftpx: leyendo %q: %w", path, err)
	}
	if len(data) > maxEditableBytes {
		out.TooLarge = true
		return out, nil
	}

	if looksBinary(data) {
		out.Binary = true
		return out, nil
	}

	out.Content = string(data)
	out.Size = int64(len(data))
	return out, nil
}

// ErrRemoteFileChanged is returned when the file's modification time moved
// between reading and saving.
var ErrRemoteFileChanged = fmt.Errorf("el archivo cambió en el servidor desde que lo abriste")

// WriteFileFromEdit saves content back, refusing when the remote file
// changed since it was read.
//
// expectedModTimeUnix is the mtime the editor loaded. A mismatch means
// somebody (or something — a deploy, a log rotation, another session) wrote
// to the file meanwhile, and silently overwriting is how an unrelated change
// disappears with nobody noticing. Passing 0 skips the check, which is what
// "overwrite anyway" does after the user is told.
func (m *BrowseManager) WriteFileFromEdit(sessionID, path, content string, expectedModTimeUnix int64) (int64, error) {
	fs, err := m.fsFor(sessionID)
	if err != nil {
		return 0, err
	}

	if expectedModTimeUnix != 0 {
		info, err := fs.Stat(path)
		if err == nil && info.ModTime != expectedModTimeUnix {
			return 0, ErrRemoteFileChanged
		}
		// A stat error is NOT treated as a conflict: the file may have been
		// deleted, and refusing to recreate it would be an odd way to
		// report that.
	}

	w, err := fs.Create(path)
	if err != nil {
		return 0, err
	}
	if _, err := io.Copy(w, bytes.NewReader([]byte(content))); err != nil {
		w.Close()
		return 0, fmt.Errorf("sftpx: escribiendo %q: %w", path, err)
	}
	if err := w.Close(); err != nil {
		return 0, fmt.Errorf("sftpx: cerrando %q: %w", path, err)
	}

	// Return the new mtime so the editor can keep saving without reopening
	// — otherwise the second save of a session would always look like a
	// conflict against its own first one.
	info, err := fs.Stat(path)
	if err != nil {
		return 0, nil
	}
	return info.ModTime, nil
}

// looksBinary reports whether data is not text.
//
// A NUL byte is the signal every tool from git to file(1) uses, and for the
// same reason: no text encoding this editor can render contains one, while
// essentially every binary format does within its first few kilobytes.
func looksBinary(data []byte) bool {
	head := data
	if len(head) > binarySniffBytes {
		head = head[:binarySniffBytes]
	}
	return bytes.IndexByte(head, 0) >= 0
}
