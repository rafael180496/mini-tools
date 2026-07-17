// Package sftpx is the file-transfer parallel path over SSH — the same kind
// of deliberate, documented native path as backend/redisquery (Redis) and
// backend/sshconn (interactive terminal): an SFTP browse/transfer is not a
// database/sql connection, so it does not go through db.PoolManager. It dials
// through sshconn.Dial (reusing that package's DSN parsing + auth + the
// InsecureIgnoreHostKey tradeoff) and speaks SFTP via github.com/pkg/sftp
// (pure-Go, no cgo).
//
// Two managers live here, both stateful and explicitly torn down:
//   - BrowseManager  — one persistent SFTP session per file-explorer pane, so
//     changing directory does not re-dial. A "local" sentinel session serves
//     the user's own machine via os.* through the same interface.
//   - TransferManager — bounded worker-pool file transfers (local↔remote and
//     remote↔remote) with per-transfer context cancellation, progress events,
//     and connections dedicated to the transfer (isolated from browse panes so
//     closing an explorer never kills an in-flight transfer, and vice versa).
package sftpx

import (
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"mini-tools/backend/sshconn"
)

// FileEntry is one directory entry, uniform across local and remote panes.
// Path is absolute (POSIX-joined for remote, OS-joined for local) so the
// frontend can navigate without knowing which side it is on.
type FileEntry struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	IsDir   bool   `json:"isDir"`
	Mode    string `json:"mode"`    // e.g. "drwxr-xr-x" / "-rw-r--r--"
	ModTime int64  `json:"modTime"` // unix seconds
}

// PermInfo is the detail behind the "Editar permisos" dialog: the POSIX
// permission bits (owner/group/other × rwx) plus a best-effort display of the
// owner. Ownership is display-only — SFTP exposes it as numeric UID/GID (shown
// as-is), and only the local machine can resolve those to names; changing
// ownership (chown) is deliberately out of scope (fragile over SFTP, usually
// needs root).
type PermInfo struct {
	Path  string `json:"path"`
	Mode  int    `json:"mode"` // permission bits only, 0..0o777
	IsDir bool   `json:"isDir"`
	Owner string `json:"owner"` // name (local) or UID (remote); "" if unknown
	Group string `json:"group"` // name (local) or GID (remote); "" if unknown
}

// fileSystem is the minimal surface both browsing and transfers need,
// implemented once for the local machine (os.*) and once per remote SFTP
// client. Keeping it small means the transfer engine is written exactly once
// and works for every source→dest combination.
type fileSystem interface {
	ReadDir(dir string) ([]FileEntry, error)
	Stat(p string) (FileEntry, error)
	Home() (string, error)
	MkdirAll(dir string) error
	Remove(p string) error // recursive for directories
	Rename(oldPath, newPath string) error
	Chmod(p string, mode os.FileMode) error
	PermInfo(p string) (PermInfo, error)
	Open(p string) (io.ReadCloser, error)
	Create(p string) (io.WriteCloser, error) // creates parent dirs
	Base(p string) string
	Join(elem ...string) string
	Close() error
}

func sortEntries(entries []FileEntry) {
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir // directories first
		}
		return entries[i].Name < entries[j].Name
	})
}

// --- local machine ---------------------------------------------------------

type localFS struct{}

func newLocalFS() fileSystem { return localFS{} }

func (localFS) ReadDir(dir string) ([]FileEntry, error) {
	raw, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := make([]FileEntry, 0, len(raw))
	for _, e := range raw {
		info, err := e.Info()
		if err != nil {
			continue // skip entries we can't stat rather than failing the whole listing
		}
		out = append(out, FileEntry{
			Name:    e.Name(),
			Path:    filepath.Join(dir, e.Name()),
			Size:    info.Size(),
			IsDir:   info.IsDir(),
			Mode:    info.Mode().String(),
			ModTime: info.ModTime().Unix(),
		})
	}
	sortEntries(out)
	return out, nil
}

func (localFS) Stat(p string) (FileEntry, error) {
	info, err := os.Stat(p)
	if err != nil {
		return FileEntry{}, err
	}
	return FileEntry{
		Name:    info.Name(),
		Path:    p,
		Size:    info.Size(),
		IsDir:   info.IsDir(),
		Mode:    info.Mode().String(),
		ModTime: info.ModTime().Unix(),
	}, nil
}

func (localFS) Home() (string, error)                  { return os.UserHomeDir() }
func (localFS) MkdirAll(dir string) error              { return os.MkdirAll(dir, 0o755) }
func (localFS) Remove(p string) error                  { return os.RemoveAll(p) }
func (localFS) Rename(o, n string) error               { return os.Rename(o, n) }
func (localFS) Chmod(p string, mode os.FileMode) error { return os.Chmod(p, mode) }
func (localFS) Open(p string) (io.ReadCloser, error)   { return os.Open(p) }
func (localFS) Base(p string) string                   { return filepath.Base(p) }
func (localFS) Join(elem ...string) string             { return filepath.Join(elem...) }
func (localFS) Close() error                           { return nil }

