package vault

import (
	"regexp"
	"sort"
	"strings"
	"sync"
	"unicode"

	"mini-tools/backend/i18n"
)

// Carpetas de notas por ruta, etiquetas y consultas acotadas para agentes.
//
// Un agente no conoce ids de carpeta: piensa en rutas como
// "Cerebro/Proyectos/mini-tools", que es como las nombra una persona y como se
// ve el árbol de Obsidian. Este archivo traduce ruta ↔ ids sin tocar el
// esquema: las carpetas de notas son filas de `folders` con scope 'note'
// (migración 38) y la ruta se arma recorriendo `parent_id`.

// noteFolderScope es el scope de las carpetas del módulo de notas.
const noteFolderScope = "note"

const (
	// maxFolderDepth acota la profundidad de una ruta pedida por un agente.
	// Un árbol de ocho niveles ya no se navega; un modelo que pide veinte
	// está equivocado.
	maxFolderDepth = 8
	// maxFolderNameLen acota el nombre de cada carpeta, en caracteres.
	maxFolderNameLen = 80
)

var msgBadFolderPath = i18n.Msg{
	ES: "ruta de carpeta inválida %q: usá nombres separados por «/», sin segmentos vacíos ni «.» / «..», de hasta %d niveles",
	EN: "invalid folder path %q: use names separated by «/», no empty segments nor «.» / «..», up to %d levels",
}

// ErrBadFolderPath identifica el rechazo de una ruta de carpeta mal formada.
var ErrBadFolderPath = i18n.New(i18n.Msg{ES: "vault: ruta de carpeta inválida", EN: "vault: invalid folder path"})

type badFolderPathError struct{ path string }

func (e *badFolderPathError) Error() string {
	return i18n.T(msgBadFolderPath, e.path, maxFolderDepth)
}
func (e *badFolderPathError) Is(target error) bool { return target == ErrBadFolderPath }

// ParseFolderPath parte una ruta de carpeta en sus segmentos y la valida.
//
// Se rechaza todo lo que no sea un nombre de carpeta llano: segmentos vacíos
// (`a//b`), `.` y `..` (no hay "carpeta actual" ni "padre" que resolver, y
// aceptarlos en silencio haría que `../x` cayera en la raíz sin avisar),
// caracteres de control y nombres larguísimos. Una barra inicial o final se
// tolera —`/Cerebro/`— porque es cómo muchos modelos escriben una ruta, y
// la barra invertida cuenta como separador por quien escribe desde Windows.
func ParseFolderPath(path string) ([]string, error) {
	p := strings.ReplaceAll(strings.TrimSpace(path), "\\", "/")
	p = strings.Trim(p, "/")
	if p == "" {
		return nil, &badFolderPathError{path: path}
	}
	segs := strings.Split(p, "/")
	if len(segs) > maxFolderDepth {
		return nil, &badFolderPathError{path: path}
	}
	for i, s := range segs {
		s = strings.TrimSpace(s)
		if s == "" || s == "." || s == ".." || len([]rune(s)) > maxFolderNameLen {
			return nil, &badFolderPathError{path: path}
		}
		for _, r := range s {
			if unicode.IsControl(r) {
				return nil, &badFolderPathError{path: path}
			}
		}
		segs[i] = s
	}
	return segs, nil
}

// noteFolders devuelve las carpetas del módulo de notas.
func (s *Store) noteFolders() ([]Folder, error) {
	all, err := s.ListFolders()
	if err != nil {
		return nil, err
	}
	out := make([]Folder, 0, len(all))
	for _, f := range all {
		if f.Scope == noteFolderScope {
			out = append(out, f)
		}
	}
	return out, nil
}

// NoteFolderPaths devuelve la ruta completa de cada carpeta de notas, por id.
func (s *Store) NoteFolderPaths() (map[string]string, error) {
	folders, err := s.noteFolders()
	if err != nil {
		return nil, err
	}
	return folderPaths(folders), nil
}

// folderPaths arma las rutas recorriendo los padres. Una cadena que no termina
// (un ciclo que la interfaz no debería permitir pero que un vault dañado
// podría tener) se corta en vez de colgar al agente.
func folderPaths(folders []Folder) map[string]string {
	byID := make(map[string]Folder, len(folders))
	for _, f := range folders {
		byID[f.ID] = f
	}
	out := make(map[string]string, len(folders))
	for _, f := range folders {
		parts := []string{f.Name}
		cur := f
		for hops := 0; cur.ParentID != "" && hops < 32; hops++ {
			p, ok := byID[cur.ParentID]
			if !ok {
				break
			}
			parts = append([]string{p.Name}, parts...)
			cur = p
		}
		out[f.ID] = strings.Join(parts, "/")
	}
	return out
}

