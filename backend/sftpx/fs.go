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
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"

	"github.com/pkg/sftp"

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
		return nil, explainLocalDenial(dir, err)
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
	// lease is a borrowed reference to the SHARED SSH connection for this
	// host (backend/sshconn's pool), not a connection of our own. An SFTP
	// subsystem is just another channel on it, which is what SSH was
	// designed for — and it means closing a file pane never drops the
	// terminal that is sharing the same host.
	lease *sshconn.ClientLease
	sftp  *sftp.Client
}

// dialRemote opens a fresh SSH connection for dsn and an SFTP subsystem over
// it. The caller owns the result and must Close() it (which tears down both
// the SFTP client and the underlying SSH connection).
func dialRemote(pool *sshconn.ClientPool, connID, dsn string) (*remoteFS, error) {
	lease, err := pool.Acquire(connID, dsn)
	if err != nil {
		return nil, err
	}
	// Lecturas y escrituras concurrentes: dejan que un archivo grande viaje
	// con varias peticiones en vuelo en vez de una atrás de la otra, que es lo
	// que decide el tiempo de una transferencia sobre un enlace con latencia
	// real (el costo está en las idas y vueltas, no en el ancho de banda).
	//
	// NO se toca el tamaño de paquete, y conviene dejar escrito por qué: una
	// versión anterior de esto llamaba a sftp.MaxPacket(256*1024) creyendo que
	// bajaba la cantidad de round-trips. MaxPacket es MaxPacketChecked, que
	// RECHAZA cualquier valor mayor a 32768 con "sizes larger than 32KB might
	// not work with all servers" — así que el cliente no se creaba y el panel
	// SFTP quedaba inutilizable contra cualquier servidor. Y aun sin ese
	// error no habría servido de nada: 32768 ya es el default de la librería,
	// o sea que no había margen para subir. Existe MaxPacketUnchecked, pero
	// pasarse de 32 KB solo es seguro contra un servidor conocido y probado,
	// que no es el caso de una app que se conecta a donde el usuario diga.
	//
	// Y sobre el listado de carpetas, que era el reclamo original: SSH_FXP_READDIR
	// es secuencial por diseño (el servidor mantiene un cursor sobre el handle),
	// así que una carpeta de miles de archivos son decenas de idas y vueltas que
	// NO se pueden paralelizar desde el cliente. Esa mejora vino por el lado del
	// render y de la caché de carpetas, no del protocolo.
	sc, err := sftp.NewClient(lease.Client,
		sftp.UseConcurrentReads(true),
		sftp.UseConcurrentWrites(true),
	)
	if err != nil {
		lease.Close()
		return nil, err
	}
	return &remoteFS{lease: lease, sftp: sc}, nil
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
	// Close the subsystem channel, then let go of the shared connection.
	// Never close the client itself: someone else may still be on it.
	sftpErr := r.sftp.Close()
	r.lease.Close()
	return sftpErr
}

// explainLocalDenial traduce el "operation not permitted" de macOS.
//
// Escritorio, Documentos, Descargas, los discos externos y las carpetas
// sincronizadas están protegidos por TCC: el sistema le pregunta al usuario la
// PRIMERA vez que un programa las toca, y hasta que conteste —o si el usuario
// dijo que no— cualquier lectura vuelve con EPERM. El error de Go dice
// literalmente `open /Users/x/Downloads: operation not permitted`, que desde el
// explorador se lee como un error de la app y no como lo que es: un permiso
// que falta y que se concede en dos clics.
//
// El diálogo del sistema solo aparece si el paquete declara la cadena de uso
// correspondiente (`NSDownloadsFolderUsageDescription` y compañía en
// build/darwin/Info.plist). Sin ellas macOS deniega sin preguntar nada, que es
// exactamente el caso que motivó esto.
//
// Segundo caso, distinto y también frecuente: una compilación nueva es, para
// TCC, **otra aplicación** —el permiso se recuerda por firma, y `wails build`
// vuelve a autofirmar cada vez—, así que un permiso concedido ayer no vale para
// el binario de hoy y el sistema pregunta de nuevo.
func explainLocalDenial(dir string, err error) error {
	if runtime.GOOS != "darwin" || !errors.Is(err, fs.ErrPermission) {
		return err
	}
	return fmt.Errorf("macOS no le dio permiso a la aplicación para leer %q.\n\n"+
		"Si no apareció ningún diálogo, concedelo a mano en Ajustes del Sistema → "+
		"Privacidad y seguridad → Archivos y carpetas (o Acceso total al disco) y "+
		"volvé a abrir la app. Una versión recién compilada cuenta como una "+
		"aplicación distinta para macOS, así que el permiso hay que darlo otra vez.", dir)
}