func (localFS) PermInfo(p string) (PermInfo, error) {
	info, err := os.Stat(p)
	if err != nil {
		return PermInfo{}, err
	}
	owner, group := localOwner(info) // platform-specific (fs_owner_*.go)
	return PermInfo{
		Path:  p,
		Mode:  int(info.Mode().Perm()),
		IsDir: info.IsDir(),
		Owner: owner,
		Group: group,
	}, nil
}

func (localFS) Create(p string) (io.WriteCloser, error) {
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return nil, err
	}
	return os.Create(p)
}

// --- remote host over SFTP -------------------------------------------------

type remoteFS struct {
	ssh  *ssh.Client
	sftp *sftp.Client
}

// dialRemote opens a fresh SSH connection for dsn and an SFTP subsystem over
// it. The caller owns the result and must Close() it (which tears down both
// the SFTP client and the underlying SSH connection).
func dialRemote(dsn string) (*remoteFS, error) {
	client, err := sshconn.Dial(dsn)
	if err != nil {
		return nil, err
	}
	sc, err := sftp.NewClient(client)
	if err != nil {
		client.Close()
		return nil, err
	}
	return &remoteFS{ssh: client, sftp: sc}, nil
}

func (r *remoteFS) ReadDir(dir string) ([]FileEntry, error) {
	infos, err := r.sftp.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := make([]FileEntry, 0, len(infos))
	for _, fi := range infos {
		out = append(out, FileEntry{
			Name:    fi.Name(),
			Path:    r.sftp.Join(dir, fi.Name()),
			Size:    fi.Size(),
			IsDir:   fi.IsDir(),
			Mode:    fi.Mode().String(),
			ModTime: fi.ModTime().Unix(),
		})
	}
	sortEntries(out)
	return out, nil
}

func (r *remoteFS) Stat(p string) (FileEntry, error) {
	fi, err := r.sftp.Stat(p)
	if err != nil {
		return FileEntry{}, err
	}
	return FileEntry{
		Name:    fi.Name(),
		Path:    p,
		Size:    fi.Size(),
		IsDir:   fi.IsDir(),
		Mode:    fi.Mode().String(),
		ModTime: fi.ModTime().Unix(),
	}, nil
}

// Home returns the working directory the server placed us in right after
// login — for OpenSSH that is the user's home directory.
func (r *remoteFS) Home() (string, error) { return r.sftp.Getwd() }

func (r *remoteFS) MkdirAll(dir string) error              { return r.sftp.MkdirAll(dir) }
func (r *remoteFS) Rename(o, n string) error               { return r.sftp.Rename(o, n) }
func (r *remoteFS) Chmod(p string, mode os.FileMode) error { return r.sftp.Chmod(p, mode) }
func (r *remoteFS) Base(p string) string                   { return path.Base(p) }

// PermInfo reads mode + ownership. SFTP only exposes ownership as numeric
// UID/GID (via FileStat), so those are shown as-is — there is no name lookup
// over SFTP without reading the remote /etc/passwd.
func (r *remoteFS) PermInfo(p string) (PermInfo, error) {
	fi, err := r.sftp.Stat(p)
	if err != nil {
		return PermInfo{}, err
	}
	var owner, group string
	if st, ok := fi.Sys().(*sftp.FileStat); ok {
		owner = strconv.FormatUint(uint64(st.UID), 10)
		group = strconv.FormatUint(uint64(st.GID), 10)
	}
	return PermInfo{
		Path:  p,
		Mode:  int(fi.Mode().Perm()),
		IsDir: fi.IsDir(),
		Owner: owner,
		Group: group,
	}, nil
}
func (r *remoteFS) Join(elem ...string) string {
	return r.sftp.Join(elem...)
}

func (r *remoteFS) Open(p string) (io.ReadCloser, error) { return r.sftp.Open(p) }

func (r *remoteFS) Create(p string) (io.WriteCloser, error) {
	if err := r.sftp.MkdirAll(path.Dir(p)); err != nil {
		return nil, err
	}
	return r.sftp.Create(p)
}

// Remove deletes p recursively — SFTP's RemoveDirectory only removes empty
// directories, so children are cleared bottom-up first.
func (r *remoteFS) Remove(p string) error {
	fi, err := r.sftp.Stat(p)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return r.sftp.Remove(p)
	}
	entries, err := r.sftp.ReadDir(p)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if err := r.Remove(r.sftp.Join(p, e.Name())); err != nil {
			return err
		}
	}
	return r.sftp.RemoveDirectory(p)
}

func (r *remoteFS) Close() error {
	sftpErr := r.sftp.Close()
	sshErr := r.ssh.Close()
	if sftpErr != nil {
		return sftpErr
	}
	return sshErr
}