// childFolder busca, entre las carpetas de notas, la hija de parentID con ese
// nombre. Compara sin tildes ni mayúsculas: "cerebro" y "Cerebro" son la misma
// carpeta para quien la nombra, y crear dos haría que cada nota cayera en la
// que el modelo escribió ese día.
func childFolder(folders []Folder, parentID, name string) (Folder, bool) {
	want := foldText(name)
	for _, f := range folders {
		if f.ParentID == parentID && foldText(f.Name) == want {
			return f, true
		}
	}
	return Folder{}, false
}

// FindNoteFolder resuelve una ruta a su carpeta sin crear nada. found es false
// si algún tramo no existe.
func (s *Store) FindNoteFolder(path string) (id string, found bool, err error) {
	segs, err := ParseFolderPath(path)
	if err != nil {
		return "", false, err
	}
	folders, err := s.noteFolders()
	if err != nil {
		return "", false, err
	}
	parent := ""
	for _, seg := range segs {
		f, ok := childFolder(folders, parent, seg)
		if !ok {
			return "", false, nil
		}
		parent = f.ID
	}
	return parent, true, nil
}

// noteFolderMu serializa EnsureNoteFolder: dos llamadas simultáneas que creen
// "Cerebro/Temas" a la vez dejarían dos carpetas "Temas".
var noteFolderMu sync.Mutex

// EnsureNoteFolder devuelve la carpeta de esa ruta creando las que falten.
func (s *Store) EnsureNoteFolder(path string) (string, error) {
	segs, err := ParseFolderPath(path)
	if err != nil {
		return "", err
	}
	noteFolderMu.Lock()
	defer noteFolderMu.Unlock()

	folders, err := s.noteFolders()
	if err != nil {
		return "", err
	}
	parent := ""
	for _, seg := range segs {
		if f, ok := childFolder(folders, parent, seg); ok {
			parent = f.ID
			continue
		}
		created, err := s.CreateFolder(seg, parent, noteFolderScope)
		if err != nil {
			return "", err
		}
		folders = append(folders, *created)
		parent = created.ID
	}
	return parent, nil
}

// NoteFolderSubtree devuelve los ids de la carpeta de esa ruta y de todas sus
// descendientes. found es false si la ruta no existe.
func (s *Store) NoteFolderSubtree(path string) (ids map[string]bool, found bool, err error) {
	root, found, err := s.FindNoteFolder(path)
	if err != nil || !found {
		return nil, false, err
	}
	folders, err := s.noteFolders()
	if err != nil {
		return nil, false, err
	}
	ids = map[string]bool{root: true}
	// Un recorrido por niveles: las carpetas vienen planas y sin orden de
	// profundidad, así que se repite hasta que no entre ninguna más.
	for grew := true; grew; {
		grew = false
		for _, f := range folders {
			if !ids[f.ID] && ids[f.ParentID] {
				ids[f.ID] = true
				grew = true
			}
		}
	}
	return ids, true, nil
}

// FolderStat es una carpeta de notas con cuántas notas visibles tiene.
type FolderStat struct {
	ID   string `json:"id"`
	Path string `json:"path"`
	// Notes son las notas visibles para agentes que están DIRECTAMENTE en la
	// carpeta; Total suma además las de sus subcarpetas.
	Notes int `json:"notes"`
	Total int `json:"total"`
}

// SharedFolderTree devuelve las carpetas de notas con sus conteos de notas
// VISIBLES (no privadas), más cuántas notas visibles hay en la raíz.
//
// **Qué carpetas se listan.** Solo las que tienen al menos una nota visible en
// su subárbol. El nombre de una carpeta va en claro y puede decir mucho
// ("Credenciales prod"): una carpeta que solo contiene notas privadas no le
// aparece a un agente, en coherencia con que sus notas tampoco. Una carpeta
// vacía recién creada tampoco: no hay nada que mostrar adentro, y el agente que
// la creó ya sabe la ruta.
//
// Los conteos salen de GROUP BY sobre columnas en claro: no se descifra nada.
func (s *Store) SharedFolderTree() (folders []FolderStat, rootNotes int, err error) {
	rows, err := s.db.Query(`SELECT COALESCE(folder_id, ''), COUNT(*) FROM vault_notes WHERE is_private = 0 GROUP BY folder_id`)
	if err != nil {
		return nil, 0, i18n.Errorf(i18n.Msg{ES: "vault: contando las notas por carpeta: %w", EN: "vault: counting notes per folder: %w"}, err)
	}
	defer rows.Close()
	direct := map[string]int{}
	for rows.Next() {
		var id string
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return nil, 0, err
		}
		direct[id] = n
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}

	all, err := s.noteFolders()
	if err != nil {
		return nil, 0, err
	}
	paths := folderPaths(all)
	byID := make(map[string]Folder, len(all))
	for _, f := range all {
		byID[f.ID] = f
	}
	// Cada nota suma a su carpeta y a todos sus ancestros.
	total := map[string]int{}
	for id, n := range direct {
		if id == "" {
			continue
		}
		cur, ok := byID[id]
		for hops := 0; ok && hops < 32; hops++ {
			total[cur.ID] += n
			cur, ok = byID[cur.ParentID]
		}
	}
	for _, f := range all {
		if total[f.ID] == 0 {
			continue
		}
		folders = append(folders, FolderStat{ID: f.ID, Path: paths[f.ID], Notes: direct[f.ID], Total: total[f.ID]})
	}
	sort.Slice(folders, func(i, j int) bool { return foldText(folders[i].Path) < foldText(folders[j].Path) })
	return folders, direct[""], nil
}

