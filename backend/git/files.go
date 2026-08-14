package git

import (
	"bytes"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Listar, leer y escribir archivos del ÁRBOL DE TRABAJO, para editarlos dentro
// de la app en vez de saltar a un editor externo.
//
// Hasta acá el módulo Git solo sabía leer archivos en dos formas muy acotadas:
// GetFileAtCommit (una versión histórica, para mostrar) y ReadConflictFile /
// ResolveConflictFile (un archivo en conflicto, con sus marcadores). Ninguna
// de las dos sirve para "abrí este archivo y editalo": la primera es de solo
// lectura por definición y la segunda solo existe mientras hay un merge a
// medias.
//
// El contrato de lectura/escritura es deliberadamente el mismo que el de
// sftpx.ReadFileForEdit / WriteFileFromEdit: contenido en memoria, mtime al
// leer para detectar que alguien más tocó el archivo, y binario/demasiado
// grande REPORTADOS en vez de devueltos como error, para que la UI pueda
// explicar por qué no lo abre en lugar de fallar sin decir nada. Son el mismo
// problema — un archivo que se edita en un buffer de la app — y dos contratos
// distintos obligarían a escribir dos veces el mismo diálogo de conflicto.

const (
	// maxEditableBytes limita lo que se carga en un buffer del editor. Abrir
	// un log de un giga en un editor de texto no es una feature; sin tope, el
	// modo de fallo es la app entera congelada mientras lee.
	maxEditableBytes = 4 << 20 // 4 MiB
	// binarySniffBytes es cuánto del comienzo se mira para decidir si esto es
	// texto.
	binarySniffBytes = 8000
	// maxWorkTreeEntries acota el listado. Un monorepo con cientos de miles de
	// archivos versionados no se navega en un árbol, y mandarlos todos al
	// frontend congela el render mucho antes de que sirvan de algo.
	maxWorkTreeEntries = 50000
)

// WorkTree es el listado plano de archivos editables del árbol de trabajo.
//
// Plano y no anidado a propósito: el frontend ya arma árboles a partir de
// listas planas (lib/folderTree.ts para las carpetas, lib/branchTree.ts para
// las ramas), y construir acá un tercer formato de árbol solo agregaría una
// forma más que mantener en sincronía con las otras dos.
type WorkTree struct {
	// Files son rutas relativas a la raíz del repositorio, con "/" como
	// separador en todas las plataformas — es lo que devuelve git y lo que el
	// resto del módulo ya usa.
	Files []string `json:"files"`
	// Truncated avisa que se llegó al tope y el listado está incompleto. Se
	// informa en vez de silenciarse: un árbol al que le faltan archivos sin
	// decirlo es peor que uno que avisa que le faltan.
	Truncated bool `json:"truncated"`
}

// WorkFile es el contenido de un archivo más lo necesario para guardarlo sin
// pisar el trabajo de otro. Mismos nombres de campo que sftpx.RemoteFile: el
// editor del frontend es el mismo widget para un archivo local y uno remoto.
type WorkFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Size    int64  `json:"size"`
	// ModTimeUnix es la fecha de modificación AL LEER. Vuelve al guardar para
	// detectar que el archivo cambió abajo mientras estaba abierto.
	ModTimeUnix int64 `json:"modTimeUnix"`
	// Binary marca que el contenido no es texto; Content queda vacío.
	Binary bool `json:"binary"`
	// TooLarge marca que supera el tope editable; Content queda vacío.
	TooLarge bool `json:"tooLarge"`
}

// ErrWorkFileChanged se devuelve cuando el archivo cambió en disco entre la
// lectura y el guardado.
var ErrWorkFileChanged = fmt.Errorf("el archivo cambió en el disco desde que lo abriste")

// ListWorkTree devuelve los archivos versionados y los no rastreados que NO
// están ignorados.
//
// `--exclude-standard` es lo que hace utilizable el listado: sin él, un
// proyecto de Node devuelve node_modules entero y el árbol deja de servir. Se
// listan también los no rastreados porque un archivo recién creado es
// exactamente el que se quiere abrir para terminarlo.
func (r *Runner) ListWorkTree(repoPath string) (WorkTree, error) {
	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return WorkTree{}, err
	}

	out, err := r.runLocal(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
	if err != nil {
		return WorkTree{}, err
	}

	// Los borrados del árbol de trabajo siguen estando en el índice, así que
	// --cached los lista igual. Abrirlos daría "no existe" desde un árbol que
	// los muestra como si estuvieran, así que se descuentan acá.
	deleted := map[string]bool{}
	if del, err := r.runLocal(root, "ls-files", "-z", "--deleted"); err == nil {
		for _, p := range splitNUL(del) {
			deleted[p] = true
		}
	}

	// Un archivo en conflicto aparece una vez por etapa (1/2/3) en --cached,
	// así que sin deduplicar el árbol lo mostraría por triplicado justo cuando
	// más molesta.
	seen := make(map[string]bool)
	tree := WorkTree{Files: make([]string, 0, 256)}
	for _, p := range splitNUL(out) {
		if p == "" || deleted[p] || seen[p] {
			continue
		}
		seen[p] = true
		if len(tree.Files) >= maxWorkTreeEntries {
			tree.Truncated = true
			break
		}
		tree.Files = append(tree.Files, p)
	}
	return tree, nil
}

