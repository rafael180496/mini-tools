package workspace

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"mini-tools/backend/i18n"
)

// skipDirs son las carpetas que una búsqueda sin git no recorre. Es una
// heurística: con un repositorio git se usa `git ls-files`, que respeta el
// .gitignore de verdad (incluido el global y el de subcarpetas) y esto no
// corre. Sin git, estas son las que casi siempre son dependencias, builds o
// cachés y no código del usuario.
var skipDirs = map[string]bool{
	".git": true, ".hg": true, ".svn": true,
	"node_modules": true, "vendor": true, "dist": true, "build": true, "target": true,
	".next": true, ".nuxt": true, "__pycache__": true, ".venv": true, "venv": true,
	".idea": true, ".gradle": true, ".cache": true, "coverage": true,
}

// gitListTimeout acota `git ls-files`: en un monorepo enorme preferimos caer a
// la heurística antes que dejar la herramienta colgada.
const gitListTimeout = 20 * time.Second

func (w *Workspace) search(ctx context.Context, args map[string]any) (string, error) {
	pattern := strArg(args, "pattern")
	if pattern == "" {
		return "", missing("pattern")
	}
	expr := pattern
	if !boolArg(args, "regex") {
		expr = regexp.QuoteMeta(pattern)
	}
	if boolArg(args, "ignore_case") {
		expr = "(?i)" + expr
	}
	re, err := regexp.Compile(expr)
	if err != nil {
		return "", i18n.Errorf(i18n.Msg{ES: "la expresión regular no es válida: %w", EN: "the regular expression is not valid: %w"}, err)
	}
	limit := intArg(args, "max_results", maxSearchDefault)
	if limit < 1 {
		limit = maxSearchDefault
	}
	if limit > maxSearchCap {
		limit = maxSearchCap
	}
	glob := strings.TrimSpace(strArg(args, "glob"))
	if glob != "" {
		if _, err := filepath.Match(glob, "x"); err != nil {
			return "", i18n.Errorf(i18n.Msg{ES: "el filtro glob no es válido: %w", EN: "the glob filter is not valid: %w"}, err)
		}
	}

	abs, rel, err := w.resolve(strArg(args, "path"))
	if err != nil {
		return "", err
	}
	fi, err := os.Stat(abs)
	if err != nil {
		return "", i18n.Errorf(i18n.Msg{ES: "no se pudo buscar en %q: %w", EN: "could not search in %q: %w"}, rel, err)
	}

	var files []string // rutas relativas a la raíz, con `/`
	if fi.IsDir() {
		files = w.candidateFiles(ctx, abs, rel)
	} else {
		files = []string{rel}
	}

	var b strings.Builder
	matches, scanned := 0, 0
	truncated := false
files:
	for _, f := range files {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		if glob != "" && !globMatch(glob, f) {
			continue
		}
		path := filepath.Join(w.root, filepath.FromSlash(f))
		info, err := os.Lstat(path)
		// Solo archivos regulares: un enlace puede apuntar fuera de la raíz y
		// la lista de git incluye los borrados que todavía no se commitearon.
		if err != nil || !info.Mode().IsRegular() || info.Size() > maxSearchFileBytes {
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil || looksBinary(data) {
			continue
		}
		scanned++
		sc := bufio.NewScanner(bytes.NewReader(data))
		sc.Buffer(make([]byte, 0, 64*1024), maxSearchFileBytes)
		n := 0
		for sc.Scan() {
			n++
			line := sc.Text()
			if !re.MatchString(line) {
				continue
			}
			if matches >= limit {
				truncated = true
				break files
			}
			matches++
			fmt.Fprintf(&b, "%s:%d: %s\n", f, n, clip(strings.TrimSpace(line), 240))
		}
	}
	if matches == 0 {
		return i18n.T(i18n.Msg{ES: "Sin coincidencias (%d archivos revisados).", EN: "No matches (%d files searched)."}, scanned), nil
	}
	if truncated {
		b.WriteString(i18n.T(i18n.Msg{ES: "[se muestran las primeras %d coincidencias: afiná el patrón o la carpeta]", EN: "[showing the first %d matches: narrow the pattern or the folder]"}, limit))
	}
	return b.String(), nil
}

func globMatch(glob, rel string) bool {
	if strings.Contains(glob, "/") {
		ok, _ := filepath.Match(glob, rel)
		return ok
	}
	ok, _ := filepath.Match(glob, filepath.Base(rel))
	return ok
}

// candidateFiles lista los archivos bajo dir (relativo a la raíz: rel).
// Primero `git ls-files` —tracked + sin trackear que no estén ignorados—; sin
// git, o fuera de un repositorio, recorre el árbol saltando skipDirs.
func (w *Workspace) candidateFiles(ctx context.Context, dirAbs, rel string) []string {
	if files, ok := w.gitFiles(ctx, rel); ok {
		return files
	}
	var out []string
	_ = filepath.WalkDir(dirAbs, func(path string, d fs.DirEntry, err error) error {
		if err != nil || ctx.Err() != nil {
			return fs.SkipDir
		}
		if d.IsDir() {
			if path != dirAbs && skipDirs[d.Name()] {
				return fs.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		if len(out) >= maxSearchFiles {
			return fs.SkipAll
		}
		r, err := filepath.Rel(w.root, path)
		if err == nil {
			out = append(out, filepath.ToSlash(r))
		}
		return nil
	})
	return out
}

// gitFiles usa `git ls-files` para respetar el .gitignore. ok=false si la raíz
// no es un repositorio, si no hay git o si tardó demasiado.
func (w *Workspace) gitFiles(ctx context.Context, rel string) ([]string, bool) {
	if _, err := os.Lstat(filepath.Join(w.root, ".git")); err != nil {
		return nil, false
	}
	gitBin, err := exec.LookPath("git")
	if err != nil {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(ctx, gitListTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, gitBin, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", rel)
	cmd.Dir = w.root
	cmd.Env = append(env(), "GIT_OPTIONAL_LOCKS=0")
	out, err := cmd.Output()
	if err != nil {
		return nil, false
	}
	seen := map[string]bool{}
	var files []string
	for _, p := range bytes.Split(out, []byte{0}) {
		if len(p) == 0 {
			continue
		}
		s := string(p)
		if seen[s] {
			continue
		}
		seen[s] = true
		files = append(files, s)
		if len(files) >= maxSearchFiles {
			break
		}
	}
	return files, true
}
