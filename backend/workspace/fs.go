package workspace

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"mini-tools/backend/i18n"
)

func looksBinary(data []byte) bool {
	n := len(data)
	if n > 8192 {
		n = 8192
	}
	return bytes.IndexByte(data[:n], 0) >= 0
}

// splitLines parte un texto en líneas sin contar como línea el vacío que deja
// el salto final.
func splitLines(s string) []string {
	if s == "" {
		return nil
	}
	lines := strings.Split(s, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

func (w *Workspace) readFile(args map[string]any) (string, error) {
	p := strArg(args, "path")
	if strings.TrimSpace(p) == "" {
		return "", missing("path")
	}
	abs, rel, err := w.resolve(p)
	if err != nil {
		return "", err
	}
	if isGitConfig(rel) {
		return "", i18n.Errorf(i18n.Msg{ES: "no se lee .git/config: puede traer credenciales", EN: "reading .git/config is not allowed: it may hold credentials"})
	}
	fi, err := os.Stat(abs)
	if err != nil {
		return "", i18n.Errorf(i18n.Msg{ES: "no se pudo leer %q: %w", EN: "could not read %q: %w"}, rel, err)
	}
	if fi.IsDir() {
		return "", i18n.Errorf(i18n.Msg{ES: "%q es un directorio: usá list_dir", EN: "%q is a directory: use list_dir"}, rel)
	}
	if fi.Size() > maxFileBytes {
		return "", i18n.Errorf(i18n.Msg{ES: "%q es demasiado grande (%d MB): buscá con search", EN: "%q is too large (%d MB): use search"}, rel, fi.Size()>>20)
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return "", i18n.Errorf(i18n.Msg{ES: "no se pudo leer %q: %w", EN: "could not read %q: %w"}, rel, err)
	}
	if looksBinary(data) {
		return "", i18n.Errorf(i18n.Msg{ES: "%q es un archivo binario", EN: "%q is a binary file"}, rel)
	}

	lines := splitLines(strings.ToValidUTF8(string(data), "�"))
	total := len(lines)
	start := intArg(args, "start_line", 1)
	end := intArg(args, "end_line", total)
	if start < 1 {
		start = 1
	}
	if end > total || end < 1 {
		end = total
	}
	if total == 0 {
		return fmt.Sprintf("[%s: %s]", rel, i18n.T(i18n.Msg{ES: "archivo vacío", EN: "empty file"})), nil
	}
	if start > total {
		return "", i18n.Errorf(i18n.Msg{ES: "%q tiene %d líneas y pediste desde la %d", EN: "%q has %d lines and you asked from line %d"}, rel, total, start)
	}
	if end < start {
		return "", i18n.Errorf(i18n.Msg{ES: "end_line (%d) es anterior a start_line (%d)", EN: "end_line (%d) is before start_line (%d)"}, end, start)
	}

	var b strings.Builder
	last := start - 1
	for i := start - 1; i < end; i++ {
		line := lines[i]
		if r := []rune(line); len(r) > maxLineChars {
			line = string(r[:maxLineChars]) + "…"
		}
		if b.Len()+len(line)+1 > maxReadBytes && i > start-1 {
			break
		}
		b.WriteString(line)
		b.WriteByte('\n')
		last = i + 1
	}
	header := fmt.Sprintf("[%s: %s]\n", rel, i18n.T(i18n.Msg{ES: "líneas %d-%d de %d", EN: "lines %d-%d of %d"}, start, last, total))
	out := header + b.String()
	if last < end {
		out += i18n.T(i18n.Msg{
			ES: "[cortado por tamaño: seguí con start_line=%d]",
			EN: "[cut by size: continue with start_line=%d]",
		}, last+1)
	} else if last < total {
		out += i18n.T(i18n.Msg{ES: "[hay más: el archivo tiene %d líneas]", EN: "[there is more: the file has %d lines]"}, total)
	}
	return out, nil
}

func (w *Workspace) listDir(args map[string]any) (string, error) {
	abs, rel, err := w.resolve(strArg(args, "path"))
	if err != nil {
		return "", err
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		return "", i18n.Errorf(i18n.Msg{ES: "no se pudo listar %q: %w", EN: "could not list %q: %w"}, rel, err)
	}
	sort.SliceStable(entries, func(i, j int) bool {
		di, dj := entries[i].IsDir(), entries[j].IsDir()
		if di != dj {
			return di
		}
		return strings.ToLower(entries[i].Name()) < strings.ToLower(entries[j].Name())
	})
	var b strings.Builder
	shown := 0
	for _, e := range entries {
		if shown >= maxDirEntries {
			break
		}
		shown++
		switch {
		case e.Type()&os.ModeSymlink != 0:
			// Un enlace se informa como tal: seguirlo podría salir del árbol.
			b.WriteString(e.Name() + "@\n")
		case e.IsDir():
			b.WriteString(e.Name() + "/\n")
		default:
			if info, err := e.Info(); err == nil {
				fmt.Fprintf(&b, "%s  (%d B)\n", e.Name(), info.Size())
			} else {
				b.WriteString(e.Name() + "\n")
			}
		}
	}
	head := rel
	if head == "." {
		head = "/"
	}
	out := fmt.Sprintf("[%s: %s]\n", head, i18n.T(i18n.Msg{ES: "%d entradas", EN: "%d entries"}, len(entries))) + b.String()
	if len(entries) > shown {
		out += i18n.T(i18n.Msg{ES: "[se muestran las primeras %d]", EN: "[showing the first %d]"}, shown)
	}
	return out, nil
}

func (w *Workspace) writeFile(args map[string]any) (string, error) {
	p := strArg(args, "path")
	if strings.TrimSpace(p) == "" {
		return "", missing("path")
	}
	content, ok := args["content"].(string)
	if !ok {
		return "", missing("content")
	}
	if len(content) > maxWriteBytes {
		return "", i18n.Errorf(i18n.Msg{ES: "el contenido es demasiado grande (%d KB, máximo %d KB): partilo en varios archivos", EN: "the content is too large (%d KB, max %d KB): split it into several files"}, len(content)>>10, maxWriteBytes>>10)
	}
	abs, rel, err := w.resolveWrite(p)
	if err != nil {
		return "", err
	}
	if rel == "." {
		return "", i18n.Errorf(i18n.Msg{ES: "falta el nombre del archivo", EN: "the file name is missing"})
	}
	mode := os.FileMode(0o644)
	existed := false
	if fi, err := os.Stat(abs); err == nil {
		if fi.IsDir() {
			return "", i18n.Errorf(i18n.Msg{ES: "%q es un directorio", EN: "%q is a directory"}, rel)
		}
		mode, existed = fi.Mode().Perm(), true
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return "", i18n.Errorf(i18n.Msg{ES: "no se pudo crear la carpeta de %q: %w", EN: "could not create the folder of %q: %w"}, rel, err)
	}
	if err := os.WriteFile(abs, []byte(content), mode); err != nil {
		return "", i18n.Errorf(i18n.Msg{ES: "no se pudo escribir %q: %w", EN: "could not write %q: %w"}, rel, err)
	}
	n := strings.Count(content, "\n")
	if content != "" && !strings.HasSuffix(content, "\n") {
		n++
	}
	if existed {
		return i18n.T(i18n.Msg{ES: "Reemplazado %s (%d líneas, %d bytes).", EN: "Replaced %s (%d lines, %d bytes)."}, rel, n, len(content)), nil
	}
	return i18n.T(i18n.Msg{ES: "Creado %s (%d líneas, %d bytes).", EN: "Created %s (%d lines, %d bytes)."}, rel, n, len(content)), nil
}

func (w *Workspace) editFile(args map[string]any) (string, error) {
	p := strArg(args, "path")
	if strings.TrimSpace(p) == "" {
		return "", missing("path")
	}
	oldS, ok := args["old_string"].(string)
	if !ok || oldS == "" {
		return "", missing("old_string")
	}
	newS, ok := args["new_string"].(string)
	if !ok {
		return "", missing("new_string")
	}
	if oldS == newS {
		return "", i18n.Errorf(i18n.Msg{ES: "old_string y new_string son iguales: no hay nada que cambiar", EN: "old_string and new_string are the same: nothing to change"})
	}
	abs, rel, err := w.resolveWrite(p)
	if err != nil {
		return "", err
	}
	fi, err := os.Stat(abs)
	if err != nil {
		return "", i18n.Errorf(i18n.Msg{ES: "no se pudo leer %q: %w (para crear un archivo usá write_file)", EN: "could not read %q: %w (to create a file use write_file)"}, rel, err)
	}
	if fi.IsDir() {
		return "", i18n.Errorf(i18n.Msg{ES: "%q es un directorio", EN: "%q is a directory"}, rel)
	}
	if fi.Size() > maxFileBytes {
		return "", i18n.Errorf(i18n.Msg{ES: "%q es demasiado grande para editarlo", EN: "%q is too large to edit"}, rel)
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return "", i18n.Errorf(i18n.Msg{ES: "no se pudo leer %q: %w", EN: "could not read %q: %w"}, rel, err)
	}
	if looksBinary(data) || !utf8.Valid(data) {
		return "", i18n.Errorf(i18n.Msg{ES: "%q no es un archivo de texto UTF-8", EN: "%q is not a UTF-8 text file"}, rel)
	}
	text := string(data)

	count := strings.Count(text, oldS)
	// Un archivo con saltos CRLF que el modelo cita con LF: se reintenta con
	// el salto del archivo en vez de fallar por algo que no se ve.
	if count == 0 && strings.Contains(text, "\r\n") && strings.Contains(oldS, "\n") && !strings.Contains(oldS, "\r\n") {
		o2 := strings.ReplaceAll(oldS, "\n", "\r\n")
		if c := strings.Count(text, o2); c > 0 {
			oldS, newS, count = o2, strings.ReplaceAll(newS, "\n", "\r\n"), c
		}
	}
	switch {
	case count == 0:
		return "", i18n.Errorf(i18n.Msg{
			ES: "old_string no aparece en %q. Releé el archivo: tiene que coincidir exactamente, con la sangría y los saltos de línea",
			EN: "old_string does not appear in %q. Re-read the file: it must match exactly, including indentation and line breaks",
		}, rel)
	case count > 1:
		return "", i18n.Errorf(i18n.Msg{
			ES: "old_string aparece %d veces en %q: agregá líneas de contexto para que sea único",
			EN: "old_string appears %d times in %q: add context lines to make it unique",
		}, count, rel)
	}
	out := strings.Replace(text, oldS, newS, 1)
	if err := os.WriteFile(abs, []byte(out), fi.Mode().Perm()); err != nil {
		return "", i18n.Errorf(i18n.Msg{ES: "no se pudo escribir %q: %w", EN: "could not write %q: %w"}, rel, err)
	}
	return i18n.T(i18n.Msg{ES: "Editado %s: %d líneas reemplazadas por %d.", EN: "Edited %s: %d lines replaced by %d."}, rel, strings.Count(oldS, "\n")+1, strings.Count(newS, "\n")+1), nil
}
