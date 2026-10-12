package workspace

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"mini-tools/backend/i18n"
)

// maxGlobResults acota cuántas rutas devuelve glob. Más que esto no es una
// respuesta que el modelo pueda usar: es una señal de que el patrón es muy
// ancho, y la nota del final se lo dice.
const maxGlobResults = 200

// glob busca archivos por nombre. Comparte con search la lista de candidatos
// (candidateFiles): `git ls-files` en un repositorio —que respeta el
// .gitignore de verdad— y un recorrido que salta las carpetas pesadas en una
// carpeta cualquiera. Así las dos herramientas "ven" los mismos archivos.
//
// Devuelve rutas relativas a la RAÍZ y no a `path`: es lo que el modelo le
// pasa después a read_file, y una ruta relativa a otra carpeta lo obligaría a
// recomponerla.
func (w *Workspace) glob(ctx context.Context, args map[string]any) (string, error) {
	pattern := strings.TrimSpace(filepath.ToSlash(strArg(args, "pattern")))
	pattern = strings.TrimPrefix(pattern, "./")
	if pattern == "" {
		return "", missing("pattern")
	}
	if strings.HasPrefix(pattern, "/") {
		return "", i18n.Errorf(i18n.Msg{
			ES: "el patrón tiene que ser relativo (por ejemplo «**/*.go»); para otra carpeta usá el argumento path",
			EN: "the pattern must be relative (for example “**/*.go”); for another folder use the path argument",
		})
	}
	// Sin «/» se busca por nombre en cualquier profundidad, como hace ripgrep
	// con -g: «*.go» es lo que casi todos los modelos escriben cuando quieren
	// «todos los .go».
	if !strings.Contains(pattern, "/") {
		pattern = "**/" + pattern
	}
	re, err := globRegexp(pattern)
	if err != nil {
		return "", err
	}

	abs, rel, err := w.resolve(strArg(args, "path"))
	if err != nil {
		return "", err
	}
	fi, err := os.Stat(abs)
	if err != nil {
		return "", i18n.Errorf(i18n.Msg{ES: "no se pudo buscar en %q: %w", EN: "could not search in %q: %w"}, rel, err)
	}
	if !fi.IsDir() {
		return "", i18n.Errorf(i18n.Msg{ES: "%q no es un directorio", EN: "%q is not a directory"}, rel)
	}

	prefix := ""
	if rel != "." {
		prefix = rel + "/"
	}
	files := w.candidateFiles(ctx, abs, rel)
	var matched []string
	for _, f := range files {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		sub := f
		if prefix != "" {
			if !strings.HasPrefix(f, prefix) {
				continue
			}
			sub = strings.TrimPrefix(f, prefix)
		}
		if !re.MatchString(sub) {
			continue
		}
		// Como en search: solo archivos regulares. La lista de git incluye los
		// borrados sin commitear y los enlaces pueden apuntar afuera.
		info, err := os.Lstat(filepath.Join(w.root, filepath.FromSlash(f)))
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		matched = append(matched, f)
	}
	if len(matched) == 0 {
		return i18n.T(i18n.Msg{ES: "Sin archivos que coincidan (%d archivos revisados).", EN: "No matching files (%d files checked)."}, len(files)), nil
	}
	sort.Strings(matched)
	var b strings.Builder
	shown := matched
	if len(shown) > maxGlobResults {
		shown = shown[:maxGlobResults]
	}
	for _, f := range shown {
		b.WriteString(f)
		b.WriteByte('\n')
	}
	if len(matched) > len(shown) {
		b.WriteString(i18n.T(i18n.Msg{
			ES: "[se muestran %d de %d archivos: afiná el patrón o la carpeta]",
			EN: "[showing %d of %d files: narrow the pattern or the folder]",
		}, len(shown), len(matched)))
	}
	return b.String(), nil
}

// globRegexp traduce un glob a una expresión regular anclada. Entiende «*»
// (cualquier cosa menos «/»), «?» (un carácter que no sea «/»), «**» (cualquier
// cosa, incluido «/»; seguido de «/» admite también cero carpetas), «[a-z]» y
// «[!a-z]» (clases), «{a,b}» (alternativas) y «\x» (el carácter x, literal).
//
// Se escribe a mano y no con filepath.Match porque este no entiende «**» ni
// las llaves, que son justo lo que los modelos usan.
func globRegexp(p string) (*regexp.Regexp, error) {
	var b strings.Builder
	b.WriteString("(?s)^")
	braces := 0
	for i := 0; i < len(p); i++ {
		c := p[i]
		switch c {
		case '*':
			if i+1 < len(p) && p[i+1] == '*' {
				j := i + 2
				if j < len(p) && p[j] == '/' {
					b.WriteString("(?:.*/)?")
					i = j
					continue
				}
				b.WriteString(".*")
				i = j - 1
				continue
			}
			b.WriteString("[^/]*")
		case '?':
			b.WriteString("[^/]")
		case '[':
			end := strings.IndexByte(p[i+1:], ']')
			if end <= 0 {
				b.WriteString(`\[`)
				continue
			}
			class := p[i+1 : i+1+end]
			neg := false
			if strings.HasPrefix(class, "!") || strings.HasPrefix(class, "^") {
				neg, class = true, class[1:]
			}
			class = strings.NewReplacer(`\`, `\\`, `]`, `\]`, `[`, `\[`).Replace(class)
			if neg {
				b.WriteString("[^/" + class + "]")
			} else {
				b.WriteString("[" + class + "]")
			}
			i += end + 1
		case '{':
			braces++
			b.WriteString("(?:")
		case '}':
			if braces == 0 {
				b.WriteString(`\}`)
				continue
			}
			braces--
			b.WriteString(")")
		case ',':
			if braces > 0 {
				b.WriteString("|")
			} else {
				b.WriteString(",")
			}
		case '\\':
			if i+1 < len(p) {
				i++
				b.WriteString(regexp.QuoteMeta(string(p[i])))
			}
		default:
			b.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	if braces != 0 {
		return nil, i18n.Errorf(i18n.Msg{ES: "el patrón tiene llaves sin cerrar", EN: "the pattern has unclosed braces"})
	}
	b.WriteString("$")
	re, err := regexp.Compile(b.String())
	if err != nil {
		return nil, i18n.Errorf(i18n.Msg{ES: "el patrón glob no es válido: %w", EN: "the glob pattern is not valid: %w"}, err)
	}
	return re, nil
}