// ReadWorkFile carga un archivo del árbol de trabajo para editarlo.
func (r *Runner) ReadWorkFile(repoPath, path string) (WorkFile, error) {
	full, err := r.editablePath(repoPath, path)
	if err != nil {
		return WorkFile{}, err
	}

	info, err := os.Stat(full)
	if err != nil {
		return WorkFile{}, fmt.Errorf("leyendo %q: %w", path, err)
	}
	if info.IsDir() {
		return WorkFile{}, fmt.Errorf("%q es un directorio, no un archivo", path)
	}

	out := WorkFile{Path: path, Size: info.Size(), ModTimeUnix: info.ModTime().Unix()}
	if info.Size() > maxEditableBytes {
		out.TooLarge = true
		return out, nil
	}

	data, err := os.ReadFile(full)
	if err != nil {
		return WorkFile{}, fmt.Errorf("leyendo %q: %w", path, err)
	}
	// Se vuelve a comprobar contra los bytes leídos y no solo contra el stat:
	// el archivo puede haber crecido entre una cosa y la otra.
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

// WriteWorkFile guarda el contenido editado, negándose si el archivo cambió en
// disco desde que se leyó.
//
// expectedModTimeUnix es el mtime que cargó el editor. Que no coincida
// significa que algo más escribió ahí mientras tanto — otro editor, un `git
// checkout`, el propio agente en la terminal de al lado, que en esta app es un
// caso REAL y no hipotético — y pisar eso en silencio es cómo desaparece un
// cambio ajeno sin que nadie se entere. 0 saltea la comprobación: es lo que
// manda "guardar igual" después de avisarle al usuario.
//
// Devuelve el mtime nuevo para que el siguiente guardado compare contra el
// valor correcto y no contra el de la apertura.
func (r *Runner) WriteWorkFile(repoPath, path, content string, expectedModTimeUnix int64) (int64, error) {
	full, err := r.editablePath(repoPath, path)
	if err != nil {
		return 0, err
	}

	// El modo del archivo existente se preserva: reescribir un script
	// ejecutable como 0644 lo rompe de una forma que no se nota hasta que
	// alguien lo corre. Mismo criterio que ResolveConflictFile.
	mode := os.FileMode(0o644)
	if info, err := os.Stat(full); err == nil {
		if info.IsDir() {
			return 0, fmt.Errorf("%q es un directorio, no un archivo", path)
		}
		mode = info.Mode().Perm()
		if expectedModTimeUnix != 0 && info.ModTime().Unix() != expectedModTimeUnix {
			return 0, ErrWorkFileChanged
		}
	}
	// Un stat fallido NO se trata como conflicto: el archivo puede haber sido
	// borrado, y negarse a recrearlo sería una forma rara de informarlo.

	// El directorio padre se crea si falta. Es lo que hace que "creá el
	// AGENTS.md que este repo no tiene" funcione de verdad para una ruta como
	// ".github/copilot-instructions.md" en un repositorio sin .github, en vez
	// de fallar con un error del sistema de archivos que no explica nada.
	// editablePath ya garantizó que esta ruta cae dentro del repositorio.
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return 0, fmt.Errorf("creando el directorio de %q: %w", path, err)
	}

	if err := writeFileAtomic(full, []byte(content), mode); err != nil {
		return 0, fmt.Errorf("escribiendo %q: %w", path, err)
	}

	info, err := os.Stat(full)
	if err != nil {
		return 0, nil
	}
	return info.ModTime().Unix(), nil
}