// NoteFolderID devuelve la carpeta de una nota ("" = raíz). Es una columna en
// claro: no descifra nada.
func (s *Store) NoteFolderID(noteID string) (string, error) {
	var id string
	if err := s.db.QueryRow(`SELECT COALESCE(folder_id, '') FROM vault_notes WHERE id = ?`, noteID).Scan(&id); err != nil {
		return "", i18n.Errorf(i18n.Msg{ES: "vault: leyendo la carpeta de la nota: %w", EN: "vault: reading the note's folder: %w"}, err)
	}
	return id, nil
}

// ---------------------------------------------------------------- etiquetas

var (
	fencedCode = regexp.MustCompile("(?s)```.*?```|~~~.*?~~~")
	inlineCode = regexp.MustCompile("`[^`\n]*`")
	fmTagsLine = regexp.MustCompile(`(?i)^\s*(?:tags|etiquetas)\s*:\s*(.*)$`)
)

// NoteTags devuelve las etiquetas de una nota, sin la almohadilla y sin
// repetir (se comparan sin tildes ni mayúsculas, se devuelve la primera
// escritura).
//
// Una etiqueta puede estar de dos maneras, y las dos valen:
//
//   - `#algo` en el cuerpo (o en el frontmatter), igual que en Obsidian;
//   - `tags: [a, b]` / `tags: a, b` / lista `- a` en el frontmatter.
//
// El código (bloques y en línea) se ignora en el cuerpo: `#include` o un
// comentario de shell no son etiquetas, y llenarían la lista de basura. Es el
// mismo `extractTags` del autocompletado, que es lo que define qué es un `#tag`.
func NoteTags(content, frontmatter string) []string {
	body := inlineCode.ReplaceAllString(fencedCode.ReplaceAllString(content, ""), "")
	var raw []string
	for _, t := range extractTags(body) {
		raw = append(raw, strings.TrimPrefix(t, "#"))
	}
	for _, t := range extractTags(frontmatter) {
		raw = append(raw, strings.TrimPrefix(t, "#"))
	}
	raw = append(raw, frontmatterTagList(frontmatter)...)

	seen := map[string]bool{}
	out := []string{}
	for _, t := range raw {
		t = strings.Trim(strings.TrimSpace(t), "-/_")
		key := foldText(t)
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, t)
	}
	return out
}

// frontmatterTagList lee la clave `tags:` del frontmatter en sus tres formas
// habituales. No es un parser YAML (regla 12: no se suma uno al binario): solo
// lo que hace falta para esta clave.
func frontmatterTagList(frontmatter string) []string {
	lines := strings.Split(frontmatter, "\n")
	var out []string
	for i, line := range lines {
		m := fmTagsLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		rest := strings.TrimSpace(m[1])
		if rest == "" {
			// Forma de lista: las líneas `- algo` que siguen.
			for _, next := range lines[i+1:] {
				item := strings.TrimSpace(next)
				if !strings.HasPrefix(item, "-") {
					break
				}
				out = append(out, cleanTagItem(strings.TrimPrefix(item, "-")))
			}
			continue
		}
		rest = strings.TrimSuffix(strings.TrimPrefix(rest, "["), "]")
		for _, item := range strings.Split(rest, ",") {
			out = append(out, cleanTagItem(item))
		}
	}
	return out
}

func cleanTagItem(s string) string {
	return strings.TrimPrefix(strings.Trim(strings.TrimSpace(s), `"'`), "#")
}

// hasTag dice si la nota tiene esa etiqueta (sin tildes ni mayúsculas; la
// almohadilla inicial se tolera).
func hasTag(tags []string, want string) bool {
	want = foldText(strings.TrimPrefix(strings.TrimSpace(want), "#"))
	if want == "" {
		return true
	}
	for _, t := range tags {
		if foldText(t) == want {
			return true
		}
	}
	return false
}

// ------------------------------------------------- consultas para agentes

