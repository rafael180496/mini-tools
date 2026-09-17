package sftpx

import (
	"fmt"
	"os"
	"sync"
)

// What to do when a transfer would land on a name that already exists.
//
// Overwriting without asking is how a good copy gets replaced by a stale
// one, and it is unrecoverable over SFTP — there is no trash. So the
// default is to ASK, and the policies below are the answers.
const (
	// ConflictAsk means the caller has not decided yet; Start refuses
	// rather than picking for them.
	ConflictAsk = "ask"
	// ConflictOverwrite replaces unconditionally.
	ConflictOverwrite = "overwrite"
	// ConflictNewer replaces only when the SOURCE is more recently
	// modified. The safe middle ground for the common case (re-uploading a
	// build), and the one that silently does nothing when the destination
	// is already ahead.
	ConflictNewer = "newer"
	// ConflictSkip leaves the existing file untouched.
	ConflictSkip = "skip"
	// ConflictRename keeps both, adding " (1)", " (2)"… to the incoming one.
	ConflictRename = "rename"
)

// Conflict is one destination name that already exists.
type Conflict struct {
	Name string `json:"name"`
	// Src/Dst sizes and times, so the dialog can say WHICH is newer and by
	// how much instead of asking the user to decide blind.
	SrcSize    int64 `json:"srcSize"`
	DstSize    int64 `json:"dstSize"`
	SrcModTime int64 `json:"srcModTime"`
	DstModTime int64 `json:"dstModTime"`
	IsDir      bool  `json:"isDir"`
}

// conflictStatWorkers bounds how many pre-flight stats fly at once.
//
// El costo de esta comprobación son idas y vueltas, no CPU: sobre un enlace
// con 80 ms de latencia, 112 archivos en serie son dos stats cada uno —más de
// veinte segundos de pantalla quieta antes de que aparezca el diálogo—. El
// cliente SFTP multiplexa peticiones sobre el mismo canal, así que lanzarlas
// en paralelo convierte esas idas y vueltas en unas pocas tandas. 16 alcanza
// para eso sin inundar al servidor (pkg/sftp usa 64 para las lecturas de un
// archivo grande).
const conflictStatWorkers = 16

// CheckConflicts reports which of the items would overwrite something in
// dstDir.
//
// Run BEFORE the transfer starts rather than discovering collisions
// mid-copy: a dialog that appears after three of five files already
// overwrote something is not a choice, it is a notification.
func (m *TransferManager) CheckConflicts(src, dst Endpoint, dstDir string, items []Item) ([]Conflict, error) {
	srcFS, err := openEndpoint(m.pool, src)
	if err != nil {
		return nil, err
	}
	defer srcFS.Close()

	dstFS, err := openEndpoint(m.pool, dst)
	if err != nil {
		return nil, err
	}
	defer dstFS.Close()

	// Index-aligned para que el resultado conserve el orden de la selección
	// aunque las comprobaciones terminen desordenadas: el diálogo lista los
	// nombres y una lista que cambia de orden entre dos intentos no se puede
	// releer.
	found := make([]*Conflict, len(items))
	sem := make(chan struct{}, conflictStatWorkers)
	var wg sync.WaitGroup

	for i, item := range items {
		wg.Add(1)
		go func(i int, item Item) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			name := srcFS.Base(item.Path)
			target := dstFS.Join(dstDir, name)

			dstInfo, err := dstFS.Stat(target)
			if err != nil {
				// Not existing is the normal case and not an error worth
				// reporting — os.IsNotExist is not reliable across the sftp
				// client's error wrapping, so any stat failure is read as
				// "nothing there", and a real permission problem surfaces later
				// when the write itself fails, with a clearer message.
				return
			}

			c := Conflict{
				Name:       name,
				DstSize:    dstInfo.Size,
				DstModTime: dstInfo.ModTime,
				IsDir:      dstInfo.IsDir,
			}
			// El stat del origen solo se paga cuando hay colisión: es la única
			// vez que hace falta saber cuál de los dos lados es más reciente.
			if srcInfo, err := srcFS.Stat(item.Path); err == nil {
				c.SrcSize = srcInfo.Size
				c.SrcModTime = srcInfo.ModTime
			}
			found[i] = &c
		}(i, item)
	}
	wg.Wait()

	var out []Conflict
	for _, c := range found {
		if c != nil {
			out = append(out, *c)
		}
	}

	return out, nil
}

// resolveConflict decides the destination path for one item under a policy,
// or reports that it should be skipped.
//
// Returns (path, skip, error). A rename walks " (1)", " (2)"… until a free
// name is found, capped so a directory full of collisions cannot spin
// forever.
func resolveConflict(dstFS fileSystem, dstDir, name, policy string, srcModTime int64) (string, bool, error) {
	target := dstFS.Join(dstDir, name)

	existing, err := dstFS.Stat(target)
	if err != nil {
		// Nothing there: no conflict to resolve.
		return target, false, nil
	}

	switch policy {
	case ConflictOverwrite, "":
		return target, false, nil

	case ConflictSkip:
		return "", true, nil

	case ConflictNewer:
		// Skip when the destination is at least as new. Equal timestamps
		// count as "already up to date": re-uploading an identical file is
		// the case this policy exists to avoid.
		if existing.ModTime >= srcModTime {
			return "", true, nil
		}
		return target, false, nil

	case ConflictRename:
		base, ext := splitExt(name)
		for i := 1; i <= 999; i++ {
			candidate := dstFS.Join(dstDir, fmt.Sprintf("%s (%d)%s", base, i, ext))
			if _, err := dstFS.Stat(candidate); err != nil {
				return candidate, false, nil
			}
		}
		return "", false, fmt.Errorf("sftpx: no se encontró un nombre libre para %q", name)

	default:
		return "", false, fmt.Errorf("sftpx: política de conflicto desconocida: %q", policy)
	}
}

// splitExt separates "archivo.tar.gz" into "archivo.tar" and ".gz".
//
// Only the LAST extension is split off, which is what keeps a rename
// readable: "backup.tar (1).gz" would be wrong, "backup.tar (1).gz" is what
// every file manager produces for this case.
func splitExt(name string) (string, string) {
	for i := len(name) - 1; i > 0; i-- {
		if name[i] == '.' {
			return name[:i], name[i:]
		}
		if name[i] == '/' || name[i] == os.PathSeparator {
			break
		}
	}
	return name, ""
}