// editablePath resuelve una ruta relativa del repositorio a una ruta absoluta
// que se puede abrir para editar, o falla.
//
// Se apoya en safeWorkingPath (conflict.go), que ya resuelve la raíz del
// repositorio y rechaza rutas absolutas o que se escapen con "..", y le suma
// las dos guardas que un editor de propósito general necesita y el resolutor
// de conflictos no:
//
//   - .git queda fuera. safeWorkingPath acepta cualquier ruta dentro del
//     repositorio, y ahí adentro está .git/config y los hooks — editarlos por
//     accidente desde un árbol de archivos es una forma silenciosa de romper
//     un repositorio o de ejecutar código en el próximo commit.
//   - Los symlinks se resuelven ANTES de aprobar la ruta. La comprobación
//     puramente textual de safeWorkingPath alcanza cuando las rutas las
//     produce git (que es su caso: ConflictedFiles), pero acá la ruta puede
//     venir de lo que el frontend pida, y un symlink versionado que apunte a
//     ~/.ssh/id_rsa pasa una comprobación de prefijo sin problema.
func (r *Runner) editablePath(repoPath, path string) (string, error) {
	full, err := r.safeWorkingPath(repoPath, path)
	if err != nil {
		return "", err
	}

	root, err := r.resolveRepo(repoPath)
	if err != nil {
		return "", err
	}

	rel, err := filepath.Rel(root, full)
	if err != nil {
		return "", fmt.Errorf("la ruta %q queda fuera del repositorio", path)
	}
	if first, _, _ := strings.Cut(filepath.ToSlash(rel), "/"); first == ".git" {
		return "", fmt.Errorf("los archivos internos de git (.git/) no se editan desde acá")
	}

	// El repositorio se canonicaliza también: en macOS /tmp es un symlink a
	// /private/tmp, así que comparar una ruta ya resuelta contra una raíz sin
	// resolver rechazaría archivos perfectamente válidos.
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", fmt.Errorf("no se pudo resolver la raíz del repositorio: %w", err)
	}

	// Lo que todavía no existe no se puede resolver, así que se sube hasta el
	// ancestro más cercano que SÍ existe, se resuelve ese, y se le vuelven a
	// colgar los tramos que faltaban. Cubre los dos casos de crear algo nuevo:
	// un archivo en un directorio que ya está, y un archivo cuyo directorio
	// tampoco existe todavía (".github/copilot-instructions.md" en un repo sin
	// .github). Lo que importa para la seguridad es que el ancestro real siga
	// cayendo dentro del repositorio: si un tramo intermedio es un symlink
	// hacia afuera, se resuelve acá y la comprobación de abajo lo rechaza.
	target, missing := full, []string(nil)
	for {
		if _, err := os.Lstat(target); err == nil {
			break
		}
		parent := filepath.Dir(target)
		if parent == target {
			return "", fmt.Errorf("no se pudo resolver la ruta %q", path)
		}
		missing = append([]string{filepath.Base(target)}, missing...)
		target = parent
	}
	realTarget, err := filepath.EvalSymlinks(target)
	if err != nil {
		return "", fmt.Errorf("no se pudo resolver la ruta %q: %w", path, err)
	}
	if len(missing) > 0 {
		realTarget = filepath.Join(append([]string{realTarget}, missing...)...)
	}

	if realRel, err := filepath.Rel(realRoot, realTarget); err != nil ||
		realRel == ".." || strings.HasPrefix(realRel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("la ruta %q apunta fuera del repositorio", path)
	}
	return full, nil
}

// writeFileAtomic escribe en un temporal del MISMO directorio y renombra
// encima.
//
// El mismo directorio importa: rename solo es atómico dentro de un sistema de
// archivos, y un temporal en /tmp puede estar en otro. Lo que compra es que un
// corte a mitad de escritura deje el archivo anterior intacto en vez de uno
// truncado — que en un repositorio es un cambio que el usuario cree haber
// guardado y no está.
func writeFileAtomic(path string, data []byte, mode fs.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".mini-tools-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op si el rename ya se lo llevó

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	// Sync antes de cerrar: sin esto el rename puede completarse con los datos
	// todavía en el cache de página, y un corte de energía deja un archivo
	// nuevo y vacío donde antes había uno bueno.
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, mode); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

// looksBinary informa si data no es texto.
//
// El byte NUL es la señal que usan git y file(1), y por el mismo motivo:
// ninguna codificación de texto que este editor pueda mostrar lo contiene,
// mientras que prácticamente todo formato binario lo trae en sus primeros
// kilobytes.
func looksBinary(data []byte) bool {
	head := data
	if len(head) > binarySniffBytes {
		head = head[:binarySniffBytes]
	}
	return bytes.IndexByte(head, 0) >= 0
}