// SharedNote es una nota visible para agentes, sin su cuerpo completo.
type SharedNote struct {
	ID        string
	Title     string
	FolderID  string
	Tags      []string
	UpdatedAt int64
	// Snippet es el fragmento donde acertó la búsqueda (sin marcadores).
	Snippet string
	score   int
}

// SharedNoteFilter acota una consulta sobre las notas visibles.
type SharedNoteFilter struct {
	// Query: todas las palabras tienen que aparecer (título o cuerpo, sin
	// tildes ni mayúsculas); lo que va entre comillas es una frase literal.
	// Vacío = todas.
	Query string
	// Tag filtra por etiqueta (con o sin `#`).
	Tag string
	// FolderIDs, si no es nil, deja solo las notas de esas carpetas.
	FolderIDs map[string]bool
	// SortByTitle ordena alfabéticamente (sin tildes ni mayúsculas) en vez de
	// por relevancia o fecha: es el orden de una lista de navegación.
	SortByTitle bool
	// Limit corta el resultado (0 = sin tope).
	Limit int
}

// SearchSharedNotes lista o busca SOLO entre las notas visibles para agentes.
//
// **Es la puerta de lectura por lista, igual que NoteForAI lo es por título.**
// `is_private = 0` está en la propia consulta: una nota privada no sale de la
// base, no se descifra y no puede aparecer ni como título ni como fragmento.
// Los filtros de carpeta y etiqueta se aplican después, sobre lo que ya pasó ese
// corte, así que ninguno puede ampliar lo visible.
//
// Con texto, ordena por relevancia (el mismo `scoreNote` del buscador de la
// app); sin texto, por fecha de modificación.
func (s *Store) SearchSharedNotes(f SharedNoteFilter) ([]SharedNote, error) {
	pq := ParseNoteQuery(f.Query)
	// Solo cuentan palabras y frases: `tag:`/`enlaza:`/`privado:` son filtros del
	// buscador de la app, y `privado:` en particular no tiene sentido acá.
	q := NoteQuery{Terms: pq.Terms, Phrases: pq.Phrases}
	// `tag:algo` dentro del texto vale como el filtro de etiqueta, si no se pasó
	// uno aparte; `enlaza:` y `privado:` se ignoran.
	tag := f.Tag
	if tag == "" && len(pq.Tags) > 0 {
		tag = pq.Tags[0]
	}
	searching := len(q.Terms) > 0 || len(q.Phrases) > 0

	rows, err := s.db.Query(
		`SELECT id, encrypted_title, title_nonce, encrypted_content, content_nonce,
		        encrypted_frontmatter, frontmatter_nonce, updated_at, COALESCE(folder_id, '')
		 FROM vault_notes WHERE is_private = 0 ORDER BY updated_at DESC`)
	if err != nil {
		return nil, i18n.Errorf(i18n.Msg{ES: "vault: buscando en las notas: %w", EN: "vault: searching the notes: %w"}, err)
	}
	defer rows.Close()

	out := []SharedNote{}
	for rows.Next() {
		var id, folderID string
		var encTitle, titleNonce, encContent, contentNonce, encFm, fmNonce []byte
		var updated int64
		if err := rows.Scan(&id, &encTitle, &titleNonce, &encContent, &contentNonce, &encFm, &fmNonce, &updated, &folderID); err != nil {
			return nil, err
		}
		// La carpeta se filtra ANTES de descifrar: es una columna en claro.
		if f.FolderIDs != nil && !f.FolderIDs[folderID] {
			continue
		}
		title := s.decryptOptional(encTitle, titleNonce)
		content := s.decryptOptional(encContent, contentNonce)
		frontmatter := s.decryptOptional(encFm, fmNonce)

		tags := NoteTags(content, frontmatter)
		if tag != "" && !hasTag(tags, tag) {
			continue
		}
		n := SharedNote{ID: id, Title: title, FolderID: folderID, Tags: tags, UpdatedAt: updated}
		if searching {
			hit, ok := scoreNote(q, id, title, content, frontmatter)
			if !ok {
				continue
			}
			n.score = hit.Score
			n.Snippet = strings.NewReplacer("«", "", "»", "").Replace(hit.Snippet)
		}
		out = append(out, n)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if searching {
		sort.SliceStable(out, func(i, j int) bool {
			if out[i].score != out[j].score {
				return out[i].score > out[j].score
			}
			return out[i].UpdatedAt > out[j].UpdatedAt
		})
	}
	if f.SortByTitle {
		sort.SliceStable(out, func(i, j int) bool { return foldText(out[i].Title) < foldText(out[j].Title) })
	}
	if f.Limit > 0 && len(out) > f.Limit {
		out = out[:f.Limit]
	}
	return out, nil
}
